import {
  type ActiveAlertsData,
  type ActorContext,
  type AlertSection,
  type AlertStatus,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  type HistoryChange,
  type HistoryChangeInput,
  type HistoryChangeRecord,
  type HistoryEntryType,
  type HistoryItem,
  type HistoryKind,
  type HistoryProvenance,
  type HistoryReadData,
  type HistoryReview,
  type HistoryReviewAttest,
  type HistoryState,
  type HistoryVerification,
  type HistoryVerify,
  type HistoryVersionDetail,
  type HistoryVersionHeader,
  RefusalError,
  type ReportedBy,
  type ReviewOutcome,
  type TenantTransaction,
  validateHistoryChangeRecord,
  validateHistoryReadQuery,
  validateHistoryReviewAttest,
  validateHistoryVerify,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { authorOf, resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { assertNotMerged, loadClinicalPatient, loadEncounter, requireOpenEncounter } from './encounters';

export const HISTORY_VERSION_RESOURCE = 'clinicalHistoryVersion';
export const HISTORY_VERIFICATION_RESOURCE = 'clinicalHistoryVerification';
export const HISTORY_REVIEW_RESOURCE = 'clinicalHistoryReview';
const HISTORY_READ_RESOURCE = 'clinicalHistory';
/** Engineering bound per patient (not a clinical rule): a larger history is refused, never truncated. */
const MAX_ITEMS = 500;
const ALERT_KINDS = ['allergy', 'condition', 'medication'] as const;
type AlertKind = (typeof ALERT_KINDS)[number];

/** Which states each kind may take (recommended-pending-clinical-approval). Removal is a state change. */
const STATES: Readonly<Record<HistoryKind, readonly HistoryState[]>> = {
  condition: ['active', 'resolved', 'entered_in_error'],
  allergy: ['active', 'resolved', 'entered_in_error'],
  medication: ['active', 'discontinued', 'entered_in_error'],
  vital: ['active', 'entered_in_error'],
  social: ['active', 'resolved', 'entered_in_error'],
};

const NOT_PROVIDED_INTERACTIONS =
  'Interaction checking is not provided: there is no drug database and no medication or allergy is interpreted.';
const NOT_PROVIDED_CDS =
  'No clinical decision support is provided: every active allergy, condition and medication is listed as recorded, without relevance classification or recommendation.';

interface StreamRow extends Record<string, unknown> {
  id: string;
  origin_patient_id: string;
  head_sequence: number;
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  kind: HistoryKind;
  entry_type: HistoryEntryType;
  stream_id: string;
  origin_patient_id: string;
  subject_patient_id: string;
}

interface ChangeRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  item_sequence: number;
  state: HistoryState;
  display_text: string | null;
  code_ref: string | null;
  detail_text: string | null;
  effective_from: string | null;
  effective_until: string | null;
  reason_code: string | null;
  version_id: string;
  stream_id: string;
  sequence: number;
  provenance: HistoryProvenance;
  reported_by: ReportedBy;
  source_ref: string | null;
  encounter_id: string | null;
  recorded_by: string;
  recorded_by_role: ClinicalRole;
  recorded_by_credential_ref: string | null;
  recorded_at: Date;
}

interface VerificationRow extends Record<string, unknown> {
  change_id: string;
  item_id: string;
  encounter_id: string | null;
  verified_by: string;
  verified_by_role: ClinicalRole;
  verified_by_credential_ref: string | null;
  verified_at: Date;
}

const CHANGE_COLUMNS = `c.id, c.item_id, c.item_sequence, c.state, c.display_text, c.code_ref, c.detail_text,
  c.effective_from::text AS effective_from, c.effective_until::text AS effective_until, c.reason_code,
  v.id AS version_id, v.stream_id, v.sequence, v.provenance, v.reported_by, v.source_ref, v.encounter_id,
  v.recorded_by, v.recorded_by_role, v.recorded_by_credential_ref, v.recorded_at`;

const header = (c: ChangeRow): HistoryVersionHeader => ({
  historyVersionRef: c.version_id,
  streamRef: c.stream_id,
  version: c.sequence,
  provenance: c.provenance,
  reportedBy: c.reported_by,
  sourceRef: c.source_ref,
  encounterRef: c.encounter_id,
  recordedBy: authorOf(c.recorded_by, c.recorded_by_role, c.recorded_by_credential_ref),
  recordedAt: c.recorded_at.toISOString(),
});

const toChange = (c: ChangeRow): HistoryChange => ({
  changeRef: c.id,
  itemSequence: c.item_sequence,
  state: c.state,
  displayText: c.display_text,
  codeRef: c.code_ref,
  detailText: c.detail_text,
  effectiveFrom: c.effective_from,
  effectiveUntil: c.effective_until,
  reasonCode: c.reason_code,
  recorded: header(c),
});

const toVerification = (v: VerificationRow): HistoryVerification => ({
  changeRef: v.change_id,
  verifiedBy: authorOf(v.verified_by, v.verified_by_role, v.verified_by_credential_ref),
  verifiedAt: v.verified_at.toISOString(),
  encounterRef: v.encounter_id,
});

async function patientStreams(tx: TenantTransaction, patientId: string): Promise<StreamRow[]> {
  const { rows } = await tx.query<StreamRow>(
    `SELECT id, origin_patient_id, head_sequence FROM cuspatlas.clinical_history_streams
     WHERE subject_patient_id = $1 ORDER BY id`,
    [patientId],
  );
  return rows;
}

async function patientItems(tx: TenantTransaction, patientId: string): Promise<ItemRow[]> {
  const { rows } = await tx.query<ItemRow>(
    `SELECT i.id, i.kind, i.entry_type, i.stream_id, s.origin_patient_id, s.subject_patient_id
     FROM cuspatlas.clinical_history_items i
     JOIN cuspatlas.clinical_history_streams s ON s.id = i.stream_id AND s.tenant_id = i.tenant_id
     WHERE s.subject_patient_id = $1 ORDER BY i.created_at, i.id`,
    [patientId],
  );
  return rows;
}

async function changesOf(
  tx: TenantTransaction,
  itemIds: readonly string[],
  asOf: Date | null,
): Promise<ChangeRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await tx.query<ChangeRow>(
    `SELECT ${CHANGE_COLUMNS} FROM cuspatlas.clinical_history_changes c
     JOIN cuspatlas.clinical_history_versions v ON v.id = c.version_id AND v.tenant_id = c.tenant_id
     WHERE c.item_id = ANY ($1::uuid[]) AND ($2::timestamptz IS NULL OR v.recorded_at <= $2)
     ORDER BY c.item_id, c.item_sequence`,
    [itemIds, asOf],
  );
  return rows;
}

