import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type MergeResult,
  type ReviewCategory,
  type TenantTransaction,
  validateIdentityMerge,
  validateProvenanceQuery,
} from '@cuspatlas/contracts';
import { mergeSet } from '../billing/base';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { scoreCandidate } from '../patients/merge';
import { createMatchKeyer, matchKeys, recordFromCreate } from '../patients/model';
import {
  assertRef,
  bumpChange,
  checkEnvelope,
  conflict,
  failed,
  loadPackage,
  MIGRATION_PACKAGE_RESOURCE,
  type MigrationBase,
  notFound,
  validate,
} from './base';
import { insertReviews } from './intake';
import { loadStaged, patientCreateOf } from './plan';

/**
 * M4: identity, duplicate and provenance reconciliation. Candidates come from S6's own scoring
 * (`scoreCandidate` over the same tenant-bound match keys), within the source package and against
 * existing tenant patients; contact-only overlap (a shared household phone) never qualifies. Nothing
 * is merged automatically: a candidate group is a staff review item, and a merge is S6
 * `mergePatients` with S6's confirmation token, delegated verbatim. No second merge command exists.
 */
type MatchRow = Parameters<typeof scoreCandidate>[0];

interface Pseudo {
  readonly stagedId: string;
  readonly rowNo: number;
  readonly row: MatchRow;
}

const DEFAULT_MIN_SCORE = 40;

async function minScore(tx: TenantTransaction): Promise<number> {
  const { rows } = await tx.query<{ s: number }>(
    'SELECT candidate_min_score AS s FROM cuspatlas.patient_policy_settings',
  );
  return rows[0]?.s ?? DEFAULT_MIN_SCORE;
}

