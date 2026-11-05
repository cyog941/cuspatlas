import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type PackageIntake,
  type PackageIntakeSummary,
  type PackageStateView,
  type ReviewCategory,
  type ReviewDecision,
  type ReviewItem,
  type ReviewItemResolve,
  type SourceFormat,
  type SourceProfileRegister,
  type TenantTransaction,
  validatePackageIntake,
  validatePackageQuery,
  validateReviewItemListQuery,
  validateReviewItemResolve,
  validateSourceProfileRegister,
} from '@cuspatlas/contracts';
import { loadSettings } from '../billing/base';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { ALLOWED_DECISIONS, parseCsv, type ReviewProposal, SOURCE_ADAPTERS, stageTable } from './adapter';
import {
  assertRef,
  bumpChange,
  checkEnvelope,
  conflict,
  failed,
  isPgError,
  loadPackage,
  MIGRATION_PACKAGE_RESOURCE,
  type MigrationBase,
  notFound,
  validate,
} from './base';

const MAX_ROWS = 5000;

interface ProfileRow extends Record<string, unknown> {
  id: string;
  source_system: string;
  format: SourceFormat;
  practice_ref: string;
  version: number;
  latest: number;
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  package_id: string;
  category: ReviewCategory;
  entity: string;
  field: string | null;
  subject_key: string;
  staged_record_ids: string[];
  proposal: Record<string, unknown>;
  state: 'open' | 'resolved';
  decision: ReviewDecision | null;
  version: number;
}

export const toReviewItem = (r: ItemRow): ReviewItem => ({
  itemRef: r.id,
  category: r.category,
  entity: r.entity,
  field: r.field,
  subjectKey: r.subject_key,
  stagedRefs: r.staged_record_ids,
  proposal: r.proposal,
  state: r.state,
  decision: r.decision,
  allowedDecisions: ALLOWED_DECISIONS[r.category],
});

export const ITEM_COLUMNS = `id, package_id, category, entity, field, subject_key, staged_record_ids, proposal, state,
  decision, version`;

/** Inserts review proposals (one row per category, entity and subject; repeated rows are grouped). */
export async function insertReviews(
  tx: TenantTransaction,
  packageId: string,
  reviews: readonly (ReviewProposal & { entity: string; stagedIds: readonly string[] })[],
): Promise<number> {
  const grouped = new Map<string, { r: ReviewProposal & { entity: string }; ids: string[] }>();
  for (const r of reviews) {
    const key = `${r.category}\u0000${r.entity}\u0000${r.subjectKey}`;
    const g = grouped.get(key) ?? { r, ids: [] };
    g.ids.push(...r.stagedIds);
    grouped.set(key, g);
  }
  if (grouped.size === 0) return 0;
  const rows = [...grouped.values()].map(({ r, ids }) => ({
    category: r.category,
    entity: r.entity,
    field: r.field,
    subject_key: r.subjectKey,
    ids,
    proposal: r.proposal,
  }));
  await tx.query(
    `INSERT INTO cuspatlas.migration_review_items (tenant_id, package_id, category, entity, field, subject_key,
       staged_record_ids, proposal)
     SELECT cuspatlas.current_tenant_id(), $1, r.category, r.entity, r.field, r.subject_key,
       ARRAY(SELECT jsonb_array_elements_text(r.ids))::uuid[], r.proposal
     FROM jsonb_to_recordset($2::jsonb) AS r (category text, entity text, field text, subject_key text, ids jsonb,
       proposal jsonb)
     ON CONFLICT (package_id, category, entity, subject_key) DO NOTHING`,
    [packageId, JSON.stringify(rows)],
  );
  return grouped.size;
}

/** M2: source profiles, package intake and staging, and the staff review queue. */
export interface IntakeHooks {
  /** M4: identity candidates for the staged patients (returns the number of review items added). */
  afterStage(tx: TenantTransaction, packageId: string): Promise<number>;
  /** M4: checks a `sameAsExisting` decision names a live patient of this tenant; returns its id. */
  existingPatient(
    tx: TenantTransaction,
    item: { category: ReviewCategory; proposal?: Record<string, unknown> },
    patientRef: string,
  ): Promise<string>;
}

