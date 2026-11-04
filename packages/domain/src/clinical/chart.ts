import {
  type ActorContext,
  assertValid,
  type ChartEntry,
  type ChartEntryCorrect,
  type ChartEntryKind,
  type ChartEntryRecord,
  type ChartEntryRecordData,
  type ChartEntryState,
  type ChartProvenance,
  type ChartReadData,
  type ChartReadQuery,
  type ChartRecordedState,
  type ChartToothState,
  CLINICAL_PROPERTIES,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  type TenantTransaction,
  type ToothDisplaySystem,
  type ToothInput,
  validateChartEntryCorrect,
  validateChartEntryRecord,
  validateChartReadQuery,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { authorOf, resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { assertNotMerged, loadClinicalPatient, requireOpenEncounter } from './encounters';
import { checkSurfaces, parseTooth, TOOTH_VOCABULARY, toothInfo, toothRef } from './tooth-identity';

export const CHART_ENTRY_RESOURCE = 'clinicalChartEntry';
const CHART_READ_RESOURCE = 'clinicalChart';
/** Engineering bound per patient (not a clinical rule): a larger chart is refused, never truncated. */
const MAX_ENTRIES = 2000;
const NEEDS_TOOTH: ReadonlySet<ChartEntryKind> = new Set([
  'missing',
  'implant',
  'supernumerary',
  'existing_restoration',
]);
const NO_SURFACES: ReadonlySet<ChartEntryKind> = new Set(['missing', 'implant', 'supernumerary']);

export interface ChartEntryRow extends Record<string, unknown> {
  id: string;
  chart_id: string;
  sequence: number;
  tooth_canonical_ref: string | null;
  tooth_vocabulary: string | null;
  surfaces: string[] | null;
  kind: ChartEntryKind;
  finding_ref: string;
  recorded_state: ChartRecordedState;
  detail_text: string | null;
  provenance: ChartProvenance;
  source_ref: string | null;
  encounter_id: string | null;
  supersedes_entry_id: string | null;
  correction_reason_code: string | null;
  recorded_by: string;
  recorded_by_role: ClinicalRole;
  recorded_by_credential_ref: string | null;
  recorded_at: Date;
  subject_patient_id: string;
  origin_patient_id: string;
}

const ENTRY_COLUMNS = `x.id, x.chart_id, x.sequence, x.tooth_canonical_ref, x.tooth_vocabulary, x.surfaces, x.kind,
  x.finding_ref, x.recorded_state, x.detail_text, x.provenance, x.source_ref, x.encounter_id, x.supersedes_entry_id,
  x.correction_reason_code, x.recorded_by, x.recorded_by_role, x.recorded_by_credential_ref, x.recorded_at,
  c.subject_patient_id, c.origin_patient_id`;

/** Every entry of the patient's charts (one per source patient), deterministic order. */
async function patientEntries(
  tx: TenantTransaction,
  patientId: string,
  asOf: Date | null,
): Promise<ChartEntryRow[]> {
  const { rows } = await tx.query<ChartEntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM cuspatlas.clinical_chart_entries x
     JOIN cuspatlas.clinical_charts c ON c.id = x.chart_id AND c.tenant_id = x.tenant_id
     WHERE c.subject_patient_id = $1 AND ($2::timestamptz IS NULL OR x.recorded_at <= $2)
     ORDER BY x.recorded_at, x.chart_id, x.sequence`,
    [patientId, asOf],
  );
  return rows;
}

async function entryById(tx: TenantTransaction, entryId: string): Promise<ChartEntryRow | null> {
  if (!UUID.test(entryId)) return null;
  const { rows } = await tx.query<ChartEntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM cuspatlas.clinical_chart_entries x
     JOIN cuspatlas.clinical_charts c ON c.id = x.chart_id AND c.tenant_id = x.tenant_id WHERE x.id = $1`,
    [entryId],
  );
  return rows[0] ?? null;
}

/** State of each entry within a visible set: superseded once a visible successor names it. */
function statesOf(
  rows: readonly ChartEntryRow[],
): Map<string, { state: ChartEntryState; successor: string | null }> {
  const successor = new Map<string, string>();
  for (const r of rows) if (r.supersedes_entry_id !== null) successor.set(r.supersedes_entry_id, r.id);
  const out = new Map<string, { state: ChartEntryState; successor: string | null }>();
  for (const r of rows) {
    const next = successor.get(r.id) ?? null;
    out.set(r.id, { state: next === null ? r.recorded_state : 'superseded', successor: next });
  }
  return out;
}

function toEntry(
  r: ChartEntryRow,
  s: { state: ChartEntryState; successor: string | null },
  display: ToothDisplaySystem,
): ChartEntry {
  const recordedBy = authorOf(r.recorded_by, r.recorded_by_role, r.recorded_by_credential_ref);
  return {
    entryRef: r.id,
    chartRef: r.chart_id,
    patientRef: r.subject_patient_id,
    sourcePatientRef: r.origin_patient_id,
    sequence: r.sequence,
    tooth: r.tooth_canonical_ref === null ? null : toothRef(r.tooth_canonical_ref, display),
    surfaces: r.surfaces,
    kind: r.kind,
    findingRef: r.finding_ref,
    state: s.state,
    recordedState: r.recorded_state,
    detailText: r.detail_text,
    provenance: r.provenance,
    sourceRef: r.source_ref,
    encounterRef: r.encounter_id,
    recordedBy,
    // An imported or patient-reported finding is never attributed to the clinician who entered it.
    clinicalAuthor: r.provenance === 'recorded' ? recordedBy : null,
    recordedAt: r.recorded_at.toISOString(),
    supersedesEntryRef: r.supersedes_entry_id,
    supersededByEntryRef: s.successor,
    correctionReasonCode: r.correction_reason_code,
    toothVocabulary: r.tooth_vocabulary,
  };
}

/** Chart state reconstructed from active entries, per canonical tooth (no inference from absence). */
function teethOf(entries: readonly ChartEntry[]): ChartToothState[] {
  const byTooth = new Map<string, ChartEntry[]>();
  for (const e of entries) {
    if (e.tooth === null || e.state !== 'active') continue;
    byTooth.set(e.tooth.canonicalRef, [...(byTooth.get(e.tooth.canonicalRef) ?? []), e]);
  }
  return [...byTooth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, list]) => {
      const kinds = new Set(list.map((e) => e.kind));
      const status = kinds.has('implant') ? 'implant' : kinds.has('missing') ? 'missing' : 'present';
      return {
        tooth: list[0]?.tooth as ChartEntry['tooth'] & object,
        status,
        activeEntryRefs: list.map((e) => e.entryRef),
      };
    });
}

