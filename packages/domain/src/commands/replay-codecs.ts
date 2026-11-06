import type { ProposalOperation, ProposalState, ProposalSummary } from '@cuspatlas/contracts';
import type { ReplayCodec, StoredResult } from './execute-once';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

type TaskSummary = { readonly taskRef: string; readonly label: string };

/**
 * Synthetic-task replay projection. Only the server-issued `taskRef` is stored; the label is the
 * caller's own input and comes back from the replay request, whose payload has the same canonical
 * digest as the original (both operations set the label to exactly the submitted value).
 */
const taskSummaryCodec: ReplayCodec<TaskSummary> = {
  persist: (data): StoredResult => ({ kind: 'success', taskRef: data.taskRef }),
  restore(stored, payload) {
    const label = (payload as { label?: unknown } | null)?.label;
    if (stored.kind !== 'success' || typeof stored.taskRef !== 'string' || !UUID.test(stored.taskRef)) {
      throw new Error('Stored result is malformed');
    }
    if (typeof label !== 'string') throw new Error('Replay payload is malformed');
    return { taskRef: stored.taskRef, label };
  },
};

/**
 * Proposal summaries hold only server-issued values (references, digests, versions, timestamps,
 * enumerations), never caller text, so the whole summary is the stored projection.
 */
const proposalSummaryCodec: ReplayCodec<ProposalSummary> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    proposalRef: d.proposalRef,
    operation: d.operation,
    state: d.state,
    payloadDigest: d.payloadDigest,
    policyVersion: d.policyVersion,
    expiresAt: d.expiresAt,
    resourceRef: d.resourceRef,
    resourceVersion: d.resourceVersion,
  }),
  restore(s) {
    if (
      s.kind !== 'success' ||
      typeof s.proposalRef !== 'string' ||
      !UUID.test(s.proposalRef) ||
      typeof s.payloadDigest !== 'string' ||
      !DIGEST.test(s.payloadDigest) ||
      typeof s.policyVersion !== 'string' ||
      typeof s.expiresAt !== 'string' ||
      typeof s.operation !== 'string' ||
      typeof s.state !== 'string'
    ) {
      throw new Error('Stored result is malformed');
    }
    return {
      proposalRef: s.proposalRef,
      operation: s.operation as ProposalOperation,
      state: s.state as ProposalState,
      payloadDigest: s.payloadDigest,
      policyVersion: s.policyVersion,
      expiresAt: s.expiresAt,
      resourceRef: typeof s.resourceRef === 'string' ? s.resourceRef : null,
      resourceVersion: typeof s.resourceVersion === 'number' ? s.resourceVersion : null,
    };
  },
};

export const SYNTHETIC_TASK_REPLAY_CODECS: Readonly<
  Record<string, ReplayCodec<TaskSummary> | ReplayCodec<ProposalSummary>>
> = {
  'syntheticTasks.create': taskSummaryCodec,
  'syntheticTasks.relabel': taskSummaryCodec,
  // F Task 7a. A commit's payload is the proposal's stored payload, which carries the label.
  'syntheticTasks.proposals.prepare': proposalSummaryCodec,
  'syntheticTasks.proposals.approve': proposalSummaryCodec,
  'syntheticTasks.proposals.commit': taskSummaryCodec,
};
