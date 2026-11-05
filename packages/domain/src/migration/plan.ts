import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type PatientCreate,
  type ReviewCategory,
  type ReviewDecision,
  type TenantTransaction,
  validateImportApply,
  validatePackageQuery,
  validatePatientCreate,
} from '@cuspatlas/contracts';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { createMatchKeyer, MATCH_KEY } from '../patients/model';
import { LEGACY_APPOINTMENT_STATUS, SOURCE_ADAPTERS } from './adapter';
import {
  bumpChange,
  checkEnvelope,
  conflict,
  loadPackage,
  MIGRATION_PACKAGE_RESOURCE,
  type MigrationBase,
  type PackageRow,
  validate,
} from './base';

/**
 * M3: the import plan (a pure function of the staged rows, the review decisions and the adapter, so a
 * dry run writes nothing) and its staged application. Every applied source record is one
 * `migration_applied_records` row (unique per staged record): a re-run applies nothing twice and a
 * crashed run resumes from the same plan. Patients are created only through S4 `createPatient`.
 */
export type ApplyAction =
  | 'createPatient'
  | 'linkPatient'
  | 'historicalReference'
  | 'sourceArchive'
  | 'openingBalance'
  | 'unappliedCredit'
  | 'openClaimReference';

export interface StagedRecord extends Record<string, unknown> {
  id: string;
  entity: string;
  row_no: number;
  source_id: string | null;
  mapped: boolean;
  payload: Record<string, string>;
  issue_code: string | null;
}

interface PlanItemRow extends Record<string, unknown> {
  id: string;
  category: ReviewCategory;
  entity: string;
  field: string | null;
  staged_record_ids: string[];
  state: 'open' | 'resolved';
  decision: ReviewDecision | null;
  decision_patient_id: string | null;
}

export interface PlannedEntry {
  readonly staged: StagedRecord;
  readonly kind: 'action' | 'excluded' | 'blocked';
  readonly action?: ApplyAction;
  readonly code?: string;
  /** Source id of the patient a dependent row belongs to. */
  readonly patientSource?: string;
  /** linkPatient: the existing patient staff named. */
  readonly linkPatient?: string;
  /** Monetary review accepted as the adapter proposed (M5). */
  readonly accepted?: boolean;
}

export interface ImportPlanView {
  readonly packageRef: string;
  readonly planDigest: string;
  readonly counts: readonly {
    entity: string;
    staged: number;
    planned: number;
    applied: number;
    excluded: number;
    blocked: number;
  }[];
  readonly exceptions: readonly { code: string; entity: string; stagedRef: string; requiredAction: string }[];
}

export interface ImportApplySummary {
  readonly packageRef: string;
  readonly planDigest: string;
  readonly appliedThisBatch: number;
  readonly alreadyApplied: number;
  readonly remaining: number;
  readonly blocked: number;
  readonly excluded: number;
  readonly state: 'partial' | 'complete';
}

/** Decides financial rows (M5); without it they stay blocked. */
export type FinancialPlanner = (
  staged: StagedRecord,
  ctx: {
    accepted: boolean;
    patient: PlannedEntry | undefined;
    currency: string;
    seen: Set<string>;
    /** Posted opening balances of the tenant: `patient|currency|day` -> staged record (H2 M-1). */
    existing: ReadonlyMap<string, string>;
  },
) => Omit<PlannedEntry, 'staged'>;

export const ENTITY_ORDER = [
  'patients',
  'appointments',
  'procedures',
  'ledger_balances',
  'unapplied_credits',
  'open_claims',
];
const orderOf = (e: string) => {
  const i = ENTITY_ORDER.indexOf(e);
  return i < 0 ? ENTITY_ORDER.length : i;
};
const FINANCIAL = new Set(['ledger_balances', 'unapplied_credits', 'open_claims']);
export const MIGRATION_IDENTIFIER_ISSUER = 'cuspatlas-migration';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const YEAR = /^\d{4}$/;