/**
 * Seam for C7 and C11: the current chart state of one canonical tooth of a patient. `not_charted`
 * means no active entry names the tooth; nothing is inferred from that absence.
 */
export async function toothOnChart(
  tx: TenantTransaction,
  patientId: string,
  canonicalRef: string,
): Promise<{
  status: 'present' | 'missing' | 'implant' | 'not_charted';
  activeEntryRefs: readonly string[];
}> {
  const rows = await patientEntries(tx, patientId, null);
  const states = statesOf(rows);
  const entries = rows.map((r) =>
    toEntry(r, states.get(r.id) as { state: ChartEntryState; successor: null }, 'universal'),
  );
  const t = teethOf(entries).find((x) => x.tooth.canonicalRef === canonicalRef);
  return t
    ? { status: t.status, activeEntryRefs: t.activeEntryRefs }
    : { status: 'not_charted', activeEntryRefs: [] };
}

/** Seam for C11/C14: one entry with its current state (null when hidden or missing). */
export async function loadChartEntry(tx: TenantTransaction, entryRef: string): Promise<ChartEntry | null> {
  const row = await entryById(tx, entryRef);
  if (!row) return null;
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.clinical_chart_entries WHERE supersedes_entry_id = $1',
    [row.id],
  );
  const successor = rows[0]?.id ?? null;
  return toEntry(
    row,
    { state: successor === null ? row.recorded_state : 'superseded', successor },
    'universal',
  );
}

/** Resolves a tooth input to its canonical reference or refuses (422) at the given pointer. */
export function resolveTooth(input: ToothInput, pointer: string): string {
  const parsed = parseTooth(input);
  if (!parsed.ok) throw failedAt(`${pointer}/code`, 'unknownToothCode');
  return parsed.canonicalRef;
}

