import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  ENGAGEMENT_PROPERTIES,
  RefusalError,
  type TenantTransaction,
  validateEmptyQuery,
  validateFormPublish,
  validateFormRetire,
  validateFormSubmissionInput,
  validateIntakeReviewResolve,
} from '@cuspatlas/contracts';
import { executeOnce } from '../../commands/execute-once';
import { recordCommand } from '../../events/record-command';
import { recordSensitiveRead } from '../../events/record-sensitive-read';
import { AVAILABLE, workItem, workList } from '../../work-items';
import { assertRef, checkEnvelope, conflict, type EngagementBase, failedAt, notFound } from '../common';
import { insertConsent } from '../communications/consent';
import { loadPortalPrincipal, requirePortalAccess } from '../portal/access';

/**
 * E4 intake forms. Form versions are published configuration (synthetic content; clinical sign-off
 * of real content is pending, recorded on every version as `pending_clinical_review`). A submission is
 * an append-only fact bound to the form version it answered, with provenance (transport, submitting
 * principal, the S5 relationship a guardian or proxy used) and idempotent on its key. Consent answers
 * become E6 consent facts linked to the submission (communications and portal consent only: clinical
 * treatment consent is C13's and is never captured here). Answers never write another record:
 *
 * - demographics answers that differ from the S4 record open one staff review item; the reviewer sees
 *   the diff against the live record and applies it through S4's own update command (never a silent
 *   overwrite), or rejects it;
 * - medical-history answers open one hand-off item for C8 carrying only a payload reference
 *   (`intake-submission:<ref>#<keys>`); C8 is not deployed, so the item stays open and blocked on C8.
 *
 * An answer equal to the record opens nothing (a fact entered once is reused, UX-02).
 */
export const INTAKE_POLICY_VERSION = 'intake.pending-approval.1';
export const INTAKE_SUBMISSION_RESOURCE = 'intakeSubmission';

type FieldKind = 'text' | 'choice' | 'date' | 'boolean';
type Target =
  | 'demographics.preferredName'
  | 'demographics.pronouns'
  | 'demographics.language'
  | 'medical_history';
interface FormField {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  maxLength?: number;
  options?: string[];
  target?: Target;
}
interface FormConsent {
  key: string;
  label: string;
  channel: string;
  purpose: string;
  consentVersion: string;
}
interface FormDefinition {
  fields: FormField[];
  consents: FormConsent[];
}

const GROUP: Readonly<Record<string, 'preferredName' | 'pronouns' | 'language'>> = {
  'demographics.preferredName': 'preferredName',
  'demographics.pronouns': 'pronouns',
  'demographics.language': 'language',
};
const COLUMN = { preferredName: 'preferred_name', pronouns: 'pronouns', language: 'language' } as const;
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const groupValue = (group: 'preferredName' | 'pronouns' | 'language', answer: string) =>
  group === 'language' ? { known: true, tag: answer } : { known: true, value: answer };

interface FormRow extends Record<string, unknown> {
  id: string;
  form_ref: string;
  version: number;
  title: string;
  definition: FormDefinition;
  state: 'published' | 'retired';
  valid_until: Date | null;
  content_review: string;
  published_at: Date;
  latest: number;
  expired: boolean;
}

async function loadFormVersion(
  tx: TenantTransaction,
  formRef: string,
  version?: number,
): Promise<FormRow | null> {
  const { rows } = await tx.query<FormRow>(
    `SELECT f.id, f.form_ref, f.version, f.title, f.definition, f.state, f.valid_until, f.content_review,
       f.published_at, (SELECT max(version) FROM cuspatlas.intake_form_versions x WHERE x.form_ref = f.form_ref) AS latest,
       (f.valid_until IS NOT NULL AND f.valid_until <= now()) AS expired
     FROM cuspatlas.intake_form_versions f WHERE f.form_ref = $1 AND ($2::int IS NULL OR f.version = $2)
     ORDER BY f.version DESC LIMIT 1`,
    [formRef, version ?? null],
  );
  return rows[0] ?? null;
}

const accepting = (f: FormRow) => f.state === 'published' && !f.expired && f.version === f.latest;

