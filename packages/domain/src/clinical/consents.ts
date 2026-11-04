import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type CommandEnvelope,
  type CommandResult,
  type Consent,
  type ConsentCapture,
  type ConsentEvidence,
  type ConsentListQuery,
  type ConsentSigner,
  type ConsentSignerBasis,
  type ConsentTemplate,
  type ConsentTemplateRegister,
  type ConsentWithdraw,
  RefusalError,
  type TenantTransaction,
  validateConsentCapture,
  validateConsentListQuery,
  validateConsentTemplateRegister,
  validateConsentWithdraw,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { PostMergeFactProbe } from '../patients/merge';
import { loadPatientPolicy, majorityInstant, requireRelationshipScope } from '../policy/patient-access';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { assertNotMerged, loadClinicalPatient } from './encounters';
import { registerConsentBindingReader } from './estimates';

export const CONSENT_RESOURCE = 'clinicalConsent';
export const CONSENT_TEMPLATE_RESOURCE = 'clinicalConsentTemplate';
const MAX_CONSENTS = 500;

interface ConsentRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  origin_patient_id: string;
  scope: Consent['scope'];
  plan_version_id: string | null;
  plan_item_id: string | null;
  acceptance_id: string | null;
  method: Consent['method'];
  template_ref: string;
  template_digest: string;
  template_registered: boolean;
  attestation_code: string;
  evidence_ref: string | null;
  evidence_digest: string | null;
  signer_kind: 'patient' | 'related_person';
  signer_patient_id: string;
  signer_basis: ConsentSignerBasis;
  signer_relationship_ids: string[];
  access_policy_version: string | null;
  authority_evaluated_at: Date;
  witness_ref: string | null;
  recorded_by: string;
  effective_at: Date;
  version: number;
  w_reason_code: string | null;
  w_signer_kind: 'patient' | 'related_person' | null;
  w_signer_patient_id: string | null;
  w_signer_basis: ConsentSignerBasis | null;
  w_signer_relationship_ids: string[] | null;
  w_evidence_ref: string | null;
  w_evidence_digest: string | null;
  w_recorded_by: string | null;
  w_effective_at: Date | null;
}

const CONSENT_SELECT = `SELECT c.id, c.subject_patient_id, c.origin_patient_id, c.scope, c.plan_version_id, c.plan_item_id,
    c.acceptance_id, c.method, c.template_ref, c.template_digest,
    EXISTS (SELECT 1 FROM cuspatlas.clinical_consent_templates t WHERE t.tenant_id = c.tenant_id
            AND t.template_ref = c.template_ref AND t.digest = c.template_digest) AS template_registered,
    c.attestation_code, c.evidence_ref, c.evidence_digest, c.signer_kind, c.signer_patient_id, c.signer_basis,
    c.signer_relationship_ids, c.access_policy_version, c.authority_evaluated_at, c.witness_ref, c.recorded_by,
    c.effective_at, c.version, w.reason_code AS w_reason_code, w.signer_kind AS w_signer_kind,
    w.signer_patient_id AS w_signer_patient_id, w.signer_basis AS w_signer_basis,
    w.signer_relationship_ids AS w_signer_relationship_ids, w.evidence_ref AS w_evidence_ref,
    w.evidence_digest AS w_evidence_digest, w.recorded_by AS w_recorded_by, w.effective_at AS w_effective_at
  FROM cuspatlas.clinical_consents c
  LEFT JOIN cuspatlas.clinical_consent_withdrawals w ON w.consent_id = c.id AND w.tenant_id = c.tenant_id`;

const evidenceOf = (ref: string | null, digest: string | null): ConsentEvidence | null =>
  ref === null || digest === null ? null : { artifactRef: ref, digest };

