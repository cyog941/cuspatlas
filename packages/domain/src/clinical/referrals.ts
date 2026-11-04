import { createHash } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalAuthor,
  type CommandEnvelope,
  type CommandResult,
  type Referral,
  type ReferralClose,
  type ReferralCreate,
  type ReferralEventKind,
  type ReferralPackage,
  type ReferralRecall,
  type ReferralRecordKind,
  type ReferralResponse,
  type ReferralSend,
  type ReferralShareCreate,
  type ReferralState,
  type ReferralTransmissionFailure,
  type ReferralWorklistQuery,
  RefusalError,
  type TenantTransaction,
  validateReferralClose,
  validateReferralCreate,
  validateReferralPackage,
  validateReferralRecall,
  validateReferralResponse,
  validateReferralSend,
  validateReferralShareCreate,
  validateReferralTransmissionFailure,
  validateReferralWorklistQuery,
  type WorkItem,
  type WorkItemListData,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { AVAILABLE, workItem, workList } from '../work-items';
import { resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { assertNotMerged, loadClinicalPatient } from './encounters';

export const REFERRAL_RESOURCE = 'clinicalReferral';
export const REFERRAL_EXPORT_FORMAT = 'cuspatlas-referral-export/1';
const MAX_REFERRALS = 200;
const MAX_SHARE_DAYS = 365;

/** How each selectable kind is tied to its current patient (references only; nothing is copied). */
const OWNER_SQL: Readonly<Record<ReferralRecordKind, string>> = {
  renderedProcedure: `SELECT e.subject_patient_id AS patient FROM cuspatlas.clinical_rendered_procedures x
    JOIN cuspatlas.clinical_encounters e ON e.id = x.encounter_id AND e.tenant_id = x.tenant_id
    WHERE x.id = $1 AND x.kind = 'rendered'`,
  chartEntry: `SELECT c.subject_patient_id AS patient FROM cuspatlas.clinical_chart_entries x
    JOIN cuspatlas.clinical_charts c ON c.id = x.chart_id AND c.tenant_id = x.tenant_id WHERE x.id = $1`,
  note: `SELECT e.subject_patient_id AS patient FROM cuspatlas.clinical_notes x
    JOIN cuspatlas.clinical_encounters e ON e.id = x.encounter_id AND e.tenant_id = x.tenant_id WHERE x.id = $1`,
  historyVersion: `SELECT s.subject_patient_id AS patient FROM cuspatlas.clinical_history_versions x
    JOIN cuspatlas.clinical_history_streams s ON s.id = x.stream_id AND s.tenant_id = x.tenant_id WHERE x.id = $1`,
  perioExam: `SELECT s.subject_patient_id AS patient FROM cuspatlas.clinical_perio_exams x
    JOIN cuspatlas.clinical_perio_streams s ON s.id = x.stream_id AND s.tenant_id = x.tenant_id WHERE x.id = $1`,
  planVersion: `SELECT p.subject_patient_id AS patient FROM cuspatlas.clinical_plan_versions x
    JOIN cuspatlas.clinical_treatment_plans p ON p.id = x.plan_id AND p.tenant_id = x.tenant_id WHERE x.id = $1`,
  imageLink: `SELECT e.subject_patient_id AS patient FROM cuspatlas.clinical_encounter_image_links x
    JOIN cuspatlas.clinical_encounters e ON e.id = x.encounter_id AND e.tenant_id = x.tenant_id WHERE x.id = $1`,
  labCase: `SELECT x.subject_patient_id AS patient FROM cuspatlas.clinical_lab_cases x WHERE x.id = $1`,
};

interface ReferralRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  origin_patient_id: string;
  direction: 'outgoing' | 'incoming';
  counterparty_ref: string;
  reason_code: string;
  requested_scope: string;
  consent_id: string | null;
  response_due_date: string | null;
  possible_duplicate_of_id: string | null;
  state: ReferralState;
  created_by: string;
  created_at: Date;
  version: number;
}
const SELECT = `SELECT id, subject_patient_id, origin_patient_id, direction, counterparty_ref, reason_code, requested_scope,
    consent_id, to_char(response_due_date, 'YYYY-MM-DD') AS response_due_date, possible_duplicate_of_id, state,
    created_by, created_at, version
  FROM cuspatlas.clinical_referrals`;
