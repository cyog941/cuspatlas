import { createHash, randomUUID } from 'node:crypto';
import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  isRefusalError,
  listEnvelope,
  type ObjectStorePort,
  type TenantTransaction,
  validateExportCreate,
  validateExportDownload,
  validateExportGrant,
  validateExportListQuery,
  validateExportQuery,
} from '@cuspatlas/contracts';
import { canonicalJson } from '../commands/digest';
import type { ReplayCodec, StoredResult } from '../commands/execute-once';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { signGrantToken, verifyGrantToken } from '../imaging/tokens';
import {
  type ComposedDocument,
  documentDigest,
  GRANT_SECONDS,
  PRACTICE_EXPORT_DOCUMENTS,
  type PracticeExporters,
} from '../migration/practice-export';
import {
  type AutomationBase,
  assertRef,
  checkEnvelope,
  conflict,
  failed,
  notFound,
  unavailable,
  validate,
} from './base';

/**
 * A15 export surface. One API over three scopes, all granted by the ordinary `exports.create` scope
 * (no licence, plan or feature key exists on this path):
 * - `practice`: the M1 practice export (cuspatlas-practice-export/1), composed by reference;
 * - `patient`: the right-of-access export of one patient across S, I, C, E and B;
 * - `domain`: one module's export document.
 * Patient and domain packages use `cuspatlas-export/1` (docs/export-format.md) and the M1 digest and
 * document registry; each module export is called as the caller, so it re-authorizes for itself.
 */
export const EXPORT_FORMAT = 'cuspatlas-export/1' as const;
export const EXPORT_DOMAINS = ['scheduling', 'imaging', 'clinical', 'engagement', 'billing'] as const;
export type ExportDomain = (typeof EXPORT_DOMAINS)[number];
const M1_PURPOSES = new Set(['practiceExit', 'verification', 'archiveCopy']);

export interface ExportPracticePort {
  create(
    ctx: ActorContext,
    e: CommandEnvelope<unknown>,
  ): Promise<
    CommandResult<{
      exportRef: string;
      format: string;
      manifestDigest: string;
      packageDigest: string;
      byteLength: number;
      documentCount: number;
    }>
  >;
  grant(ctx: ActorContext, e: CommandEnvelope<unknown>): Promise<{ data: { token: string } }>;
  download(ctx: ActorContext, e: CommandEnvelope<unknown>): Promise<{ data: unknown }>;
}

export interface ExportDeps {
  readonly exporters: PracticeExporters;
  readonly practice?: ExportPracticePort;
  readonly objectStore?: ObjectStorePort;
  readonly tokenSecret?: Uint8Array | null;
}

type Doc = ComposedDocument;
type Row = Record<string, unknown>;
export interface ScopedManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly exportRef: string;
  readonly exportedAt: string;
  readonly scope: { kind: 'patient'; subjectRef: string } | { kind: 'domain'; domain: ExportDomain };
  readonly documents: { format: string; digestSha256: string; tables: Record<string, number> }[];
  readonly blobs: { digestSha256: string; byteLength: number }[];
  readonly licenceGate: 'none';
  readonly completeness: { readonly basis: string };
}
export interface ScopedPackage {
  readonly manifest: ScopedManifest;
  readonly documents: readonly Doc[];
}

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** Patient-link columns (`patient_id`, `subject_patient_id`, `survivor_patient_id`, ...) with a value. */
const patientLinks = (r: Row): unknown[] =>
  Object.entries(r)
    .filter(([k, v]) => /(^|_)patient_id$/.test(k) && v !== null && v !== undefined)
    .map(([, v]) => v);

/**
 * Patient filter over the composed module documents: a row belongs to the patient when it is the
 * patient row, when one of its patient-link columns (`patient_id`, `subject_patient_id`, ...) is the
 * patient, or (rows without a patient link) when one of its `*_id` columns references a row already
 * included. Rows of another patient never enter, so a shared
 * account or relationship cannot pull a different patient's records in. Reference data (locations,
 * fee schedules, templates) that references no included row is left out by design.
 */