/** The consent as of `asOf` (a withdrawal after that instant is not yet visible). */
function view(r: ConsentRow, asOf: number): Consent {
  const withdrawn = r.w_effective_at !== null && r.w_effective_at.getTime() <= asOf;
  return {
    consentRef: r.id,
    patientRef: r.subject_patient_id,
    sourcePatientRef: r.origin_patient_id,
    scope: r.scope,
    planVersionRef: r.plan_version_id,
    planItemRef: r.plan_item_id,
    acceptanceRef: r.acceptance_id,
    method: r.method,
    templateRef: r.template_ref,
    templateDigest: r.template_digest,
    templateStatus: r.template_registered ? 'registered' : 'unresolved',
    attestationCode: r.attestation_code,
    evidence: evidenceOf(r.evidence_ref, r.evidence_digest),
    signer: {
      kind: r.signer_kind,
      personRef: r.signer_patient_id,
      basis: r.signer_basis,
      relationshipRefs: r.signer_relationship_ids,
      policyVersion: r.access_policy_version,
      evaluatedAt: r.authority_evaluated_at.toISOString(),
    },
    witnessRef: r.witness_ref,
    recordedBy: r.recorded_by,
    effectiveAt: r.effective_at.toISOString(),
    version: r.version,
    state: withdrawn ? 'withdrawn' : 'active',
    withdrawal:
      withdrawn && r.w_effective_at !== null
        ? {
            reasonCode: r.w_reason_code as string,
            signer: {
              kind: r.w_signer_kind as 'patient' | 'related_person',
              personRef: r.w_signer_patient_id as string,
              basis: r.w_signer_basis as ConsentSignerBasis,
              relationshipRefs: r.w_signer_relationship_ids ?? [],
              policyVersion: r.access_policy_version,
              evaluatedAt: r.w_effective_at.toISOString(),
            },
            evidence: evidenceOf(r.w_evidence_ref, r.w_evidence_digest),
            recordedBy: r.w_recorded_by as string,
            effectiveAt: r.w_effective_at.toISOString(),
          }
        : null,
  };
}

interface Authority {
  readonly kind: 'patient' | 'related_person';
  readonly personId: string;
  readonly basis: ConsentSignerBasis;
  readonly relationshipIds: readonly string[];
  readonly policyVersion: string | null;
  readonly evaluatedAt: Date;
}

/**
 * Signer authority, evaluated now and never inherited: the patient themself unless recorded as a
 * minor, or a related person holding an active S5 relationship with the `consent` scope.
 */
async function signerAuthority(
  tx: TenantTransaction,
  patientId: string,
  signer: ConsentSigner,
): Promise<Authority> {
  if (signer.kind === 'related_person') {
    if (!UUID.test(signer.personRef) || signer.personRef === patientId)
      throw failedAt('/signer/personRef', 'invalid');
    const access = await requireRelationshipScope(tx, patientId, signer.personRef, 'consent');
    return {
      kind: 'related_person',
      personId: signer.personRef,
      basis: 'relationship_consent_scope',
      relationshipIds: access.relationships
        .filter((r) => r.status === 'active' && r.scopes.includes('consent'))
        .map((r) => r.relationshipRef)
        .slice(0, 20),
      policyVersion: access.policyVersion,
      evaluatedAt: new Date(access.evaluatedAt),
    };
  }
  const { rows } = await tx.query<{
    birth: string | null;
    precision: 'day' | 'month' | 'year' | 'unknown';
    now: Date;
  }>(
    `SELECT to_char(birth_date, 'YYYY-MM-DD') AS birth, birth_date_precision AS precision, clock_timestamp() AS now
     FROM cuspatlas.patients WHERE id = $1`,
    [patientId],
  );
  const p = rows[0];
  if (!p) throw notFound();
  const policy = await loadPatientPolicy(tx);
  const majority = majorityInstant(p.birth, p.precision, policy.ageOfMajorityYears);
  if (majority !== null && majority.getTime() > p.now.getTime()) {
    throw new RefusalError({
      code: 'forbidden',
      reasonCode: 'consent_signer_minor',
      detail: { reason: 'consent_signer_minor' },
    });
  }
  return {
    kind: 'patient',
    personId: patientId,
    basis: majority === null ? 'self_age_unknown' : 'self_adult',
    relationshipIds: [],
    policyVersion: null,
    evaluatedAt: p.now,
  };
}

