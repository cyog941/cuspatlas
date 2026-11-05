import type { ReplayCodec, StoredResult } from '../commands/execute-once';

/**
 * Replay projections of the migration commands. Every stored value is server-issued (references,
 * counts, enumerations, digests); no caller text (names, legacy codes, table contents) is stored.
 */
// biome-ignore lint/suspicious/noExplicitAny: results are flat records of server values.
function flat<T extends Record<string, any>>(keys: readonly (keyof T & string)[]): ReplayCodec<T> {
  return {
    persist: (data): StoredResult => {
      const out: Record<string, string | number | boolean | null> = { kind: 'success' };
      for (const k of keys) out[k] = data[k] as string | number | boolean | null;
      return out;
    },
    restore(stored) {
      if (stored.kind !== 'success') throw new Error('Stored result is malformed');
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (!(k in stored)) throw new Error('Stored result is malformed');
        out[k] = stored[k];
      }
      return out as T;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const MIGRATION_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<any>>> = {
  'migration.sourceProfiles.register': flat(['profileRef', 'profileVersion']),
  'migration.packages.intake': flat(['packageRef', 'state', 'alreadyStaged', 'stagedCount', 'reviewCount']),
  'migration.reviewItems.resolve': flat(['itemRef', 'decision']),
  'migration.reports.build': flat(['reportRef', 'reportVersion', 'reportDigest', 'blockingExceptions']),
  'migration.signoffs.record': flat(['signOffRef', 'role', 'decision']),
  'migration.cutover.advance': flat(['packageRef', 'cutoverState']),
  'migration.archive.register': flat([
    'archiveRef',
    'archiveVersion',
    'state',
    'entryCount',
    'archiveDigest',
  ]),
  'migration.archive.holds.record': flat(['holdRef', 'action']),
  'operations.operatorProfiles.record': flat(['profileRef', 'profileVersion']),
  'operations.backupVerifications.record': flat(['verificationRef', 'result']),
  'practice.export.create': flat([
    'exportRef',
    'format',
    'manifestDigest',
    'packageDigest',
    'byteLength',
    'documentCount',
    'exportedAt',
  ]),
};