export function filterPatientDocuments(docs: readonly Doc[], patientRef: string): Doc[] {
  const included = new Set<string>([patientRef]);
  const taken = docs.map((d) => Object.fromEntries(Object.keys(d.tables).map((t) => [t, new Set<number>()])));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [di, d] of docs.entries()) {
      for (const [t, rows] of Object.entries(d.tables)) {
        const set = taken[di]?.[t] as Set<number>;
        for (const [i, r] of (rows as Row[]).entries()) {
          if (set.has(i)) continue;
          const links = patientLinks(r);
          const ok =
            t === 'patients'
              ? r.id === patientRef
              : links.length > 0
                ? links.includes(patientRef)
                : Object.entries(r).some(
                    ([k, v]) => k !== 'id' && k.endsWith('_id') && typeof v === 'string' && included.has(v),
                  );
          if (!ok) continue;
          set.add(i);
          if (typeof r.id === 'string') included.add(r.id);
          changed = true;
        }
      }
    }
  }
  return docs.map((d, di) => {
    const tables = Object.fromEntries(
      Object.entries(d.tables).map(([t, rows]) => [
        t,
        (rows as Row[]).filter((_, i) => taken[di]?.[t]?.has(i)),
      ]),
    );
    const out: Doc = { format: d.format, exportedAt: d.exportedAt, tables } as Doc;
    if (d.blobs) {
      const digests = new Set(
        Object.values(tables).flatMap((rows) =>
          (rows as Row[]).map((r) => r.digest_sha256).filter((x): x is string => typeof x === 'string'),
        ),
      );
      return { ...out, blobs: d.blobs.filter((b) => digests.has(b.digestSha256)) };
    }
    return out;
  });
}

export function buildScopedManifest(
  exportRef: string,
  exportedAt: string,
  scope: ScopedManifest['scope'],
  docs: readonly Doc[],
): ScopedManifest {
  return {
    format: EXPORT_FORMAT,
    exportRef,
    exportedAt,
    scope,
    documents: docs.map((d) => ({
      format: d.format,
      digestSha256: documentDigest(d),
      tables: Object.fromEntries(Object.entries(d.tables).map(([t, rows]) => [t, rows.length])),
    })),
    blobs: docs.flatMap((d) =>
      (d.blobs ?? []).map((b) => ({ digestSha256: b.digestSha256, byteLength: b.byteLength })),
    ),
    licenceGate: 'none',
    completeness: {
      basis:
        scope.kind === 'patient'
          ? 'every table of every module format; rows linked to the patient; reference data excluded'
          : 'every table of the module format',
    },
  };
}

export type ScopedExportRefusal =
  | 'unknown_version'
  | 'empty_manifest'
  | 'missing_entity'
  | 'count_mismatch'
  | 'digest_mismatch'
  | 'tenant_mismatch'
  | 'foreign_patient';
export type ScopedExportValidation =
  | { accepted: true; warnings: string[] }
  | { accepted: false; reason: ScopedExportRefusal; entity: string };
const refuse = (reason: ScopedExportRefusal, entity: string): ScopedExportValidation => ({
  accepted: false,
  reason,
  entity,
});

/**
 * Completeness validator of `cuspatlas-export/1` (reuses the M1 document registry and digest): the
 * version is known; the documents are exactly those of the scope, in the platform import order; every
 * table of each format is present with the manifest's row count and no extra table; each document
 * digest matches; no tenant identifier appears; a patient package holds rows of its subject only.
 * Anything else is refused, naming the failing entity; nothing shorter is ever accepted.
 */
