import type { ReplayCodec, StoredResult } from './execute-once';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export const SYNTHETIC_TASK_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<TaskSummary>>> = {
  'syntheticTasks.create': taskSummaryCodec,
  'syntheticTasks.relabel': taskSummaryCodec,
};