interface Planned {
  readonly tooth: string | null;
  readonly surfaces: readonly string[] | null;
  readonly kind: ChartEntryKind;
}

/** Kind, tooth and surface rules (structural; the surface values are provisional, C-S1-Q2). */
function checkShape(tooth: string | null, surfaces: readonly string[] | null, kind: ChartEntryKind): Planned {
  if (NEEDS_TOOTH.has(kind) && tooth === null) throw failedAt('/tooth', 'required');
  const supernumeraryTooth = tooth !== null && toothInfo(tooth)?.dentition === 'supernumerary';
  if (kind === 'supernumerary' && !supernumeraryTooth)
    throw failedAt('/tooth', 'supernumeraryNeedsSupernumeraryTooth');
  if (supernumeraryTooth && kind !== 'supernumerary' && kind !== 'condition') {
    throw failedAt('/kind', 'kindNotForSupernumeraryTooth');
  }
  if (surfaces === null) return { tooth, surfaces: null, kind };
  if (tooth === null) throw failedAt('/surfaces', 'surfacesNeedTooth');
  if (NO_SURFACES.has(kind)) throw failedAt('/surfaces', 'surfacesNotForKind');
  const checked = checkSurfaces(tooth, surfaces);
  if (!checked.ok) throw failedAt('/surfaces', checked.reason);
  return { tooth, surfaces: checked.surfaces, kind };
}

/** The chart of one source patient, created on first use and locked FOR UPDATE. */
async function ownChart(tx: TenantTransaction, patientId: string): Promise<{ id: string; head: number }> {
  await tx.query(
    `INSERT INTO cuspatlas.clinical_charts (tenant_id, subject_patient_id, origin_patient_id, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $1, cuspatlas.current_actor_id())
     ON CONFLICT (tenant_id, origin_patient_id) DO NOTHING`,
    [patientId],
  );
  const { rows } = await tx.query<{ id: string; head_sequence: number }>(
    'SELECT id, head_sequence FROM cuspatlas.clinical_charts WHERE origin_patient_id = $1 FOR UPDATE',
    [patientId],
  );
  const c = rows[0];
  if (!c) throw new Error('chart is missing');
  return { id: c.id, head: c.head_sequence };
}

async function lockChart(tx: TenantTransaction, chartId: string): Promise<{ id: string; head: number }> {
  const { rows } = await tx.query<{ id: string; head_sequence: number }>(
    'SELECT id, head_sequence FROM cuspatlas.clinical_charts WHERE id = $1 FOR UPDATE',
    [chartId],
  );
  const c = rows[0];
  if (!c) throw notFound();
  return { id: c.id, head: c.head_sequence };
}

interface Insert extends Planned {
  readonly findingRef: string;
  readonly state: ChartRecordedState;
  readonly detailText: string | null;
  readonly provenance: ChartProvenance;
  readonly sourceRef: string | null;
  readonly encounterId: string | null;
  readonly supersedes: string | null;
  readonly reasonCode: string | null;
}