export function validateScopedExport(
  input: { readonly manifest: object; readonly documents: readonly object[] },
  opts: { subjectRef?: string; tenantId?: string } = {},
): ScopedExportValidation {
  const pkg = input as unknown as ScopedPackage;
  const m = pkg.manifest;
  if (m?.format !== EXPORT_FORMAT) return refuse('unknown_version', 'manifest');
  if (!Array.isArray(m.documents) || m.documents.length === 0 || !Array.isArray(pkg.documents))
    return refuse('empty_manifest', 'manifest');
  const want =
    m.scope?.kind === 'patient'
      ? PRACTICE_EXPORT_DOCUMENTS
      : PRACTICE_EXPORT_DOCUMENTS.filter(
          (_, i) => EXPORT_DOMAINS[i] === (m.scope as { domain?: string })?.domain,
        );
  if (want.length === 0) return refuse('unknown_version', 'scope');
  for (const [i, w] of want.entries()) {
    const summary = m.documents[i];
    const doc = pkg.documents[i];
    if (summary?.format !== w.format || doc?.format !== w.format) return refuse('missing_entity', w.format);
    for (const t of w.tables) {
      if (!Array.isArray(doc.tables?.[t]) || summary.tables?.[t] === undefined)
        return refuse('missing_entity', `${w.format}:${t}`);
      if (summary.tables[t] !== doc.tables[t]?.length) return refuse('count_mismatch', `${w.format}:${t}`);
    }
    for (const t of new Set([...Object.keys(doc.tables), ...Object.keys(summary.tables)]))
      if (!w.tables.includes(t)) return refuse('count_mismatch', `${w.format}:${t}`);
  }
  if (m.documents.length !== want.length || pkg.documents.length !== want.length)
    return refuse('count_mismatch', 'documents');
  for (const doc of pkg.documents)
    for (const rows of Object.values(doc.tables))
      if ((rows as Row[]).some((r) => 'tenant_id' in r)) return refuse('tenant_mismatch', doc.format);
  if (opts.tenantId !== undefined && JSON.stringify(pkg).includes(opts.tenantId))
    return refuse('tenant_mismatch', 'package');
  if (m.scope.kind === 'patient') {
    const subject = opts.subjectRef ?? m.scope.subjectRef;
    if (subject !== m.scope.subjectRef) return refuse('foreign_patient', 'scope');
    for (const doc of pkg.documents)
      for (const [t, rows] of Object.entries(doc.tables))
        for (const r of rows as Row[])
          if (
            (t === 'patients' && r.id !== subject) ||
            (t !== 'patients' && patientLinks(r).length > 0 && !patientLinks(r).includes(subject))
          )
            return refuse('foreign_patient', `${doc.format}:${t}`);
  }
  for (const [i, doc] of pkg.documents.entries())
    if (documentDigest(doc) !== m.documents[i]?.digestSha256) return refuse('digest_mismatch', doc.format);
  const blobs = pkg.documents.flatMap((d) => d.blobs ?? []);
  if (
    canonicalJson(blobs.map((b) => ({ digestSha256: b.digestSha256, byteLength: b.byteLength }))) !==
    canonicalJson(m.blobs)
  )
    return refuse('digest_mismatch', 'blobs');
  return { accepted: true, warnings: [] };
}

interface RequestRow extends Record<string, unknown> {
  id: string;
  scope: 'practice' | 'patient' | 'domain';
  subject_id: string | null;
  domain: string | null;
  format_version: string;
  purpose: string;
  state: 'building' | 'ready' | 'failed';
  artifact_format: string | null;
  practice_export_id: string | null;
  manifest: Record<string, unknown> | null;
  manifest_digest: string | null;
  package_digest: string | null;
  byte_length: string | number | null;
  document_count: number | null;
  storage_key: string | null;
  diagnostic: string | null;
  version: number;
  created_at: Date;
  completed_at: Date | null;
}
const present = (r: RequestRow) => ({
  exportRef: r.id,
  scope: r.scope,
  subjectRef: r.subject_id,
  domain: r.domain,
  formatVersion: r.format_version,
  purpose: r.purpose,
  state: r.state,
  artifactFormat: r.artifact_format,
  manifestDigest: r.manifest_digest,
  packageDigest: r.package_digest,
  byteLength: r.byte_length === null ? null : Number(r.byte_length),
  documentCount: r.document_count,
  diagnostic: r.diagnostic,
  licenceGate: 'none' as const,
  version: r.version,
  createdAt: new Date(r.created_at).toISOString(),
  completedAt: r.completed_at === null ? null : new Date(r.completed_at).toISOString(),
});
export type ExportRequestView = ReturnType<typeof present>;

// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const AUTOMATION_EXPORT_CODECS: Readonly<Record<string, ReplayCodec<any>>> = {
  'exports.create': {
    persist: (d: ExportRequestView): StoredResult => ({ kind: 'success', ...d }),
    restore(stored) {
      if (stored.kind !== 'success') throw new Error('Stored result is malformed');
      const { kind: _k, ...rest } = stored;
      return rest as unknown as ExportRequestView;
    },
  } satisfies ReplayCodec<ExportRequestView>,
};

export function createExportOperations(base: AutomationBase, ex: ExportDeps | undefined) {
  const { deps, execute } = base;
  const need = () => {
    if (!ex?.objectStore || !ex.tokenSecret) throw unavailable();
    return { exporters: ex.exporters, objectStore: ex.objectStore, tokenSecret: ex.tokenSecret };
  };
  const loadRequest = async (tx: TenantTransaction, ref: string, lock = false): Promise<RequestRow> => {
    assertRef(ref);
    const { rows } = await tx.query<RequestRow>(
      `SELECT * FROM cuspatlas.export_requests WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [ref],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  };
  const envOf = (
    operation: string,
    payload: unknown,
    key: string = randomUUID(),
  ): CommandEnvelope<unknown> => ({
    operation,
    idempotencyKey: key,
    payload,
  });

  /** Builds the artifact as the caller; returns the completion columns or a fixed diagnostic. */
  const build = async (ctx: ActorContext, row: RequestRow) => {
    const { exporters, objectStore } = need();
    if (row.scope === 'practice') {
      if (!ex?.practice) throw unavailable();
      const r = await ex.practice.create(
        ctx,
        envOf('practice.export.create', { purpose: row.purpose }, `exports-${row.id}`),
      );
      return {
        artifactFormat: r.data.format,
        practiceExportId: r.data.exportRef,
        manifest: null,
        manifestDigest: r.data.manifestDigest,
        packageDigest: r.data.packageDigest,
        byteLength: r.data.byteLength,
        documentCount: r.data.documentCount,
        storageKey: null,
      };
    }
    const order = [
      exporters.scheduling,
      exporters.imaging,
      exporters.clinical,
      exporters.engagement,
      exporters.billing,
    ];
    let docs: Doc[];
    if (row.scope === 'domain') {
      const f = order[EXPORT_DOMAINS.indexOf(row.domain as ExportDomain)];
      if (!f) throw failed('unknown_domain');
      docs = [await f(ctx)];
    } else {
      const all: Doc[] = [];
      for (const f of order) all.push(await f(ctx));
      docs = filterPatientDocuments(all, row.subject_id as string);
    }
    const scope: ScopedManifest['scope'] =
      row.scope === 'patient'
        ? { kind: 'patient', subjectRef: row.subject_id as string }
        : { kind: 'domain', domain: row.domain as ExportDomain };
    const manifest = buildScopedManifest(row.id, new Date().toISOString(), scope, docs);
    const pkg: ScopedPackage = { manifest, documents: docs };
    const check = validateScopedExport(pkg, { tenantId: ctx.tenantId });
    if (!check.accepted) return { diagnostic: check.reason };
    const bytes = Buffer.from(JSON.stringify(pkg), 'utf8');
    const staged = await objectStore.stage(ctx.tenantId, bytes);
    const { storageKey } = await objectStore.promote(ctx.tenantId, staged.stagingKey, staged.digestSha256);
    return {
      artifactFormat: EXPORT_FORMAT,
      practiceExportId: null,
      manifest,
      manifestDigest: sha256(canonicalJson(manifest)),
      packageDigest: staged.digestSha256,
      byteLength: bytes.byteLength,
      documentCount: docs.length,
      storageKey,
    };
  };

  return {
    /**
     * Requests and builds an export (human only, `exports.create`; tenant-wide membership). The
     * request is recorded (`building`, audit v1), built as the caller, then completed (`ready` or
     * `failed` with a diagnostic, audit v2) with a sensitive-read record. A module refusing the caller
     * fails the request and returns that refusal.
     */
    createExport(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ExportRequestView>> {
      const op = 'exports.create';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          scope: 'practice' | 'patient' | 'domain';
          subjectRef?: string;
          domain?: string;
          purpose: string;
        }>(validateExportCreate, p);
        if ((p.scope === 'patient') !== (p.subjectRef !== undefined)) throw failed('subject_scope_mismatch');
        if ((p.scope === 'domain') !== (p.domain !== undefined)) throw failed('domain_scope_mismatch');
        if (p.scope === 'practice' && !M1_PURPOSES.has(p.purpose))
          throw failed('purpose_not_allowed_for_scope');
        need();
        const r = await deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            if (p.subjectRef !== undefined) {
              assertRef(p.subjectRef);
              const seen = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [p.subjectRef]);
              if (seen.rows.length === 0) throw notFound();
            }
            const { rows } = await tx.query<RequestRow>(
              `INSERT INTO cuspatlas.export_requests (id, tenant_id, scope, subject_id, domain, format_version, purpose,
                 created_by)
               VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, $4, 'cuspatlas-export/1', $5, cuspatlas.current_actor_id())
               RETURNING *`,
              [randomUUID(), p.scope, p.subjectRef ?? null, p.domain ?? null, p.purpose],
            );
            const row = rows[0] as RequestRow;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'exportRequest', resourceRef: row.id, resourceVersion: 1 },
              { changedFields: ['scope', 'state'] },
            );
            return { data: present(row), version: 1 };
          }),
        );
        if (r.replayed || r.data.state !== 'building') return r;
        let outcome: Awaited<ReturnType<typeof build>> | { diagnostic: string };
        let rethrow: unknown = null;
        const start = await deps.withTenantTransaction(ctx, (tx) => loadRequest(tx, r.data.exportRef));
        try {
          outcome = await build(ctx, start);
        } catch (err) {
          outcome = { diagnostic: isRefusalError(err) ? err.code : 'build_failed' };
          if (isRefusalError(err)) rethrow = err;
        }
        const done = await deps.withTenantTransaction(ctx, async (tx) => {
          const o = outcome as Partial<Awaited<ReturnType<typeof build>>> & { diagnostic?: string };
          const failedState = o.diagnostic !== undefined;
          const { rows } = await tx.query<RequestRow>(
            `UPDATE cuspatlas.export_requests SET state = $2, artifact_format = $3, practice_export_id = $4,
               manifest = $5, manifest_digest = $6, package_digest = $7, byte_length = $8, document_count = $9,
               storage_key = $10, diagnostic = $11, version = version + 1, completed_at = now()
             WHERE id = $1 AND state = 'building' RETURNING *`,
            [
              r.data.exportRef,
              failedState ? 'failed' : 'ready',
              failedState ? null : o.artifactFormat,
              failedState ? null : (o.practiceExportId ?? null),
              failedState || !o.manifest ? null : JSON.stringify(o.manifest),
              failedState ? null : o.manifestDigest,
              failedState ? null : o.packageDigest,
              failedState ? null : o.byteLength,
              failedState ? null : o.documentCount,
              failedState ? null : (o.storageKey ?? null),
              failedState ? o.diagnostic : null,
            ],
          );
          const row = rows[0] as RequestRow;
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'exportRequest',
              resourceRef: row.id,
              resourceVersion: row.version,
            },
            { changedFields: ['state'] },
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'exportRequest',
            resourceRefs: [row.id],
            queryFields: [],
          });
          return row;
        });
        if (rethrow) throw rethrow;
        return { ...r, data: present(done), version: done.version };
      });
    },

    listExports(ctx: ActorContext, query: unknown) {
      const op = 'exports.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.tenantWide(ctx, op, 'exports');
        validate<{ limit?: number; cursor?: string; state?: string }>(validateExportListQuery, query);
        const pg = base.page(ctx, query);
        const state = query.state ?? null;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          const total = Number(
            (
              await tx.query<{ n: string }>(
                'SELECT count(*) AS n FROM cuspatlas.export_requests WHERE ($1::text IS NULL OR state = $1)',
                [state],
              )
            ).rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<RequestRow>(
            `SELECT * FROM cuspatlas.export_requests WHERE ($1::text IS NULL OR state = $1)
             ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
            [state, pg.limit, pg.offset],
          );
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { state },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'exportRef' },
              total,
            }),
            items: rows.map(present),
          };
        });
      });
    },

    readExport(ctx: ActorContext, query: unknown) {
      const op = 'exports.read';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        validate<{ exportRef: string }>(validateExportQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadRequest(tx, query.exportRef);
          let manifest = row.manifest;
          if (manifest === null && row.practice_export_id !== null) {
            const m = await tx.query<{ manifest: Record<string, unknown> }>(
              'SELECT manifest FROM cuspatlas.practice_exports WHERE id = $1',
              [row.practice_export_id],
            );
            manifest = m.rows[0]?.manifest ?? null;
          }
          return { data: { ...present(row), manifest } };
        });
      });
    },

    /** Mints a delivery grant (at most 300 s) bound to the caller; each call mints a new one. */
    grantExport(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'exports.grant';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ exportRef: string }>(validateExportGrant, p);
        const { tokenSecret } = need();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadRequest(tx, p.exportRef);
          if (row.state !== 'ready') throw conflict('export_not_ready');
          const { rows } = await tx.query<{ id: string; exp: string }>(
            `INSERT INTO cuspatlas.export_grants (tenant_id, export_id, principal_id, created_at, expires_at)
             VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(), now(), now() + make_interval(secs => $2))
             RETURNING id, floor(extract(epoch FROM expires_at))::bigint::text AS exp`,
            [row.id, GRANT_SECONDS],
          );
          const grant = rows[0] as { id: string; exp: string };
          await recordCommand(
            tx,
            { operation: op, resourceType: 'exportGrant', resourceRef: grant.id, resourceVersion: 1 },
            { changedFields: ['grant'] },
          );
          const token = signGrantToken(
            tokenSecret,
            { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: row.id },
            grant.id,
            Number(grant.exp),
          );
          return {
            data: { grantRef: grant.id, token, expiresAt: new Date(Number(grant.exp) * 1000).toISOString() },
          };
        });
      });
    },

    /**
     * The package to the holder of a live grant (sensitive read). A practice export is read through the
     * M1 grant and download as the same caller, so M1 re-authorizes and re-verifies its bytes.
     */
    downloadExport(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'exports.download';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ exportRef: string; token: string }>(validateExportDownload, p);
        assertRef(p.exportRef);
        const { tokenSecret, objectStore } = need();
        const parsed = verifyGrantToken(
          tokenSecret,
          { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: p.exportRef },
          p.token,
        );
        if (!parsed) throw notFound();
        const row = await deps.withTenantTransaction(ctx, async (tx) => {
          const live = await tx.query(
            `SELECT 1 FROM cuspatlas.export_grants WHERE id = $1 AND export_id = $2
               AND principal_id = cuspatlas.current_actor_id() AND expires_at > now()`,
            [parsed.grantRef, p.exportRef],
          );
          if (live.rows.length === 0) throw notFound();
          const r = await loadRequest(tx, p.exportRef);
          if (r.state !== 'ready') throw conflict('export_not_ready');
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'exportRequest',
            resourceRefs: [r.id],
            queryFields: [],
          });
          return r;
        });
        if (row.practice_export_id !== null) {
          if (!ex?.practice) throw unavailable();
          const g = await ex.practice.grant(
            ctx,
            envOf('practice.export.grant', { exportRef: row.practice_export_id }),
          );
          return ex.practice.download(
            ctx,
            envOf('practice.export.download', { exportRef: row.practice_export_id, token: g.data.token }),
          );
        }
        const bytes = await objectStore.read(
          ctx.tenantId,
          row.storage_key as string,
          row.package_digest as string,
        );
        return { data: JSON.parse(Buffer.from(bytes).toString('utf8')) as ScopedPackage };
      });
    },
  };
}