/** A real calendar day that Postgres `date` accepts (H2 M-1: `2026-02-30` passes the shape, not the cast). */
export function realDay(v: string): boolean {
  if (!DAY.test(v) || v < '0001-01-01') return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The S4 create body of one staged patient (validated with the S4 contract), or null when invalid. */
export function patientCreateOf(row: StagedRecord, sourceSystem: string): PatientCreate | null {
  const p = row.payload;
  const given = (p.first_name ?? '').trim();
  const family = (p.last_name ?? '').trim();
  const birth = (p.birth_date ?? '').trim();
  const precision = DAY.test(birth) ? 'day' : MONTH.test(birth) ? 'month' : YEAR.test(birth) ? 'year' : null;
  if (birth !== '' && precision === null) return null;
  if (precision === 'day' && !realDay(birth)) return null;
  if (precision === 'month' && !realDay(`${birth}-01`)) return null;
  const phone = (p.phone ?? '').trim();
  const body: PatientCreate = {
    legalName: given && family ? { known: true, given, family } : { known: false, reason: 'not_provided' },
    birthDate: precision
      ? { known: true, value: birth, precision }
      : { known: false, reason: 'not_provided' },
    ...(phone
      ? {
          contact: {
            known: true,
            points: [{ channel: 'phone', use: 'home', value: phone, preference: 'preferred' }],
          },
        }
      : {}),
    identifiers: [
      { type: 'prior_system', issuer: sourceSystem, value: row.source_id as string },
      // The staged record itself: lets a resumed run find the patient it already created.
      { type: 'external_record', issuer: MIGRATION_IDENTIFIER_ISSUER, value: row.id },
    ],
    provenance: {
      legalName: 'migration_import',
      birthDate: 'migration_import',
      identifiers: 'migration_import',
      ...(phone ? { contact: 'migration_import' as const } : {}),
    },
  };
  return validatePatientCreate(body) ? body : null;
}

const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z.includes('/');
  } catch {
    return false;
  }
};
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

export async function loadStaged(tx: TenantTransaction, packageId: string): Promise<StagedRecord[]> {
  const { rows } = await tx.query<StagedRecord>(
    `SELECT id, entity, row_no, source_id, mapped, payload, issue_code FROM cuspatlas.migration_staged_records
     WHERE package_id = $1 ORDER BY entity, row_no`,
    [packageId],
  );
  return rows.sort(
    (a, b) =>
      orderOf(a.entity) - orderOf(b.entity) ||
      (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : a.row_no - b.row_no),
  );
}

export interface ComputedPlan {
  readonly entries: readonly PlannedEntry[];
  readonly digest: string;
  readonly patientsBySource: ReadonlyMap<string, PlannedEntry>;
}

