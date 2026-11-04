import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  SYNTHETIC_TASK_PROPERTIES,
  type SyntheticTask,
  type SyntheticTaskCreate,
  type SyntheticTaskList,
  type SyntheticTaskListQuery,
  type SyntheticTaskRelabel,
  validateIdempotencyKey,
  validateSyntheticTaskCreate,
  validateSyntheticTaskListQuery,
  validateSyntheticTaskRelabel,
  validateTaskRef,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from './commands/boundary';
import { type CommandExecutor, executeDirect } from './commands/executor';
import { type CursorCodec, createCursorCodec } from './cursor';
import { recordCommand } from './events/record-command';
import { type ActionName, type Authorize, assertLocation } from './policy/authorize';

export interface SyntheticTaskDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** Defaults to executeDirect; Task 5 supplies executeOnce. */
  readonly execute?: CommandExecutor;
  /** Defaults to a per-process random HMAC key. */
  readonly cursors?: CursorCodec;
}

export type TaskSummary = { readonly taskRef: string; readonly label: string };

const DEFAULT_LIMIT = 25;
const RESOURCE_TYPE = 'syntheticTask';

interface TaskRow extends Record<string, unknown> {
  id: string;
  label: string;
  location_ref: string | null;
  version: number;
}

const toTask = (r: TaskRow): SyntheticTask => ({
  taskRef: r.id,
  label: r.label,
  locationRef: r.location_ref,
  version: r.version,
});

const notFound = () => new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });

function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateIdempotencyKey, envelope.idempotencyKey, SYNTHETIC_TASK_PROPERTIES);
}

/**
 * The synthetic-task domain: the only command/query layer for this aggregate. REST, MCP and workers
 * call these functions; none of them takes a tenant from its input.
 */
export function createSyntheticTaskService(deps: SyntheticTaskDeps) {
  const execute = deps.execute ?? executeDirect;
  const cursors = deps.cursors ?? createCursorCodec();

  function guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T> {
    return withAttemptRecording(
      deps.recording,
      { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
      work,
    );
  }

  return {
    createSyntheticTask(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TaskSummary>> {
      return guarded(ctx, 'syntheticTasks.create', async () => {
        // Ordering: authorization -> schema -> domain rules.
        const decision = await deps.authorize(ctx, 'syntheticTasks.create', {
          tenantId: ctx.tenantId,
          id: 'new',
        });
        checkEnvelope(envelope, 'syntheticTasks.create');
        const payload = envelope.payload;
        assertValid<SyntheticTaskCreate>(validateSyntheticTaskCreate, payload, SYNTHETIC_TASK_PROPERTIES);
        const locationRef = payload.locationRef ?? null;
        assertLocation(decision.locationRefs, locationRef);
        // A location-restricted member may only create inside one of its locations.
        if (decision.locationRefs !== null && locationRef === null) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
        }
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<TaskSummary>(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<TaskRow>(
              `INSERT INTO cuspatlas.synthetic_tasks (tenant_id, label, location_ref, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())
               RETURNING id, label, location_ref, version`,
              [payload.label, locationRef],
            );
            const row = rows[0];
            if (!row) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              {
                operation: 'syntheticTasks.create',
                resourceType: RESOURCE_TYPE,
                resourceRef: row.id,
                resourceVersion: row.version,
              },
              { changedFields: ['label', 'locationRef'] },
            );
            return { data: { taskRef: row.id, label: row.label }, version: row.version };
          }),
        );
      });
    },

    relabelSyntheticTask(
      ctx: ActorContext,
      taskRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TaskSummary>> {
      return guarded(ctx, 'syntheticTasks.relabel', async () => {
        const decision = await deps.authorize(ctx, 'syntheticTasks.relabel', {
          tenantId: ctx.tenantId,
          id: taskRef,
        });
        checkEnvelope(envelope, 'syntheticTasks.relabel');
        const payload = envelope.payload;
        assertValid<SyntheticTaskRelabel>(validateSyntheticTaskRelabel, payload, SYNTHETIC_TASK_PROPERTIES);
        if (!validateTaskRef(taskRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const found = await tx.query<TaskRow>(
            'SELECT id, label, location_ref, version FROM cuspatlas.synthetic_tasks WHERE id = $1 FOR UPDATE',
            [taskRef],
          );
          const current = found.rows[0];
          if (!current) throw notFound();
          // Authorization of the located resource happens before the executor, so a replay is
          // reauthorized; the version comparison is domain logic and runs only inside the handler.
          assertLocation(decision.locationRefs, current.location_ref);
          return execute<TaskSummary>(
            ctx,
            { ...envelope, expectedVersion: payload.expectedVersion },
            tx,
            async () => {
              if (current.version !== payload.expectedVersion) {
                throw new RefusalError({
                  code: 'stale_version',
                  detail: { currentVersion: current.version },
                });
              }
              const { rows } = await tx.query<TaskRow>(
                `UPDATE cuspatlas.synthetic_tasks SET label = $1, version = version + 1, updated_at = now()
               WHERE id = $2 AND version = $3 RETURNING id, label, location_ref, version`,
                [payload.label, taskRef, payload.expectedVersion],
              );
              const row = rows[0];
              if (!row) throw new RefusalError({ code: 'stale_version' });
              await recordCommand(
                tx,
                {
                  operation: 'syntheticTasks.relabel',
                  resourceType: RESOURCE_TYPE,
                  resourceRef: row.id,
                  resourceVersion: row.version,
                },
                { changedFields: ['label'] },
              );
              return { data: { taskRef: row.id, label: row.label }, version: row.version };
            },
          );
        });
      });
    },

    getSyntheticTask(ctx: ActorContext, taskRef: string): Promise<SyntheticTask> {
      return guarded(ctx, 'syntheticTasks.read', async () => {
        const decision = await deps.authorize(ctx, 'syntheticTasks.read', {
          tenantId: ctx.tenantId,
          id: taskRef,
        });
        if (!validateTaskRef(taskRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<TaskRow>(
            'SELECT id, label, location_ref, version FROM cuspatlas.synthetic_tasks WHERE id = $1',
            [taskRef],
          );
          const row = rows[0];
          if (!row) throw notFound();
          assertLocation(decision.locationRefs, row.location_ref);
          return toTask(row);
        });
      });
    },

    listSyntheticTasks(ctx: ActorContext, query: unknown): Promise<SyntheticTaskList> {
      return guarded(ctx, 'syntheticTasks.read', async () => {
        const decision = await deps.authorize(ctx, 'syntheticTasks.read', {
          tenantId: ctx.tenantId,
          id: 'list',
        });
        assertValid<SyntheticTaskListQuery>(validateSyntheticTaskListQuery, query, SYNTHETIC_TASK_PROPERTIES);
        const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
        const after = query.cursor === undefined ? null : cursors.decode(ctx.tenantId, query.cursor);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<TaskRow>(
            `SELECT id, label, location_ref, version FROM cuspatlas.synthetic_tasks
             WHERE ($1::uuid IS NULL OR id > $1::uuid)
               AND ($2::text[] IS NULL OR location_ref IS NULL OR location_ref = ANY ($2::text[]))
             ORDER BY id LIMIT $3`,
            [after, decision.locationRefs, limit + 1],
          );
          const page = rows.slice(0, limit).map(toTask);
          const last = page[page.length - 1];
          return {
            data: page,
            nextCursor: rows.length > limit && last ? cursors.encode(ctx.tenantId, last.taskRef) : null,
          };
        });
      });
    },
  };
}

export type SyntheticTaskService = ReturnType<typeof createSyntheticTaskService>;
