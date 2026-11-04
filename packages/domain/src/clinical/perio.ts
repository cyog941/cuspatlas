import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  type PerioComparedSite,
  type PerioCompareQuery,
  type PerioComparisonData,
  type PerioDerivation,
  type PerioDerive,
  type PerioExam,
  type PerioExamCorrect,
  type PerioExamHeader,
  type PerioExamRecord,
  type PerioInputMeasure,
  type PerioMeasure,
  type PerioMeasurement,
  type PerioSite,
  type PerioValueInput,
  type TenantTransaction,
  validatePerioCompareQuery,
  validatePerioDerive,
  validatePerioExamCorrect,
  validatePerioExamRecord,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { authorOf, resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { chartToothStates, resolveTooth } from './chart';
import { assertNotMerged, loadClinicalPatient, requireOpenEncounter } from './encounters';
import { toothInfo, toothRef } from './tooth-identity';

export const PERIO_EXAM_RESOURCE = 'clinicalPerioExam';
export const PERIO_DERIVATION_RESOURCE = 'clinicalPerioDerivation';
/** Engineering bound per patient (not a clinical rule): more exams are refused, never truncated. */
const MAX_EXAMS = 500;
/** Provisional six-site scheme (C-S1-Q5 blocking: the site definition is a clinical value). */
export const PROVISIONAL_SITES: readonly PerioSite[] = ['db', 'b', 'mb', 'dl', 'l', 'ml'];
const MEASURES: readonly PerioMeasure[] = ['probing_depth', 'recession', 'bleeding', 'mobility', 'furcation'];
const COMPARED: readonly PerioInputMeasure[] = ['probing_depth', 'recession'];
const LABEL = 'derived_pending_clinical_approval' as const;

interface ExamRow extends Record<string, unknown> {
  id: string;
  stream_id: string;
  sequence: number;
  site_scheme: 'six_site_provisional';
  exam_date: string | null;
  tooth_count: number;
  encounter_id: string | null;
  recorded_by: string;
  recorded_by_role: ClinicalRole;
  recorded_by_credential_ref: string | null;
  recorded_at: Date;
  subject_patient_id: string;
  origin_patient_id: string;
}

const EXAM_COLUMNS = `x.id, x.stream_id, x.sequence, x.site_scheme, x.exam_date::text AS exam_date, x.tooth_count,
  x.encounter_id, x.recorded_by, x.recorded_by_role, x.recorded_by_credential_ref, x.recorded_at,
  s.subject_patient_id, s.origin_patient_id`;
const EXAM_FROM = `cuspatlas.clinical_perio_exams x
  JOIN cuspatlas.clinical_perio_streams s ON s.id = x.stream_id AND s.tenant_id = x.tenant_id`;

interface MeasurementRow extends Record<string, unknown> {
  id: string;
  tooth_canonical_ref: string;
  site: PerioSite | null;
  measure: PerioMeasure;
  status: 'measured' | 'not_measured';
  value_mm: number | null;
  value_flag: boolean | null;
  value_grade: string | null;
  supersedes_measurement_id: string | null;
  reason_code: string | null;
  recorded_by: string;
  recorded_by_role: ClinicalRole;
  recorded_by_credential_ref: string | null;
  recorded_at: Date;
}

interface FormulaRow extends Record<string, unknown> {
  formula_ref: string;
  version: number;
  operation: 'sum';
  inputs: PerioInputMeasure[];
  withdrawn_at: Date | null;
}

const toothOrder = (canonicalRef: string) => {
  const t = toothInfo(canonicalRef);
  if (!t) return 999;
  const dentition = t.dentition === 'permanent' ? 0 : t.dentition === 'primary' ? 1 : 2;
  return dentition * 100 + ['ur', 'ul', 'll', 'lr'].indexOf(t.quadrant) * 10 + t.position;
};
const siteOrder = (site: PerioSite | null) => (site === null ? 9 : PROVISIONAL_SITES.indexOf(site));
const bySiteKey = (
  a: { tooth: string; site: PerioSite | null },
  b: { tooth: string; site: PerioSite | null },
) => toothOrder(a.tooth) - toothOrder(b.tooth) || siteOrder(a.site) - siteOrder(b.site);

const header = (e: ExamRow): PerioExamHeader => ({
  examRef: e.id,
  streamRef: e.stream_id,
  patientRef: e.subject_patient_id,
  sourcePatientRef: e.origin_patient_id,
  sequence: e.sequence,
  siteScheme: e.site_scheme,
  examDate: e.exam_date,
  encounterRef: e.encounter_id,
  toothCount: e.tooth_count,
  recordedBy: authorOf(e.recorded_by, e.recorded_by_role, e.recorded_by_credential_ref),
  recordedAt: e.recorded_at.toISOString(),
});

async function examById(tx: TenantTransaction, examRef: string): Promise<ExamRow | null> {
  if (!UUID.test(examRef)) return null;
  const { rows } = await tx.query<ExamRow>(`SELECT ${EXAM_COLUMNS} FROM ${EXAM_FROM} WHERE x.id = $1`, [
    examRef,
  ]);
  return rows[0] ?? null;
}

async function measurementsOf(tx: TenantTransaction, examId: string): Promise<MeasurementRow[]> {
  const { rows } = await tx.query<MeasurementRow>(
    `SELECT id, tooth_canonical_ref, site, measure, status, value_mm, value_flag, value_grade, supersedes_measurement_id,
       reason_code, recorded_by, recorded_by_role, recorded_by_credential_ref, recorded_at
     FROM cuspatlas.clinical_perio_measurements WHERE exam_id = $1`,
    [examId],
  );
  return rows.sort(
    (a, b) =>
      bySiteKey(
        { tooth: a.tooth_canonical_ref, site: a.site },
        { tooth: b.tooth_canonical_ref, site: b.site },
      ) ||
      MEASURES.indexOf(a.measure) - MEASURES.indexOf(b.measure) ||
      a.recorded_at.getTime() - b.recorded_at.getTime() ||
      (a.supersedes_measurement_id === null ? -1 : 1),
  );
}

const successors = (rows: readonly MeasurementRow[]) =>
  new Map(
    rows.filter((r) => r.supersedes_measurement_id !== null).map((r) => [r.supersedes_measurement_id, r.id]),
  );

function toMeasurement(r: MeasurementRow, next: ReadonlyMap<string | null, string>): PerioMeasurement {
  return {
    measurementRef: r.id,
    tooth: toothRef(r.tooth_canonical_ref, 'universal'),
    site: r.site,
    measure: r.measure,
    status: r.status,
    mm: r.value_mm,
    present: r.value_flag,
    grade: r.value_grade,
    current: !next.has(r.id),
    supersedesRef: r.supersedes_measurement_id,
    supersededByRef: next.get(r.id) ?? null,
    reasonCode: r.reason_code,
    recordedBy: authorOf(r.recorded_by, r.recorded_by_role, r.recorded_by_credential_ref),
    recordedAt: r.recorded_at.toISOString(),
  };
}

/** Current numeric value per tooth/site for one measure (null when not measured). */
function currentValues(
  rows: readonly MeasurementRow[],
  measure: PerioInputMeasure,
): Map<string, number | null> {
  const next = successors(rows);
  const out = new Map<string, number | null>();
  for (const r of rows) {
    if (r.measure !== measure || next.has(r.id) || r.site === null) continue;
    out.set(`${r.tooth_canonical_ref}|${r.site}`, r.status === 'measured' ? r.value_mm : null);
  }
  return out;
}

interface DerivationRow extends Record<string, unknown> {
  id: string;
  exam_id: string;
  formula_ref: string;
  formula_version: number;
  operation: 'sum';
  inputs: PerioInputMeasure[];
  withdrawn_at: Date | null;
  computed_by: string;
  computed_by_role: ClinicalRole;
  computed_by_credential_ref: string | null;
  computed_at: Date;
}

async function derivationsOf(
  tx: TenantTransaction,
  filter: string,
  value: string,
): Promise<PerioDerivation[]> {
  const { rows } = await tx.query<DerivationRow>(
    `SELECT d.id, d.exam_id, d.formula_ref, d.formula_version, f.operation, f.inputs, f.withdrawn_at, d.computed_by,
       d.computed_by_role, d.computed_by_credential_ref, d.computed_at
     FROM cuspatlas.clinical_perio_derivations d
     JOIN cuspatlas.clinical_perio_formulas f ON f.tenant_id = d.tenant_id AND f.formula_ref = d.formula_ref
       AND f.version = d.formula_version
     WHERE d.${filter} = $1 ORDER BY d.computed_at, d.id`,
    [value],
  );
  if (rows.length === 0) return [];
  const { rows: values } = await tx.query<{
    derivation_id: string;
    tooth_canonical_ref: string;
    site: PerioSite;
    status: 'derived' | 'not_computable';
    value: number | null;
    missing_inputs: PerioInputMeasure[];
  }>(
    `SELECT derivation_id, tooth_canonical_ref, site, status, value, missing_inputs
     FROM cuspatlas.clinical_perio_derived_values WHERE derivation_id = ANY ($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  return rows.map((d) => ({
    derivationRef: d.id,
    examRef: d.exam_id,
    formula: {
      formulaRef: d.formula_ref,
      version: d.formula_version,
      operation: d.operation,
      inputs: d.inputs,
      approvalStatus: 'pending',
      withdrawn: d.withdrawn_at !== null,
      historical: d.withdrawn_at !== null && d.withdrawn_at.getTime() >= d.computed_at.getTime(),
    },
    label: LABEL,
    computedBy: authorOf(d.computed_by, d.computed_by_role, d.computed_by_credential_ref),
    computedAt: d.computed_at.toISOString(),
    values: values
      .filter((v) => v.derivation_id === d.id)
      .sort((a, b) =>
        bySiteKey(
          { tooth: a.tooth_canonical_ref, site: a.site },
          { tooth: b.tooth_canonical_ref, site: b.site },
        ),
      )
      .map((v) => ({
        tooth: toothRef(v.tooth_canonical_ref, 'universal'),
        site: v.site,
        status: v.status,
        value: v.value,
        missingInputs: v.missing_inputs,
      })),
  }));
}

async function projectExam(tx: TenantTransaction, exam: ExamRow): Promise<PerioExam> {
  const rows = await measurementsOf(tx, exam.id);
  const next = successors(rows);
  return {
    ...header(exam),
    measurements: rows.map((r) => toMeasurement(r, next)),
    derivations: await derivationsOf(tx, 'exam_id', exam.id),
  };
}

async function ownStream(tx: TenantTransaction, patientId: string): Promise<{ id: string; head: number }> {
  await tx.query(
    `INSERT INTO cuspatlas.clinical_perio_streams (tenant_id, subject_patient_id, origin_patient_id, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $1, cuspatlas.current_actor_id())
     ON CONFLICT (tenant_id, origin_patient_id) DO NOTHING`,
    [patientId],
  );
  const { rows } = await tx.query<{ id: string; head_sequence: number }>(
    'SELECT id, head_sequence FROM cuspatlas.clinical_perio_streams WHERE origin_patient_id = $1 FOR UPDATE',
    [patientId],
  );
  const s = rows[0];
  if (!s) throw new Error('perio stream is missing');
  return { id: s.id, head: s.head_sequence };
}

async function lockStream(tx: TenantTransaction, streamId: string): Promise<void> {
  await tx.query('SELECT id FROM cuspatlas.clinical_perio_streams WHERE id = $1 FOR UPDATE', [streamId]);
}

async function gradeVocabulary(tx: TenantTransaction): Promise<Set<string>> {
  const { rows } = await tx.query<{ measure: string; grade_code: string }>(
    'SELECT measure, grade_code FROM cuspatlas.clinical_perio_grade_vocabulary',
  );
  return new Set(rows.map((r) => `${r.measure}|${r.grade_code}`));
}

interface PlannedValue {
  readonly tooth: string;
  readonly site: PerioSite | null;
  readonly measure: PerioMeasure;
  readonly status: 'measured' | 'not_measured';
  readonly mm: number | null;
  readonly flag: boolean | null;
  readonly grade: string | null;
  readonly supersedes: string | null;
}

/** Validates one value against its measure and the configured grades, or refuses at the pointer. */
function planValue(
  v: PerioValueInput,
  measure: PerioMeasure,
  grades: ReadonlySet<string>,
  at: string,
): Pick<PlannedValue, 'status' | 'mm' | 'flag' | 'grade'> {
  if (v.status === 'not_measured') {
    if (Object.keys(v).length > 1) throw failedAt(at, 'valueNotForMeasure');
    return { status: 'not_measured', mm: null, flag: null, grade: null };
  }
  const has = (k: string) => (v as Record<string, unknown>)[k] !== undefined;
  const want =
    measure === 'bleeding' ? 'present' : measure === 'mobility' || measure === 'furcation' ? 'grade' : 'mm';
  if (!has(want) || ['mm', 'present', 'grade'].some((k) => k !== want && has(k))) {
    throw failedAt(at, 'valueNotForMeasure');
  }
  if (want === 'mm') {
    const mm = v.mm as number;
    if (measure === 'probing_depth' && (mm < 0 || mm > 20)) throw failedAt(`${at}/mm`, 'outOfRange');
    return { status: 'measured', mm, flag: null, grade: null };
  }
  if (want === 'present') return { status: 'measured', mm: null, flag: v.present as boolean, grade: null };
  if (!grades.has(`${measure}|${v.grade}`)) throw failedAt(`${at}/grade`, 'notConfigured');
  return { status: 'measured', mm: null, flag: null, grade: v.grade as string };
}

async function insertValues(
  tx: TenantTransaction,
  examId: string,
  values: readonly PlannedValue[],
  reasonCode: string | null,
  author: { role: ClinicalRole; credentialRef: string | null },
): Promise<void> {
  const col = <K extends keyof PlannedValue>(k: K) => values.map((v) => v[k]);
  await tx.query(
    `INSERT INTO cuspatlas.clinical_perio_measurements (tenant_id, exam_id, tooth_canonical_ref, site, measure, status,
       value_mm, value_flag, value_grade, supersedes_measurement_id, reason_code, recorded_by, recorded_by_role,
       recorded_by_credential_ref)
     SELECT cuspatlas.current_tenant_id(), $1, u.t, u.s, u.m, u.st, u.mm, u.fl, u.gr, u.sup, $2,
       cuspatlas.current_actor_id(), $3, $4
     FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::bool[], $11::text[], $12::uuid[])
       WITH ORDINALITY AS u(t, s, m, st, mm, fl, gr, sup, n)
     ORDER BY u.n`,
    [
      examId,
      reasonCode,
      author.role,
      author.credentialRef,
      col('tooth'),
      col('site'),
      col('measure'),
      col('status'),
      col('mm'),
      col('flag'),
      col('grade'),
      col('supersedes'),
    ],
  );
}

function compareMaps(
  baseVals: ReadonlyMap<string, number | null>,
  targetVals: ReadonlyMap<string, number | null>,
  measure: PerioInputMeasure | 'derived',
  missingWord: 'not_measured' | 'not_computable',
): PerioComparedSite[] {
  const keys = [...new Set([...baseVals.keys(), ...targetVals.keys()])];
  return keys
    .map((k) => {
      const [tooth, site] = k.split('|') as [string, PerioSite];
      return { tooth, site, k };
    })
    .sort(bySiteKey)
    .map(({ tooth, site, k }) => {
      const b = baseVals.get(k);
      const t = targetVals.get(k);
      let status: PerioComparedSite['status'];
      if (b === undefined) status = 'absent_in_base';
      else if (t === undefined) status = 'absent_in_target';
      else if (b === null && t === null) status = `${missingWord}_in_both`;
      else if (b === null) status = `${missingWord}_in_base`;
      else if (t === null) status = `${missingWord}_in_target`;
      else status = 'compared';
      return {
        tooth: toothRef(tooth, 'universal'),
        site,
        measure,
        base: b ?? null,
        target: t ?? null,
        // Unmeasured or absent sites never contribute arithmetic (no false improvement).
        delta: status === 'compared' ? (t as number) - (b as number) : null,
        status,
      };
    });
}

type Ack = { readonly ref: string };

/** C7 commands and reads. Nothing here diagnoses, classifies or recommends. */
export function createPerioOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  const reread = async (tx: TenantTransaction, examId: string) => {
    const exam = await examById(tx, examId);
    if (!exam) throw notFound();
    return projectExam(tx, exam);
  };

  /** The exam a command or read targets, with its patient located FOR SHARE (or plain for reads). */
  const examFor = async (tx: TenantTransaction, examRef: string, lock: 'FOR SHARE' | '' = 'FOR SHARE') => {
    const exam = await examById(tx, examRef);
    if (!exam) throw notFound();
    const patient = await loadClinicalPatient(tx, exam.subject_patient_id, lock);
    return { exam, patient };
  };

  return {
    recordPerioExam(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PerioExam>> {
      const op = 'clinical.perio.recordExam';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PerioExamRecord>(validatePerioExamRecord, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            if (p.encounterRef !== undefined) {
              await requireOpenEncounter(tx, decision, p.encounterRef, {
                patientId: patient.id,
                alternative: 'clinical.encounters.open',
              });
            }
            const grades = await gradeVocabulary(tx);
            const seen = new Set<string>();
            const planned: PlannedValue[] = [];
            const teeth: string[] = [];
            for (const [i, t] of p.teeth.entries()) {
              const at = `/teeth/${i}`;
              const tooth = resolveTooth(t.tooth, `${at}/tooth`);
              if (toothInfo(tooth)?.dentition === 'supernumerary')
                throw failedAt(`${at}/tooth`, 'siteSchemeNotForTooth');
              if (seen.has(tooth)) throw failedAt(`${at}/tooth`, 'duplicateTooth');
              seen.add(tooth);
              teeth.push(tooth);
              // A complete exam or nothing: every site of the scheme, each measured or explicitly not.
              for (const field of ['probingDepth', 'recession', 'bleeding'] as const) {
                if (t[field].length !== PROVISIONAL_SITES.length)
                  throw failedAt(`${at}/${field}`, 'siteMissing');
              }
              for (const measure of ['mobility', 'furcation'] as const) {
                const v = t[measure];
                planned.push({
                  tooth,
                  site: null,
                  measure,
                  supersedes: null,
                  ...planValue(
                    v === 'not_measured'
                      ? { status: 'not_measured' }
                      : { status: 'measured', grade: v.grade },
                    measure,
                    grades,
                    `${at}/${measure}`,
                  ),
                });
              }
              for (const [j, site] of PROVISIONAL_SITES.entries()) {
                for (const [measure, field] of [
                  ['probing_depth', 'probingDepth'],
                  ['recession', 'recession'],
                  ['bleeding', 'bleeding'],
                ] as const) {
                  const v = t[field][j];
                  const value: PerioValueInput =
                    v === 'not_measured' || v === undefined
                      ? { status: 'not_measured' }
                      : typeof v === 'boolean'
                        ? { status: 'measured', present: v }
                        : { status: 'measured', mm: v };
                  planned.push({
                    tooth,
                    site,
                    measure,
                    supersedes: null,
                    ...planValue(value, measure, grades, `${at}/${field}/${j}`),
                  });
                }
              }
            }
            // A tooth charted missing is refused; the chart must say otherwise first (no implicit entry).
            const chart = await chartToothStates(tx, patient.id);
            const absent = teeth.flatMap((t) =>
              chart.get(t)?.status === 'missing' ? (chart.get(t)?.missingEntryRefs ?? []) : [],
            );
            if (absent.length > 0) {
              throw conflict('tooth_absent_on_chart', {
                blockingRefs: absent.slice(0, 20).map((ref) => ({ kind: 'chartEntry', ref })),
              });
            }
            const stream = await ownStream(tx, patient.id);
            if (stream.head >= MAX_EXAMS) throw failedAt('/', 'tooManyExams');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_perio_exams (tenant_id, stream_id, sequence, site_scheme, exam_date, tooth_count,
                 encounter_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::date, $5, $6, cuspatlas.current_actor_id(), $7, $8)
               RETURNING id`,
              [
                stream.id,
                stream.head + 1,
                p.siteScheme,
                p.examDate ?? null,
                teeth.length,
                p.encounterRef ?? null,
                author.role,
                author.credentialRef,
              ],
            );
            const examId = rows[0]?.id;
            if (!examId) throw new Error('insert returned no row');
            await insertValues(tx, examId, planned, null, author);
            await tx.query(
              `UPDATE cuspatlas.clinical_perio_streams SET head_sequence = head_sequence + 1, version = version + 1,
                 updated_at = now() WHERE id = $1`,
              [stream.id],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: PERIO_EXAM_RESOURCE, resourceRef: examId, resourceVersion: 1 },
              { changedFields: ['teeth', 'siteScheme', ...(p.examDate ? ['examDate'] : [])] },
            );
            return { data: { ref: examId }, version: 1 };
          });
          return { ...r, data: await reread(tx, r.data.ref) };
        });
      });
    },

    correctPerioExam(
      ctx: ActorContext,
      perioExamRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PerioExam>> {
      const op = 'clinical.perio.correctExam';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PerioExamCorrect>(validatePerioExamCorrect, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { exam, patient } = await examFor(tx, perioExamRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { perioExamRef, ...p } },
            tx,
            async () => {
              if (p.encounterRef !== undefined) {
                await requireOpenEncounter(tx, decision, p.encounterRef, {
                  patientId: patient.id,
                  alternative: 'clinical.encounters.open',
                });
              }
              // Serializes correctors of this exam: the second sees the first's successor.
              await lockStream(tx, exam.stream_id);
              const rows = await measurementsOf(tx, exam.id);
              const byId = new Map(rows.map((m) => [m.id, m]));
              const next = successors(rows);
              const grades = await gradeVocabulary(tx);
              const refs = p.corrections.map((c) => c.measurementRef);
              if (new Set(refs).size !== refs.length) throw failedAt('/corrections', 'duplicateMeasurement');
              const planned: PlannedValue[] = [];
              for (const [i, c] of p.corrections.entries()) {
                const m = byId.get(c.measurementRef);
                // A measurement of another exam (or none) is the same answer as a missing one.
                if (!m) throw notFound();
                if (next.has(m.id)) {
                  let head = m.id;
                  while (next.has(head)) head = next.get(head) as string;
                  throw conflict('measurement_superseded', {
                    blockingRefs: [{ kind: 'perioMeasurement', ref: head }],
                  });
                }
                planned.push({
                  tooth: m.tooth_canonical_ref,
                  site: m.site,
                  measure: m.measure,
                  supersedes: m.id,
                  ...planValue(c.value, m.measure, grades, `/corrections/${i}/value`),
                });
              }
              try {
                await insertValues(tx, exam.id, planned, p.reasonCode, author);
              } catch (err) {
                if ((err as { code?: unknown }).code === '23505') throw conflict('measurement_superseded');
                throw err;
              }
              const revision =
                1 + rows.filter((m) => m.supersedes_measurement_id !== null).length + planned.length;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PERIO_EXAM_RESOURCE,
                  resourceRef: exam.id,
                  resourceVersion: revision,
                },
                { changedFields: ['measurements'] },
              );
              return { data: { ref: exam.id }, version: revision };
            },
          );
          return { ...r, data: await reread(tx, r.data.ref) };
        });
      });
    },

    derivePerioValues(
      ctx: ActorContext,
      perioExamRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PerioDerivation>> {
      const op = 'clinical.perio.derive';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<PerioDerive>(validatePerioDerive, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { exam } = await examFor(tx, perioExamRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { perioExamRef, ...p } },
            tx,
            async () => {
              await lockStream(tx, exam.stream_id);
              const { rows: formulas } = await tx.query<FormulaRow>(
                'SELECT formula_ref, version, operation, inputs, withdrawn_at FROM cuspatlas.clinical_perio_formulas WHERE formula_ref = $1',
                [p.formulaRef],
              );
              if (formulas.length === 0) throw failedAt('/formulaRef', 'notConfigured');
              const f = formulas.find((x) => x.version === p.formulaVersion);
              if (!f) throw failedAt('/formulaVersion', 'notConfigured');
              if (f.withdrawn_at !== null) throw conflict('formula_withdrawn');
              const rows = await measurementsOf(tx, exam.id);
              const inputs = new Map(f.inputs.map((m) => [m, currentValues(rows, m)]));
              const keys = [...(inputs.get(f.inputs[0] as PerioInputMeasure)?.keys() ?? [])];
              const { rows: created } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_perio_derivations (tenant_id, exam_id, formula_ref, formula_version, computed_by,
                 computed_by_role, computed_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id(), $4, $5) RETURNING id`,
                [exam.id, f.formula_ref, f.version, author.role, author.credentialRef],
              );
              const id = created[0]?.id;
              if (!id) throw new Error('insert returned no row');
              const values = keys.map((k) => {
                const missing = f.inputs.filter((m) => (inputs.get(m)?.get(k) ?? null) === null);
                const [tooth, site] = k.split('|') as [string, PerioSite];
                // Only measured inputs enter the arithmetic; anything else is not computable, never zero.
                const value =
                  missing.length === 0
                    ? f.inputs.reduce((sum, m) => sum + (inputs.get(m)?.get(k) as number), 0)
                    : null;
                return {
                  tooth,
                  site,
                  status: missing.length === 0 ? 'derived' : 'not_computable',
                  value,
                  missing,
                };
              });
              await tx.query(
                `INSERT INTO cuspatlas.clinical_perio_derived_values (tenant_id, derivation_id, tooth_canonical_ref, site, status,
                 value, missing_inputs)
               SELECT cuspatlas.current_tenant_id(), $1, u.t, u.s, u.st, u.v,
                 CASE WHEN u.mi = '' THEN '{}'::text[] ELSE string_to_array(u.mi, ',') END
               FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[]) AS u(t, s, st, v, mi)`,
                [
                  id,
                  values.map((v) => v.tooth),
                  values.map((v) => v.site),
                  values.map((v) => v.status),
                  values.map((v) => v.value),
                  values.map((v) => v.missing.join(',')),
                ],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PERIO_DERIVATION_RESOURCE,
                  resourceRef: id,
                  resourceVersion: 1,
                },
                { changedFields: ['formulaRef', 'formulaVersion'] },
              );
              return { data: { ref: id }, version: 1 };
            },
          );
          const { rows } = await tx.query<{ exam_id: string }>(
            'SELECT exam_id FROM cuspatlas.clinical_perio_derivations WHERE id = $1',
            [r.data.ref],
          );
          const found = (await derivationsOf(tx, 'id', r.data.ref))[0];
          if (!found || !rows[0]) throw notFound();
          return { ...r, data: found };
        });
      });
    },

    /** One exam with every measurement (current and superseded) and every derivation. A sensitive read. */
    readPerioExam(ctx: ActorContext, perioExamRef: string): Promise<PerioExam> {
      const op = 'clinical.perio.readExam';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { exam } = await examFor(tx, perioExamRef, '');
          const out = await projectExam(tx, exam);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: PERIO_EXAM_RESOURCE,
            resourceRefs: [exam.id],
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** Every exam of the patient (each with its source patient), oldest first. A sensitive read. */
    listPerioExams(ctx: ActorContext, patientRef: string): Promise<readonly PerioExamHeader[]> {
      const op = 'clinical.perio.listExams';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, patientRef, '');
          assertNotMerged(patient);
          const { rows } = await tx.query<ExamRow>(
            `SELECT ${EXAM_COLUMNS} FROM ${EXAM_FROM} WHERE s.subject_patient_id = $1 ORDER BY x.recorded_at, x.id`,
            [patient.id],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: PERIO_EXAM_RESOURCE,
            resourceRefs: [patient.id, ...rows.map((e) => e.id)].slice(0, 100),
            queryFields: [],
          });
          return rows.map(header);
        });
      });
    },

    /**
     * Per-site deltas between two exams of one patient. Unmeasured and absent sites are listed with
     * the reason and excluded from arithmetic; derived deltas (optional) name each formula version.
     */
    comparePerioExams(ctx: ActorContext, query: unknown): Promise<PerioComparisonData> {
      const op = 'clinical.perio.compare';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid<PerioCompareQuery>(validatePerioCompareQuery, query, CLINICAL_PROPERTIES);
        if ((query.formulaRef === undefined) !== (query.formulaVersion === undefined)) {
          throw failedAt(query.formulaRef === undefined ? '/formulaRef' : '/formulaVersion', 'required');
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const base_ = await examById(tx, query.baseExamRef);
          const target = await examById(tx, query.targetExamRef);
          if (!base_ || !target) throw notFound();
          if (target.subject_patient_id !== base_.subject_patient_id) {
            throw failedAt('/targetExamRef', 'examPatientMismatch');
          }
          const [bRows, tRows] = [await measurementsOf(tx, base_.id), await measurementsOf(tx, target.id)];
          const sites = COMPARED.flatMap((m) =>
            compareMaps(currentValues(bRows, m), currentValues(tRows, m), m, 'not_measured'),
          );
          let derived: PerioComparisonData['derived'] = null;
          const formulaVersions: { examRef: string; formulaRef: string; version: number }[] = [];
          if (query.formulaRef !== undefined && query.formulaVersion !== undefined) {
            const version = Number(query.formulaVersion);
            const pick = async (e: ExamRow) =>
              (await derivationsOf(tx, 'exam_id', e.id))
                .filter((d) => d.formula.formulaRef === query.formulaRef && d.formula.version === version)
                .at(-1);
            const [bd, td] = [await pick(base_), await pick(target)];
            if (!bd || !td) {
              throw conflict('derivation_missing', {
                blockingRefs: [
                  ...(bd ? [] : [{ kind: 'perioExam', ref: base_.id }]),
                  ...(td ? [] : [{ kind: 'perioExam', ref: target.id }]),
                ],
              });
            }
            const map = (d: PerioDerivation) =>
              new Map(d.values.map((v) => [`${v.tooth.canonicalRef}|${v.site}`, v.value]));
            derived = {
              formulaRef: query.formulaRef,
              approvalStatus: 'pending',
              label: LABEL,
              sites: compareMaps(map(bd), map(td), 'derived', 'not_computable'),
            };
            formulaVersions.push(
              { examRef: base_.id, formulaRef: bd.formula.formulaRef, version: bd.formula.version },
              { examRef: target.id, formulaRef: td.formula.formulaRef, version: td.formula.version },
            );
          }
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: PERIO_EXAM_RESOURCE,
            resourceRefs: [base_.id, target.id],
            queryFields: Object.keys(query).sort(),
          });
          return {
            patientRef: base_.subject_patient_id,
            baseExamRef: base_.id,
            targetExamRef: target.id,
            sites,
            derived,
            formulaVersions,
          };
        });
      });
    },
  };
}