/** Field-level validation against the bound version: violations name keys and rules, never values. */
function checkAnswers(
  def: FormDefinition,
  answers: Record<string, unknown>,
  consents: Record<string, unknown>,
) {
  const violations: { pointer: string; rule: string }[] = [];
  const fields = new Map(def.fields.map((f) => [f.key, f]));
  for (const key of Object.keys(answers)) {
    const f = fields.get(key);
    if (!f) {
      violations.push({ pointer: `/answers/${key}`, rule: 'unknownField' });
      continue;
    }
    const v = answers[key];
    const ok =
      f.kind === 'boolean'
        ? typeof v === 'boolean'
        : typeof v === 'string' &&
          (f.kind === 'text'
            ? v.length <= (f.maxLength ?? 500)
            : f.kind === 'choice'
              ? (f.options ?? []).includes(v)
              : DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)));
    if (!ok) violations.push({ pointer: `/answers/${key}`, rule: 'answerKind' });
    else if (f.target === 'demographics.language' && !LANGUAGE_TAG.test(v as string))
      violations.push({ pointer: `/answers/${key}`, rule: 'languageTag' });
    else if (f.target === 'demographics.pronouns' && (v as string).length > 40)
      violations.push({ pointer: `/answers/${key}`, rule: 'maxLength' });
  }
  for (const f of def.fields) {
    if (f.required && !Object.hasOwn(answers, f.key))
      violations.push({ pointer: `/answers/${f.key}`, rule: 'requiredAnswer' });
  }
  const consentKeys = new Set(def.consents.map((c) => c.key));
  for (const key of Object.keys(consents)) {
    if (!consentKeys.has(key)) violations.push({ pointer: `/consents/${key}`, rule: 'unknownField' });
  }
  if (violations.length > 0) {
    throw new RefusalError({ code: 'validation_failed', detail: { violations: violations.slice(0, 50) } });
  }
}

function checkDefinition(p: { fields: FormField[]; consents?: FormConsent[] }) {
  const keys = new Set<string>();
  p.fields.forEach((f, i) => {
    if (keys.has(f.key)) throw failedAt(`/fields/${i}/key`, 'duplicateKey');
    keys.add(f.key);
    if ((f.kind === 'choice') !== (f.options !== undefined))
      throw failedAt(`/fields/${i}/options`, 'choiceOptions');
    if (f.target !== undefined && f.target !== 'medical_history' && f.kind !== 'text')
      throw failedAt(`/fields/${i}/target`, 'demographicsTargetNeedsText');
  });
  const targets = p.fields.map((f) => f.target).filter((t) => t !== undefined && t !== 'medical_history');
  if (new Set(targets).size !== targets.length) throw failedAt('/fields', 'duplicateTarget');
  (p.consents ?? []).forEach((c, i) => {
    if (keys.has(c.key)) throw failedAt(`/consents/${i}/key`, 'duplicateKey');
    keys.add(c.key);
  });
}

const reviewExplanation = {
  demographics_update:
    'An intake form proposes demographic changes that differ from the patient record. Review the difference and apply it through the patient record, or reject it.',
  medical_history_handoff:
    'An intake form carries medical-history answers for clinical review. They are held by reference until the clinical record (C8) can receive them; nothing was written to the chart.',
} as const;