function checkEvidence(method: string, evidence: ConsentEvidence | undefined): void {
  if ((method === 'paper' || method === 'portal') && evidence === undefined)
    throw failedAt('/evidence', 'evidenceRequired');
}

// C12 reads the consent binding of an accepted plan version from here (C13 owns consent state).
registerConsentBindingReader(async (tx, planVersionId) => {
  const { rows } = await tx.query<{ id: string; withdrawn: boolean }>(
    `SELECT c.id, EXISTS (SELECT 1 FROM cuspatlas.clinical_consent_withdrawals w WHERE w.consent_id = c.id
                          AND w.tenant_id = c.tenant_id) AS withdrawn
     FROM cuspatlas.clinical_consents c WHERE c.plan_version_id = $1 AND c.scope IN ('treatment_plan', 'procedure')
     ORDER BY c.effective_at, c.id LIMIT 50`,
    [planVersionId],
  );
  if (rows.length === 0) return { status: 'outstanding', consentRefs: [] };
  return {
    status: rows.some((r) => !r.withdrawn) ? 'bound' : 'withdrawn',
    consentRefs: rows.map((r) => r.id),
  };
});

/** S-D2: consents captured, or withdrawals recorded, on the survivor after the merge instant. */
export const CONSENT_POST_MERGE_FACT_PROBE: PostMergeFactProbe = {
  factKind: 'clinical',
  async count(tx, survivorRef, mergedAt) {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM cuspatlas.clinical_consents c WHERE c.subject_patient_id = $1 AND c.effective_at >= $2)
            + (SELECT count(*) FROM cuspatlas.clinical_consent_withdrawals w
                JOIN cuspatlas.clinical_consents c ON c.id = w.consent_id AND c.tenant_id = w.tenant_id
                WHERE c.subject_patient_id = $1 AND w.effective_at >= $2) AS n`,
      [survivorRef, mergedAt],
    );
    return Number(rows[0]?.n ?? 0);
  },
};

type Ack = { readonly ref: string };

/** C13 commands and reads. Treatment consent only; E's messaging consent is never read or written. */
export function createConsentOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  const load = async (tx: TenantTransaction, consentRef: string, lock = '') => {
    if (!UUID.test(consentRef)) throw notFound();
    const { rows } = await tx.query<ConsentRow>(`${CONSENT_SELECT} WHERE c.id = $1 ${lock}`, [consentRef]);
    const row = rows[0];
    if (!row) throw notFound();
    return row;
  };
  const answer = async (tx: TenantTransaction, consentRef: string) =>
    view(await load(tx, consentRef), Date.now());

  return {
    captureConsent(ctx: ActorContext, envelope: CommandEnvelope<unknown>): Promise<CommandResult<Consent>> {
      const op = 'clinical.consents.capture';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ConsentCapture>(validateConsentCapture, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            if (
              p.scope === 'general_treatment' &&
              (p.planVersionRef !== undefined || p.planItemRef !== undefined)
            )
              throw failedAt('/planVersionRef', 'notForScope');
            if (p.scope !== 'general_treatment' && p.planVersionRef === undefined)
              throw failedAt('/planVersionRef', 'required');
            if (p.scope === 'procedure' && p.planItemRef === undefined)
              throw failedAt('/planItemRef', 'required');
            if (p.scope === 'treatment_plan' && p.planItemRef !== undefined)
              throw failedAt('/planItemRef', 'notForScope');
            checkEvidence(p.method, p.evidence);
            let acceptanceId: string | null = null;
            if (p.planVersionRef !== undefined) {
              const { rows: v } = await tx.query<{
                subject_patient_id: string;
                acceptance_ref: string | null;
              }>(
                `SELECT p.subject_patient_id, v.acceptance_ref FROM cuspatlas.clinical_plan_versions v
                 JOIN cuspatlas.clinical_treatment_plans p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id
                 WHERE v.id = $1 FOR SHARE OF v`,
                [p.planVersionRef],
              );
              const version = v[0];
              if (!version) throw notFound();
              if (version.subject_patient_id !== patient.id)
                throw failedAt('/planVersionRef', 'planVersionPatientMismatch');
              const { rows: next } = await tx.query<{ id: string }>(
                'SELECT id FROM cuspatlas.clinical_plan_versions WHERE supersedes_version_id = $1',
                [p.planVersionRef],
              );
              if (next[0]) {
                throw conflict('plan_version_superseded', {
                  blockingRefs: [{ kind: 'planVersion', ref: next[0].id }],
                });
              }
              acceptanceId = version.acceptance_ref;
              if (p.planItemRef !== undefined) {
                const { rows: item } = await tx.query(
                  'SELECT 1 FROM cuspatlas.clinical_plan_items WHERE id = $1 AND plan_version_id = $2',
                  [UUID.test(p.planItemRef) ? p.planItemRef : null, p.planVersionRef],
                );
                if (item.length === 0) throw failedAt('/planItemRef', 'itemNotInVersion');
              }
            }
            const { rows: policy } = await tx.query<{ witness_required: boolean }>(
              'SELECT witness_required FROM cuspatlas.clinical_consent_method_policies WHERE method = $1',
              [p.method],
            );
            if (policy[0]?.witness_required && p.witnessRef === undefined) {
              throw conflict('witness_required');
            }
            const authority = await signerAuthority(tx, patient.id, p.signer);
            const { rows: n } = await tx.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM cuspatlas.clinical_consents WHERE subject_patient_id = $1',
              [patient.id],
            );
            if ((n[0]?.n ?? 0) >= MAX_CONSENTS) throw failedAt('/', 'tooManyConsents');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_consents (tenant_id, subject_patient_id, origin_patient_id, scope,
                 plan_version_id, plan_item_id, acceptance_id, method, template_ref, template_digest, attestation_code,
                 evidence_ref, evidence_digest, signer_kind, signer_patient_id, signer_basis, signer_relationship_ids,
                 access_policy_version, authority_evaluated_at, witness_ref, recorded_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15::uuid[], $16, $17, $18, cuspatlas.current_actor_id()) RETURNING id`,
              [
                patient.id,
                p.scope,
                p.planVersionRef ?? null,
                p.planItemRef ?? null,
                acceptanceId,
                p.method,
                p.templateRef,
                p.templateDigest,
                p.attestationCode,
                p.evidence?.artifactRef ?? null,
                p.evidence?.digest ?? null,
                authority.kind,
                authority.personId,
                authority.basis,
                authority.relationshipIds,
                authority.policyVersion,
                authority.evaluatedAt,
                p.witnessRef ?? null,
              ],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: CONSENT_RESOURCE, resourceRef: id, resourceVersion: 1 },
              {
                changedFields: [
                  'scope',
                  'method',
                  'signer',
                  'templateDigest',
                  ...(p.evidence ? ['evidence'] : []),
                ],
              },
            );
            return { data: { ref: id }, version: 1 };
          });
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    withdrawConsent(
      ctx: ActorContext,
      consentRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Consent>> {
      const op = 'clinical.consents.withdraw';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ConsentWithdraw>(validateConsentWithdraw, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const found = await load(tx, consentRef);
          const patient = await loadClinicalPatient(tx, found.subject_patient_id);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { consentRef, ...p } }, tx, async () => {
            const c = await load(tx, consentRef, 'FOR UPDATE OF c');
            if (c.w_effective_at !== null) {
              throw conflict('consent_withdrawn', { blockingRefs: [{ kind: 'consent', ref: c.id }] });
            }
            if (c.version !== p.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: c.version } });
            }
            const authority = await signerAuthority(tx, patient.id, p.signer);
            await tx.query(
              `INSERT INTO cuspatlas.clinical_consent_withdrawals (tenant_id, consent_id, reason_code, signer_kind,
                 signer_patient_id, signer_basis, signer_relationship_ids, evidence_ref, evidence_digest, recorded_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6::uuid[], $7, $8, cuspatlas.current_actor_id())`,
              [
                c.id,
                p.reasonCode,
                authority.kind,
                authority.personId,
                authority.basis,
                authority.relationshipIds,
                p.evidence?.artifactRef ?? null,
                p.evidence?.digest ?? null,
              ],
            );
            const { rows } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.clinical_consents SET version = version + 1, updated_at = now() WHERE id = $1
               RETURNING version`,
              [c.id],
            );
            const version = rows[0]?.version;
            if (version === undefined) throw new Error('update returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: CONSENT_RESOURCE, resourceRef: c.id, resourceVersion: version },
              { changedFields: ['withdrawal'] },
            );
            return { data: { ref: c.id }, version };
          });
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    readConsent(ctx: ActorContext, consentRef: string): Promise<Consent> {
      const op = 'clinical.consents.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const out = view(await load(tx, consentRef), Date.now());
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: CONSENT_RESOURCE,
            resourceRefs: [out.consentRef],
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** A patient's consents as of an instant (default now), oldest first. A sensitive read. */
    listConsents(
      ctx: ActorContext,
      patientRef: string,
      query: unknown,
    ): Promise<{ readonly data: readonly Consent[]; readonly asOf: string }> {
      const op = 'clinical.consents.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid<ConsentListQuery>(validateConsentListQuery, query, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, patientRef, '');
          assertNotMerged(patient);
          const asOf = query.asOf === undefined ? new Date() : new Date(query.asOf);
          const { rows } = await tx.query<ConsentRow>(
            `${CONSENT_SELECT} WHERE c.subject_patient_id = $1 AND c.effective_at <= $2
               AND ($3::uuid IS NULL OR c.plan_version_id = $3) ORDER BY c.effective_at, c.id LIMIT ${MAX_CONSENTS}`,
            [patient.id, asOf, query.planVersionRef ?? null],
          );
          const data = rows.map((r) => view(r, asOf.getTime()));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: CONSENT_RESOURCE,
            resourceRefs: [patient.id, ...data.map((d) => d.consentRef)].slice(0, 100),
            queryFields: Object.keys(query).sort(),
          });
          return { data, asOf: asOf.toISOString() };
        });
      });
    },

    /** Practice configuration: records that a consent text version (by digest) exists. */
    registerConsentTemplate(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ConsentTemplate>> {
      const op = 'clinical.consentTemplates.register';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ConsentTemplateRegister>(validateConsentTemplateRegister, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            const { rows: existing } = await tx.query<{ id: string }>(
              'SELECT id FROM cuspatlas.clinical_consent_templates WHERE template_ref = $1 AND digest = $2',
              [p.templateRef, p.digest],
            );
            if (existing[0]) {
              throw conflict('template_registered', {
                blockingRefs: [{ kind: 'consentTemplate', ref: existing[0].id }],
              });
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_consent_templates (tenant_id, template_ref, digest, registered_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())
               ON CONFLICT (tenant_id, template_ref, digest) DO NOTHING RETURNING id`,
              [p.templateRef, p.digest],
            );
            const id = rows[0]?.id;
            if (!id) throw conflict('template_registered');
            await recordCommand(
              tx,
              { operation: op, resourceType: CONSENT_TEMPLATE_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['templateRef', 'digest'] },
            );
            return { data: { ref: id }, version: 1 };
          });
          const { rows } = await tx.query<{
            template_ref: string;
            digest: string;
            registered_by: string;
            registered_at: Date;
          }>(
            'SELECT template_ref, digest, registered_by, registered_at FROM cuspatlas.clinical_consent_templates WHERE id = $1',
            [r.data.ref],
          );
          const t = rows[0];
          if (!t) throw notFound();
          return {
            ...r,
            data: {
              templateRef: t.template_ref,
              digest: t.digest,
              registeredBy: t.registered_by,
              registeredAt: t.registered_at.toISOString(),
            },
          };
        });
      });
    },
  };
}
