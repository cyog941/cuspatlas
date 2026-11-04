import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalAuthor,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  type ProcedureBillingEvent,
  type ProcedureCorrect,
  type ProcedureCorrection,
  type ProcedureRender,
  type RenderedProcedure,
  type TenantTransaction,
  validateProcedureCorrect,
  validateProcedureRender,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { PostMergeFactProbe } from '../patients/merge';
import { authorOf, resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { loadChartEntry, resolveTooth } from './chart';
import { assertNotMerged, loadClinicalPatient, loadEncounter } from './encounters';
import { checkSurfaces, TOOTH_VOCABULARY, toothRef } from './tooth-identity';

export const RENDERED_PROCEDURE_RESOURCE = 'clinicalRenderedProcedure';
/**
 * The field names of the C14 -> B event payload, carried as the outbox `changedFields` (the outbox is
 * field-names-only, F). The values are the immutable procedure row the event's aggregate names, read
 * by B through `loadRenderedProcedureEvent` (or `clinical.procedures.read`).
 */
export const PROCEDURE_EVENT_FIELDS = [
  'procedureRef',
  'patientRef',
  'encounterRef',
  'renderingProviderRef',
  'dateOfService',
  'codeRef',
  'toothSurface',
  'planItemRef',
  'reversesProcedureRef',
  'replacesProcedureRef',
  'version',
] as const;
const MAX_PER_ENCOUNTER = 500;
const RENDERABLE = new Set(['accepted', 'scheduled']);
/** Assignment roles that make a provider an encounter's provider (C5-P4; pending decision C14-P2). */
const PROVIDER_ROLES = [
  'treating_provider',
  'secondary_provider',
  'supervising_provider',
  'completing_provider',
];

interface ProcedureRow extends Record<string, unknown> {
  id: string;
  kind: 'rendered' | 'reversal';
  encounter_id: string;
  origin_patient_id: string;
  current_patient_id: string;
  sequence: number;
  plan_item_id: string | null;
  provenance: RenderedProcedure['provenance'];
  code_ref: string;
  tooth_canonical_ref: string | null;
  surfaces: string[] | null;
  chart_entry_id: string | null;
  date_of_service: string;
  rendering_provider_id: string;
  provider_override_reason: string | null;
  duplicate_intent: RenderedProcedure['duplicateIntent'];
  reverses_procedure_id: string | null;
  replaces_procedure_id: string | null;
  reason_code: string | null;
  recorded_by: string;
  recorded_by_role: ClinicalRole;
  recorded_by_credential_ref: string | null;
  recorded_at: Date;
  reversed_by: string | null;
  replaced_by: string | null;
}

const SELECT = `SELECT p.id, p.kind, p.encounter_id, p.origin_patient_id, e.subject_patient_id AS current_patient_id,
    p.sequence, p.plan_item_id, p.provenance, p.code_ref, p.tooth_canonical_ref, p.surfaces, p.chart_entry_id,
    to_char(p.date_of_service, 'YYYY-MM-DD') AS date_of_service, p.rendering_provider_id, p.provider_override_reason,
    p.duplicate_intent, p.reverses_procedure_id, p.replaces_procedure_id, p.reason_code, p.recorded_by,
    p.recorded_by_role, p.recorded_by_credential_ref, p.recorded_at,
    (SELECT r.id FROM cuspatlas.clinical_rendered_procedures r WHERE r.reverses_procedure_id = p.id
       AND r.tenant_id = p.tenant_id) AS reversed_by,
    (SELECT r.id FROM cuspatlas.clinical_rendered_procedures r WHERE r.replaces_procedure_id = p.id
       AND r.tenant_id = p.tenant_id) AS replaced_by
  FROM cuspatlas.clinical_rendered_procedures p
  JOIN cuspatlas.clinical_encounters e ON e.id = p.encounter_id AND e.tenant_id = p.tenant_id`;

function billingEvent(r: ProcedureRow): ProcedureBillingEvent {
  return {
    eventType: r.kind === 'reversal' ? 'procedure.reversed.v1' : 'procedure.rendered.v1',
    procedureRef: r.id,
    patientRef: r.origin_patient_id,
    encounterRef: r.encounter_id,
    renderingProviderRef: r.rendering_provider_id,
    dateOfService: r.date_of_service,
    codeRef: r.code_ref,
    toothSurface:
      r.tooth_canonical_ref === null ? null : { toothRef: r.tooth_canonical_ref, surfaces: r.surfaces },
    planItemRef: r.plan_item_id,
    reversesProcedureRef: r.reverses_procedure_id,
    replacesProcedureRef: r.replaces_procedure_id,
    version: 1,
  };
}

async function loadRow(tx: TenantTransaction, procedureRef: string, lock = ''): Promise<ProcedureRow | null> {
  if (!UUID.test(procedureRef)) return null;
  const { rows } = await tx.query<ProcedureRow>(`${SELECT} WHERE p.id = $1 ${lock}`, [procedureRef]);
  return rows[0] ?? null;
}

async function view(tx: TenantTransaction, r: ProcedureRow): Promise<RenderedProcedure> {
  let discrepancy: RenderedProcedure['chartDiscrepancy'] = 'none';
  if (r.chart_entry_id !== null) {
    const entry = await loadChartEntry(tx, r.chart_entry_id);
    if (entry?.state === 'superseded') discrepancy = 'chart_entry_superseded';
    else if (entry?.state === 'entered_in_error') discrepancy = 'chart_entry_entered_in_error';
  }
  return {
    procedureRef: r.id,
    kind: r.kind,
    state: r.kind === 'reversal' ? 'reversal' : r.reversed_by !== null ? 'reversed' : 'active',
    encounterRef: r.encounter_id,
    patientRef: r.current_patient_id,
    sourcePatientRef: r.origin_patient_id,
    sequence: r.sequence,
    planItemRef: r.plan_item_id,
    provenance: r.provenance,
    codeRef: r.code_ref,
    tooth: r.tooth_canonical_ref === null ? null : toothRef(r.tooth_canonical_ref, 'universal'),
    surfaces: r.surfaces,
    chartEntryRef: r.chart_entry_id,
    chartDiscrepancy: discrepancy,
    dateOfService: r.date_of_service,
    renderingProviderRef: r.rendering_provider_id,
    providerOverrideReason: r.provider_override_reason,
    duplicateIntent: r.duplicate_intent,
    reversesProcedureRef: r.reverses_procedure_id,
    reversedByRef: r.reversed_by,
    replacesProcedureRef: r.replaces_procedure_id,
    replacedByRef: r.replaced_by,
    reasonCode: r.reason_code,
    recordedBy: authorOf(r.recorded_by, r.recorded_by_role, r.recorded_by_credential_ref),
    recordedAt: r.recorded_at.toISOString(),
    billingEvent: billingEvent(r),
  };
}

/**
 * C14 -> B seam: the event payload of one procedure fact, read inside the caller's (B's) own tenant
 * transaction. Returns null when the procedure is hidden or missing. Identifiers only.
 */
export async function loadRenderedProcedureEvent(
  tx: TenantTransaction,
  procedureRef: string,
): Promise<ProcedureBillingEvent | null> {
  const r = await loadRow(tx, procedureRef);
  return r === null ? null : billingEvent(r);
}

/** S-D2: procedures recorded (or corrected) on the survivor's encounters at or after the merge instant. */
export const PROCEDURE_POST_MERGE_FACT_PROBE: PostMergeFactProbe = {
  factKind: 'clinical',
  async count(tx, survivorRef, mergedAt) {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cuspatlas.clinical_rendered_procedures p
       JOIN cuspatlas.clinical_encounters e ON e.id = p.encounter_id AND e.tenant_id = p.tenant_id
       WHERE e.subject_patient_id = $1 AND p.recorded_at >= $2`,
      [survivorRef, mergedAt],
    );
    return Number(rows[0]?.n ?? 0);
  },
};

interface Draft {
  readonly encounterId: string;
  readonly patientId: string;
  readonly sequence: number;
  readonly planItemId: string | null;
  readonly provenance: RenderedProcedure['provenance'];
  readonly codeRef: string;
  readonly tooth: string | null;
  readonly surfaces: readonly string[] | null;
  readonly chartEntryId: string | null;
  readonly dateOfService: string;
  readonly providerId: string;
  readonly overrideReason: string | null;
  readonly duplicateIntent: RenderedProcedure['duplicateIntent'];
  readonly kind: 'rendered' | 'reversal';
  readonly reversesId: string | null;
  readonly replacesId: string | null;
  readonly reasonCode: string | null;
}

async function insert(tx: TenantTransaction, d: Draft, who: ClinicalAuthor): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.clinical_rendered_procedures (tenant_id, kind, encounter_id, origin_patient_id, sequence,
       plan_item_id, provenance, code_ref, tooth_canonical_ref, tooth_vocabulary, surfaces, chart_entry_id,
       date_of_service, rendering_provider_id, provider_override_reason, duplicate_intent, reverses_procedure_id,
       replaces_procedure_id, reason_code, recorded_by, recorded_by_role, recorded_by_credential_ref)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12::date, $13, $14, $15,
       $16, $17, $18, cuspatlas.current_actor_id(), $19, $20) RETURNING id`,
    [
      d.kind,
      d.encounterId,
      d.patientId,
      d.sequence,
      d.planItemId,
      d.provenance,
      d.codeRef,
      d.tooth,
      d.tooth === null ? null : TOOTH_VOCABULARY,
      d.surfaces,
      d.chartEntryId,
      d.dateOfService,
      d.providerId,
      d.overrideReason,
      d.duplicateIntent,
      d.reversesId,
      d.replacesId,
      d.reasonCode,
      who.role,
      who.credentialRef,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no row');
  return id;
}

/** Appends a completion (or its reversal) to the item and bumps the plan version revision. */
async function itemEvent(
  tx: TenantTransaction,
  itemId: string,
  to: 'completed' | 'accepted',
  procedureId: string,
  who: ClinicalAuthor,
): Promise<void> {
  const { rows } = await tx.query<{ sequence: number; to_state: string; plan_version_id: string }>(
    `SELECT e.sequence, e.to_state, i.plan_version_id FROM cuspatlas.clinical_plan_item_events e
     JOIN cuspatlas.clinical_plan_items i ON i.id = e.item_id AND i.tenant_id = e.tenant_id
     WHERE e.item_id = $1 ORDER BY e.sequence DESC LIMIT 1`,
    [itemId],
  );
  const last = rows[0];
  if (!last) throw new Error('item has no state');
  await tx.query(
    `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
       rendered_procedure_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id(), $7, $8)`,
    [
      itemId,
      last.sequence + 1,
      last.to_state,
      to,
      to === 'completed' ? 'rendered' : 'render_reversed',
      procedureId,
      who.role,
      who.credentialRef,
    ],
  );
  await tx.query(
    `UPDATE cuspatlas.clinical_plan_versions SET revision = revision + 1, updated_at = now() WHERE id = $1`,
    [last.plan_version_id],
  );
}

type Ack = { readonly ref: string };

/** C14 commands and reads. No command prices anything; B posts charges from the events. */
export function createProcedureOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  /** The rendering provider: a provider resource of this tenant, assigned to the encounter or overridden. */
  const checkProvider = async (
    tx: TenantTransaction,
    encounterId: string,
    providerRef: string,
    overrideReason: string | null,
    pointer: string,
  ) => {
    if (!UUID.test(providerRef)) throw notFound();
    const { rows } = await tx.query<{ kind: string }>(
      'SELECT kind FROM cuspatlas.scheduling_resources WHERE id = $1',
      [providerRef],
    );
    const r = rows[0];
    if (!r) throw notFound();
    if (r.kind !== 'provider') throw failedAt(pointer, 'notAProvider');
    const { rows: assigned } = await tx.query(
      `SELECT 1 FROM cuspatlas.clinical_encounter_assignments WHERE encounter_id = $1 AND resource_id = $2
         AND role = ANY ($3::text[]) LIMIT 1`,
      [encounterId, providerRef, PROVIDER_ROLES],
    );
    if (assigned.length === 0 && overrideReason === null) {
      throw conflict('provider_not_assigned', { blockingRefs: [{ kind: 'encounter', ref: encounterId }] });
    }
  };
  /** Not after today in the encounter location's own time zone. */
  const checkDate = async (tx: TenantTransaction, locationId: string, date: string, pointer: string) => {
    const { rows } = await tx.query<{ ok: boolean }>(
      `SELECT $2::date <= (now() AT TIME ZONE l.time_zone)::date AS ok FROM cuspatlas.scheduling_locations l WHERE l.id = $1`,
      [locationId, date],
    );
    if (rows[0]?.ok !== true) throw failedAt(pointer, 'dateOfServiceInFuture');
  };
  const active = async (tx: TenantTransaction, encounterId: string) =>
    (
      await tx.query<ProcedureRow>(
        `${SELECT} WHERE p.encounter_id = $1 AND p.kind = 'rendered' AND NOT EXISTS (
           SELECT 1 FROM cuspatlas.clinical_rendered_procedures r WHERE r.reverses_procedure_id = p.id
             AND r.tenant_id = p.tenant_id)`,
        [encounterId],
      )
    ).rows;
  const answer = async (tx: TenantTransaction, ref: string) => {
    const r = await loadRow(tx, ref);
    if (!r) throw notFound();
    return view(tx, r);
  };

  return {
    renderProcedure(
      ctx: ActorContext,
      encounterRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RenderedProcedure>> {
      const op = 'clinical.procedures.render';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ProcedureRender>(validateProcedureRender, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // The encounter row serializes renders of one visit (duplicates, sequences) and a close.
          const encounter = await loadEncounter(tx, decision, encounterRef, 'FOR UPDATE OF e');
          const patient = await loadClinicalPatient(tx, encounter.subject_patient_id);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { encounterRef, ...p } },
            tx,
            async () => {
              assertNotMerged(patient);
              if (encounter.state === 'closed') {
                throw conflict('encounter_closed', {
                  blockingRefs: [{ kind: 'encounter', ref: encounter.id }],
                  alternative: 'clinical.procedures.correct',
                });
              }
              await checkProvider(
                tx,
                encounter.id,
                p.renderingProviderRef,
                p.providerOverrideReason ?? null,
                '/renderingProviderRef',
              );
              await checkDate(tx, encounter.location_id, p.dateOfService, '/dateOfService');
              let codeRef: string;
              let tooth: string | null;
              let surfaces: readonly string[] | null;
              let chartEntryId: string | null = null;
              let complete = false;
              if (p.planItemRef !== undefined) {
                if (!UUID.test(p.planItemRef)) throw notFound();
                const { rows: items } = await tx.query<{
                  id: string;
                  plan_version_id: string;
                  procedure_code_ref: string;
                  tooth_canonical_ref: string | null;
                  surfaces: string[] | null;
                  chart_entry_id: string | null;
                  subject_patient_id: string;
                }>(
                  `SELECT i.id, i.plan_version_id, i.procedure_code_ref, i.tooth_canonical_ref, i.surfaces, i.chart_entry_id,
                   pl.subject_patient_id
                 FROM cuspatlas.clinical_plan_items i
                 JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id
                 JOIN cuspatlas.clinical_treatment_plans pl ON pl.id = v.plan_id AND pl.tenant_id = v.tenant_id
                 WHERE i.id = $1`,
                  [p.planItemRef],
                );
                const item = items[0];
                if (!item) throw notFound();
                if (item.subject_patient_id !== patient.id)
                  throw failedAt('/planItemRef', 'planItemPatientMismatch');
                await tx.query('SELECT id FROM cuspatlas.clinical_plan_versions WHERE id = $1 FOR UPDATE', [
                  item.plan_version_id,
                ]);
                const { rows: next } = await tx.query<{ id: string }>(
                  'SELECT id FROM cuspatlas.clinical_plan_versions WHERE supersedes_version_id = $1',
                  [item.plan_version_id],
                );
                if (next[0]) {
                  throw conflict('plan_version_superseded', {
                    blockingRefs: [{ kind: 'planVersion', ref: next[0].id }],
                  });
                }
                if (p.codeRef !== undefined && p.codeRef !== item.procedure_code_ref)
                  throw failedAt('/codeRef', 'codeMismatchWithPlanItem');
                if (p.tooth !== undefined && resolveTooth(p.tooth, '/tooth') !== item.tooth_canonical_ref)
                  throw failedAt('/tooth', 'toothMismatchWithPlanItem');
                if (
                  p.surfaces !== undefined &&
                  [...p.surfaces].sort().join() !== [...(item.surfaces ?? [])].sort().join()
                )
                  throw failedAt('/surfaces', 'surfacesMismatchWithPlanItem');
                codeRef = item.procedure_code_ref;
                tooth = item.tooth_canonical_ref;
                surfaces = item.surfaces;
                chartEntryId = item.chart_entry_id;
                const { rows: st } = await tx.query<{ to_state: string }>(
                  `SELECT to_state FROM cuspatlas.clinical_plan_item_events WHERE item_id = $1 ORDER BY sequence DESC LIMIT 1`,
                  [item.id],
                );
                const state = st[0]?.to_state ?? 'proposed';
                if (state === 'completed') {
                  if (p.duplicateIntent !== 'additional_visit') {
                    throw conflict('plan_item_completed', {
                      blockingRefs: [{ kind: 'planItem', ref: item.id }],
                    });
                  }
                } else if (!RENDERABLE.has(state)) {
                  throw conflict('plan_item_not_renderable', {
                    blockingRefs: [{ kind: 'planItem', ref: item.id }],
                  });
                } else {
                  complete = true;
                }
              } else {
                if (p.codeRef === undefined) throw failedAt('/codeRef', 'required');
                codeRef = p.codeRef;
                tooth = p.tooth === undefined ? null : resolveTooth(p.tooth, '/tooth');
                surfaces = null;
                if (p.surfaces !== undefined) {
                  if (tooth === null) throw failedAt('/surfaces', 'surfacesNeedTooth');
                  const checked = checkSurfaces(tooth, p.surfaces);
                  if (!checked.ok) throw failedAt('/surfaces', checked.reason);
                  surfaces = checked.surfaces;
                }
                if (p.chartEntryRef !== undefined) {
                  const entry = await loadChartEntry(tx, p.chartEntryRef);
                  if (!entry) throw notFound();
                  if (entry.patientRef !== patient.id)
                    throw failedAt('/chartEntryRef', 'chartEntryPatientMismatch');
                  if (tooth !== null && entry.tooth?.canonicalRef !== tooth)
                    throw failedAt('/tooth', 'toothMismatchWithChartEntry');
                  chartEntryId = entry.entryRef;
                }
              }
              // Duplicates and sequences are judged against the encounter's active procedures (row locked above).
              const current = await active(tx, encounter.id);
              if (current.length >= MAX_PER_ENCOUNTER) throw failedAt('/', 'tooManyProcedures');
              if (current.some((x) => x.sequence === p.sequence)) {
                throw conflict('sequence_in_use', {
                  blockingRefs: current
                    .filter((x) => x.sequence === p.sequence)
                    .map((x) => ({ kind: 'renderedProcedure', ref: x.id })),
                });
              }
              const key = (c: string, t: string | null, s: readonly string[] | null, i: string | null) =>
                JSON.stringify([c, t, s === null ? null : [...s].sort(), i]);
              const same = current.filter(
                (x) =>
                  key(x.code_ref, x.tooth_canonical_ref, x.surfaces, x.plan_item_id) ===
                  key(codeRef, tooth, surfaces, p.planItemRef ?? null),
              );
              if (same.length > 0 && p.duplicateIntent !== 'repeat_in_visit') {
                throw conflict('duplicate_procedure', {
                  blockingRefs: same.slice(0, 20).map((x) => ({ kind: 'renderedProcedure', ref: x.id })),
                });
              }
              const id = await insert(
                tx,
                {
                  encounterId: encounter.id,
                  patientId: patient.id,
                  sequence: p.sequence,
                  planItemId: p.planItemRef ?? null,
                  provenance: p.planItemRef === undefined ? 'unscheduled' : 'planned',
                  codeRef,
                  tooth,
                  surfaces,
                  chartEntryId,
                  dateOfService: p.dateOfService,
                  providerId: p.renderingProviderRef,
                  overrideReason: p.providerOverrideReason ?? null,
                  duplicateIntent: p.duplicateIntent ?? null,
                  kind: 'rendered',
                  reversesId: null,
                  replacesId: null,
                  reasonCode: null,
                },
                who,
              );
              if (complete && p.planItemRef !== undefined)
                await itemEvent(tx, p.planItemRef, 'completed', id, who);
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: RENDERED_PROCEDURE_RESOURCE,
                  resourceRef: id,
                  resourceVersion: 1,
                },
                { changedFields: [...PROCEDURE_EVENT_FIELDS] },
              );
              return { data: { ref: id }, version: 1 };
            },
          );
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    /** Reverses a rendered procedure and optionally records its linked replacement. Nothing is rewritten. */
    correctProcedure(
      ctx: ActorContext,
      procedureRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ProcedureCorrection>> {
      const op = 'clinical.procedures.correct';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ProcedureCorrect>(validateProcedureCorrect, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const found = await loadRow(tx, procedureRef);
          if (!found) throw notFound();
          const encounter = await loadEncounter(tx, decision, found.encounter_id, 'FOR UPDATE OF e');
          await loadClinicalPatient(tx, encounter.subject_patient_id);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { procedureRef, ...p } },
            tx,
            async () => {
              const o = await loadRow(tx, procedureRef);
              if (!o) throw notFound();
              if (o.kind === 'reversal')
                throw conflict('procedure_not_correctable', {
                  blockingRefs: [{ kind: 'renderedProcedure', ref: o.id }],
                });
              if (o.reversed_by !== null) {
                throw conflict('procedure_reversed', {
                  blockingRefs: [{ kind: 'renderedProcedure', ref: o.reversed_by }],
                });
              }
              // A replacement's sequence is judged against the procedures still active once the original is reversed.
              if (p.replacement !== undefined) {
                const seq = p.replacement.sequence ?? o.sequence;
                const others = (await active(tx, o.encounter_id)).filter(
                  (x) => x.id !== o.id && x.sequence === seq,
                );
                if (others.length > 0) {
                  throw conflict('sequence_in_use', {
                    blockingRefs: others.map((x) => ({ kind: 'renderedProcedure', ref: x.id })),
                  });
                }
              }
              const reversal = await insert(
                tx,
                {
                  encounterId: o.encounter_id,
                  patientId: o.origin_patient_id,
                  sequence: o.sequence,
                  planItemId: o.plan_item_id,
                  provenance: 'correction',
                  codeRef: o.code_ref,
                  tooth: o.tooth_canonical_ref,
                  surfaces: o.surfaces,
                  chartEntryId: o.chart_entry_id,
                  dateOfService: o.date_of_service,
                  providerId: o.rendering_provider_id,
                  overrideReason: o.provider_override_reason,
                  duplicateIntent: null,
                  kind: 'reversal',
                  reversesId: o.id,
                  replacesId: null,
                  reasonCode: p.reasonCode,
                },
                who,
              );
              // A completion this procedure made returns its item to accepted, explicitly. The item is the one
              // whose current completion names this procedure: the procedure's own item, or the carried-forward
              // item of the current plan version (an item of a superseded version is frozen history). An item
              // still covered by another active procedure (an additional visit) stays completed.
              let reverted = false;
              let targetItem: string | null = null;
              if (o.plan_item_id !== null) {
                const { rows: named } = await tx.query<{ item_id: string }>(
                  `SELECT e.item_id FROM cuspatlas.clinical_plan_item_events e
                   WHERE e.rendered_procedure_id = $1 AND e.to_state = 'completed'
                     AND e.sequence = (SELECT max(x.sequence) FROM cuspatlas.clinical_plan_item_events x
                                       WHERE x.item_id = e.item_id AND x.tenant_id = e.tenant_id)
                     AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_items i
                                     JOIN cuspatlas.clinical_plan_versions s ON s.supersedes_version_id = i.plan_version_id
                                       AND s.tenant_id = i.tenant_id
                                     WHERE i.id = e.item_id AND i.tenant_id = e.tenant_id)
                   LIMIT 1`,
                  [o.id],
                );
                targetItem = named[0]?.item_id ?? null;
                if (targetItem !== null) {
                  const { rows: covering } = await tx.query(
                    `SELECT 1 FROM cuspatlas.clinical_rendered_procedures p
                     WHERE p.kind = 'rendered' AND p.id <> $1 AND p.plan_item_id = ANY ($2::uuid[])
                       AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_rendered_procedures r
                                       WHERE r.reverses_procedure_id = p.id AND r.tenant_id = p.tenant_id)
                     LIMIT 1`,
                    [o.id, [o.plan_item_id, targetItem]],
                  );
                  if (covering.length === 0) {
                    await itemEvent(tx, targetItem, 'accepted', reversal, who);
                    reverted = true;
                  }
                }
              }
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: RENDERED_PROCEDURE_RESOURCE,
                  resourceRef: reversal,
                  resourceVersion: 1,
                },
                { changedFields: [...PROCEDURE_EVENT_FIELDS] },
              );
              const x = p.replacement;
              if (x !== undefined) {
                const codeRef = x.codeRef ?? o.code_ref;
                let tooth = o.tooth_canonical_ref;
                let surfaces: readonly string[] | null = o.surfaces;
                if (x.tooth !== undefined) {
                  tooth = resolveTooth(x.tooth, '/replacement/tooth');
                  surfaces = null;
                }
                if (x.surfaces !== undefined) {
                  if (tooth === null) throw failedAt('/replacement/surfaces', 'surfacesNeedTooth');
                  const checked = checkSurfaces(tooth, x.surfaces);
                  if (!checked.ok) throw failedAt('/replacement/surfaces', checked.reason);
                  surfaces = checked.surfaces;
                }
                const providerRef = x.renderingProviderRef ?? o.rendering_provider_id;
                const overrideReason =
                  x.providerOverrideReason ??
                  (x.renderingProviderRef === undefined ? o.provider_override_reason : null);
                if (x.renderingProviderRef !== undefined) {
                  await checkProvider(
                    tx,
                    o.encounter_id,
                    providerRef,
                    overrideReason,
                    '/replacement/renderingProviderRef',
                  );
                }
                const dateOfService = x.dateOfService ?? o.date_of_service;
                if (x.dateOfService !== undefined)
                  await checkDate(tx, encounter.location_id, dateOfService, '/replacement/dateOfService');
                // The replacement keeps the plan item only when it is still that item's procedure: the same
                // code, tooth and surfaces (checked again by the database).
                let planItemId: string | null = null;
                const linked = targetItem ?? o.plan_item_id;
                if (linked !== null) {
                  const { rows: it } = await tx.query<{
                    procedure_code_ref: string;
                    tooth_canonical_ref: string | null;
                    surfaces: string[] | null;
                  }>(
                    'SELECT procedure_code_ref, tooth_canonical_ref, surfaces FROM cuspatlas.clinical_plan_items WHERE id = $1',
                    [linked],
                  );
                  const item = it[0];
                  const norm = (v: readonly string[] | null) => (v === null ? null : [...v].sort().join());
                  if (
                    item &&
                    item.procedure_code_ref === codeRef &&
                    item.tooth_canonical_ref === tooth &&
                    norm(item.surfaces) === norm(surfaces)
                  )
                    planItemId = linked;
                }
                const replacement = await insert(
                  tx,
                  {
                    encounterId: o.encounter_id,
                    patientId: encounter.subject_patient_id,
                    sequence: x.sequence ?? o.sequence,
                    planItemId,
                    provenance: 'correction',
                    codeRef,
                    tooth,
                    surfaces,
                    chartEntryId: x.tooth === undefined ? o.chart_entry_id : null,
                    dateOfService,
                    providerId: providerRef,
                    overrideReason,
                    duplicateIntent: o.duplicate_intent,
                    kind: 'rendered',
                    reversesId: null,
                    replacesId: o.id,
                    reasonCode: p.reasonCode,
                  },
                  who,
                );
                if (planItemId !== null && reverted)
                  await itemEvent(tx, planItemId, 'completed', replacement, who);
                await recordCommand(
                  tx,
                  {
                    operation: op,
                    resourceType: RENDERED_PROCEDURE_RESOURCE,
                    resourceRef: replacement,
                    resourceVersion: 1,
                  },
                  { changedFields: [...PROCEDURE_EVENT_FIELDS] },
                );
              }
              return { data: { ref: o.id }, version: 1 };
            },
          );
          const original = await answer(tx, r.data.ref);
          if (original.reversedByRef === null) throw new Error('correction has no reversal');
          return {
            ...r,
            data: {
              original,
              reversal: await answer(tx, original.reversedByRef),
              replacement: original.replacedByRef === null ? null : await answer(tx, original.replacedByRef),
            },
          };
        });
      });
    },

    /** One procedure fact with its correction links and billing event. A sensitive read. */
    readProcedure(ctx: ActorContext, procedureRef: string): Promise<RenderedProcedure> {
      const op = 'clinical.procedures.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await loadRow(tx, procedureRef);
          if (!r) throw notFound();
          await loadEncounter(tx, decision, r.encounter_id);
          const out = await view(tx, r);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: RENDERED_PROCEDURE_RESOURCE,
            resourceRefs: [r.id],
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** Every procedure fact of an encounter (history) and the net set still standing. A sensitive read. */
    listProcedures(
      ctx: ActorContext,
      encounterRef: string,
    ): Promise<{ readonly procedures: readonly RenderedProcedure[]; readonly netRefs: readonly string[] }> {
      const op = 'clinical.procedures.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await loadEncounter(tx, decision, encounterRef);
          const { rows } = await tx.query<ProcedureRow>(
            `${SELECT} WHERE p.encounter_id = $1 ORDER BY p.recorded_at, p.id LIMIT ${MAX_PER_ENCOUNTER}`,
            [encounter.id],
          );
          const procedures: RenderedProcedure[] = [];
          for (const r of rows) procedures.push(await view(tx, r));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: RENDERED_PROCEDURE_RESOURCE,
            resourceRefs: [encounter.id, ...rows.map((r) => r.id)].slice(0, 100),
            queryFields: [],
          });
          return {
            procedures,
            netRefs: procedures.filter((x) => x.state === 'active').map((x) => x.procedureRef),
          };
        });
      });
    },
  };
}