async function appendEntry(
  tx: TenantTransaction,
  chart: { id: string; head: number },
  x: Insert,
  author: { role: ClinicalRole; credentialRef: string | null },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.clinical_chart_entries (tenant_id, chart_id, sequence, tooth_canonical_ref, tooth_vocabulary,
       surfaces, kind, finding_ref, recorded_state, detail_text, provenance, source_ref, encounter_id,
       supersedes_entry_id, correction_reason_code, recorded_by, recorded_by_role, recorded_by_credential_ref)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       cuspatlas.current_actor_id(), $15, $16) RETURNING id`,
    [
      chart.id,
      chart.head + 1,
      x.tooth,
      x.tooth === null ? null : TOOTH_VOCABULARY,
      x.surfaces,
      x.kind,
      x.findingRef,
      x.state,
      x.detailText,
      x.provenance,
      x.sourceRef,
      x.encounterId,
      x.supersedes,
      x.reasonCode,
      author.role,
      author.credentialRef,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no row');
  await tx.query(
    `UPDATE cuspatlas.clinical_charts SET head_sequence = head_sequence + 1, version = version + 1, updated_at = now()
     WHERE id = $1`,
    [chart.id],
  );
  return id;
}

const sameSet = (a: readonly string[] | null, b: readonly string[] | null) =>
  JSON.stringify(a === null ? null : [...a].sort()) === JSON.stringify(b === null ? null : [...b].sort());

type Ack = { readonly ref: string; readonly outcome?: 'recorded' | 'existing' };

/** C6 commands and reads. No command diagnoses, interprets or recommends anything. */
export function createChartOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  const project = async (tx: TenantTransaction, ref: string): Promise<ChartEntry> => {
    const e = await loadChartEntry(tx, ref);
    if (!e) throw notFound();
    return e;
  };

  return {
    recordChartEntry(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ChartEntryRecordData>> {
      const op = 'clinical.chart.recordEntry';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ChartEntryRecord>(validateChartEntryRecord, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            if (p.provenance === 'imported' && p.sourceRef === undefined)
              throw failedAt('/sourceRef', 'required');
            if (p.encounterRef !== undefined) {
              await requireOpenEncounter(tx, decision, p.encounterRef, {
                patientId: patient.id,
                alternative: 'clinical.encounters.open',
              });
            }
            const tooth = p.tooth === undefined ? null : resolveTooth(p.tooth, '/tooth');
            const shape = checkShape(tooth, p.surfaces ?? null, p.kind);
            const state = p.state ?? 'active';
            // Serializes every writer of this patient's own chart (and the merge, which locks the patient first).
            const chart = await ownChart(tx, patient.id);
            const rows = await patientEntries(tx, patient.id, null);
            const states = statesOf(rows);
            const dup = rows.find(
              (e) =>
                states.get(e.id)?.state === state &&
                e.tooth_canonical_ref === shape.tooth &&
                sameSet(e.surfaces, shape.surfaces) &&
                e.kind === shape.kind &&
                e.finding_ref === p.findingRef &&
                e.provenance === p.provenance,
            );
            // The same active finding again: one entry, nothing from this request applied.
            if (dup) return { data: { ref: dup.id, outcome: 'existing' }, version: dup.sequence };
            if (rows.length >= MAX_ENTRIES) throw failedAt('/', 'tooManyEntries');
            const id = await appendEntry(
              tx,
              chart,
              {
                ...shape,
                findingRef: p.findingRef,
                state,
                detailText: p.detailText ?? null,
                provenance: p.provenance,
                sourceRef: p.sourceRef ?? null,
                encounterId: p.encounterRef ?? null,
                supersedes: null,
                reasonCode: null,
              },
              author,
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: CHART_ENTRY_RESOURCE, resourceRef: id, resourceVersion: 1 },
              {
                changedFields: [
                  'kind',
                  'findingRef',
                  'provenance',
                  ...(tooth ? ['tooth'] : []),
                  ...(shape.surfaces ? ['surfaces'] : []),
                ],
              },
            );
            return { data: { ref: id, outcome: 'recorded' }, version: chart.head + 1 };
          });
          return {
            ...r,
            data: { outcome: r.data.outcome ?? 'recorded', entry: await project(tx, r.data.ref) },
          };
        });
      });
    },

    correctChartEntry(
      ctx: ActorContext,
      chartEntryRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ChartEntry>> {
      const op = 'clinical.chart.correctEntry';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ChartEntryCorrect>(validateChartEntryCorrect, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const found = await entryById(tx, chartEntryRef);
          if (!found) throw notFound();
          const patient = await loadClinicalPatient(tx, found.subject_patient_id);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { chartEntryRef, ...p } },
            tx,
            async () => {
              assertNotMerged(patient);
              if (p.encounterRef !== undefined) {
                await requireOpenEncounter(tx, decision, p.encounterRef, {
                  patientId: patient.id,
                  alternative: 'clinical.encounters.open',
                });
              }
              // The successor is written into the base entry's own chart (which keeps its source patient).
              const chart = await lockChart(tx, found.chart_id);
              const current = await loadChartEntry(tx, found.id);
              if (!current) throw notFound();
              if (current.state === 'superseded') {
                const rows = await patientEntries(tx, patient.id, null);
                const next = new Map(
                  rows.filter((x) => x.supersedes_entry_id).map((x) => [x.supersedes_entry_id, x.id]),
                );
                let head = found.id;
                while (next.has(head)) head = next.get(head) as string;
                throw conflict('entry_superseded', { blockingRefs: [{ kind: 'chartEntry', ref: head }] });
              }
              if (current.state === 'entered_in_error') {
                throw conflict('entry_entered_in_error', {
                  blockingRefs: [{ kind: 'chartEntry', ref: found.id }],
                });
              }
              const tooth =
                p.tooth === undefined ? found.tooth_canonical_ref : resolveTooth(p.tooth, '/tooth');
              const shape = checkShape(
                tooth,
                p.surfaces === undefined ? found.surfaces : p.surfaces,
                p.kind ?? found.kind,
              );
              const id = await appendEntry(
                tx,
                chart,
                {
                  ...shape,
                  findingRef: p.findingRef ?? found.finding_ref,
                  state: p.state,
                  detailText: p.detailText === undefined ? found.detail_text : p.detailText,
                  // Provenance and source carry forward: an imported finding stays attributed to its source.
                  provenance: found.provenance,
                  sourceRef: found.source_ref,
                  encounterId: p.encounterRef ?? null,
                  supersedes: found.id,
                  reasonCode: p.reasonCode,
                },
                author,
              );
              await recordCommand(
                tx,
                { operation: op, resourceType: CHART_ENTRY_RESOURCE, resourceRef: id, resourceVersion: 1 },
                {
                  changedFields: [
                    'supersedes',
                    'state',
                    ...Object.keys(p).filter((k) => k !== 'reasonCode' && k !== 'state'),
                  ],
                },
              );
              return { data: { ref: id }, version: chart.head + 1 };
            },
          );
          return { ...r, data: await project(tx, r.data.ref) };
        });
      });
    },

    /** The chart as of an instant (default now): every entry with its state, plus the tooth state. A sensitive read. */
    readChart(ctx: ActorContext, patientRef: string, query: unknown): Promise<ChartReadData> {
      const op = 'clinical.chart.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid<ChartReadQuery>(validateChartReadQuery, query, CLINICAL_PROPERTIES);
        const asOf = query.asOf === undefined ? null : new Date(query.asOf);
        if (asOf !== null && asOf.getTime() > Date.now()) throw failedAt('/asOf', 'inTheFuture');
        const display = query.displaySystem ?? 'universal';
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, patientRef, '');
          assertNotMerged(patient);
          const rows = await patientEntries(tx, patient.id, asOf);
          const states = statesOf(rows);
          const all = rows.map((r) =>
            toEntry(r, states.get(r.id) as { state: ChartEntryState; successor: string | null }, display),
          );
          const entries = all.filter(
            (e) =>
              (query.provenance === undefined || e.provenance === query.provenance) &&
              (query.dentition === undefined || e.tooth === null || e.tooth.dentition === query.dentition),
          );
          const { rows: charts } = await tx.query<{ id: string; origin_patient_id: string }>(
            `SELECT id, origin_patient_id FROM cuspatlas.clinical_charts WHERE subject_patient_id = $1
               AND ($2::timestamptz IS NULL OR created_at <= $2) ORDER BY id`,
            [patient.id, asOf],
          );
          const heads = new Map<string, number>();
          for (const r of rows) heads.set(r.chart_id, Math.max(heads.get(r.chart_id) ?? 0, r.sequence));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: CHART_READ_RESOURCE,
            resourceRefs: [patient.id, ...charts.map((c) => c.id)].slice(0, 100),
            queryFields: Object.keys(query).sort(),
          });
          return {
            patientRef: patient.id,
            asOf: (asOf ?? new Date()).toISOString(),
            displaySystem: display,
            recorded: rows.length > 0,
            charts: charts
              .filter((c) => heads.has(c.id))
              .map((c) => ({
                chartRef: c.id,
                sourcePatientRef: c.origin_patient_id,
                version: heads.get(c.id) ?? 0,
              })),
            entries,
            teeth: teethOf(entries),
          };
        });
      });
    },
  };
}
