import type { PostMergeFactProbe } from '../patients/merge';

/**
 * S-D2 post-merge financial fact probe (ADR 0008 M-11). A merge never relinks posted billing rows;
 * the account follows the merge at read time. Any journal entry posted after the merge for the
 * survivor or for an identity merged into it is a new financial fact, so an unmerge then needs the
 * elevated reconciliation review (the entry may have used money across the two identities).
 */
export const BILLING_POST_MERGE_PROBE: PostMergeFactProbe = {
  factKind: 'financial',
  async count(tx, survivorRef, mergedAt) {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(DISTINCT e.id)::int AS n FROM cuspatlas.billing_journal_entries e
       JOIN cuspatlas.billing_journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
       WHERE e.posted_at > $2 AND (l.patient_id = $1 OR l.patient_id IN (
         SELECT id FROM cuspatlas.patients WHERE merged_into = $1))`,
      [survivorRef, mergedAt],
    );
    return rows[0]?.n ?? 0;
  },
};