/** The deterministic plan of one package (reads only). */
export async function computePlan(
  tx: TenantTransaction,
  pkg: PackageRow,
  currency: string,
  financial: FinancialPlanner | null,
): Promise<ComputedPlan> {
  const staged = await loadStaged(tx, pkg.id);
  const { rows: items } = await tx.query<PlanItemRow>(
    `SELECT id, category, entity, field, staged_record_ids, state, decision, decision_patient_id
     FROM cuspatlas.migration_review_items WHERE package_id = $1 ORDER BY id`,
    [pkg.id],
  );
  const byRecord = new Map<string, PlanItemRow[]>();
  const entityItems = new Map<string, PlanItemRow[]>();
  for (const i of items) {
    if (i.category === 'unknown_field' || i.category === 'unmapped_entity') {
      entityItems.set(i.entity, [...(entityItems.get(i.entity) ?? []), i]);
      if (i.category === 'unknown_field') continue;
    }
    for (const id of i.staged_record_ids) byRecord.set(id, [...(byRecord.get(id) ?? []), i]);
  }
  // A linked existing patient merged since the decision is followed to its survivor (H2 M-4).
  const linked = [...new Set(items.flatMap((i) => (i.decision_patient_id ? [i.decision_patient_id] : [])))];
  const survivorOf = new Map<string, string>();
  if (linked.length > 0) {
    const { rows: chain } = await tx.query<{ start: string; id: string }>(
      `WITH RECURSIVE c (start, id, depth) AS (
         SELECT p.id, p.id, 0 FROM cuspatlas.patients p WHERE p.id = ANY ($1::uuid[])
         UNION ALL
         SELECT c.start, p.merged_into, c.depth + 1 FROM c JOIN cuspatlas.patients p ON p.id = c.id
         WHERE p.merged_into IS NOT NULL AND c.depth < 32)
       SELECT DISTINCT ON (start) start::text, id::text FROM c ORDER BY start, depth DESC`,
      [linked],
    );
    for (const r of chain) survivorOf.set(r.start, r.id);
  }
  const existing = new Map<string, string>();
  if (financial) {
    const { rows: posted } = await tx.query<{ k: string; staged_record_id: string }>(
      `SELECT patient_id::text || '|' || currency || '|' || to_char(coalesce(as_of, '1900-01-01'::date), 'YYYY-MM-DD') AS k,
         staged_record_id::text AS staged_record_id
       FROM cuspatlas.migration_opening_items WHERE kind = 'balance'`,
    );
    for (const r of posted) existing.set(r.k, r.staged_record_id);
  }
  const patients = new Map<string, PlannedEntry>();
  const seen = new Set<string>();
  const entries: PlannedEntry[] = [];
  const blocked = (s: StagedRecord, code: string): PlannedEntry => ({ staged: s, kind: 'blocked', code });
  const excluded = (s: StagedRecord, code: string): PlannedEntry => ({ staged: s, kind: 'excluded', code });
  const dependent = (s: StagedRecord): PlannedEntry | { patientSource: string } => {
    const ref = s.payload.patient_id ?? '';
    const pe = patients.get(ref);
    if (!pe) return excluded(s, 'unknown_patient');
    if (pe.kind === 'blocked') return blocked(s, 'patient_blocked');
    if (pe.kind === 'excluded') return excluded(s, 'patient_excluded');
    return { patientSource: ref };
  };
  for (const s of staged) {
    const own = byRecord.get(s.id) ?? [];
    const scoped = entityItems.get(s.entity) ?? [];
    let entry: PlannedEntry;
    if (!s.mapped) {
      const d = scoped.find((i) => i.category === 'unmapped_entity');
      entry =
        !d || d.state === 'open'
          ? blocked(s, 'review_open')
          : d.decision === 'archiveOnly'
            ? { staged: s, kind: 'action', action: 'sourceArchive' }
            : excluded(s, 'excluded_by_review');
    } else if (own.some((i) => i.state === 'open') || scoped.some((i) => i.state === 'open')) {
      entry = blocked(s, 'review_open');
    } else if (own.some((i) => i.decision === 'exclude') || s.issue_code !== null) {
      entry = excluded(s, s.issue_code ?? 'excluded_by_review');
    } else if (s.entity === 'patients') {
      const identity = own.find((i) => i.category === 'identity');
      if (identity?.decision === 'sameAsExisting' && identity.decision_patient_id)
        entry = {
          staged: s,
          kind: 'action',
          action: 'linkPatient',
          linkPatient: survivorOf.get(identity.decision_patient_id) ?? identity.decision_patient_id,
        };
      else
        entry = patientCreateOf(s, pkg.source_system)
          ? { staged: s, kind: 'action', action: 'createPatient' }
          : excluded(s, 'validation_failed');
    } else {
      const dep = dependent(s);
      if ('staged' in dep) entry = dep;
      else if (FINANCIAL.has(s.entity)) {
        entry = financial
          ? {
              staged: s,
              ...financial(s, {
                accepted: own.some((i) => i.decision === 'acceptProposal'),
                patient: patients.get(dep.patientSource),
                currency,
                seen,
                existing,
              }),
              patientSource: dep.patientSource,
            }
          : blocked(s, 'financial_mapping_pending');
      } else if (own.some((i) => i.decision === 'archiveOnly' && i.category === 'future_appointment')) {
        entry = { staged: s, kind: 'action', action: 'sourceArchive', patientSource: dep.patientSource };
      } else if (s.entity === 'appointments') {
        const p = s.payload;
        const ok =
          LOCAL_MINUTE.test(p.start_local ?? '') &&
          validZone(p.time_zone ?? '') &&
          /^\d{1,3}$/.test(p.duration_min ?? '');
        entry = ok
          ? { staged: s, kind: 'action', action: 'historicalReference', patientSource: dep.patientSource }
          : excluded(s, 'validation_failed');
      } else if (s.entity === 'procedures') {
        // Only a reviewed legacy code (archive only) becomes a historical reference.
        const reviewed = own.some((i) => i.category === 'terminology' && i.decision === 'archiveOnly');
        entry =
          reviewed && DAY.test(s.payload.service_date ?? '')
            ? { staged: s, kind: 'action', action: 'historicalReference', patientSource: dep.patientSource }
            : reviewed
              ? excluded(s, 'validation_failed')
              : blocked(s, 'review_open');
      } else entry = blocked(s, 'review_open');
    }
    if (s.entity === 'patients' && s.source_id && entry.kind !== 'excluded') patients.set(s.source_id, entry);
    else if (s.entity === 'patients' && s.source_id && !patients.has(s.source_id))
      patients.set(s.source_id, entry);
    entries.push(entry);
  }
  const adapter = SOURCE_ADAPTERS[pkg.format as keyof typeof SOURCE_ADAPTERS];
  const digest = sha256Hex(
    canonicalJson({
      adapter: `${adapter.format}@${adapter.adapterVersion}`,
      packageDigest: pkg.package_digest,
      entries: entries.map((e) => [
        e.staged.id,
        e.kind,
        e.action ?? null,
        e.code ?? null,
        e.linkPatient ?? null,
      ]),
    }),
  );
  return { entries, digest, patientsBySource: patients };
}