export function createIntakeOperations(base: EngagementBase) {
  const { deps } = base;
  const execute = deps.execute ?? executeOnce;

  /** The shared submission core (portal and staff): validation, the fact, consents, review items. */
  async function insertSubmission(
    tx: TenantTransaction,
    operation: string,
    s: {
      patientRef: string;
      via: 'portal' | 'staff';
      viaRelationship: string | null;
      consentSource: string;
      provenance: 'patient_reported' | 'guardian_reported' | 'staff_entry';
      form: FormRow;
      answers: Record<string, string | boolean>;
      consents: Record<string, 'granted' | 'denied'>;
    },
  ) {
    const { rows } = await tx.query<{ id: string; submitted_at: Date }>(
      `INSERT INTO cuspatlas.intake_submissions (tenant_id, form_version_id, patient_id, submitted_via, submitted_by,
         via_relationship_id, answers)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id(), $4, $5::jsonb)
       RETURNING id, submitted_at`,
      [s.form.id, s.patientRef, s.via, s.viaRelationship, JSON.stringify(s.answers)],
    );
    const id = rows[0]?.id as string;
    await recordCommand(
      tx,
      { operation, resourceType: INTAKE_SUBMISSION_RESOURCE, resourceRef: id, resourceVersion: 1 },
      { changedFields: ['formVersion', 'answers', 'consents'] },
    );
    const consentRefs: string[] = [];
    for (const c of s.form.definition.consents) {
      const state = s.consents[c.key];
      if (state === undefined) continue;
      const r = await insertConsent(tx, operation, {
        patientRef: s.patientRef,
        channel: c.channel,
        purpose: c.purpose,
        state,
        source: s.consentSource,
        version: c.consentVersion,
        via: s.viaRelationship,
      });
      await tx.query(
        `INSERT INTO cuspatlas.intake_submission_consents (tenant_id, submission_id, consent_id, consent_key)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, $3)`,
        [id, r.data.consentRef, c.key],
      );
      consentRefs.push(r.data.consentRef);
    }
    // Proposed demographics: only groups that differ from the live record (a fact entered once).
    const proposed: Record<string, unknown> = {};
    const history: string[] = [];
    const current = (
      await tx.query<Record<string, unknown>>(
        'SELECT preferred_name, pronouns, language FROM cuspatlas.patients WHERE id = $1',
        [s.patientRef],
      )
    ).rows[0];
    for (const f of s.form.definition.fields) {
      const answer = s.answers[f.key];
      if (answer === undefined || f.target === undefined) continue;
      if (f.target === 'medical_history') {
        history.push(f.key);
        continue;
      }
      const group = GROUP[f.target];
      if (!group || typeof answer !== 'string') continue;
      const value = groupValue(group, answer);
      if (JSON.stringify(current?.[COLUMN[group]]) !== JSON.stringify(value)) proposed[group] = value;
    }
    const reviews: { reviewRef: string; kind: string }[] = [];
    if (Object.keys(proposed).length > 0) {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO cuspatlas.intake_review_items (tenant_id, submission_id, patient_id, kind, proposed, payload_ref)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, 'demographics_update', $3::jsonb, $4) RETURNING id`,
        [
          id,
          s.patientRef,
          JSON.stringify({ groups: proposed, provenance: s.provenance }),
          `intake-submission:${id}`,
        ],
      );
      reviews.push({ reviewRef: r.rows[0]?.id as string, kind: 'demographics_update' });
    }
    if (history.length > 0) {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO cuspatlas.intake_review_items (tenant_id, submission_id, patient_id, kind, proposed, payload_ref)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, 'medical_history_handoff', '{}'::jsonb, $3) RETURNING id`,
        [id, s.patientRef, `intake-submission:${id}#${history.join(',')}`],
      );
      reviews.push({ reviewRef: r.rows[0]?.id as string, kind: 'medical_history_handoff' });
    }
    return {
      data: {
        submissionRef: id,
        patientRef: s.patientRef,
        formRef: s.form.form_ref,
        formVersion: s.form.version,
        submittedVia: s.via,
        viaRelationshipRef: s.viaRelationship,
        consentCount: consentRefs.length,
        demographicsReview: reviews.some((r) => r.kind === 'demographics_update'),
        historyHandoff: reviews.some((r) => r.kind === 'medical_history_handoff'),
        submittedAt: (rows[0] as { submitted_at: Date }).submitted_at.toISOString(),
      },
      version: 1,
    };
  }

  async function boundForm(tx: TenantTransaction, p: { formRef: string; formVersion: number }) {
    const form = await loadFormVersion(tx, p.formRef, p.formVersion);
    if (!form) throw notFound();
    // Only the current version accepts new submissions; earlier submissions stay bound to theirs.
    if (!accepting(form)) throw conflict('form_version_expired');
    return form;
  }

  type SubmissionPayload = {
    formRef: string;
    formVersion: number;
    answers: Record<string, string | boolean>;
    consents?: Record<string, 'granted' | 'denied'>;
  };

  return {
    publishForm(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'intake.forms.publish';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateFormPublish, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as {
          formRef: string;
          title: string;
          fields: FormField[];
          consents?: FormConsent[];
          validUntil?: string;
        };
        checkDefinition(p);
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute(ctx, envelope, tx, async () => {
            const latest = await tx.query<{ v: number | null }>(
              'SELECT max(version)::int AS v FROM cuspatlas.intake_form_versions WHERE form_ref = $1',
              [p.formRef],
            );
            const version = (latest.rows[0]?.v ?? 0) + 1;
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.intake_form_versions (tenant_id, form_ref, version, title, definition, valid_until,
                 published_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::jsonb, $5, cuspatlas.current_actor_id()) RETURNING id`,
              [
                p.formRef,
                version,
                p.title,
                JSON.stringify({ fields: p.fields, consents: p.consents ?? [] }),
                p.validUntil ?? null,
              ],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'intakeFormVersion', resourceRef: id, resourceVersion: 1 },
              { changedFields: ['title', 'fields', 'consents'] },
            );
            return {
              data: {
                formRef: p.formRef,
                formVersion: version,
                state: 'published',
                contentReview: 'pending_clinical_review',
              },
              version,
            };
          }),
        );
      });
    },

    retireForm(ctx: ActorContext, formRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'intake.forms.retire';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        if (!/^[a-z0-9-]{1,64}$/.test(formRef)) throw notFound();
        assertValid(validateFormRetire, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { expectedVersion: number };
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute(ctx, { ...envelope, payload: { formRef, ...p } }, tx, async () => {
            const { rows } = await tx.query<{ id: string; version: number; state: string }>(
              `SELECT id, version, state FROM cuspatlas.intake_form_versions WHERE form_ref = $1
               ORDER BY version DESC LIMIT 1 FOR UPDATE`,
              [formRef],
            );
            const f = rows[0];
            if (!f) throw notFound();
            if (f.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: f.version } });
            if (f.state !== 'published') throw conflict('form_already_retired');
            await tx.query(
              `UPDATE cuspatlas.intake_form_versions SET state = 'retired', retired_by = cuspatlas.current_actor_id(),
                 retired_at = now() WHERE id = $1`,
              [f.id],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: 'intakeFormVersion', resourceRef: f.id, resourceVersion: 2 },
              { changedFields: ['state'] },
            );
            return { data: { formRef, formVersion: f.version, state: 'retired' }, version: f.version };
          }),
        );
      });
    },

    listForms(ctx: ActorContext, query: unknown) {
      const op = 'intake.forms.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<FormRow>(
            `SELECT DISTINCT ON (f.form_ref) f.id, f.form_ref, f.version, f.title, f.definition, f.state, f.valid_until,
               f.content_review, f.published_at, f.version AS latest,
               (f.valid_until IS NOT NULL AND f.valid_until <= now()) AS expired
             FROM cuspatlas.intake_form_versions f ORDER BY f.form_ref, f.version DESC LIMIT 200`,
          );
          return rows.map((f) => ({
            formRef: f.form_ref,
            formVersion: f.version,
            title: f.title,
            state: f.state,
            acceptingSubmissions: accepting(f),
            contentReview: f.content_review,
            fields: f.definition.fields,
            consents: f.definition.consents,
            publishedAt: f.published_at.toISOString(),
          }));
        });
      });
    },

    /** The current version of a form for a portal principal (any live principal; no patient data). */
    describePortalForm(ctx: ActorContext, formRef: string, query: unknown) {
      return base.guarded(ctx, 'portal.forms.describe', async () => {
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await loadPortalPrincipal(tx);
          if (!/^[a-z0-9-]{1,64}$/.test(formRef)) throw notFound();
          const f = await loadFormVersion(tx, formRef);
          if (!f || !accepting(f)) throw notFound();
          return {
            formRef: f.form_ref,
            formVersion: f.version,
            title: f.title,
            fields: f.definition.fields.map((x) => ({
              key: x.key,
              label: x.label,
              kind: x.kind,
              required: x.required,
              ...(x.options ? { options: x.options } : {}),
              ...(x.maxLength ? { maxLength: x.maxLength } : {}),
            })),
            consents: f.definition.consents.map((c) => ({
              key: c.key,
              label: c.label,
              channel: c.channel,
              purpose: c.purpose,
            })),
          };
        });
      });
    },

    /** Portal submission: self, or a relationship holding demographics and consent (forms view). */
    submitPortalForm(ctx: ActorContext, patientRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'portal.forms.submit';
      return base.guarded(ctx, op, async () => {
        checkEnvelope(envelope, op);
        assertValid(validateFormSubmissionInput, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as SubmissionPayload;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const access = await requirePortalAccess(tx, patientRef, ['demographics', 'consent']);
          const via =
            access.via === 'self'
              ? null
              : (access.access?.relationships.find(
                  (r) =>
                    r.status === 'active' &&
                    r.scopes.includes('demographics') &&
                    r.scopes.includes('consent'),
                )?.relationshipRef ?? null);
          return execute(ctx, { ...envelope, payload: { patientRef, ...p } }, tx, async () => {
            const form = await boundForm(tx, p);
            checkAnswers(form.definition, p.answers, p.consents ?? {});
            return insertSubmission(tx, op, {
              patientRef: access.patientRef,
              via: 'portal',
              viaRelationship: via,
              consentSource: access.via === 'self' ? 'patient_portal' : 'guardian_portal',
              provenance: access.via === 'self' ? 'patient_reported' : 'guardian_reported',
              form,
              answers: p.answers,
              consents: p.consents ?? {},
            });
          });
        });
      });
    },

    /** Staff entry of a completed (paper or front-desk) form for a patient. */
    submitStaffForm(ctx: ActorContext, patientRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'intake.submissions.submit';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateFormSubmissionInput, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as SubmissionPayload;
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(patientRef);
          const pt = await tx.query<{ merged_into: string | null }>(
            'SELECT merged_into FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
            [patientRef],
          );
          if (!pt.rows[0]) throw notFound();
          return execute(ctx, { ...envelope, payload: { patientRef, ...p } }, tx, async () => {
            if (pt.rows[0]?.merged_into !== null) throw conflict('patient_merged');
            const form = await boundForm(tx, p);
            checkAnswers(form.definition, p.answers, p.consents ?? {});
            return insertSubmission(tx, op, {
              patientRef,
              via: 'staff',
              viaRelationship: null,
              consentSource: 'written_form',
              provenance: 'staff_entry',
              form,
              answers: p.answers,
              consents: p.consents ?? {},
            });
          });
        });
      });
    },

    listSubmissions(ctx: ActorContext, patientRef: string, query: unknown) {
      const op = 'intake.submissions.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(patientRef);
          const exists = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [patientRef]);
          if (exists.rowCount === 0) throw notFound();
          const { rows } = await tx.query<{
            id: string;
            form_ref: string;
            version: number;
            submitted_via: string;
            via_relationship_id: string | null;
            submitted_at: Date;
            consent_refs: string[];
            reviews: { kind: string; state: string }[];
          }>(
            `SELECT s.id, f.form_ref, f.version, s.submitted_via, s.via_relationship_id, s.submitted_at,
               ARRAY(SELECT c.consent_id::text FROM cuspatlas.intake_submission_consents c WHERE c.submission_id = s.id
                 ORDER BY c.consent_key) AS consent_refs,
               coalesce((SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'state', r.state) ORDER BY r.kind)
                 FROM cuspatlas.intake_review_items r WHERE r.submission_id = s.id), '[]'::jsonb) AS reviews
             FROM cuspatlas.intake_submissions s
             JOIN cuspatlas.intake_form_versions f ON f.id = s.form_version_id AND f.tenant_id = s.tenant_id
             WHERE s.patient_id = $1 ORDER BY s.submitted_at, s.id LIMIT 200`,
            [patientRef],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'patient',
            resourceRefs: [patientRef],
            queryFields: [],
          });
          return rows.map((r) => ({
            submissionRef: r.id,
            formRef: r.form_ref,
            formVersion: r.version,
            submittedVia: r.submitted_via,
            viaRelationshipRef: r.via_relationship_id,
            submittedAt: r.submitted_at.toISOString(),
            consentRefs: r.consent_refs,
            reviews: r.reviews,
          }));
        });
      });
    },

    readSubmission(ctx: ActorContext, submissionRef: string) {
      const op = 'intake.submissions.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(submissionRef);
          const { rows } = await tx.query<{
            id: string;
            patient_id: string;
            form_ref: string;
            version: number;
            definition: FormDefinition;
            submitted_via: string;
            submitted_by: string;
            via_relationship_id: string | null;
            answers: Record<string, unknown>;
            submitted_at: Date;
          }>(
            `SELECT s.id, s.patient_id, f.form_ref, f.version, f.definition, s.submitted_via, s.submitted_by,
               s.via_relationship_id, s.answers, s.submitted_at
             FROM cuspatlas.intake_submissions s
             JOIN cuspatlas.intake_form_versions f ON f.id = s.form_version_id AND f.tenant_id = s.tenant_id
             WHERE s.id = $1`,
            [submissionRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: INTAKE_SUBMISSION_RESOURCE,
            resourceRefs: [r.id, r.patient_id],
            queryFields: [],
          });
          return {
            submissionRef: r.id,
            patientRef: r.patient_id,
            formRef: r.form_ref,
            formVersion: r.version,
            submittedVia: r.submitted_via,
            submittedByRef: r.submitted_by,
            viaRelationshipRef: r.via_relationship_id,
            // Answers as given, against the field definitions of the version they answered.
            answers: r.definition.fields
              .filter((f) => Object.hasOwn(r.answers, f.key))
              .map((f) => ({
                key: f.key,
                label: f.label,
                kind: f.kind,
                target: f.target ?? null,
                value: r.answers[f.key],
              })),
            submittedAt: r.submitted_at.toISOString(),
          };
        });
      });
    },

    /** Open intake review items as exception-first work items (front desk; C8 hand-offs blocked). */
    reviewWorklist(ctx: ActorContext, query: unknown) {
      const op = 'intake.reviews.worklist';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            kind: 'demographics_update' | 'medical_history_handoff';
            submission_id: string;
            patient_id: string;
            created_at: Date;
          }>(
            `SELECT id, kind, submission_id, patient_id, created_at FROM cuspatlas.intake_review_items
             WHERE state = 'open' ORDER BY created_at, id LIMIT 500`,
          );
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          return workList(
            now,
            AVAILABLE,
            rows.map((r) =>
              workItem({
                workItemRef: r.id,
                kind: 'intake_review',
                reasonCode: r.kind,
                explanation: reviewExplanation[r.kind],
                evidenceRefs: [
                  { kind: 'intakeSubmission', ref: r.submission_id },
                  { kind: 'patient', ref: r.patient_id },
                ],
                dueAt: null,
                suggestedNextAction:
                  r.kind === 'demographics_update' ? 'review_and_apply_or_reject' : 'hold_for_c8',
                blockingDependencies: r.kind === 'medical_history_handoff' ? ['C8'] : [],
              }),
            ),
          );
        });
      });
    },

    /** One review item with the live diff (current S4 value against the proposed one). */
    readReview(ctx: ActorContext, reviewRef: string) {
      const op = 'intake.reviews.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(reviewRef);
          const { rows } = await tx.query<{
            id: string;
            kind: string;
            submission_id: string;
            patient_id: string;
            proposed: { groups?: Record<string, unknown>; provenance?: string };
            payload_ref: string;
            state: string;
            resolution_reason: string | null;
            applied_patient_version: number | null;
            version: number;
            current: Record<string, unknown>;
            patient_version: number;
          }>(
            `SELECT r.id, r.kind, r.submission_id, r.patient_id, r.proposed, r.payload_ref, r.state, r.resolution_reason,
               r.applied_patient_version, r.version,
               jsonb_build_object('preferredName', p.preferred_name, 'pronouns', p.pronouns, 'language', p.language) AS current,
               p.version AS patient_version
             FROM cuspatlas.intake_review_items r JOIN cuspatlas.patients p ON p.id = r.patient_id AND p.tenant_id = r.tenant_id
             WHERE r.id = $1`,
            [reviewRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'intakeReview',
            resourceRefs: [r.id, r.patient_id],
            queryFields: [],
          });
          const groups = r.proposed.groups ?? {};
          return {
            reviewRef: r.id,
            kind: r.kind,
            submissionRef: r.submission_id,
            patientRef: r.patient_id,
            payloadRef: r.payload_ref,
            state: r.state,
            resolutionReason: r.resolution_reason,
            appliedPatientVersion: r.applied_patient_version,
            version: r.version,
            patientVersion: r.patient_version,
            diff: Object.keys(groups).map((g) => ({
              group: g,
              current: r.current[g] ?? null,
              proposed: groups[g],
              unchanged: JSON.stringify(r.current[g]) === JSON.stringify(groups[g]),
            })),
            blockedOn: r.kind === 'medical_history_handoff' ? 'C8' : null,
          };
        });
      });
    },

    /**
     * Resolves a review item. apply (demographics only) calls S4's own update command with the patient
     * version the reviewer saw (a changed record is stale, never overwritten) and a key derived from the
     * item and that version (a retry replays S4's result); then the item records the applied version.
     */
    resolveReview(ctx: ActorContext, reviewRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'intake.reviews.resolve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateIntakeReviewResolve, envelope.payload, ENGAGEMENT_PROPERTIES);
        assertRef(reviewRef);
        const p = envelope.payload as {
          decision: 'apply' | 'reject';
          expectedVersion: number;
          patientVersion?: number;
          reasonCode?: string;
        };
        const item = await deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            kind: string;
            patient_id: string;
            proposed: { groups?: Record<string, unknown>; provenance?: string };
            state: string;
            version: number;
          }>(
            'SELECT kind, patient_id, proposed, state, version FROM cuspatlas.intake_review_items WHERE id = $1',
            [reviewRef],
          );
          return rows[0] ?? null;
        });
        if (!item) throw notFound();
        let appliedVersion: number | null = null;
        if (p.decision === 'apply') {
          if (item.kind !== 'demographics_update') throw conflict('c8_not_deployed');
          if (p.patientVersion === undefined) throw failedAt('/patientVersion', 'required');
          if (item.state === 'open' && item.version === p.expectedVersion) {
            if (!deps.patients) {
              throw new RefusalError({
                code: 'service_unavailable',
                retryable: true,
                detail: { reason: 'patient_service_unavailable' },
              });
            }
            const groups = item.proposed.groups ?? {};
            const provenance = item.proposed.provenance ?? 'patient_reported';
            const res = await deps.patients.updatePatientDemographics(ctx, item.patient_id, {
              operation: 'patients.updateDemographics',
              idempotencyKey: `intake-apply-${reviewRef}-v${p.patientVersion}`,
              payload: {
                expectedVersion: p.patientVersion,
                ...groups,
                provenance: Object.fromEntries(Object.keys(groups).map((g) => [g, provenance])),
              },
            });
            appliedVersion = res.version;
          }
        }
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute(ctx, { ...envelope, payload: { reviewRef, ...p } }, tx, async () => {
            const { rows } = await tx.query<{ state: string; version: number }>(
              'SELECT state, version FROM cuspatlas.intake_review_items WHERE id = $1 FOR UPDATE',
              [reviewRef],
            );
            const r = rows[0];
            if (!r) throw notFound();
            if (r.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: r.version } });
            if (r.state !== 'open') throw conflict('review_already_resolved');
            const state = p.decision === 'apply' ? 'applied' : 'rejected';
            await tx.query(
              `UPDATE cuspatlas.intake_review_items SET state = $2, resolution_reason = $3, applied_patient_version = $4,
                 resolved_by = cuspatlas.current_actor_id(), resolved_at = now(), version = version + 1 WHERE id = $1`,
              [
                reviewRef,
                state,
                p.reasonCode ?? (p.decision === 'apply' ? 'applied_by_staff' : 'rejected_by_staff'),
                appliedVersion,
              ],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'intakeReview',
                resourceRef: reviewRef,
                resourceVersion: r.version + 1,
              },
              { changedFields: ['state'] },
            );
            return {
              data: { reviewRef, state, appliedPatientVersion: appliedVersion },
              version: r.version + 1,
            };
          }),
        );
      });
    },
  };
}

/** The E2 `forms` view producer: the patient's submissions (no answers) with their review status. */
export async function formsView(tx: TenantTransaction, patientRef: string) {
  const { rows } = await tx.query<{
    id: string;
    form_ref: string;
    version: number;
    submitted_at: Date;
    open: boolean;
  }>(
    `SELECT s.id, f.form_ref, f.version, s.submitted_at,
       EXISTS (SELECT 1 FROM cuspatlas.intake_review_items r WHERE r.submission_id = s.id AND r.state = 'open') AS open
     FROM cuspatlas.intake_submissions s
     JOIN cuspatlas.intake_form_versions f ON f.id = s.form_version_id AND f.tenant_id = s.tenant_id
     WHERE s.patient_id = $1 ORDER BY s.submitted_at DESC, s.id LIMIT 50`,
    [patientRef],
  );
  return {
    submissions: rows.map((r) => ({
      submissionRef: r.id,
      formRef: r.form_ref,
      formVersion: r.version,
      submittedAt: r.submitted_at.toISOString(),
      status: r.open ? 'under_review' : 'received',
    })),
  };
}
