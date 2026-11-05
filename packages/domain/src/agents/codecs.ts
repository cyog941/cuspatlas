import type { ReplayCodec, StoredResult } from '../commands/execute-once';

/** Replay projections of the workstream A batch 2 commands: server-issued values only. */
// biome-ignore lint/suspicious/noExplicitAny: results are flat records of server values.
export function flatCodec<T extends Record<string, any>>(
  keys: readonly string[],
  optional: readonly string[] = [],
): ReplayCodec<T> {
  return {
    persist: (data): StoredResult => {
      const out: Record<string, string | number | boolean | null> = { kind: 'success' };
      for (const k of [...keys, ...optional]) {
        const v = (data as Record<string, unknown>)[k];
        if (v !== undefined) out[k] = v as string | number | boolean | null;
      }
      return out;
    },
    restore(stored) {
      if (stored.kind !== 'success') throw new Error('Stored result is malformed');
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (!(k in stored)) throw new Error('Stored result is malformed');
        out[k] = stored[k];
      }
      for (const k of optional) if (k in stored) out[k] = stored[k];
      return out as T;
    },
  };
}

const AGENT = flatCodec(['agentRef', 'state', 'expiresAt'], ['credentialRef', 'sponsorRef']);

// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const AGENT_REPLAY_CODECS: Record<string, ReplayCodec<any>> = {
  'agents.principals.create': AGENT,
  'agents.principals.suspend': AGENT,
  'agents.principals.resume': AGENT,
  'agents.principals.revoke': AGENT,
  'agents.credentials.rotate': AGENT,
  'agents.sponsors.change': AGENT,
  'agents.consents.record': flatCodec(['consentRef', 'agentRef', 'state', 'expiresAt']),
  'agents.consents.revoke': flatCodec(['consentRef', 'agentRef', 'state', 'expiresAt']),
  'actions.proposals.prepare': flatCodec(['proposalRef']),
  'actions.proposals.approve': flatCodec(['proposalRef']),
  'actions.proposals.abandon': flatCodec(['proposalRef']),
  'ai.drafts.create': flatCodec(['draftRef']),
};
