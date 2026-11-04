import type { ActorContext } from '@cuspatlas/contracts';
import { withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import { createCursorCodec } from '../cursor';
import type { ActionName } from '../policy/authorize';
import { createIdentityCommands } from './identity';
import type { PatientServiceContext, PatientServiceDeps } from './service-context';

/**
 * The patients domain (S4-S6): the only command/query layer for patient identity, relationships and
 * merge. REST, MCP and workers call these functions; none of them takes a tenant from its input.
 */
export function createPatientService(deps: PatientServiceDeps) {
  const s: PatientServiceContext = {
    deps,
    execute: deps.execute ?? executeOnce,
    cursors: deps.cursors ?? createCursorCodec(),
    guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T> {
      return withAttemptRecording(
        deps.recording,
        { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
        work,
      );
    },
  };
  return { ...createIdentityCommands(s) };
}

export type PatientService = ReturnType<typeof createPatientService>;