async function verificationsOf(
  tx: TenantTransaction,
  itemIds: readonly string[],
  asOf: Date | null,
): Promise<VerificationRow[]> {
  if (itemIds.length === 0) return [];
  const { rows } = await tx.query<VerificationRow>(
    `SELECT f.change_id, c.item_id, f.encounter_id, f.verified_by, f.verified_by_role, f.verified_by_credential_ref,
       f.verified_at
     FROM cuspatlas.clinical_history_verifications f
     JOIN cuspatlas.clinical_history_changes c ON c.id = f.change_id AND c.tenant_id = f.tenant_id
     WHERE c.item_id = ANY ($1::uuid[]) AND ($2::timestamptz IS NULL OR f.verified_at <= $2)
     ORDER BY f.verified_at, f.id`,
    [itemIds, asOf],
  );
  return rows;
}

/** The patient's items as of an instant (null = now). Items with no change by then do not exist yet. */
async function itemsAsOf(
  tx: TenantTransaction,
  patientId: string,
  asOf: Date | null,
): Promise<HistoryItem[]> {
  const items = await patientItems(tx, patientId);
  const ids = items.map((i) => i.id);
  const changes = await changesOf(tx, ids, asOf);
  const verifications = await verificationsOf(tx, ids, asOf);
  const out: HistoryItem[] = [];
  for (const i of items) {
    const own = changes.filter((c) => c.item_id === i.id);
    const last = own.at(-1);
    if (!last) continue;
    const verified = verifications.filter((v) => v.item_id === i.id);
    const current = verified.filter((v) => v.change_id === last.id).at(-1);
    out.push({
      itemRef: i.id,
      kind: i.kind,
      entryType: i.entry_type,
      streamRef: i.stream_id,
      sourcePatientRef: i.origin_patient_id,
      current: toChange(last),
      verification: current ? toVerification(current) : null,
      changes: own.map(toChange),
      verifications: verified.map(toVerification),
    });
  }
  return out;
}

