import type { ReplayCodec, StoredResult } from '../commands/execute-once';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Clinical replay projections (C5, C8): only server-issued references (and server enumerations) are
 * stored, never clinical text, credentials or codes. Each command re-reads its projection inside the
 * replaying, already reauthorized transaction before answering, so idempotency rows hold no PHI.
 */
export interface ClinicalAck {
  readonly ref: string;
  readonly outcome?: 'opened' | 'existing' | 'recorded';
}

const malformed = () => new Error('Stored result is malformed');

const refCodec = (field: string): ReplayCodec<ClinicalAck> => ({
  persist: (data): StoredResult => ({ kind: 'success', [field]: data.ref }),
  restore(stored) {
    const ref = stored[field];
    if (stored.kind !== 'success' || typeof ref !== 'string' || !UUID.test(ref)) throw malformed();
    return { ref };
  },
});

const openCodec: ReplayCodec<ClinicalAck> = {
  persist: (data): StoredResult => ({
    kind: 'success',
    encounterRef: data.ref,
    outcome: data.outcome ?? 'opened',
  }),
  restore(stored) {
    const ref = stored.encounterRef;
    if (stored.kind !== 'success' || typeof ref !== 'string' || !UUID.test(ref)) throw malformed();
    if (stored.outcome !== 'opened' && stored.outcome !== 'existing') throw malformed();
    return { ref, outcome: stored.outcome };
  },
};

/** C6: a recorded entry or the existing duplicate it resolved to (reference and outcome only). */
const recordCodec: ReplayCodec<ClinicalAck> = {
  persist: (data): StoredResult => ({
    kind: 'success',
    entryRef: data.ref,
    outcome: data.outcome ?? 'recorded',
  }),
  restore(stored) {
    const ref = stored.entryRef;
    if (stored.kind !== 'success' || typeof ref !== 'string' || !UUID.test(ref)) throw malformed();
    if (stored.outcome !== 'recorded' && stored.outcome !== 'existing') throw malformed();
    return { ref, outcome: stored.outcome };
  },
};

export const CLINICAL_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<ClinicalAck>>> = {
  'clinical.authors.define': refCodec('actorRef'),
  'clinical.encounters.open': openCodec,
  'clinical.encounters.assign': refCodec('encounterRef'),
  'clinical.encounters.close': refCodec('encounterRef'),
  'clinical.history.recordChange': refCodec('historyVersionRef'),
  'clinical.history.verifyItem': refCodec('itemRef'),
  'clinical.history.attestReview': refCodec('reviewRef'),
  // C6 chart (workstream C batch 2a).
  'clinical.chart.recordEntry': recordCodec,
  'clinical.chart.correctEntry': refCodec('entryRef'),
  // C7 periodontal exams.
  'clinical.perio.recordExam': refCodec('examRef'),
  'clinical.perio.correctExam': refCodec('examRef'),
  'clinical.perio.derive': refCodec('derivationRef'),
  // C11 treatment plans (the target reference only; the plan is re-read on replay).
  'clinical.treatmentPlans.create': refCodec('planRef'),
  'clinical.treatmentPlans.addDetail': refCodec('detailRef'),
  'clinical.treatmentPlans.addItem': refCodec('itemRef'),
  'clinical.treatmentPlans.setItemState': refCodec('itemRef'),
  'clinical.treatmentPlans.setDetailState': refCodec('detailRef'),
  'clinical.treatmentPlans.supersede': refCodec('planVersionRef'),
};