const OPEN = new Set<ReferralState>(['prepared', 'received', 'sent', 'responded']);
const today = (asOf: number) => new Date(asOf).toISOString().slice(0, 10);
/** Derived: a response is owed (sent, or received from another practice) and its due date passed. */
const responseOverdue = (r: ReferralRow, asOf: number) =>
  (r.state === 'sent' || r.state === 'received') &&
  r.response_due_date !== null &&
  r.response_due_date < today(asOf);
const workRef = (kind: string, id: string) => {
  const h = createHash('sha256').update(`${kind}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function loadReferral(tx: TenantTransaction, ref: string, lock = ''): Promise<ReferralRow | null> {
  if (!UUID.test(ref)) return null;
  const { rows } = await tx.query<ReferralRow>(`${SELECT} WHERE id = $1 ${lock}`, [ref]);
  return rows[0] ?? null;
}

async function view(tx: TenantTransaction, r: ReferralRow, asOf = Date.now()): Promise<Referral> {
  const { rows: selections } = await tx.query<{ record_kind: ReferralRecordKind; record_ref: string }>(
    `SELECT record_kind, record_ref FROM cuspatlas.clinical_referral_selections WHERE referral_id = $1
     ORDER BY record_kind, record_ref`,
    [r.id],
  );
  const { rows: shares } = await tx.query<{
    id: string;
    purpose_code: string;
    scope: ReferralRecordKind[];
    expires_at: Date;
    recorded_by: string;
    recorded_at: Date;
  }>(
    `SELECT id, purpose_code, scope, expires_at, recorded_by, recorded_at FROM cuspatlas.clinical_referral_shares
     WHERE referral_id = $1 ORDER BY recorded_at, id`,
    [r.id],
  );
  const { rows: responses } = await tx.query<{
    source_ref: string;
    received_date: string;
    document_refs: string[];
    attribution: 'external_source' | 'this_practice';
    recorded_by: string;
    recorded_at: Date;
  }>(
    `SELECT source_ref, to_char(received_date, 'YYYY-MM-DD') AS received_date, document_refs, attribution, recorded_by,
       recorded_at FROM cuspatlas.clinical_referral_responses WHERE referral_id = $1 ORDER BY recorded_at, id`,
    [r.id],
  );
  const { rows: events } = await tx.query<{
    sequence: number;
    kind: ReferralEventKind;
    from_state: ReferralState | null;
    to_state: ReferralState;
    reason_code: string | null;
    error_code: string | null;
    channel: 'print' | 'export' | null;
    actor_id: string;
    at: Date;
  }>(
    `SELECT sequence, kind, from_state, to_state, reason_code, error_code, channel, actor_id, at
     FROM cuspatlas.clinical_referral_events WHERE referral_id = $1 ORDER BY sequence`,
    [r.id],
  );
  return {
    referralRef: r.id,
    patientRef: r.subject_patient_id,
    sourcePatientRef: r.origin_patient_id,
    direction: r.direction,
    counterpartyRef: r.counterparty_ref,
    reasonCode: r.reason_code,
    requestedScope: r.requested_scope,
    consentRef: r.consent_id,
    responseDueDate: r.response_due_date,
    possibleDuplicateOf: r.possible_duplicate_of_id,
    state: r.state,
    responseOverdue: responseOverdue(r, asOf),
    selections: selections.map((s) => ({ kind: s.record_kind, ref: s.record_ref })),
    shares: shares.map((s) => ({
      shareRef: s.id,
      purposeCode: s.purpose_code,
      scope: s.scope,
      expiresAt: s.expires_at.toISOString(),
      recordedBy: s.recorded_by,
      recordedAt: s.recorded_at.toISOString(),
    })),
    responses: responses.map((x) => ({
      sourceRef: x.source_ref,
      receivedDate: x.received_date,
      documentRefs: x.document_refs,
      attribution: x.attribution,
      recordedBy: x.recorded_by,
      recordedAt: x.recorded_at.toISOString(),
    })),
    events: events.map((e) => ({
      sequence: e.sequence,
      kind: e.kind,
      fromState: e.from_state,
      toState: e.to_state,
      reasonCode: e.reason_code,
      errorCode: e.error_code,
      channel: e.channel,
      actorRef: e.actor_id,
      at: e.at.toISOString(),
    })),
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    version: r.version,
  };
}

type Ack = { readonly ref: string };

/** C17 commands and reads. Nothing is transmitted electronically (C-D10); disclosure needs a share record. */
export function createReferralOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  const located = async (tx: TenantTransaction, ref: string, lock = '') => {
    const r = await loadReferral(tx, ref, lock);
    if (!r) throw notFound();
    return r;
  };
  const answer = async (tx: TenantTransaction, ref: string) => view(tx, await located(tx, ref));
  const audit = (tx: TenantTransaction, op: string, ref: string, version: number, fields: string[]) =>
    recordCommand(
      tx,
      { operation: op, resourceType: REFERRAL_RESOURCE, resourceRef: ref, resourceVersion: version },
      { changedFields: fields },
    );
  const event = async (
    tx: TenantTransaction,
    r: { id: string; state: ReferralState | null },
    e: {
      kind: ReferralEventKind;
      to: ReferralState;
      reason?: string | null;
      error?: string | null;
      channel?: string | null;
    },
    who: ClinicalAuthor,
  ) => {
    const { rows } = await tx.query<{ n: number }>(
      'SELECT coalesce(max(sequence), 0)::int AS n FROM cuspatlas.clinical_referral_events WHERE referral_id = $1',
      [r.id],
    );
    await tx.query(
      `INSERT INTO cuspatlas.clinical_referral_events (tenant_id, referral_id, sequence, kind, from_state, to_state,
         reason_code, error_code, channel, actor_id, actor_role, actor_credential_ref)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, cuspatlas.current_actor_id(), $9, $10)`,
      [
        r.id,
        (rows[0]?.n ?? 0) + 1,
        e.kind,
        r.state,
        e.to,
        e.reason ?? null,
        e.error ?? null,
        e.channel ?? null,
        who.role,
        who.credentialRef,
      ],
    );
  };
  /** Every successful step bumps the referral version (the state moves only with its event). */
  const step = async (tx: TenantTransaction, r: ReferralRow, to: ReferralState) => {
    await tx.query(
      'UPDATE cuspatlas.clinical_referrals SET state = $2, version = version + 1, updated_at = now() WHERE id = $1',
      [r.id, to],
    );
    return r.version + 1;
  };
  const checkVersion = (r: ReferralRow, expected: number) => {
    if (r.version !== expected)
      throw new RefusalError({ code: 'stale_version', detail: { currentVersion: r.version } });
  };
  const notAllowed = (r: ReferralRow) =>
    conflict('referral_step_not_allowed', { blockingRefs: [{ kind: 'referral', ref: r.id }] });
  /** The configured disclosure consent of the patient, standing (not withdrawn), or the typed refusal. */
  const disclosureConsent = async (
    tx: TenantTransaction,
    patientId: string,
    consentRef: string | undefined | null,
  ) => {
    const { rows: policy } = await tx.query<{ template: string }>(
      'SELECT disclosure_consent_template_ref AS template FROM cuspatlas.clinical_referral_policies',
    );
    if (!policy[0]) throw conflict('referral_policy_unconfigured');
    if (!consentRef || !UUID.test(consentRef)) throw conflict('disclosure_consent_required');
    const { rows } = await tx.query(
      `SELECT 1 FROM cuspatlas.clinical_consents c WHERE c.id = $1 AND c.subject_patient_id = $2 AND c.template_ref = $3
         AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_consent_withdrawals w WHERE w.consent_id = c.id
                         AND w.tenant_id = c.tenant_id)`,
      [consentRef, patientId, policy[0].template],
    );
    if (rows.length === 0) throw conflict('disclosure_consent_required');
    return consentRef;
  };
  /** The latest share covers every selected kind and is live, or the typed refusal (C-D10). */
  const coveringShare = async (tx: TenantTransaction, r: ReferralRow) => {
    const { rows: sel } = await tx.query<{ kind: ReferralRecordKind }>(
      'SELECT DISTINCT record_kind AS kind FROM cuspatlas.clinical_referral_selections WHERE referral_id = $1',
      [r.id],
    );
    if (sel.length === 0) throw conflict('package_required');
    const { rows } = await tx.query<{ id: string; scope: ReferralRecordKind[]; live: boolean }>(
      `SELECT id, scope, expires_at > now() AS live FROM cuspatlas.clinical_referral_shares WHERE referral_id = $1
       ORDER BY recorded_at DESC, id DESC LIMIT 1`,
      [r.id],
    );
    const share = rows[0];
    if (!share) throw conflict('share_record_required');
    if (!share.live)
      throw conflict('share_expired', { blockingRefs: [{ kind: 'referralShare', ref: share.id }] });
    if (sel.some((s) => !share.scope.includes(s.kind)))
      throw conflict('share_scope_exceeded', { blockingRefs: [{ kind: 'referralShare', ref: share.id }] });
    return share.id;
  };
  function command<P>(
    ctx: ActorContext,
    op: Parameters<ClinicalBase['authorize']>[1],
    referralRef: string,
    envelope: CommandEnvelope<unknown>,
    validate: Parameters<typeof assertValid>[0],
    work: (tx: TenantTransaction, r: ReferralRow, p: P, who: ClinicalAuthor) => Promise<number>,
  ): Promise<CommandResult<Referral>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload as P;
      assertValid<P>(validate, p, CLINICAL_PROPERTIES);
      return deps.withTenantTransaction(ctx, async (tx) => {
        const found = await located(tx, referralRef);
        await loadClinicalPatient(tx, found.subject_patient_id);
        const who = await resolveClinicalAuthor(tx);
        const r = await execute<Ack>(
          ctx,
          { ...envelope, payload: { referralRef, ...(p as object) } },
          tx,
          async () => {
            const current = await located(tx, referralRef, 'FOR UPDATE');
            const version = await work(tx, current, p, who);
            return { data: { ref: current.id }, version };
          },
        );
        return { ...r, data: await answer(tx, r.data.ref) };
      });
    });
  }

  return {
    createReferral(ctx: ActorContext, envelope: CommandEnvelope<unknown>): Promise<CommandResult<Referral>> {
      const op = 'clinical.referrals.create';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ReferralCreate>(validateReferralCreate, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            let consentId: string | null = null;
            if (p.direction === 'outgoing') consentId = await disclosureConsent(tx, patient.id, p.consentRef);
            else if (p.consentRef !== undefined) throw failedAt('/consentRef', 'notForIncoming');
            const { rows: dup } = await tx.query<{ id: string }>(
              `SELECT id FROM cuspatlas.clinical_referrals WHERE subject_patient_id = $1 AND direction = $2
                 AND counterparty_ref = $3 AND reason_code = $4 AND state IN ('prepared', 'received', 'sent', 'responded')
               ORDER BY created_at, id LIMIT 1`,
              [patient.id, p.direction, p.counterpartyRef, p.reasonCode],
            );
            // A possible duplicate is flagged for confirmation, never silently created.
            if (dup[0] && p.confirmDuplicate !== true) {
              throw conflict('referral_possible_duplicate', {
                blockingRefs: [{ kind: 'referral', ref: dup[0].id }],
              });
            }
            const { rows: n } = await tx.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM cuspatlas.clinical_referrals WHERE subject_patient_id = $1',
              [patient.id],
            );
            if ((n[0]?.n ?? 0) >= MAX_REFERRALS) throw failedAt('/', 'tooManyReferrals');
            const state: ReferralState = p.direction === 'outgoing' ? 'prepared' : 'received';
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_referrals (tenant_id, subject_patient_id, origin_patient_id, direction,
                 counterparty_ref, reason_code, requested_scope, consent_id, response_due_date, possible_duplicate_of_id,
                 state, created_by, created_by_role, created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $1, $2, $3, $4, $5, $6, $7, $8, $9, cuspatlas.current_actor_id(),
                 $10, $11) RETURNING id`,
              [
                patient.id,
                p.direction,
                p.counterpartyRef,
                p.reasonCode,
                p.requestedScope,
                consentId,
                p.responseDueDate ?? null,
                dup[0]?.id ?? null,
                state,
                who.role,
                who.credentialRef,
              ],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await event(tx, { id, state: null }, { kind: 'created', to: state }, who);
            await audit(tx, op, id, 1, ['patientRef', 'direction', 'counterpartyRef', 'reasonCode', 'scope']);
            return { data: { ref: id }, version: 1 };
          });
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    /** The explicit selection, all or nothing: every reference must be a record of this patient. */
    prepareReferralPackage(ctx: ActorContext, referralRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.referrals.preparePackage';
      return command<ReferralPackage>(
        ctx,
        op,
        referralRef,
        envelope,
        validateReferralPackage,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          if (r.direction !== 'outgoing' || r.state !== 'prepared') throw notAllowed(r);
          const { rows: had } = await tx.query(
            'SELECT 1 FROM cuspatlas.clinical_referral_selections WHERE referral_id = $1',
            [r.id],
          );
          if (had.length > 0)
            throw conflict('package_already_prepared', { blockingRefs: [{ kind: 'referral', ref: r.id }] });
          for (const [n, s] of p.selections.entries()) {
            const { rows } = await tx.query<{ patient: string }>(OWNER_SQL[s.kind], [s.ref]);
            if (rows[0]?.patient !== r.subject_patient_id)
              throw failedAt(`/selections/${n}/ref`, 'selectionNotOfPatient');
          }
          for (const s of p.selections) {
            await tx.query(
              `INSERT INTO cuspatlas.clinical_referral_selections (tenant_id, referral_id, record_kind, record_ref, selected_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id()) ON CONFLICT DO NOTHING`,
              [r.id, s.kind, s.ref],
            );
          }
          await event(tx, r, { kind: 'package_prepared', to: 'prepared' }, who);
          const v = await step(tx, r, 'prepared');
          await audit(tx, op, r.id, v, ['selections']);
          return v;
        },
      );
    },

    recordReferralShare(ctx: ActorContext, referralRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.referrals.recordShare';
      return command<ReferralShareCreate>(
        ctx,
        op,
        referralRef,
        envelope,
        validateReferralShareCreate,
        async (tx, r, p, who) => {
          if (r.direction !== 'outgoing' || (r.state !== 'prepared' && r.state !== 'sent'))
            throw notAllowed(r);
          const expires = Date.parse(p.expiresAt);
          if (expires <= Date.now()) throw failedAt('/expiresAt', 'expiresInPast');
          if (expires > Date.now() + MAX_SHARE_DAYS * 86_400_000)
            throw failedAt('/expiresAt', 'expiresTooLate');
          await tx.query(
            `INSERT INTO cuspatlas.clinical_referral_shares (tenant_id, referral_id, purpose_code, scope, expires_at, recorded_by)
           VALUES (cuspatlas.current_tenant_id(), $1, $2, $3::text[], $4, cuspatlas.current_actor_id())`,
            [r.id, p.purposeCode, [...p.scope].sort(), p.expiresAt],
          );
          await event(tx, r, { kind: 'share_recorded', to: r.state, reason: p.purposeCode }, who);
          const v = await step(tx, r, r.state);
          await audit(tx, op, r.id, v, ['share']);
          return v;
        },
      );
    },

    /** Print or export handed over (the only channels). Needs a package, a covering live share and consent. */
    markReferralSent(ctx: ActorContext, referralRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.referrals.markSent';
      return command<ReferralSend>(
        ctx,
        op,
        referralRef,
        envelope,
        validateReferralSend,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          if (r.direction !== 'outgoing' || r.state !== 'prepared') throw notAllowed(r);
          await coveringShare(tx, r);
          await disclosureConsent(tx, r.subject_patient_id, r.consent_id);
          await event(tx, r, { kind: 'sent', to: 'sent', channel: p.channel }, who);
          const v = await step(tx, r, 'sent');
          await audit(tx, op, r.id, v, ['state', 'channel']);
          return v;
        },
      );
    },

    /** A failed hand-over is recorded; the referral stays prepared (no false sent state). */
    recordReferralTransmissionFailure(
      ctx: ActorContext,
      referralRef: string,
      envelope: CommandEnvelope<unknown>,
    ) {
      const op = 'clinical.referrals.recordTransmissionFailure';
      return command<ReferralTransmissionFailure>(
        ctx,
        op,
        referralRef,
        envelope,
        validateReferralTransmissionFailure,
        async (tx, r, p, who) => {
          if (r.direction !== 'outgoing' || r.state !== 'prepared') throw notAllowed(r);
          await event(tx, r, { kind: 'transmission_failed', to: 'prepared', error: p.errorCode }, who);
          const v = await step(tx, r, 'prepared');
          await audit(tx, op, r.id, v, ['transmissionError']);
          return v;
        },
      );
    },

    /** A response with its source; an outgoing referral's response is the other practice's record. */
    recordReferralResponse(ctx: ActorContext, referralRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.referrals.recordResponse';
      return command<ReferralResponse>(
        ctx,
        op,
        referralRef,
        envelope,
        validateReferralResponse,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          if (r.state !== 'sent' && r.state !== 'received') throw notAllowed(r);
          await tx.query(
            `INSERT INTO cuspatlas.clinical_referral_responses (tenant_id, referral_id, source_ref, received_date,
             document_refs, attribution, recorded_by)
           VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::text[], $5, cuspatlas.current_actor_id())`,
            [
              r.id,
              p.sourceRef,
              p.receivedDate,
              p.documentRefs ?? [],
              r.direction === 'outgoing' ? 'external_source' : 'this_practice',
            ],
          );
          await event(tx, r, { kind: 'response_recorded', to: 'responded' }, who);
          const v = await step(tx, r, 'responded');
          await audit(tx, op, r.id, v, ['state', 'response']);
          return v;
        },
      );
    },

    /** Close an open referral (an unsent outgoing or an untouched incoming one is cancelled). */
    closeReferral(ctx: ActorContext, referralRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.referrals.close';
      return command<ReferralClose>(
        ctx,
        op,
        referralRef,
        envelope,
        validateReferralClose,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          if (!OPEN.has(r.state)) throw notAllowed(r);
          const to: ReferralState = r.state === 'prepared' ? 'cancelled' : 'closed';
          await event(
            tx,
            r,
            { kind: to === 'cancelled' ? 'cancelled' : 'closed', to, reason: p.reasonCode },
            who,
          );
          const v = await step(tx, r, to);
          await audit(tx, op, r.id, v, ['state']);
          return v;
        },
      );
    },

    /** A sent referral recalled is a correction with a reason; the sent event stays. */
    recallReferral(ctx: ActorContext, referralRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.referrals.recall';
      return command<ReferralRecall>(
        ctx,
        op,
        referralRef,
        envelope,
        validateReferralRecall,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          if (r.state !== 'sent') throw notAllowed(r);
          await event(tx, r, { kind: 'recalled', to: 'cancelled', reason: p.reasonCode }, who);
          const v = await step(tx, r, 'cancelled');
          await audit(tx, op, r.id, v, ['state']);
          return v;
        },
      );
    },

    readReferral(ctx: ActorContext, referralRef: string): Promise<Referral> {
      const op = 'clinical.referrals.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await located(tx, referralRef);
          const out = await view(tx, r);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: REFERRAL_RESOURCE,
            resourceRefs: [r.id],
            queryFields: [],
          });
          return out;
        });
      });
    },

    listReferrals(ctx: ActorContext, patientRef: string): Promise<Referral[]> {
      const op = 'clinical.referrals.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, patientRef, '');
          const { rows } = await tx.query<ReferralRow>(
            `${SELECT} WHERE subject_patient_id = $1 ORDER BY created_at, id LIMIT ${MAX_REFERRALS}`,
            [patient.id],
          );
          const out: Referral[] = [];
          for (const r of rows) out.push(await view(tx, r));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: REFERRAL_RESOURCE,
            resourceRefs: [patient.id, ...rows.map((r) => r.id)].slice(0, 100),
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** The printable package under its live share record: references only (C-D10). A sensitive read. */
    exportReferral(
      ctx: ActorContext,
      referralRef: string,
    ): Promise<{
      format: typeof REFERRAL_EXPORT_FORMAT;
      generatedAt: string;
      shareRef: string;
      referral: Referral;
    }> {
      const op = 'clinical.referrals.export';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await located(tx, referralRef);
          if (r.direction !== 'outgoing') throw notAllowed(r);
          const shareRef = await coveringShare(tx, r);
          const referral = await view(tx, r);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: REFERRAL_RESOURCE,
            resourceRefs: [r.id],
            queryFields: [],
          });
          return {
            format: REFERRAL_EXPORT_FORMAT,
            generatedAt: new Date().toISOString(),
            shareRef,
            referral,
          };
        });
      });
    },

    /** PT-03 referral responses, exception first: owed responses past due, and confirmed possible duplicates. */
    referralWorklist(ctx: ActorContext, query: unknown): Promise<WorkItemListData> {
      const op = 'clinical.referrals.worklist';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        const q = query as ReferralWorklistQuery;
        assertValid<ReferralWorklistQuery>(validateReferralWorklistQuery, q, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const asOf = q.asOf === undefined ? Date.now() : Date.parse(q.asOf);
          const { rows } = await tx.query<ReferralRow>(
            `${SELECT} WHERE state IN ('prepared', 'received', 'sent', 'responded') ORDER BY created_at, id LIMIT 1000`,
          );
          const items: WorkItem[] = [];
          for (const r of rows) {
            const evidence = [{ kind: 'referral', ref: r.id }];
            if (responseOverdue(r, asOf)) {
              items.push(
                workItem({
                  workItemRef: workRef('referral_response_due', r.id),
                  kind: 'referral_response_due',
                  reasonCode: r.direction === 'outgoing' ? 'response_not_received' : 'response_not_sent',
                  explanation:
                    r.direction === 'outgoing'
                      ? 'The referral was sent and no response is recorded by its due date.'
                      : 'A response to this incoming referral is owed and not recorded by its due date.',
                  evidenceRefs: evidence,
                  owner: { queue: 'clinical', principalRef: null },
                  nextActionOwedBy: r.direction === 'outgoing' ? 'vendor' : 'practice',
                  dueAt: `${r.response_due_date}T00:00:00.000Z`,
                  priority: 'soon',
                  priorityRationale: 'response_overdue',
                  suggestedNextAction:
                    r.direction === 'outgoing' ? 'follow_up_with_counterparty' : 'send_response',
                  blockingDependencies: [],
                }),
              );
            }
            if (r.possible_duplicate_of_id !== null) {
              items.push(
                workItem({
                  workItemRef: workRef('referral_review', r.id),
                  kind: 'referral_review',
                  reasonCode: 'possible_duplicate',
                  explanation:
                    'This referral was confirmed despite an open referral to the same counterparty for the same reason.',
                  evidenceRefs: [...evidence, { kind: 'referral', ref: r.possible_duplicate_of_id }],
                  owner: { queue: 'clinical', principalRef: null },
                  dueAt: null,
                  suggestedNextAction: 'review_referral',
                  blockingDependencies: [],
                }),
              );
            }
          }
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: REFERRAL_RESOURCE,
            resourceRefs: items.flatMap((i) => i.evidenceRefs.map((e) => e.ref)).slice(0, 100),
            queryFields: q.asOf === undefined ? [] : ['asOf'],
          });
          return workList(new Date(asOf), AVAILABLE, items);
        });
      });
    },
  };
}