async function versionDetail(tx: TenantTransaction, versionId: string): Promise<HistoryVersionDetail | null> {
  const { rows } = await tx.query<ChangeRow & { kind: HistoryKind; entry_type: HistoryEntryType }>(
    `SELECT ${CHANGE_COLUMNS}, i.kind, i.entry_type FROM cuspatlas.clinical_history_changes c
     JOIN cuspatlas.clinical_history_versions v ON v.id = c.version_id AND v.tenant_id = c.tenant_id
     JOIN cuspatlas.clinical_history_items i ON i.id = c.item_id AND i.tenant_id = c.tenant_id
     WHERE c.version_id = $1 ORDER BY c.id`,
    [versionId],
  );
  const first = rows[0];
  if (!first) return null;
  return {
    header: header(first),
    changes: rows.map((c) => ({
      itemRef: c.item_id,
      kind: c.kind,
      entryType: c.entry_type,
      change: toChange(c),
    })),
  };
}

/** The patient's own stream (one per source patient), created on first use and locked FOR UPDATE. */
async function ownStream(tx: TenantTransaction, patientId: string): Promise<{ id: string; head: number }> {
  await tx.query(
    `INSERT INTO cuspatlas.clinical_history_streams (tenant_id, subject_patient_id, origin_patient_id, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $1, cuspatlas.current_actor_id())
     ON CONFLICT (tenant_id, origin_patient_id) DO NOTHING`,
    [patientId],
  );
  const { rows } = await tx.query<{ id: string; head_sequence: number }>(
    'SELECT id, head_sequence FROM cuspatlas.clinical_history_streams WHERE origin_patient_id = $1 FOR UPDATE',
    [patientId],
  );
  const s = rows[0];
  if (!s) throw new Error('history stream is missing');
  return { id: s.id, head: s.head_sequence };
}

function checkProvenance(p: HistoryChangeRecord): void {
  if (p.provenance === 'imported') {
    if (p.reportedBy !== 'external_record') throw failedAt('/reportedBy', 'importedNeedsExternalRecord');
    if (p.sourceRef === undefined) throw failedAt('/sourceRef', 'required');
  } else if (p.reportedBy === 'external_record') {
    throw failedAt('/reportedBy', 'externalRecordNeedsImported');
  }
  if (p.provenance === 'patient_reported' && !['patient', 'guardian', 'caregiver'].includes(p.reportedBy)) {
    throw failedAt('/reportedBy', 'notAPatientReporter');
  }
  if (p.provenance === 'staff' && p.reportedBy !== 'clinician')
    throw failedAt('/reportedBy', 'staffNeedsClinician');
}

interface Planned {
  readonly itemId: string | null;
  readonly kind: HistoryKind;
  readonly entryType: HistoryEntryType;
  readonly sequence: number;
  readonly state: HistoryState;
  readonly displayText: string | null;
  readonly codeRef: string | null;
  readonly detailText: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly reasonCode: string | null;
}