export function createIntakeOperations(base: MigrationBase, hooks: IntakeHooks) {
  const { deps, execute } = base;
  return {
    registerSourceProfile(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ profileRef: string; profileVersion: number }>> {
      const op = 'migration.sourceProfiles.register';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<SourceProfileRegister>(validateSourceProfileRegister, p);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            // A concurrent registration of the same source system loses the unique (tenant, system, version).
            const { rows } = await tx.query<{ id: string; version: number }>(
              `INSERT INTO cuspatlas.migration_source_profiles (tenant_id, source_system, format, practice_ref, version,
                 created_by)
               SELECT cuspatlas.current_tenant_id(), $1, $2, $3,
                 coalesce((SELECT max(version) FROM cuspatlas.migration_source_profiles WHERE source_system = $1), 0) + 1,
                 cuspatlas.current_actor_id()
               RETURNING id, version`,
              [p.sourceSystem, p.format, p.practiceRef],
            );
            const row = rows[0];
            if (!row) throw new Error('profile insert returned no row');
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'migrationSourceProfile',
                resourceRef: row.id,
                resourceVersion: row.version,
              },
              { changedFields: ['sourceProfile'] },
            );
            return { data: { profileRef: row.id, profileVersion: row.version }, version: row.version };
          }),
        );
      });
    },

    intakePackage(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PackageIntakeSummary>> {
      const op = 'migration.packages.intake';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<PackageIntake>(validatePackageIntake, p);
        assertRef(p.profileRef);
        const pkg = p.package;
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<PackageIntakeSummary>(ctx, envelope, tx, async () => {
            const { rows: profiles } = await tx.query<ProfileRow>(
              `SELECT s.id, s.source_system, s.format, s.practice_ref, s.version,
                 (SELECT max(version) FROM cuspatlas.migration_source_profiles x WHERE x.source_system = s.source_system)
                   AS latest
               FROM cuspatlas.migration_source_profiles s WHERE s.id = $1`,
              [p.profileRef],
            );
            const profile = profiles[0];
            if (!profile) throw notFound();
            if (profile.version !== profile.latest) throw conflict('stale_profile');
            if (pkg.format !== profile.format || pkg.sourceSystem !== profile.source_system)
              throw failed('unregistered_source');
            if (
              p.authorisation.practiceRef !== profile.practice_ref ||
              pkg.practiceRef !== profile.practice_ref
            )
              throw failed('cross_practice');
            const packageDigest = sha256Hex(canonicalJson(pkg));
            const { rows: existing } = await tx.query<{ id: string; n: number; r: number }>(
              `SELECT p.id, (SELECT count(*)::int FROM cuspatlas.migration_staged_records s WHERE s.package_id = p.id) AS n,
                 (SELECT count(*)::int FROM cuspatlas.migration_review_items i WHERE i.package_id = p.id) AS r
               FROM cuspatlas.migration_packages p WHERE p.package_digest = $1`,
              [packageDigest],
            );
            const prior = existing[0];
            if (prior) {
              return {
                data: {
                  packageRef: prior.id,
                  state: 'staged',
                  alreadyStaged: true,
                  stagedCount: prior.n,
                  reviewCount: prior.r,
                },
                version: 1,
              };
            }
            // Completeness (M1 subset): every declared entity is present with its declared row count and
            // digest; an undeclared table is refused rather than trusted. Nothing is staged on refusal.
            const declared = new Map(pkg.manifest.entities.map((e) => [e.name, e]));
            if (declared.size !== pkg.manifest.entities.length) throw failed('duplicate_manifest_entity');
            const parsed = new Map<string, { header: string[]; rows: string[][] }>();
            for (const [name, text] of Object.entries(pkg.tables)) {
              const m = declared.get(name);
              if (!m) throw failed('undeclared_entity');
              if (sha256Hex(text) !== m.artifactDigest) throw failed('digest_mismatch');
              let t: { header: string[]; rows: string[][] };
              try {
                t = parseCsv(text);
              } catch {
                throw failed('unreadable_package');
              }
              if (t.rows.length > MAX_ROWS) throw failed('package_too_large');
              if (t.rows.length !== m.declaredCount) throw failed('count_mismatch');
              parsed.set(name, t);
            }
            for (const name of declared.keys()) if (!parsed.has(name)) throw failed('missing_entity');
            const adapter = SOURCE_ADAPTERS[profile.format];
            const settings = await loadSettings(tx);
            const stageCtx = { producedAt: new Date(pkg.producedAt), currency: settings.currency };
            let packageId: string;
            try {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.migration_packages (tenant_id, profile_id, package_digest, manifest_digest,
                   authorisation_ref, produced_at, raw, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
                 RETURNING id`,
                [
                  profile.id,
                  packageDigest,
                  sha256Hex(canonicalJson(pkg.manifest)),
                  p.authorisation.reference,
                  pkg.producedAt,
                  JSON.stringify(pkg),
                ],
              );
              packageId = rows[0]?.id as string;
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('duplicate_intake');
              throw err;
            }
            let stagedCount = 0;
            const reviews: (ReviewProposal & { entity: string; stagedIds: string[] })[] = [];
            for (const [entity, t] of parsed) {
              const { mapped, staged, tableReviews } = stageTable(
                adapter,
                entity,
                t.header,
                t.rows,
                stageCtx,
              );
              const records = staged.map((s) => ({
                row_no: s.rowNo,
                source_id: s.sourceId,
                payload: s.payload,
                payload_digest: sha256Hex(canonicalJson(s.payload)),
                issue_code: s.issueCode,
              }));
              const ids = new Map<number, string>();
              if (records.length > 0) {
                const { rows } = await tx.query<{ id: string; row_no: number }>(
                  `INSERT INTO cuspatlas.migration_staged_records (tenant_id, package_id, entity, row_no, source_id,
                     mapped, payload, payload_digest, issue_code)
                   SELECT cuspatlas.current_tenant_id(), $1, $2, r.row_no, r.source_id, $3, r.payload, r.payload_digest,
                     r.issue_code
                   FROM jsonb_to_recordset($4::jsonb) AS r (row_no int, source_id text, payload jsonb,
                     payload_digest text, issue_code text)
                   RETURNING id, row_no`,
                  [packageId, entity, mapped, JSON.stringify(records)],
                );
                for (const r of rows) ids.set(r.row_no, r.id);
              }
              stagedCount += records.length;
              const all = [...ids.values()];
              for (const r of tableReviews)
                reviews.push({ ...r, entity, stagedIds: r.category === 'unmapped_entity' ? all : [] });
              for (const s of staged)
                for (const r of s.reviews)
                  reviews.push({ ...r, entity, stagedIds: [ids.get(s.rowNo) as string] });
            }
            const extra = await hooks.afterStage(tx, packageId);
            const reviewCount = (await insertReviews(tx, packageId, reviews)) + extra;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: MIGRATION_PACKAGE_RESOURCE,
                resourceRef: packageId,
                resourceVersion: 1,
              },
              { changedFields: ['package', 'stagedRecords', 'reviewItems'] },
            );
            return {
              data: {
                packageRef: packageId,
                state: 'staged',
                alreadyStaged: false,
                stagedCount,
                reviewCount,
              },
              version: 1,
            };
          }),
        );
      });
    },

    readPackage(ctx: ActorContext, query: unknown): Promise<PackageStateView> {
      const op = 'migration.packages.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ packageRef: string }>(validatePackageQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, query.packageRef);
          const { rows } = await tx.query<{
            entity: string;
            mapped: boolean;
            staged: number;
            with_issue: number;
          }>(
            `SELECT entity, bool_and(mapped) AS mapped, count(*)::int AS staged,
               count(*) FILTER (WHERE issue_code IS NOT NULL)::int AS with_issue
             FROM cuspatlas.migration_staged_records WHERE package_id = $1 GROUP BY entity ORDER BY entity`,
            [pkg.id],
          );
          const { rows: open } = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM cuspatlas.migration_review_items WHERE package_id = $1 AND state = 'open'`,
            [pkg.id],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: MIGRATION_PACKAGE_RESOURCE,
            resourceRefs: [pkg.id],
            queryFields: ['packageRef'],
          });
          return {
            packageRef: pkg.id,
            profileRef: pkg.profile_id,
            sourceSystem: pkg.source_system,
            format: pkg.format as SourceFormat,
            packageDigest: pkg.package_digest,
            cutoverState: pkg.cutover_state,
            changeSeq: pkg.change_seq,
            entities: rows.map((r) => ({
              entity: r.entity,
              mapped: r.mapped,
              staged: r.staged,
              withIssue: r.with_issue,
            })),
            openReviewItems: open[0]?.n ?? 0,
          };
        });
      });
    },

    listReviewItems(ctx: ActorContext, query: unknown): Promise<ReviewItem[]> {
      const op = 'migration.reviewItems.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ packageRef: string; state?: 'open' | 'resolved' }>(validateReviewItemListQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, query.packageRef);
          const { rows } = await tx.query<ItemRow>(
            `SELECT ${ITEM_COLUMNS} FROM cuspatlas.migration_review_items
             WHERE package_id = $1 AND ($2::text IS NULL OR state = $2) ORDER BY category, entity, subject_key LIMIT 1000`,
            [pkg.id, query.state ?? null],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: MIGRATION_PACKAGE_RESOURCE,
            resourceRefs: [pkg.id],
            queryFields: query.state ? ['packageRef', 'state'] : ['packageRef'],
          });
          return rows.map(toReviewItem);
        });
      });
    },

    resolveReviewItem(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ itemRef: string; decision: ReviewDecision }>> {
      const op = 'migration.reviewItems.resolve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ReviewItemResolve>(validateReviewItemResolve, p);
        assertRef(p.itemRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, p.packageRef, 'FOR UPDATE');
          return execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<ItemRow>(
              `SELECT ${ITEM_COLUMNS} FROM cuspatlas.migration_review_items WHERE id = $1 AND package_id = $2 FOR UPDATE`,
              [p.itemRef, pkg.id],
            );
            const item = rows[0];
            if (!item) throw notFound();
            if (item.state !== 'open') throw conflict('already_resolved');
            if (!ALLOWED_DECISIONS[item.category].includes(p.decision)) throw failed('decision_not_allowed');
            if (p.decision === 'acceptProposal' && item.proposal.proposedTarget === undefined)
              throw failed('no_proposal');
            let patientId: string | null = null;
            if (p.decision === 'sameAsExisting') {
              if (p.patientRef === undefined) throw failed('patient_required');
              patientId = await hooks.existingPatient(tx, item, p.patientRef);
            } else if (p.patientRef !== undefined) throw failed('patient_not_applicable');
            const { rows: upd } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.migration_review_items SET state = 'resolved', decision = $2, decision_patient_id = $3,
                 reason_code = $4, resolved_by = cuspatlas.current_actor_id(), resolved_at = now(), version = version + 1
               WHERE id = $1 RETURNING version`,
              [item.id, p.decision, patientId, p.reasonCode],
            );
            const version = await bumpChange(tx, pkg.id);
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: MIGRATION_PACKAGE_RESOURCE,
                resourceRef: pkg.id,
                resourceVersion: version,
              },
              { changedFields: ['reviewItem'] },
            );
            return { data: { itemRef: item.id, decision: p.decision }, version: upd[0]?.version ?? 2 };
          });
        });
      });
    },
  };
}
