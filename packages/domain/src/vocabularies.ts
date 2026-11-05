import { type ActorContext, RefusalError, VOCABULARIES, type Vocabulary } from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from './commands/boundary';
import type { Authorize } from './policy/authorize';

/**
 * A20 / OR-02 vocabulary resource: every module's registered state set, served read-only from the
 * contracts registry (no tenant data, no database read). REST and MCP call this one service.
 */
export interface VocabularyService {
  listVocabularies(ctx: ActorContext): Promise<{ data: Vocabulary[] }>;
  getVocabulary(ctx: ActorContext, name: string): Promise<{ data: Vocabulary }>;
}

export function createVocabularyService(deps: {
  authorize: Authorize;
  recording: AttemptRecordingDeps;
}): VocabularyService {
  const check = (ctx: ActorContext, operation: 'vocabularies.list' | 'vocabularies.read', id: string) =>
    withAttemptRecording(
      deps.recording,
      { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
      () => deps.authorize(ctx, operation, { tenantId: ctx.tenantId, id }),
    );
  return {
    async listVocabularies(ctx) {
      await check(ctx, 'vocabularies.list', 'vocabularies');
      return { data: [...VOCABULARIES.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
    async getVocabulary(ctx, name) {
      await check(ctx, 'vocabularies.read', 'vocabularies');
      const v = typeof name === 'string' ? VOCABULARIES.get(name) : undefined;
      if (!v) throw new RefusalError({ code: 'not_found' });
      return { data: v };
    },
  };
}
