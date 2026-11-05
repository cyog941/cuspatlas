import { type ComposedWorker, composeWorker } from '@cuspatlas/worker';
import { T_ALPHA, T_BETA } from './fixtures';
import type { ImagingStack } from './imaging-fixtures';

/**
 * Closeout C: the A15 export build runs as a worker job. Tests drive it through the real worker
 * composition (`composeWorker`, export build stage only) over the stack's database and object store,
 * as a service principal holding only `exports.build` in both synthetic tenants.
 */
export const EXPORT_WORKER = '30000000-0000-4000-8000-0000000000d9';

const workers = new WeakMap<ImagingStack, Promise<ComposedWorker>>();

async function compose(s: ImagingStack): Promise<ComposedWorker> {
  await s.db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-export-builds')
     ON CONFLICT DO NOTHING`,
    [EXPORT_WORKER],
  );
  for (const tenant of [T_ALPHA, T_BETA])
    await s.db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [tenant, EXPORT_WORKER, ['exports.build']],
    );
  return composeWorker(
    {
      CUSPATLAS_ENV: 'synthetic-test',
      CUSPATLAS_WORKER_PRINCIPAL_ID: EXPORT_WORKER,
      CUSPATLAS_WORKER_TENANT_IDS: `${T_ALPHA},${T_BETA}`,
      CUSPATLAS_OBJECT_STORE_DIR: s.storeRoot,
    },
    { pools: { app: s.db.app, attempts: s.db.sink } },
  );
}

/** The export-build worker of a stack (composed once). */
export function exportWorker(s: ImagingStack): Promise<ComposedWorker> {
  let w = workers.get(s);
  if (!w) {
    w = compose(s);
    workers.set(s, w);
  }
  return w;
}

/** Runs the export build stage once for every served tenant. */
export async function runExportBuilds(s: ImagingStack) {
  return (await exportWorker(s)).runExportBuilds();
}

type Response = Awaited<ReturnType<ImagingStack['command']>>;

/**
 * `POST /v1/exports` as `who`, then (when the request was recorded) the build job and the poll the
 * caller makes: the returned response carries the create status with the polled request view.
 */
export async function createAndBuild(
  s: ImagingStack,
  who: Parameters<ImagingStack['command']>[0],
  body: Record<string, unknown>,
  key?: string,
): Promise<Response> {
  const created = await s.command(who, '/v1/exports', body, key);
  if (created.status !== 201) return created;
  const ref = (created.json.data as { exportRef: string }).exportRef;
  await runExportBuilds(s);
  const read = await s.inject(who, 'GET', `/v1/exports/request?exportRef=${ref}`);
  const { manifest: _m, ...view } = read.json.data as Record<string, unknown>;
  return { ...created, json: { ...created.json, data: view, version: view.version } };
}