/** Validates one change against the item's current change (or as a new item) and plans the row. */
function plan(
  c: HistoryChangeInput,
  i: number,
  prior: { item: ItemRow; last: HistoryChange } | null,
): Planned {
  const at = (field: string) => `/changes/${i}/${field}`;
  let kind: HistoryKind;
  let entryType: HistoryEntryType;
  if (prior === null) {
    if (c.kind === undefined) throw failedAt(at('kind'), 'required');
    kind = c.kind;
    entryType = c.entryType ?? 'fact';
    if (c.state === 'entered_in_error') throw failedAt(at('state'), 'newItemEnteredInError');
    if (entryType === 'none_known') {
      if (!ALERT_KINDS.includes(kind as AlertKind)) throw failedAt(at('entryType'), 'noneKnownNotForKind');
      if (c.state !== 'active') throw failedAt(at('state'), 'noneKnownMustBeActive');
      if (c.displayText !== undefined || c.codeRef !== undefined) {
        throw failedAt(at('displayText'), 'notForNoneKnown');
      }
    } else if (c.displayText === undefined) {
      throw failedAt(at('displayText'), 'required');
    }
  } else {
    if (c.kind !== undefined) throw failedAt(at('kind'), 'notForExistingItem');
    if (c.entryType !== undefined) throw failedAt(at('entryType'), 'notForExistingItem');
    if (prior.last.state === 'entered_in_error') {
      throw conflict('item_entered_in_error', {
        blockingRefs: [{ kind: 'historyItem', ref: prior.item.id }],
      });
    }
    kind = prior.item.kind;
    entryType = prior.item.entry_type;
    if (entryType === 'none_known' && (c.displayText !== undefined || c.codeRef !== undefined)) {
      throw failedAt(at('displayText'), 'notForNoneKnown');
    }
  }
  if (!STATES[kind].includes(c.state)) throw failedAt(at('state'), 'stateNotForKind');
  if (c.state === 'active' && c.reasonCode !== undefined)
    throw failedAt(at('reasonCode'), 'onlyForStateChange');
  if (c.state !== 'active' && c.reasonCode === undefined) throw failedAt(at('reasonCode'), 'required');
  const last = prior?.last;
  const from = c.effectiveFrom ?? last?.effectiveFrom ?? null;
  const until = c.effectiveUntil ?? last?.effectiveUntil ?? null;
  if (from !== null && until !== null && from > until) throw failedAt(at('effectiveUntil'), 'effectiveRange');
  return {
    itemId: prior?.item.id ?? null,
    kind,
    entryType,
    sequence: (last?.itemSequence ?? 0) + 1,
    state: c.state,
    displayText: c.displayText ?? last?.displayText ?? null,
    codeRef: c.codeRef ?? last?.codeRef ?? null,
    detailText: c.detailText ?? last?.detailText ?? null,
    effectiveFrom: from,
    effectiveUntil: until,
    reasonCode: c.reasonCode ?? null,
  };
}

/**
 * Kind-level consistency after a change set: an active "none known" statement and an active item of
 * the same kind cannot coexist. The caller resolves one explicitly in the same change set; nothing
 * is changed silently.
 */
function checkNoneKnown(current: readonly HistoryItem[], planned: readonly Planned[]): void {
  const after = new Map<string, { kind: HistoryKind; entryType: HistoryEntryType; state: HistoryState }>();
  for (const it of current)
    after.set(it.itemRef, { kind: it.kind, entryType: it.entryType, state: it.current.state });
  planned.forEach((p, i) => {
    after.set(p.itemId ?? `new-${i}`, { kind: p.kind, entryType: p.entryType, state: p.state });
  });
  for (const kind of ALERT_KINDS) {
    const active = [...after.entries()].filter(([, v]) => v.kind === kind && v.state === 'active');
    const facts = active.filter(([, v]) => v.entryType === 'fact');
    const none = active.filter(([, v]) => v.entryType === 'none_known');
    if (facts.length === 0 || none.length === 0) continue;
    const touchedFact = planned.some(
      (p) => p.kind === kind && p.entryType === 'fact' && p.state === 'active',
    );
    const refs = (list: typeof active) =>
      list
        .map(([ref]) => ref)
        .filter((ref) => UUID.test(ref))
        .slice(0, 20)
        .map((ref) => ({ kind: 'historyItem', ref }));
    throw touchedFact
      ? conflict('none_known_active', { blockingRefs: refs(none) })
      : conflict('active_items_present', { blockingRefs: refs(facts) });
  }
}

interface ReviewRow extends Record<string, unknown> {
  id: string;
  encounter_id: string;
  subject_patient_id: string;
  allergy_outcome: ReviewOutcome | null;
  condition_outcome: ReviewOutcome | null;
  medication_outcome: ReviewOutcome | null;
  reviewed_by: string;
  reviewed_by_role: ClinicalRole;
  reviewed_by_credential_ref: string | null;
  reviewed_at: Date;
}

const REVIEW_COLUMNS = `r.id, r.encounter_id, e.subject_patient_id, r.allergy_outcome, r.condition_outcome,
  r.medication_outcome, r.reviewed_by, r.reviewed_by_role, r.reviewed_by_credential_ref, r.reviewed_at`;