const REQUIRED_ACTION: Readonly<Record<string, string>> = {
  review_open: 'resolve_review_item',
  patient_blocked: 'resolve_patient_review_item',
  financial_mapping_pending: 'await_financial_mapping',
  validation_failed: 'correct_source_and_reintake',
  unknown_patient: 'correct_source_and_reintake',
  patient_excluded: 'none_patient_excluded',
  excluded_by_review: 'none_excluded_by_staff',
  duplicate_opening: 'correct_source_and_reintake',
  zero_amount: 'none_zero_amount',
  missing_source_id: 'correct_source_and_reintake',
  duplicate_source_id: 'correct_source_and_reintake',
};

export interface AppliedRow extends Record<string, unknown> {
  staged_record_id: string;
  action: ApplyAction;
  patient_id: string | null;
}

export async function loadApplied(
  tx: TenantTransaction,
  packageId: string,
): Promise<Map<string, AppliedRow>> {
  const { rows } = await tx.query<AppliedRow>(
    'SELECT staged_record_id, action, patient_id FROM cuspatlas.migration_applied_records WHERE package_id = $1',
    [packageId],
  );
  return new Map(rows.map((r) => [r.staged_record_id, r]));
}

export function planView(
  pkg: PackageRow,
  plan: ComputedPlan,
  applied: ReadonlyMap<string, AppliedRow>,
): ImportPlanView {
  const counts = new Map<
    string,
    { entity: string; staged: number; planned: number; applied: number; excluded: number; blocked: number }
  >();
  const exceptions: ImportPlanView['exceptions'][number][] = [];
  for (const e of plan.entries) {
    const c = counts.get(e.staged.entity) ?? {
      entity: e.staged.entity,
      staged: 0,
      planned: 0,
      applied: 0,
      excluded: 0,
      blocked: 0,
    };
    c.staged += 1;
    if (e.kind === 'action') {
      c.planned += 1;
      if (applied.has(e.staged.id)) c.applied += 1;
    } else {
      c[e.kind] += 1;
      if (exceptions.length < 500)
        exceptions.push({
          code: e.code ?? 'unknown',
          entity: e.staged.entity,
          stagedRef: e.staged.id,
          requiredAction: REQUIRED_ACTION[e.code ?? ''] ?? 'resolve_review_item',
        });
    }
    counts.set(e.staged.entity, c);
  }
  return { packageRef: pkg.id, planDigest: plan.digest, counts: [...counts.values()], exceptions };
}

export interface ApplyHooks {
  readonly financial: FinancialPlanner | null;
  /** M5: posts one financial opening fact in the apply transaction; returns the target reference. */
  postFinancial?(
    tx: TenantTransaction,
    entry: PlannedEntry,
    patientId: string,
    pkg: PackageRow,
  ): Promise<{
    targetKind: string;
    targetRef: string | null;
    detail: Record<string, unknown>;
    precision: string;
  }>;
  readonly currency: (tx: TenantTransaction) => Promise<string>;
}