export function createIdentityOperations(base: MigrationBase) {
  const { deps } = base;
  return {
    hooks: {
      /** Adds one identity review item per candidate group of staged patients (no merge, no link). */
      async afterStage(tx: TenantTransaction, packageId: string): Promise<number> {
        const pkg = await loadPackage(tx, packageId);
        const keyer = createMatchKeyer(deps.matchKeyPepper, tx.ctx.tenantId);
        const staged = (await loadStaged(tx, packageId)).filter(
          (s) => s.entity === 'patients' && s.mapped && s.issue_code === null,
        );
        const pseudo: Pseudo[] = [];
        for (const s of staged) {
          const body = patientCreateOf(s, pkg.source_system);
          if (!body) continue;
          // The migration's own per-record identifier never matches anything; leave it out of scoring.
          const keys = matchKeys(
            recordFromCreate({ ...body, identifiers: body.identifiers?.slice(0, 1) ?? [] }),
            keyer,
          );
          pseudo.push({
            stagedId: s.id,
            rowNo: s.row_no,
            row: {
              match_keys: keys,
              birth_date_text: body.birthDate.known ? body.birthDate.value : null,
              birth_date_precision: body.birthDate.known ? body.birthDate.precision : 'unknown',
            } as unknown as MatchRow,
          });
        }
        const threshold = await minScore(tx);
        // Within-source groups (union of qualifying pairs).
        const parent = new Map(pseudo.map((p) => [p.stagedId, p.stagedId]));
        const find = (x: string): string => {
          const y = parent.get(x) as string;
          return y === x ? x : find(y);
        };
        const pairReasons = new Map<string, string[]>();
        for (let i = 0; i < pseudo.length; i++)
          for (let j = i + 1; j < pseudo.length; j++) {
            const a = pseudo[i] as Pseudo;
            const b = pseudo[j] as Pseudo;
            const s = scoreCandidate(a.row, b.row);
            if (!s || s.score < threshold) continue;
            parent.set(find(b.stagedId), find(a.stagedId));
            pairReasons.set(`${a.stagedId}|${b.stagedId}`, s.reasons);
          }
        const groups = new Map<string, Pseudo[]>();
        for (const p of pseudo) groups.set(find(p.stagedId), [...(groups.get(find(p.stagedId)) ?? []), p]);
        const reviews = [];
        for (const members of groups.values()) {
          const candidates = new Map<string, { patientRef: string; score: number; reasons: string[] }>();
          for (const m of members) {
            const { rows } = await tx.query<MatchRow & { id: string }>(
              `SELECT id, match_keys, to_char(birth_date, 'YYYY-MM-DD') AS birth_date_text, birth_date_precision
               FROM cuspatlas.patients WHERE merged_into IS NULL AND match_keys && $1::text[] ORDER BY id LIMIT 200`,
              [m.row.match_keys],
            );
            for (const other of rows) {
              const s = scoreCandidate(m.row, other);
              if (!s || s.score < threshold) continue;
              const prev = candidates.get(other.id);
              if (!prev || prev.score < s.score)
                candidates.set(other.id, { patientRef: other.id, score: s.score, reasons: s.reasons });
            }
          }
          if (members.length < 2 && candidates.size === 0) continue;
          const sorted = [...members].sort((a, b) => a.rowNo - b.rowNo);
          reviews.push({
            category: 'identity' as const,
            entity: 'patients',
            field: null,
            subjectKey: `group:row:${(sorted[0] as Pseudo).rowNo}`,
            stagedIds: sorted.map((m) => m.stagedId),
            proposal: {
              basis:
                members.length > 1
                  ? candidates.size > 0
                    ? 'withinSourceAndExisting'
                    : 'withinSource'
                  : 'existingPatient',
              candidates: [...candidates.values()].sort(
                (a, b) => b.score - a.score || (a.patientRef < b.patientRef ? -1 : 1),
              ),
              withinSourceReasons: [...pairReasons]
                .filter(([k]) => sorted.some((m) => k.startsWith(m.stagedId)))
                .map(([k, r]) => ({ stagedRefs: k.split('|'), reasons: r })),
              automaticMerge: false,
            },
          });
        }
        return insertReviews(tx, packageId, reviews);
      },

      /** A `sameAsExisting` decision names a live, proposed candidate of this tenant. */
      async existingPatient(
        tx: TenantTransaction,
        item: { category: ReviewCategory; proposal?: Record<string, unknown> },
        patientRef: string,
      ): Promise<string> {
        if (item.category !== 'identity') throw failed('decision_not_allowed');
        assertRef(patientRef);
        const { rows } = await tx.query<{ id: string; merged_into: string | null }>(
          'SELECT id, merged_into FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
          [patientRef],
        );
        const p = rows[0];
        if (!p) throw notFound();
        if (p.merged_into !== null)
          throw conflict('patient_merged', [{ kind: 'patient', ref: p.merged_into }]);
        const candidates = (item.proposal?.candidates ?? []) as { patientRef: string }[];
        if (!candidates.some((c) => c.patientRef === p.id)) throw failed('patient_not_candidate');
        return p.id;
      },
    },

    /** Delegates verbatim to S6 `mergePatients` for two patients this resolved group became. */
    mergeIdentityGroup(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<MergeResult>> {
      const op = 'migration.identity.merge';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          packageRef: string;
          itemRef: string;
          survivorRef: string;
          mergedRef: string;
          confirmationToken: string;
          reasonCode: string;
        }>(validateIdentityMerge, p);
        assertRef(p.itemRef);
        await deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, p.packageRef);
          const { rows } = await tx.query<{ decision: string | null; ids: string[] }>(
            `SELECT i.decision, ARRAY(SELECT a.patient_id::text FROM cuspatlas.migration_applied_records a
               WHERE a.staged_record_id = ANY (i.staged_record_ids) AND a.patient_id IS NOT NULL) AS ids
             FROM cuspatlas.migration_review_items i WHERE i.id = $1 AND i.package_id = $2 AND i.category = 'identity'`,
            [p.itemRef, pkg.id],
          );
          const item = rows[0];
          if (!item) throw notFound();
          if (item.decision !== 'mergeAfterImport') throw conflict('merge_not_decided');
          if (!item.ids.includes(p.survivorRef) || !item.ids.includes(p.mergedRef))
            throw failed('not_in_group');
        });
        // S6 checks its own scope (patients.merge), human principal and confirmation token. The change
        // sequence is bumped inside the merge transaction (H2 M-3): a crash can never leave a merge
        // without the bump that makes earlier reports and sign-offs stale.
        const r = await deps.patients.mergePatients(
          ctx,
          {
            operation: 'patients.merge',
            idempotencyKey: envelope.idempotencyKey,
            payload: {
              survivorRef: p.survivorRef,
              mergedRef: p.mergedRef,
              confirmationToken: p.confirmationToken,
              reasonCode: p.reasonCode,
            },
          },
          async (tx) => {
            const pkg = await loadPackage(tx, p.packageRef, 'FOR UPDATE');
            const version = await bumpChange(tx, pkg.id);
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: MIGRATION_PACKAGE_RESOURCE,
                resourceRef: pkg.id,
                resourceVersion: version,
              },
              { changedFields: ['identityMerge'] },
            );
          },
        );
        return r;
      });
    },

    /** Source provenance of one patient identity and every identity merged into it (S6 merge set). */
    readProvenance(ctx: ActorContext, query: unknown) {
      const op = 'migration.provenance.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ patientRef: string }>(validateProvenanceQuery, query);
        assertRef(query.patientRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const set = await mergeSet(tx, query.patientRef);
          const { rows } = await tx.query<{
            package_id: string;
            patient_id: string;
            source_system: string;
            source_id: string | null;
            entity: string;
            action: string;
            time_precision: string;
            applied_at: Date;
          }>(
            `SELECT a.package_id, a.patient_id, a.source_system, a.source_id, s.entity, a.action, a.time_precision, a.applied_at
             FROM cuspatlas.migration_applied_records a JOIN cuspatlas.migration_staged_records s ON s.id = a.staged_record_id
             WHERE a.patient_id = ANY ($1::uuid[]) ORDER BY a.applied_at, a.id LIMIT 500`,
            [set.ids],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'patient',
            resourceRefs: [query.patientRef],
            queryFields: ['patientRef'],
          });
          return rows.map((r) => ({
            packageRef: r.package_id,
            patientRef: r.patient_id,
            sourceSystem: r.source_system,
            sourceId: r.source_id,
            entity: r.entity,
            action: r.action,
            timePrecision: r.time_precision,
            appliedAt: r.applied_at.toISOString(),
          }));
        });
      });
    },
  };
}