const toReview = (r: ReviewRow): HistoryReview => ({
  reviewRef: r.id,
  encounterRef: r.encounter_id,
  patientRef: r.subject_patient_id,
  allergy: r.allergy_outcome,
  condition: r.condition_outcome,
  medication: r.medication_outcome,
  reviewedBy: authorOf(r.reviewed_by, r.reviewed_by_role, r.reviewed_by_credential_ref),
  reviewedAt: r.reviewed_at.toISOString(),
});

/** Alert projection over the current items and the latest review of each kind (no interpretation). */
async function alertsFor(tx: TenantTransaction, patientId: string): Promise<Record<AlertKind, AlertSection>> {
  const items = await itemsAsOf(tx, patientId, null);
  const { rows: reviews } = await tx.query<ReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM cuspatlas.clinical_history_reviews r
     JOIN cuspatlas.clinical_encounters e ON e.id = r.encounter_id AND e.tenant_id = r.tenant_id
     WHERE e.subject_patient_id = $1 ORDER BY r.reviewed_at, r.id`,
    [patientId],
  );
  const out = {} as Record<AlertKind, AlertSection>;
  for (const kind of ALERT_KINDS) {
    const ofKind = items.filter((i) => i.kind === kind);
    const facts = ofKind.filter((i) => i.entryType === 'fact' && i.current.state === 'active');
    const none = ofKind.filter((i) => i.entryType === 'none_known' && i.current.state === 'active').at(-1);
    const review = reviews.filter((r) => r[`${kind}_outcome`] !== null).at(-1);
    const lastReview =
      review === undefined
        ? null
        : {
            reviewRef: review.id,
            encounterRef: review.encounter_id,
            outcome: review[`${kind}_outcome`] as ReviewOutcome,
            reviewedBy: authorOf(
              review.reviewed_by,
              review.reviewed_by_role,
              review.reviewed_by_credential_ref,
            ),
            reviewedAt: review.reviewed_at.toISOString(),
            stale: ofKind.some((i) =>
              i.changes.some((c) => Date.parse(c.recorded.recordedAt) > review.reviewed_at.getTime()),
            ),
          };
    let status: AlertStatus = 'unknown';
    if (facts.length > 0) status = 'present';
    else if (lastReview?.outcome === 'none' && !lastReview.stale) status = 'reviewed_none';
    else if (none) status = 'none_reported';
    out[kind] = {
      status,
      items: facts.map((i) => ({
        itemRef: i.itemRef,
        displayText: i.current.displayText,
        codeRef: i.current.codeRef,
        detailText: i.current.detailText,
        provenance: i.current.recorded.provenance,
        verified: i.verification !== null,
        recordedAt: i.current.recorded.recordedAt,
      })),
      noneKnown: none
        ? {
            itemRef: none.itemRef,
            provenance: none.current.recorded.provenance,
            recordedAt: none.current.recorded.recordedAt,
          }
        : null,
      lastReview,
    };
  }
  return out;
}

/**
 * Seam for S12 (visit context): a resolvable, text-free reference to the patient's current history,
 * read inside the caller's own transaction (no second pool connection). The caller must have
 * authorized `clinical.history.alerts` (or another clinical read) before its transaction and records
 * its own sensitive read; this function returns references and states only, never clinical text.
 */
export async function resolveHistoryReference(
  tx: TenantTransaction,
  patientRef: string,
): Promise<{
  readonly owner: 'C8';
  readonly patientRef: string;
  readonly recorded: boolean;
  readonly versions: readonly { readonly streamRef: string; readonly version: number }[];
  readonly alerts: Readonly<Record<AlertKind, AlertStatus>>;
  readonly computedAt: string;
}> {
  const patient = await loadClinicalPatient(tx, patientRef, '');
  const streams = await patientStreams(tx, patient.id);
  const alerts = await alertsFor(tx, patient.id);
  return {
    owner: 'C8',
    patientRef: patient.id,
    recorded: streams.some((s) => s.head_sequence > 0),
    versions: streams.map((s) => ({ streamRef: s.id, version: s.head_sequence })),
    alerts: {
      allergy: alerts.allergy.status,
      condition: alerts.condition.status,
      medication: alerts.medication.status,
    },
    computedAt: new Date().toISOString(),
  };
}

type Ack = { readonly ref: string };

/** C8 commands and reads. No command interprets, checks interactions or recommends anything. */
export function createHistoryOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  const readable = async (tx: TenantTransaction, patientRef: string) => {
    const patient = await loadClinicalPatient(tx, patientRef, '');
    // A merged-away identity has no history of its own any more: name the survivor instead of
    // answering "unknown" for a patient whose record moved.
    assertNotMerged(patient);
    return patient;
  };

  return {
    recordHistoryChange(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<HistoryVersionDetail>> {
      const op = 'clinical.history.recordChange';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<HistoryChangeRecord>(validateHistoryChangeRecord, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            checkProvenance(p);
            if (p.encounterRef !== undefined) {
              await requireOpenEncounter(tx, decision, p.encounterRef, {
                patientId: patient.id,
                alternative: 'clinical.encounters.open',
              });
            }
            const refs = p.changes.flatMap((c) => (c.itemRef === undefined ? [] : [c.itemRef]));
            if (new Set(refs).size !== refs.length) throw failedAt('/changes', 'duplicateItem');
            // Serializes every writer of this patient (and the merge, which locks the patient first).
            const stream = await ownStream(tx, patient.id);
            if (p.expectedVersion !== undefined && p.expectedVersion !== stream.head) {
              throw new RefusalError({
                code: 'stale_version',
                ...(stream.head >= 1 ? { detail: { currentVersion: stream.head } } : {}),
              });
            }
            const current = await itemsAsOf(tx, patient.id, null);
            const byRef = new Map(current.map((i) => [i.itemRef, i]));
            const known = new Map((await patientItems(tx, patient.id)).map((i) => [i.id, i]));
            const planned: Planned[] = [];
            for (const [i, c] of p.changes.entries()) {
              if (c.itemRef === undefined) {
                planned.push(plan(c, i, null));
                continue;
              }
              if (!UUID.test(c.itemRef)) throw notFound();
              const item = known.get(c.itemRef);
              const last = byRef.get(c.itemRef);
              if (!item || !last) {
                // Another patient's item in this tenant, or no such item: the same answer.
                throw notFound();
              }
              planned.push(plan(c, i, { item, last: last.current }));
            }
            checkNoneKnown(current, planned);
            const newItems = planned.filter((x) => x.itemId === null).length;
            if (known.size + newItems > MAX_ITEMS) throw failedAt('/changes', 'tooManyItems');
            const sequence = stream.head + 1;
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_history_versions (tenant_id, stream_id, sequence, provenance, reported_by,
                 source_ref, encounter_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id(), $7, $8)
               RETURNING id`,
              [
                stream.id,
                sequence,
                p.provenance,
                p.reportedBy,
                p.sourceRef ?? null,
                p.encounterRef ?? null,
                author.role,
                author.credentialRef,
              ],
            );
            const versionId = rows[0]?.id;
            if (!versionId) throw new Error('insert returned no row');
            for (const x of planned) {
              let itemId = x.itemId;
              if (itemId === null) {
                const created = await tx.query<{ id: string }>(
                  `INSERT INTO cuspatlas.clinical_history_items (tenant_id, stream_id, kind, entry_type)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3) RETURNING id`,
                  [stream.id, x.kind, x.entryType],
                );
                itemId = created.rows[0]?.id ?? null;
                if (itemId === null) throw new Error('insert returned no row');
              }
              await tx.query(
                `INSERT INTO cuspatlas.clinical_history_changes (tenant_id, version_id, item_id, item_sequence, state,
                   display_text, code_ref, detail_text, effective_from, effective_until, reason_code)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10)`,
                [
                  versionId,
                  itemId,
                  x.sequence,
                  x.state,
                  x.displayText,
                  x.codeRef,
                  x.detailText,
                  x.effectiveFrom,
                  x.effectiveUntil,
                  x.reasonCode,
                ],
              );
            }
            await tx.query(
              `UPDATE cuspatlas.clinical_history_streams SET head_sequence = head_sequence + 1, version = version + 1,
                 updated_at = now() WHERE id = $1`,
              [stream.id],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: HISTORY_VERSION_RESOURCE,
                resourceRef: versionId,
                resourceVersion: 1,
              },
              { changedFields: ['changes', ...new Set(planned.map((x) => x.kind))] },
            );
            return { data: { ref: versionId }, version: sequence };
          });
          const detail = await versionDetail(tx, r.data.ref);
          if (!detail) throw notFound();
          return { ...r, data: detail };
        });
      });
    },

    verifyHistoryItem(
      ctx: ActorContext,
      itemRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<HistoryItem>> {
      const op = 'clinical.history.verifyItem';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<HistoryVerify>(validateHistoryVerify, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (!UUID.test(itemRef)) throw notFound();
          const found = await tx.query<{ subject_patient_id: string }>(
            `SELECT s.subject_patient_id FROM cuspatlas.clinical_history_items i
             JOIN cuspatlas.clinical_history_streams s ON s.id = i.stream_id AND s.tenant_id = i.tenant_id
             WHERE i.id = $1`,
            [itemRef],
          );
          const subject = found.rows[0]?.subject_patient_id;
          if (!subject) throw notFound();
          const patient = await loadClinicalPatient(tx, subject);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { itemRef, ...p } }, tx, async () => {
            if (p.encounterRef !== undefined) {
              await requireOpenEncounter(tx, decision, p.encounterRef, {
                patientId: patient.id,
                alternative: 'clinical.encounters.open',
              });
            }
            const item = (await itemsAsOf(tx, patient.id, null)).find((i) => i.itemRef === itemRef);
            if (!item) throw notFound();
            if (item.current.changeRef !== p.expectedChangeRef) {
              throw conflict('item_changed', {
                blockingRefs: [{ kind: 'historyChange', ref: item.current.changeRef }],
              });
            }
            if (item.current.state === 'entered_in_error') {
              throw conflict('item_entered_in_error', {
                blockingRefs: [{ kind: 'historyItem', ref: itemRef }],
              });
            }
            if (item.verification !== null) throw conflict('already_verified');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_history_verifications (tenant_id, change_id, encounter_id, verified_by,
                 verified_by_role, verified_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id(), $3, $4) RETURNING id`,
              [item.current.changeRef, p.encounterRef ?? null, author.role, author.credentialRef],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: HISTORY_VERIFICATION_RESOURCE,
                resourceRef: id,
                resourceVersion: 1,
              },
              { changedFields: ['verification'] },
            );
            return { data: { ref: itemRef }, version: item.current.itemSequence };
          });
          const item = (await itemsAsOf(tx, patient.id, null)).find((i) => i.itemRef === r.data.ref);
          if (!item) throw notFound();
          return { ...r, data: item };
        });
      });
    },

    attestHistoryReview(
      ctx: ActorContext,
      encounterRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<HistoryReview>> {
      const op = 'clinical.history.attestReview';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<HistoryReviewAttest>(validateHistoryReviewAttest, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await loadEncounter(tx, decision, encounterRef);
          const patient = await loadClinicalPatient(tx, encounter.subject_patient_id);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { encounterRef, ...p } },
            tx,
            async () => {
              await requireOpenEncounter(tx, decision, encounterRef, {
                patientId: patient.id,
                alternative: 'clinical.encounters.open',
              });
              if (p.allergy === undefined && p.condition === undefined && p.medication === undefined) {
                throw failedAt('/', 'outcomeRequired');
              }
              // Serializes with history writers of this patient, so "none" is attested over a stable list.
              await ownStream(tx, patient.id);
              const items = await itemsAsOf(tx, patient.id, null);
              for (const kind of ALERT_KINDS) {
                if (p[kind] !== 'none') continue;
                const active = items.filter(
                  (i) => i.kind === kind && i.entryType === 'fact' && i.current.state === 'active',
                );
                if (active.length > 0) {
                  throw conflict('active_items_present', {
                    blockingRefs: active.slice(0, 20).map((i) => ({ kind: 'historyItem', ref: i.itemRef })),
                  });
                }
              }
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_history_reviews (tenant_id, encounter_id, allergy_outcome, condition_outcome,
                 medication_outcome, reviewed_by, reviewed_by_role, reviewed_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id(), $5, $6) RETURNING id`,
                [
                  encounter.id,
                  p.allergy ?? null,
                  p.condition ?? null,
                  p.medication ?? null,
                  author.role,
                  author.credentialRef,
                ],
              );
              const id = rows[0]?.id;
              if (!id) throw new Error('insert returned no row');
              await recordCommand(
                tx,
                { operation: op, resourceType: HISTORY_REVIEW_RESOURCE, resourceRef: id, resourceVersion: 1 },
                { changedFields: ALERT_KINDS.filter((k) => p[k] !== undefined) },
              );
              return { data: { ref: id }, version: 1 };
            },
          );
          const { rows } = await tx.query<ReviewRow>(
            `SELECT ${REVIEW_COLUMNS} FROM cuspatlas.clinical_history_reviews r
             JOIN cuspatlas.clinical_encounters e ON e.id = r.encounter_id AND e.tenant_id = r.tenant_id
             WHERE r.id = $1`,
            [r.data.ref],
          );
          const row = rows[0];
          if (!row) throw notFound();
          return { ...r, data: toReview(row) };
        });
      });
    },

    /** The history as of an instant (default now), every item with its full change list. A sensitive read. */
    readHistory(ctx: ActorContext, patientRef: string, query: unknown): Promise<HistoryReadData> {
      const op = 'clinical.history.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid<{ asOf?: string }>(validateHistoryReadQuery, query, CLINICAL_PROPERTIES);
        const asOf = query.asOf === undefined ? null : new Date(query.asOf);
        if (asOf !== null && asOf.getTime() > Date.now()) throw failedAt('/asOf', 'inTheFuture');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await readable(tx, patientRef);
          const streams = await patientStreams(tx, patient.id);
          const items = await itemsAsOf(tx, patient.id, asOf);
          const { rows: heads } = await tx.query<{ stream_id: string; head: number }>(
            `SELECT stream_id, max(sequence)::int AS head FROM cuspatlas.clinical_history_versions
             WHERE stream_id = ANY ($1::uuid[]) AND ($2::timestamptz IS NULL OR recorded_at <= $2) GROUP BY stream_id`,
            [streams.map((s) => s.id), asOf],
          );
          const head = new Map(heads.map((h) => [h.stream_id, h.head]));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: HISTORY_READ_RESOURCE,
            resourceRefs: [patient.id, ...streams.map((s) => s.id)].slice(0, 100),
            queryFields: asOf === null ? [] : ['asOf'],
          });
          return {
            patientRef: patient.id,
            asOf: (asOf ?? new Date()).toISOString(),
            recorded: heads.length > 0,
            streams: streams.map((s) => ({
              streamRef: s.id,
              sourcePatientRef: s.origin_patient_id,
              version: head.get(s.id) ?? 0,
            })),
            items,
          };
        });
      });
    },

    /** One recorded version and its change set. A sensitive read. */
    getHistoryVersion(ctx: ActorContext, historyVersionRef: string): Promise<HistoryVersionDetail> {
      const op = 'clinical.history.readVersion';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (!UUID.test(historyVersionRef)) throw notFound();
          const detail = await versionDetail(tx, historyVersionRef);
          if (!detail) throw notFound();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: HISTORY_VERSION_RESOURCE,
            resourceRefs: [detail.header.historyVersionRef],
            queryFields: [],
          });
          return detail;
        });
      });
    },

    /**
     * Allergies, conditions and medications relevant to care, as recorded. "Nothing recorded" is
     * `unknown`, never "none"; interaction checking and decision support are explicitly not provided.
     */
    getActiveAlerts(ctx: ActorContext, patientRef: string): Promise<ActiveAlertsData> {
      const op = 'clinical.history.alerts';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await readable(tx, patientRef);
          const alerts = await alertsFor(tx, patient.id);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: HISTORY_READ_RESOURCE,
            resourceRefs: [patient.id],
            queryFields: [],
          });
          return {
            patientRef: patient.id,
            computedAt: new Date().toISOString(),
            ...alerts,
            interactionChecking: { provided: false, statement: NOT_PROVIDED_INTERACTIONS },
            decisionSupport: { provided: false, statement: NOT_PROVIDED_CDS },
          };
        });
      });
    },
  };
}

/** Exposed for the reader of a decision record: no interaction is ever computed here. */
export const HISTORY_NOT_PROVIDED = {
  interactions: NOT_PROVIDED_INTERACTIONS,
  decisionSupport: NOT_PROVIDED_CDS,
};
