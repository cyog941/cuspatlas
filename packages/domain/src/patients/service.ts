import type { ActorContext } from '@cuspatlas/contracts';
import { withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import { createCursorCodec } from '../cursor';
import type { ActionName } from '../policy/authorize';
import { createIdentityCommands } from './identity';
import { createMergeCommands } from './merge';
import { createMergeConfirmationCodec } from './merge-confirmation';
import { createMatchKeyer } from './model';
import { createRelationshipCommands } from './relationships';
import type { PatientServiceContext, PatientServiceDeps } from './service-context';

/**
 * The patients domain (S4-S6): the only command/query layer for patient identity, relationships and
 * merge. REST, MCP and workers call these functions; none of them takes a tenant from its input.
 */
export function createPatientService(deps: PatientServiceDeps) {
  // Fails fast on a missing or short pepper (createMatchKeyer checks the length).
  createMatchKeyer(deps.matchKeyPepper, '00000000-0000-4000-8000-000000000000');
  const s: PatientServiceContext = {
    keyer: (tenantId) => createMatchKeyer(deps.matchKeyPepper, tenantId),
    deps,
    execute: deps.execute ?? executeOnce,
    cursors: deps.cursors ?? createCursorCodec(),
    confirmations: deps.mergeConfirmations ?? createMergeConfirmationCodec(),
    guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T> {
      return withAttemptRecording(
        deps.recording,
        { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
        work,
      );
    },
  };
  return { ...createIdentityCommands(s), ...createRelationshipCommands(s), ...createMergeCommands(s) };
}

export type PatientService = ReturnType<typeof createPatientService>;
