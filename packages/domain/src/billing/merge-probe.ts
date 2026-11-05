import type { PostMergeFactProbe } from '../patients/merge';

/**
 * S-D2 post-merge financial fact probe (ADR 0008 M-11). A merge never relinks posted billing rows;
 * the account follows the merge at read time. Any journal entry posted at or after the merge for any
 * identity of the survivor's whole merge chain (root and everything merged into it, transitively,
 * like `mergeSet`) is a new financial fact, so an unmerge then needs the elevated reconciliation
 * review (the entry may have used money across the identities). Entries take `clock_timestamp()`.
 */
export const BILLING_POST_MERGE_PROBE: PostMergeFactProbe = {
  factKind: 'financial',
  async count(tx, survivorRef, mergedAt) {
    const { rows } = await tx.query<{ n: number }>(
      `WITH RECURSIVE up (id, merged_into, depth) AS (
         SELECT id, merged_into, 0 FROM cuspatlas.patients WHERE id = $1
         UNION ALL
         SELECT p.id, p.merged_into, up.depth + 1 FROM cuspatlas.patients p JOIN up ON p.id = up.merged_into
         WHERE up.depth < 32),
       root AS (SELECT id FROM up WHERE merged_into IS NULL LIMIT 1),
       down (id, depth) AS (
         SELECT id, 0 FROM root
         UNION ALL
         SELECT p.id, down.depth + 1 FROM cuspatlas.patients p JOIN down ON p.merged_into = down.id
         WHERE down.depth < 32)
       SELECT count(DISTINCT e.id)::int AS n FROM cuspatlas.billing_journal_entries e
       JOIN cuspatlas.billing_journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
       WHERE e.posted_at >= $2 AND l.patient_id IN (SELECT id FROM down)`,
      [survivorRef, mergedAt],
    );
    return rows[0]?.n ?? 0;
  },
};
