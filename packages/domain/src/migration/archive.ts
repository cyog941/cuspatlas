import { createHash } from 'node:crypto';
import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type TenantTransaction,
  validateArchiveEntryQuery,
  validateArchiveHold,
  validateArchiveReferencesQuery,
  validateArchiveRegister,
  validateArchiveRetentionQuery,
  validateArchiveVerify,
} from '@cuspatlas/contracts';
import { canonicalJson } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import {
  assertRef,
  checkEnvelope,
  conflict,
  loadPackage,
  type MigrationBase,
  notFound,
  validate,
} from './base';

/**
 * M7 retention policy (recommended-pending-approval; the lawful arrangement is M-S2's): an archive
 * package is retained at least this long from registration, and never deleted while held.
 */
export const ARCHIVE_RETENTION_POLICY = 'archive-retention.pending-approval.1';
export const ARCHIVE_RETENTION_YEARS = 10;
const ARCHIVE_ACTIONS = ['historicalReference', 'sourceArchive'];

type ArchiveState = 'verified' | 'partial' | 'failed';
interface EntryRow extends Record<string, unknown> {
  id: string;
  archive_id: string;
  archive_version: number;
  patient_id: string | null;
  entity: string;
  source_id: string | null;
  time_precision: string;
  content: Record<string, string | null>;
  digest: string;
  state: ArchiveState;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const entryDigest = (e: {
  entity: string;
  source_id: string | null;
  time_precision: string;
  patient_id: string | null;
  content: unknown;
}) =>
  sha256(
    canonicalJson({
      entity: e.entity,
      sourceId: e.source_id,
      timePrecision: e.time_precision,
      patientRef: e.patient_id,
      content: e.content,
    }),
  );

const reference = (r: EntryRow) => ({
  entryRef: r.id,
  archiveRef: r.archive_id,
  archiveVersion: r.archive_version,
  entity: r.entity,
  sourceId: r.source_id,
  timePrecision: r.time_precision,
  state: r.state,
  readOnly: true as const,
});

const ENTRY_SELECT = `SELECT e.id, e.archive_id, p.archive_version, e.patient_id, e.entity, e.source_id, e.time_precision,
    e.content, e.digest, p.state
  FROM cuspatlas.migration_archive_entries e JOIN cuspatlas.migration_archive_packages p ON p.id = e.archive_id`;

async function loadArchive(tx: TenantTransaction, archiveRef: string, lock = false) {
  assertRef(archiveRef);
  const { rows } = await tx.query<{ id: string; version: number; retain_until: Date; entry_count: number }>(
    `SELECT id, version, retain_until, entry_count FROM cuspatlas.migration_archive_packages WHERE id = $1
     ${lock ? 'FOR UPDATE' : ''}`,
    [archiveRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * M7 historical archive packages. Archive content is a copy of source rows that M3 applied only as
 * archive references; no function here writes a live clinical, scheduling or financial table. Reads
 * are patient-scoped (the linked patient must be named) and sensitive-read logged.
 */
export function createArchiveOperations(base: MigrationBase) {
  const { deps, execute } = base;
  const readsPatients = async (
    ctx: ActorContext,
    op: 'migration.archive.references' | 'migration.archive.read',
  ) => {
    await base.authorize(ctx, op);
    // Archive content is patient history: the caller must also hold the patient read scope.
    await deps.authorize(ctx, 'patients.read', { tenantId: ctx.tenantId, id: 'archive' });
  };
  return {
    registerArchive(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<
      CommandResult<{
        archiveRef: string;
        archiveVersion: number;
        state: ArchiveState;
        entryCount: number;
        archiveDigest: string;
      }>
    > {
      const op = 'migration.archive.register';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ packageRef: string }>(validateArchiveRegister, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, p.packageRef, 'FOR UPDATE');
          return execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<{
              applied_id: string;
              patient_id: string | null;
              entity: string;
              source_id: string | null;
              time_precision: string;
              content: Record<string, string | null>;
            }>(
              `SELECT a.id AS applied_id, a.patient_id, s.entity, s.source_id, a.time_precision, s.payload AS content
               FROM cuspatlas.migration_applied_records a
               JOIN cuspatlas.migration_staged_records s ON s.id = a.staged_record_id
               WHERE a.package_id = $1 AND a.action = ANY ($2::text[]) ORDER BY s.entity, s.row_no`,
              [pkg.id, ARCHIVE_ACTIONS],
            );
            if (rows.length === 0) throw conflict('no_archive_references');
            const entries = rows.map((r) => ({ ...r, digest: entryDigest(r) }));
            const archiveDigest = sha256(canonicalJson(entries.map((e) => [e.applied_id, e.digest]).sort()));
            const { rows: ins } = await tx.query<{ id: string; archive_version: number }>(
              `INSERT INTO cuspatlas.migration_archive_packages (tenant_id, package_id, archive_version, state,
                 archive_digest, entry_count, retention_policy, retain_until, registered_by)
               SELECT cuspatlas.current_tenant_id(), $1, coalesce(max(archive_version), 0) + 1, 'verified', $2, $3, $4,
                 now() + make_interval(years => $5), cuspatlas.current_actor_id()
               FROM cuspatlas.migration_archive_packages WHERE package_id = $1
               RETURNING id, archive_version`,
              [pkg.id, archiveDigest, entries.length, ARCHIVE_RETENTION_POLICY, ARCHIVE_RETENTION_YEARS],
            );
            const archive = ins[0];
            if (!archive) throw new Error('archive insert returned no row');
            for (const e of entries) {
              await tx.query(
                `INSERT INTO cuspatlas.migration_archive_entries (tenant_id, archive_id, applied_record_id, patient_id,
                   entity, source_id, time_precision, content, digest)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  archive.id,
                  e.applied_id,
                  e.patient_id,
                  e.entity,
                  e.source_id,
                  e.time_precision,
                  e.content,
                  e.digest,
                ],
              );
            }
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'migrationArchive',
                resourceRef: archive.id,
                resourceVersion: 1,
              },
              { changedFields: ['entries'] },
            );
            return {
              data: {
                archiveRef: archive.id,
                archiveVersion: archive.archive_version,
                state: 'verified' as const,
                entryCount: entries.length,
                archiveDigest,
              },
              version: 1,
            };
          });
        });
      });
    },

    /** Recomputes every entry digest: `verified`, `partial` (unreadable entries enumerated) or `failed`. */
    verifyArchive(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'migration.archive.verify';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ archiveRef: string }>(validateArchiveVerify, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const archive = await loadArchive(tx, p.archiveRef, true);
          const { rows } = await tx.query<EntryRow>(`${ENTRY_SELECT} WHERE e.archive_id = $1 ORDER BY e.id`, [
            archive.id,
          ]);
          const unreadable = rows.filter((r) => entryDigest(r) !== r.digest).map((r) => r.id);
          const state: ArchiveState =
            rows.length !== archive.entry_count || (rows.length > 0 && unreadable.length === rows.length)
              ? 'failed'
              : unreadable.length > 0
                ? 'partial'
                : 'verified';
          await tx.query(
            `UPDATE cuspatlas.migration_archive_packages SET state = $2, verified_at = now(), version = version + 1
             WHERE id = $1`,
            [archive.id, state],
          );
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'migrationArchive',
              resourceRef: archive.id,
              resourceVersion: archive.version + 1,
            },
            { changedFields: ['state'] },
          );
          return {
            data: { archiveRef: archive.id, state, entryCount: rows.length, unreadableEntries: unreadable },
          };
        });
      });
    },

    /** Read-only archive references of one visible patient; an explicit empty list when there are none. */
    listArchiveReferences(ctx: ActorContext, query: unknown) {
      const op = 'migration.archive.references';
      return base.guarded(ctx, op, async () => {
        await readsPatients(ctx, op);
        validate<{ patientRef: string }>(validateArchiveReferencesQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const seen = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [query.patientRef]);
          if (seen.rows.length === 0) throw notFound();
          const { rows } = await tx.query<EntryRow>(
            `${ENTRY_SELECT} WHERE e.patient_id = $1 ORDER BY p.archive_version, e.entity, e.source_id, e.id LIMIT 10000`,
            [query.patientRef],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'migrationArchive',
            resourceRefs: [query.patientRef],
            queryFields: ['patientRef'],
          });
          return { data: rows.map(reference) };
        });
      });
    },

    /** One entry's source row, for its linked patient only; refused when unreadable or the package failed. */
    readArchiveEntry(ctx: ActorContext, query: unknown) {
      const op = 'migration.archive.read';
      return base.guarded(ctx, op, async () => {
        await readsPatients(ctx, op);
        validate<{ entryRef: string; patientRef: string }>(validateArchiveEntryQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<EntryRow>(`${ENTRY_SELECT} WHERE e.id = $1 AND e.patient_id = $2`, [
            query.entryRef,
            query.patientRef,
          ]);
          const row = rows[0];
          if (!row) throw notFound();
          if (row.state === 'failed') throw conflict('archive_unavailable');
          if (entryDigest(row) !== row.digest) throw conflict('archive_entry_unreadable');
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'migrationArchive',
            resourceRefs: [row.id],
            queryFields: ['entryRef', 'patientRef'],
          });
          return { data: { ...reference(row), content: row.content } };
        });
      });
    },

    /** Places or releases (once) a legal hold on one archive package; a held package is never deleted. */
    recordArchiveHold(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ holdRef: string; action: 'place' | 'release' }>> {
      const op = 'migration.archive.holds.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ archiveRef: string; action: 'place' | 'release'; holdRef?: string; reasonCode: string }>(
          validateArchiveHold,
          p,
        );
        return deps.withTenantTransaction(ctx, async (tx) => {
          const archive = await loadArchive(tx, p.archiveRef);
          return execute(ctx, envelope, tx, async () => {
            let holdRef: string;
            if (p.action === 'place') {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.migration_archive_holds (tenant_id, archive_id, reason_code, placed_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id()) RETURNING id`,
                [archive.id, p.reasonCode],
              );
              holdRef = rows[0]?.id as string;
            } else {
              if (p.holdRef === undefined) throw conflict('hold_not_active');
              const { rows } = await tx.query<{ id: string }>(
                `UPDATE cuspatlas.migration_archive_holds SET released_by = cuspatlas.current_actor_id(),
                   released_at = now(), release_reason = $3
                 WHERE id = $1 AND archive_id = $2 AND released_at IS NULL RETURNING id`,
                [p.holdRef, archive.id, p.reasonCode],
              );
              if (!rows[0]) throw conflict('hold_not_active');
              holdRef = rows[0].id;
            }
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'migrationArchiveHold',
                resourceRef: holdRef,
                resourceVersion: p.action === 'place' ? 1 : 2,
              },
              { changedFields: [p.action === 'place' ? 'placedAt' : 'releasedAt'] },
            );
            return { data: { holdRef, action: p.action }, version: p.action === 'place' ? 1 : 2 };
          });
        });
      });
    },

    /** Whether the package may be disposed of: never while held (archive or I8 patient hold) or retained. */
    evaluateArchiveRetention(ctx: ActorContext, query: unknown) {
      const op = 'migration.archive.retention.evaluate';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ archiveRef: string }>(validateArchiveRetentionQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const archive = await loadArchive(tx, query.archiveRef);
          const { rows } = await tx.query<{ held: boolean; retained: boolean }>(
            `SELECT (EXISTS (SELECT 1 FROM cuspatlas.migration_archive_holds h WHERE h.archive_id = $1
                       AND h.released_at IS NULL)
                     OR EXISTS (SELECT 1 FROM cuspatlas.migration_archive_entries e
                       JOIN cuspatlas.imaging_legal_holds l ON l.subject_kind = 'patient' AND l.subject_ref = e.patient_id
                         AND l.released_at IS NULL
                       WHERE e.archive_id = $1)) AS held,
                    $2::timestamptz > now() AS retained`,
            [archive.id, archive.retain_until],
          );
          const reasons: ('legal_hold' | 'retention_period')[] = [];
          if (rows[0]?.held) reasons.push('legal_hold');
          if (rows[0]?.retained) reasons.push('retention_period');
          return {
            data: {
              archiveRef: archive.id,
              eligible: reasons.length === 0,
              reasons,
              retainUntil: archive.retain_until.toISOString(),
              policyVersion: ARCHIVE_RETENTION_POLICY,
            },
          };
        });
      });
    },
  };
}