const PRECISION_OF = (e: PlannedEntry): string => {
  if (e.action === 'createPatient' || e.action === 'linkPatient' || e.action === 'sourceArchive')
    return 'none';
  if (e.staged.entity === 'appointments') return 'minute';
  if (e.staged.entity === 'procedures') return 'day';
  return 'unknown';
};

export function createImportOperations(base: MigrationBase, hooks: ApplyHooks) {
  const { deps } = base;
  return {
    planImport(ctx: ActorContext, query: unknown): Promise<ImportPlanView> {
      const op = 'migration.imports.plan';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ packageRef: string }>(validatePackageQuery, query);
        // A dry run: reads only (no sensitive-read row either; the plan carries references and codes,
        // never source values), so every table is unchanged afterwards.
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, query.packageRef);
          const plan = await computePlan(tx, pkg, await hooks.currency(tx), hooks.financial);
          return planView(pkg, plan, await loadApplied(tx, pkg.id));
        });
      });
    },

    applyImport(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ImportApplySummary>> {
      const op = 'migration.imports.apply';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ packageRef: string; expectedPlanDigest: string; batchSize?: number }>(
          validateImportApply,
          p,
        );
        const batchSize = p.batchSize ?? 50;
        const keyer = createMatchKeyer(deps.matchKeyPepper, ctx.tenantId);
        // One transaction (H2 M-4): the plan digest is re-checked under the package lock, and S4 patients
        // are created in the same transaction as their applied rows, so a refused or crashed run can
        // never leave an orphan patient. A patient left by a run before this rule is adopted by its
        // per-record identifier instead of being created twice.
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, p.packageRef, 'FOR UPDATE');
          const plan = await computePlan(tx, pkg, await hooks.currency(tx), hooks.financial);
          if (plan.digest !== p.expectedPlanDigest) throw conflict('plan_digest_changed');
          const before = await loadApplied(tx, pkg.id);
          const picked = {
            pkg,
            batch: plan.entries
              .filter((e) => e.kind === 'action' && !before.has(e.staged.id))
              .slice(0, batchSize),
          };
          // The run row of this transaction: the database lets opening items be written only inside one.
          if (picked.batch.length > 0)
            await tx.query(
              `INSERT INTO cuspatlas.migration_apply_runs (tenant_id, package_id, plan_digest, started_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())`,
              [pkg.id, plan.digest],
            );
          const created = new Map<string, string>();
          for (const e of picked.batch.filter((x) => x.action === 'createPatient')) {
            const key = keyer.key(
              MATCH_KEY.identifier,
              `external_record|${MIGRATION_IDENTIFIER_ISSUER}|${e.staged.id}`,
            );
            const { rows: found } = await tx.query<{ id: string }>(
              'SELECT id FROM cuspatlas.patients WHERE match_keys @> ARRAY[$1]::text[] ORDER BY created_at LIMIT 1',
              [key],
            );
            if (found[0]) {
              created.set(e.staged.id, found[0].id);
              continue;
            }
            const body = patientCreateOf(e.staged, pkg.source_system);
            if (!body) throw new Error('planned patient no longer validates');
            const r = await deps.patients.createPatient(
              ctx,
              { operation: 'patients.create', idempotencyKey: `mig.${e.staged.id}`, payload: body },
              tx,
            );
            created.set(e.staged.id, r.data.patientRef);
          }
          // A linked patient is locked against a concurrent merge; the plan already followed any merge.
          for (const e of picked.batch.filter((x) => x.action === 'linkPatient')) {
            const { rows: lp } = await tx.query<{ merged_into: string | null }>(
              'SELECT merged_into FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
              [e.linkPatient],
            );
            if (!lp[0] || lp[0].merged_into !== null) throw conflict('plan_digest_changed');
          }
          const patientOf = new Map<string, string>();
          for (const e of plan.entries) {
            const a = before.get(e.staged.id);
            if (e.staged.entity === 'patients' && e.staged.source_id && a?.patient_id)
              patientOf.set(e.staged.source_id, a.patient_id);
          }
          let inserted = 0;
          const insertedIds = new Set<string>();
          const adapter = SOURCE_ADAPTERS[pkg.format as keyof typeof SOURCE_ADAPTERS];
          for (const e of picked.batch) {
            if (before.has(e.staged.id)) continue;
            let patientId: string | null = null;
            let targetKind = 'sourceArchive';
            let targetRef: string | null = null;
            let detail: Record<string, unknown> = {};
            let precision = PRECISION_OF(e);
            if (e.action === 'createPatient' || e.action === 'linkPatient') {
              patientId =
                e.action === 'createPatient' ? (created.get(e.staged.id) ?? null) : (e.linkPatient ?? null);
              if (!patientId) continue;
              targetKind = 'patient';
              targetRef = patientId;
              if (e.staged.source_id) patientOf.set(e.staged.source_id, patientId);
            } else {
              patientId = e.patientSource ? (patientOf.get(e.patientSource) ?? null) : null;
              if (e.patientSource && !patientId) continue; // its patient is applied in a later batch
              if (e.action === 'historicalReference') {
                const s = e.staged.payload;
                targetKind =
                  e.staged.entity === 'appointments' ? 'historicalAppointment' : 'historicalProcedure';
                detail =
                  e.staged.entity === 'appointments'
                    ? {
                        startLocal: s.start_local,
                        timeZone: s.time_zone,
                        durationMinutes: Number(s.duration_min),
                        legacyStatus: s.status,
                        statusMeaning: LEGACY_APPOINTMENT_STATUS[s.status ?? ''] ?? 'unmappedLegacyStatus',
                      }
                    : { serviceDate: s.service_date, legacyCode: s.legacy_code, legacyFeeMinor: s.fee_minor };
              } else if (e.action !== 'sourceArchive') {
                if (!hooks.postFinancial || !patientId) continue;
                const f = await hooks.postFinancial(tx, e, patientId, pkg);
                targetKind = f.targetKind;
                targetRef = f.targetRef;
                detail = f.detail;
                precision = f.precision;
              }
            }
            const { rowCount } = await tx.query(
              `INSERT INTO cuspatlas.migration_applied_records (tenant_id, package_id, staged_record_id, action, target_kind,
                 target_ref, patient_id, source_system, source_id, time_precision, provenance, detail, applied_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, cuspatlas.current_actor_id())
               ON CONFLICT (staged_record_id) DO NOTHING`,
              [
                pkg.id,
                e.staged.id,
                e.action,
                targetKind,
                targetRef,
                patientId,
                pkg.source_system,
                e.staged.source_id,
                precision,
                JSON.stringify({
                  adapter: `${adapter.format}@${adapter.adapterVersion}`,
                  sourceSystem: pkg.source_system,
                  sourceId: e.staged.source_id,
                  sourceEntity: e.staged.entity,
                  packageDigest: pkg.package_digest,
                  mappingConfidence: 'validated',
                }),
                JSON.stringify(detail),
              ],
            );
            if ((rowCount ?? 0) > 0) insertedIds.add(e.staged.id);
            inserted += rowCount ?? 0;
          }
          let version = pkg.version;
          if (inserted > 0) {
            version = await bumpChange(tx, pkg.id);
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: MIGRATION_PACKAGE_RESOURCE,
                resourceRef: pkg.id,
                resourceVersion: version,
              },
              { changedFields: ['appliedRecords'] },
            );
          }
          const actions = plan.entries.filter((e) => e.kind === 'action').length;
          const blocked = plan.entries.filter((e) => e.kind === 'blocked').length;
          const excluded = plan.entries.filter((e) => e.kind === 'excluded').length;
          const done = plan.entries.filter(
            (e) => e.kind === 'action' && (before.has(e.staged.id) || insertedIds.has(e.staged.id)),
          ).length;
          const remaining = actions - done;
          return {
            data: {
              packageRef: pkg.id,
              planDigest: plan.digest,
              appliedThisBatch: inserted,
              alreadyApplied: before.size,
              remaining,
              blocked,
              excluded,
              state: remaining === 0 && blocked === 0 ? 'complete' : 'partial',
            },
            version,
            correlationId: ctx.correlationId,
            replayed: false,
          };
        });
      });
    },
  };
}
