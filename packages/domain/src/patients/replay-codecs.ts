import type { ReplayCodec, StoredResult } from '../commands/execute-once';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Patient replay projection: only a server-issued reference is stored, never names, dates or contact
 * values. `restore` returns that reference alone; the patient service re-reads the projection inside
 * the replaying (already reauthorized) transaction before answering, so idempotency rows hold no PHI.
 */
export interface StoredRef {
  readonly ref: string;
}

const refCodec = (field: string): ReplayCodec<StoredRef> => ({
  persist: (data): StoredResult => ({ kind: 'success', [field]: data.ref }),
  restore(stored) {
    const ref = stored[field];
    if (stored.kind !== 'success' || typeof ref !== 'string' || !UUID.test(ref)) {
      throw new Error('Stored result is malformed');
    }
    return { ref };
  },
});

export const PATIENT_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<StoredRef>>> = {
  'patients.create': refCodec('patientRef'),
  'patients.updateDemographics': refCodec('patientRef'),
  'patients.setStatus': refCodec('patientRef'),
  'patients.relationships.add': refCodec('relationshipRef'),
  'patients.relationships.revoke': refCodec('relationshipRef'),
  'patients.merge': refCodec('mergeRef'),
  'patients.unmerge': refCodec('mergeRef'),
};
