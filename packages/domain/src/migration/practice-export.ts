import { createHash, randomUUID } from 'node:crypto';
import {
  type ActorContext,
  BILLING_EXPORT_FORMAT,
  BILLING_EXPORT_TABLES,
  CLINICAL_EXPORT_FORMAT,
  CLINICAL_EXPORT_TABLES,
  type CommandEnvelope,
  type CommandResult,
  ENGAGEMENT_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_TABLES,
  IMAGING_EXPORT_FORMAT,
  IMAGING_EXPORT_TABLES,
  isObjectStoreError,
  type ObjectStorePort,
  PRACTICE_EXPORT_FORMAT,
  type PracticeExportDocument,
  type PracticeExportManifest,
  type PracticeExportPackage,
  RefusalError,
  SCHEDULING_EXPORT_FORMAT,
  SCHEDULING_EXPORT_TABLES,
  type TenantTransaction,
  validatePracticeExportCreate,
  validatePracticeExportDownload,
  validatePracticeExportGrant,
  validatePracticeExportQuery,
  validatePracticeExportRequestQuery,
} from '@cuspatlas/contracts';
import { canonicalJson } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import type { ExportReadAudit } from '../events/record-sensitive-read';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { signGrantToken, verifyGrantToken } from '../imaging/tokens';
import type { ActionName } from '../policy/authorize';
import { OPENING_CHAIN } from '../rcm/export';
import { assertRef, checkEnvelope, conflict, type MigrationBase, notFound, validate } from './base';

/** A composed domain export: S17, I9, C18, E9 or B10 (I9 also lists its blobs). */
export type ComposedDocument = PracticeExportDocument & {
  readonly blobs?: readonly { digestSha256: string; byteLength: number }[];
};

/**
 * The five domain exports the practice export composes, each called as the same caller (so each
 * re-authorizes and sensitive-read logs itself), in the platform import order.
 */
export interface PracticeExporters {
  scheduling(ctx: ActorContext, audit?: ExportReadAudit): Promise<ComposedDocument>;
  imaging(ctx: ActorContext, audit?: ExportReadAudit): Promise<ComposedDocument>;
  clinical(ctx: ActorContext, audit?: ExportReadAudit): Promise<ComposedDocument>;
  engagement(ctx: ActorContext, audit?: ExportReadAudit): Promise<ComposedDocument>;
  billing(ctx: ActorContext, audit?: ExportReadAudit): Promise<ComposedDocument>;
}

/**
 * Closeout A8: the stored package bytes exactly as built, verified against the digest recorded at build
 * time, for byte (streamed or HTTP Range) delivery. REST slices them; the digest is the package digest.
 */
export interface PackageBytes {
  /** The whole package, or (when `offset` is set) only the selected range starting at `offset`. */
  readonly bytes: Uint8Array;
  readonly digestSha256: string;
  /** The whole package's length (never the length of a range). */
  readonly byteLength: number;
  /** Closeout C review: set when only a range was read (a `range` selection was given). */
  readonly offset?: number;
}
/** A selection of `[start, end)` within the package of `totalLength` bytes, or null for none. */
export type PackageRangeSelect = (
  totalLength: number,
) => { readonly start: number; readonly end: number } | null;
/** A8: how a byte delivery was asked for (a ranged read is audited with the `range` marker). */
export interface PackageBytesRequest {
  readonly ranged?: boolean;
  /**
   * Closeout C review: read only this range of the verified package (REST Range, MCP chunk), not the
   * whole package. The bytes are still verified against the recorded digest before any is returned.
   */
  readonly range?: PackageRangeSelect;
}

/** A8: stored bytes that no longer match the recorded digest (or are gone) are never served. */
export async function readVerifiedPackage(
  store: ObjectStorePort,
  tenantId: string,
  storageKey: string,
  digest: string,
): Promise<Uint8Array> {
  try {
    return await store.read(tenantId, storageKey, digest);
  } catch (err) {
    if (isObjectStoreError(err) && (err.code === 'digest_mismatch' || err.code === 'missing'))
      throw conflict('package_integrity_failed');
    throw err;
  }
}

/**
 * Closeout C review: the verified package as delivered: the whole package, or only the selected range
 * (through the store's ranged read when it has one, so a chunk never reads the whole package; a store
 * without one is read whole and sliced). Integrity failures refuse like `readVerifiedPackage`.
 */
export async function readVerifiedPackageBytes(
  store: ObjectStorePort,
  tenantId: string,
  storageKey: string,
  digest: string,
  range?: PackageRangeSelect,
): Promise<PackageBytes> {
  if (!range) {
    const bytes = await readVerifiedPackage(store, tenantId, storageKey, digest);
    return { bytes, digestSha256: digest, byteLength: bytes.byteLength };
  }
  if (!store.readRange) {
    const whole = await readVerifiedPackage(store, tenantId, storageKey, digest);
    const sel = range(whole.byteLength);
    return {
      bytes: sel ? whole.subarray(sel.start, sel.end) : new Uint8Array(0),
      digestSha256: digest,
      byteLength: whole.byteLength,
      offset: sel?.start ?? 0,
    };
  }
  try {
    const r = await store.readRange(tenantId, storageKey, digest, range);
    return { bytes: r.bytes, digestSha256: digest, byteLength: r.totalLength, offset: r.start };
  } catch (err) {
    if (isObjectStoreError(err) && (err.code === 'digest_mismatch' || err.code === 'missing'))
      throw conflict('package_integrity_failed');
    throw err;
  }
}

export interface PracticeExportDeps {
  readonly exporters: PracticeExporters;
  /** Private storage of the package bytes (content-addressed); the key never leaves the service. */
  readonly objectStore?: ObjectStorePort;
  /** I1 grant-token secret: delivery tokens are short-lived and bound to the caller and the export. */
  readonly tokenSecret?: Uint8Array | null;
}

/** Every document a complete practice export carries, in the platform import order, with its tables. */
export const PRACTICE_EXPORT_DOCUMENTS: readonly { format: string; tables: readonly string[] }[] = [
  { format: SCHEDULING_EXPORT_FORMAT, tables: SCHEDULING_EXPORT_TABLES },
  { format: IMAGING_EXPORT_FORMAT, tables: IMAGING_EXPORT_TABLES },
  { format: CLINICAL_EXPORT_FORMAT, tables: CLINICAL_EXPORT_TABLES },
  { format: ENGAGEMENT_EXPORT_FORMAT, tables: ENGAGEMENT_EXPORT_TABLES },
  { format: BILLING_EXPORT_FORMAT, tables: BILLING_EXPORT_TABLES },
];
export const GRANT_SECONDS = 300;
const TERMINOLOGY_SYSTEM = 'cuspatlas-synthetic-provisional';

export type PracticeExportRefusal =
  | 'unknown_version'
  | 'empty_manifest'
  | 'missing_entity'
  | 'count_mismatch'
  | 'digest_mismatch'
  | 'tenant_mismatch';
export type PracticeExportValidation =
  | { accepted: true; warnings: string[] }
  | { accepted: false; reason: PracticeExportRefusal; entity: string };

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** Digest of one document's format and tables (the export time is not content). */
export const documentDigest = (d: PracticeExportDocument): string =>
  sha256(canonicalJson({ format: d.format, tables: d.tables }));

function codeVersions(docs: readonly PracticeExportDocument[]): string[] {
  const out = new Set<string>();
  for (const d of docs)
    for (const rows of Object.values(d.tables))
      for (const r of rows) if (typeof r.code_version === 'string') out.add(r.code_version);
  return [...out].sort();
}

export function buildPracticeManifest(
  exportRef: string,
  exportedAt: string,
  docs: readonly ComposedDocument[],
): PracticeExportManifest {
  const imaging = docs.find((d) => d.format === IMAGING_EXPORT_FORMAT);
  return {
    format: PRACTICE_EXPORT_FORMAT,
    exportRef,
    exportedAt,
    documents: docs.map((d) => ({
      format: d.format,
      digestSha256: documentDigest(d),
      tables: Object.fromEntries(Object.entries(d.tables).map(([t, rows]) => [t, rows.length])),
    })),
    blobs: (imaging?.blobs ?? []).map((b) => ({ digestSha256: b.digestSha256, byteLength: b.byteLength })),
    terminology: { system: TERMINOLOGY_SYSTEM, licensed: false, codeVersions: codeVersions(docs) },
    provenance: { generator: 'cuspatlas', importOrder: PRACTICE_EXPORT_DOCUMENTS.map((d) => d.format) },
  };
}

const refuse = (reason: PracticeExportRefusal, entity: string): PracticeExportValidation => ({
  accepted: false,
  reason,
  entity,
});

/**
 * M1 completeness validator: a package is accepted only when its version is known, it carries every
 * document of the platform import order with every table of each format, each table's row count and
 * each document's digest match the manifest, the blob list matches the I9 document, and no tenant
 * identifier appears. The first failure is returned with the failing entity named; nothing partial is
 * ever accepted.
 */
export function validatePracticeExport(
  input: { readonly manifest: object; readonly documents: readonly object[] },
  opts: { tenantId?: string } = {},
): PracticeExportValidation {
  // Untrusted input (an export read back for import): every shape is checked before use.
  const pkg = input as unknown as PracticeExportPackage;
  const m = pkg.manifest;
  if (m?.format !== PRACTICE_EXPORT_FORMAT) return refuse('unknown_version', 'manifest');
  if (!Array.isArray(m.documents) || m.documents.length === 0 || (pkg.documents ?? []).length === 0)
    return refuse('empty_manifest', 'manifest');
  for (const [i, want] of PRACTICE_EXPORT_DOCUMENTS.entries()) {
    const summary = m.documents[i];
    const doc = pkg.documents[i];
    if (summary?.format !== want.format || doc?.format !== want.format)
      return refuse('missing_entity', want.format);
    for (const t of want.tables) {
      if (!Array.isArray(doc.tables[t]) || summary.tables[t] === undefined)
        return refuse('missing_entity', `${want.format}:${t}`);
      if (summary.tables[t] !== doc.tables[t]?.length) return refuse('count_mismatch', `${want.format}:${t}`);
    }
    for (const t of new Set([...Object.keys(doc.tables), ...Object.keys(summary.tables)]))
      if (!want.tables.includes(t)) return refuse('count_mismatch', `${want.format}:${t}`);
  }
  if (m.documents.length !== PRACTICE_EXPORT_DOCUMENTS.length || pkg.documents.length !== m.documents.length)
    return refuse('count_mismatch', 'documents');
  for (const doc of pkg.documents)
    for (const rows of Object.values(doc.tables))
      if (rows.some((r) => 'tenant_id' in r)) return refuse('tenant_mismatch', doc.format);
  if (opts.tenantId !== undefined && JSON.stringify(pkg).includes(opts.tenantId))
    return refuse('tenant_mismatch', 'package');
  for (const [i, doc] of pkg.documents.entries())
    if (documentDigest(doc) !== m.documents[i]?.digestSha256) return refuse('digest_mismatch', doc.format);
  const imaging = pkg.documents[1] as ComposedDocument;
  const blobs = imaging.blobs ?? [];
  if (blobs.length !== m.blobs.length) return refuse('count_mismatch', 'blobs');
  if (canonicalJson(blobs) !== canonicalJson(m.blobs)) return refuse('digest_mismatch', 'blobs');
  return { accepted: true, warnings: [] };
}

interface ExportRow extends Record<string, unknown> {
  id: string;
  manifest: PracticeExportManifest;
  manifest_digest: string;
  package_digest: string;
  storage_key: string;
}

/** Closeout D2: the module exports an M1 build composes, checked at request time. */
const MODULE_EXPORT_ACTIONS = [
  'scheduling.export',
  'imaging.export',
  'clinical.export',
  'communications.export',
  'billing.export',
] as const;
const REQUEST_COLUMNS = `id, state, purpose, practice_export_id, artifact_format, manifest_digest, package_digest,
  byte_length, document_count, diagnostic, version, created_at, completed_at`;
interface PracticeRequestRow extends Record<string, unknown> {
  id: string;
  state: 'building' | 'ready' | 'failed';
  purpose: string;
  practice_export_id: string | null;
  artifact_format: string | null;
  manifest_digest: string | null;
  package_digest: string | null;
  byte_length: string | number | null;
  document_count: number | null;
  diagnostic: string | null;
  version: number;
  created_at: Date;
  completed_at: Date | null;
}
const presentRequest = (r: PracticeRequestRow) => ({
  requestRef: r.id,
  state: r.state,
  purpose: r.purpose,
  exportRef: r.practice_export_id,
  format: r.artifact_format,
  manifestDigest: r.manifest_digest,
  packageDigest: r.package_digest,
  byteLength: r.byte_length === null ? null : Number(r.byte_length),
  documentCount: r.document_count,
  diagnostic: r.diagnostic,
  requestedAt: new Date(r.created_at).toISOString(),
  completedAt: r.completed_at === null ? null : new Date(r.completed_at).toISOString(),
});
/** Closeout D2: one M1 practice export request as `practice.export.create` and `.read` answer it. */
export type PracticeExportRequestView = ReturnType<typeof presentRequest>;

export function createPracticeExportOperations(base: MigrationBase) {
  const { deps, execute } = base;
  const pe = (): { exporters: PracticeExporters; objectStore: ObjectStorePort; tokenSecret: Uint8Array } => {
    const p = deps.practiceExport;
    if (!p?.objectStore || !p.tokenSecret)
      throw new RefusalError({ code: 'service_unavailable', retryable: true });
    return { exporters: p.exporters, objectStore: p.objectStore, tokenSecret: p.tokenSecret };
  };
  const tenantWide = async (ctx: ActorContext, op: ActionName) => {
    const decision = await deps.authorize(ctx, op, { tenantId: ctx.tenantId, id: 'practiceExport' });
    if (decision.locationRefs !== null)
      throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
  };
  const compose = async (ctx: ActorContext): Promise<ComposedDocument[]> => {
    const x = pe().exporters;
    // Sequential: each export is its own consistent read; the live count check below catches drift.
    const out: ComposedDocument[] = [];
    for (const f of [x.scheduling, x.imaging, x.clinical, x.engagement, x.billing]) out.push(await f(ctx));
    return out;
  };
  /** Live row counts of every exported table under RLS (B's migration tables: the opening chain only). */
  const liveMismatches = async (tx: TenantTransaction, docs: readonly ComposedDocument[]) => {
    const mismatches: { entity: string; reason: 'count_mismatch' | 'digest_mismatch' | 'missing_entity' }[] =
      [];
    for (const [i, want] of PRACTICE_EXPORT_DOCUMENTS.entries()) {
      const doc = docs[i];
      for (const t of want.tables) {
        const source = OPENING_CHAIN[t]?.source ?? `cuspatlas.${t}`;
        const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${source} r`);
        if ((rows[0]?.n ?? 0) !== (doc?.tables[t]?.length ?? -1))
          mismatches.push({ entity: `${want.format}:${t}`, reason: 'count_mismatch' });
      }
    }
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(DISTINCT digest_sha256)::int AS n FROM cuspatlas.imaging_objects WHERE state = 'available'`,
    );
    if ((rows[0]?.n ?? 0) !== (docs[1]?.blobs?.length ?? -1))
      mismatches.push({ entity: 'blobs', reason: 'count_mismatch' });
    return mismatches;
  };
  const loadExport = async (tx: TenantTransaction, exportRef: string): Promise<ExportRow> => {
    assertRef(exportRef);
    const { rows } = await tx.query<ExportRow>(
      `SELECT id, manifest, manifest_digest, package_digest, storage_key FROM cuspatlas.practice_exports
       WHERE id = $1`,
      [exportRef],
    );
    const row = rows[0];
    if (!row) throw notFound();
    return row;
  };
  const readStored = (ctx: ActorContext, row: ExportRow) =>
    readVerifiedPackage(pe().objectStore, ctx.tenantId, row.storage_key, row.package_digest);
  const readPackage = async (ctx: ActorContext, row: ExportRow): Promise<PracticeExportPackage> =>
    JSON.parse(Buffer.from(await readStored(ctx, row)).toString('utf8')) as PracticeExportPackage;
  /**
   * The delivery path shared by the JSON and byte representations: the full policy layer (tenant-wide
   * authorization, envelope, a live grant bound to this caller and export), then the stored bytes
   * verified against the recorded digest, then the sensitive-read audit (never the content).
   */
  const deliver = <T>(
    ctx: ActorContext,
    envelope: CommandEnvelope<unknown>,
    ranged: boolean,
    read: (row: ExportRow) => Promise<T>,
  ): Promise<{ data: T }> => {
    const op = 'practice.export.download';
    return base.guarded(ctx, op, async () => {
      await tenantWide(ctx, op);
      checkEnvelope(envelope, op);
      const payload = envelope.payload;
      validate<{ exportRef: string; token: string }>(validatePracticeExportDownload, payload);
      const { exportRef, token } = payload;
      assertRef(exportRef);
      const parsed = verifyGrantToken(
        pe().tokenSecret,
        { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: exportRef },
        token,
      );
      if (!parsed) throw notFound();
      return deps.withTenantTransaction(ctx, async (tx) => {
        const live = await tx.query(
          `SELECT 1 FROM cuspatlas.practice_export_grants WHERE id = $1 AND export_id = $2
             AND principal_id = cuspatlas.current_actor_id() AND expires_at > now()`,
          [parsed.grantRef, exportRef],
        );
        if (live.rows.length === 0) throw notFound();
        const row = await loadExport(tx, exportRef);
        const out = await read(row);
        await recordSensitiveRead(tx, {
          operation: op,
          resourceType: 'practiceExport',
          resourceRefs: [row.id],
          queryFields: ranged ? ['range'] : [],
        });
        return { data: out };
      });
    });
  };

  const loadRequest = async (tx: TenantTransaction, ref: string): Promise<PracticeRequestRow> => {
    assertRef(ref);
    const { rows } = await tx.query<PracticeRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM cuspatlas.export_requests WHERE id = $1 AND origin = 'practice.export.create'`,
      [ref],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  };

  return {
    /**
     * M1 (Closeout D2): records a practice export request (`building`, origin `practice.export.create`)
     * and returns at once; the leased worker job (`exports.build`) builds it as the requester and the
     * caller polls `practice.export.read`. A tenant-wide human administrator only. The module exports the
     * build composes are checked now as well, so a caller one of them refuses is refused here (nothing
     * recorded); the build re-checks everything when it runs. A same-key retry answers the request's
     * current state, never the stored building view.
     */
    createPracticeExport(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PracticeExportRequestView>> {
      const op = 'practice.export.create';
      return base.guarded(ctx, op, async () => {
        await tenantWide(ctx, op);
        checkEnvelope(envelope, op);
        const payload = envelope.payload;
        validate<{ purpose: string }>(validatePracticeExportCreate, payload);
        pe();
        for (const action of MODULE_EXPORT_ACTIONS)
          await deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'practiceExport' });
        const r = await deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<PracticeRequestRow>(
              `INSERT INTO cuspatlas.export_requests (id, tenant_id, scope, format_version, purpose, origin, created_by)
               VALUES ($1, cuspatlas.current_tenant_id(), 'practice', 'cuspatlas-export/1', $2, 'practice.export.create',
                 cuspatlas.current_actor_id())
               RETURNING ${REQUEST_COLUMNS}`,
              [randomUUID(), payload.purpose],
            );
            const row = rows[0] as PracticeRequestRow;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'exportRequest', resourceRef: row.id, resourceVersion: 1 },
              { changedFields: ['scope', 'state'] },
            );
            return { data: presentRequest(row), version: 1 };
          }),
        );
        if (!r.replayed) return r;
        const now = await deps.withTenantTransaction(ctx, (tx) => loadRequest(tx, r.data.requestRef));
        return { ...r, data: presentRequest(now), version: now.version };
      });
    },

    /** Closeout D2: the state of one M1 practice export request (the poll after create). */
    readPracticeExport(ctx: ActorContext, query: unknown): Promise<{ data: PracticeExportRequestView }> {
      const op = 'practice.export.read';
      return base.guarded(ctx, op, async () => {
        await tenantWide(ctx, op);
        validate<{ requestRef: string }>(validatePracticeExportRequestQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => ({
          data: presentRequest(await loadRequest(tx, query.requestRef)),
        }));
      });
    },

    /**
     * M1 build (not a catalog operation; Closeout D2): run only by the worker's export build job, as the
     * requester. Composes the S, I, C, E and B exports of the caller's tenant into one versioned package,
     * refuses it when any table's count differs from the live tenant (a partial export is never
     * stored), stores the bytes privately (content-addressed) and records the manifest under
     * `practice.export.create`. Keyed (`practice.export.build`), so a taken-over lease replays the
     * committed build instead of building twice. Delivery is a separate short-lived grant.
     */
    buildPracticeExport(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<
      CommandResult<{
        exportRef: string;
        format: string;
        manifestDigest: string;
        packageDigest: string;
        byteLength: number;
        documentCount: number;
        exportedAt: string;
      }>
    > {
      const op = 'practice.export.create';
      return base.guarded(ctx, op, async () => {
        await tenantWide(ctx, op);
        checkEnvelope(envelope, 'practice.export.build');
        const payload = envelope.payload;
        validate<{ purpose: string }>(validatePracticeExportCreate, payload);
        const purpose = payload.purpose;
        const { objectStore } = pe();
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const docs = await compose(ctx);
            const gaps = await liveMismatches(tx, docs);
            if (gaps.length > 0)
              throw conflict(
                'export_incomplete',
                gaps.slice(0, 20).map((g) => ({ kind: 'exportEntity', ref: g.entity })),
              );
            const exportRef = randomUUID();
            const at = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
            const manifest = buildPracticeManifest(exportRef, at.toISOString(), docs);
            const pkg: PracticeExportPackage = { manifest, documents: docs };
            const check = validatePracticeExport(pkg, { tenantId: ctx.tenantId });
            if (!check.accepted) throw conflict(check.reason, [{ kind: 'exportEntity', ref: check.entity }]);
            const bytes = Buffer.from(JSON.stringify(pkg), 'utf8');
            const staged = await objectStore.stage(ctx.tenantId, bytes);
            // Closeout C: promotion holds the content lock until the row referencing the bytes commits,
            // so the orphan-bytes sweep (which skips a locked digest) cannot remove them in between.
            await tx.query('SELECT cuspatlas.imaging_lock_content(cuspatlas.current_tenant_id(), $1)', [
              staged.digestSha256,
            ]);
            const { storageKey } = await objectStore.promote(
              ctx.tenantId,
              staged.stagingKey,
              staged.digestSha256,
            );
            const manifestDigest = sha256(canonicalJson(manifest));
            await tx.query(
              `INSERT INTO cuspatlas.practice_exports (id, tenant_id, format, purpose, manifest, manifest_digest,
                 package_digest, byte_length, storage_key, document_count, created_by, created_at)
               VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, cuspatlas.current_actor_id(), $10)`,
              [
                exportRef,
                PRACTICE_EXPORT_FORMAT,
                purpose,
                JSON.stringify(manifest),
                manifestDigest,
                staged.digestSha256,
                bytes.byteLength,
                storageKey,
                docs.length,
                at,
              ],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: 'practiceExport', resourceRef: exportRef, resourceVersion: 1 },
              { changedFields: ['manifest'] },
            );
            await recordSensitiveRead(tx, {
              operation: op,
              resourceType: 'practiceExport',
              resourceRefs: [exportRef],
              queryFields: [],
            });
            return {
              data: {
                exportRef,
                format: PRACTICE_EXPORT_FORMAT,
                manifestDigest,
                packageDigest: staged.digestSha256,
                byteLength: bytes.byteLength,
                documentCount: docs.length,
                exportedAt: manifest.exportedAt,
              },
              version: 1,
            };
          }),
        );
      });
    },

    /**
     * Mints a delivery grant (at most 300 s) bound to the caller and the export. Not idempotent by
     * design (like I1 read grants): each call mints a new grant and the token is never stored.
     */
    grantPracticeExport(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'practice.export.grant';
      return base.guarded(ctx, op, async () => {
        await tenantWide(ctx, op);
        checkEnvelope(envelope, op);
        const payload = envelope.payload;
        validate<{ exportRef: string }>(validatePracticeExportGrant, payload);
        const { tokenSecret } = pe();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadExport(tx, payload.exportRef);
          const { rows } = await tx.query<{ id: string; exp: string; expires_at: Date }>(
            `INSERT INTO cuspatlas.practice_export_grants (tenant_id, export_id, principal_id, created_at, expires_at)
             VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(), now(), now() + make_interval(secs => $2))
             RETURNING id, floor(extract(epoch FROM expires_at))::bigint::text AS exp, expires_at`,
            [row.id, GRANT_SECONDS],
          );
          const grant = rows[0];
          if (!grant) throw new Error('grant insert returned no row');
          await recordCommand(
            tx,
            { operation: op, resourceType: 'practiceExportGrant', resourceRef: grant.id, resourceVersion: 1 },
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

    /** The stored package, verified against its digest, to the holder of a live grant (sensitive read). */
    downloadPracticeExport(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      return deliver(ctx, envelope, false, (row) => readPackage(ctx, row));
    },

    /**
     * A8: the same delivery as `downloadPracticeExport` (same operation, policy, grant and audit) as the
     * stored bytes and their recorded digest, for streamed or ranged REST transfer. A grant serves any
     * number of ranges within its lifetime (at most 300 s); each range is re-authorized and re-verified.
     */
    downloadPracticeExportBytes(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
      request: PackageBytesRequest = {},
    ): Promise<{ data: PackageBytes }> {
      return deliver(ctx, envelope, request.ranged === true, (row) =>
        readVerifiedPackageBytes(
          pe().objectStore,
          ctx.tenantId,
          row.storage_key,
          row.package_digest,
          request.range,
        ),
      );
    },

    /**
     * Re-verifies a stored export: the bytes against their digest and the completeness validator
     * (`failed` otherwise), then a fresh export of the live tenant against the manifest, naming each
     * table whose count or document whose digest differs (`drifted`). Writes nothing but the audit.
     */
    verifyPracticeExport(ctx: ActorContext, query: unknown) {
      const op = 'practice.export.verify';
      return base.guarded(ctx, op, async () => {
        await tenantWide(ctx, op);
        validate<{ exportRef: string }>(validatePracticeExportQuery, query);
        pe();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadExport(tx, query.exportRef);
          const mismatches: {
            entity: string;
            reason: 'count_mismatch' | 'digest_mismatch' | 'missing_entity';
          }[] = [];
          let state: 'verified' | 'drifted' | 'failed' = 'verified';
          let pkg: PracticeExportPackage | null = null;
          try {
            pkg = await readPackage(ctx, row);
          } catch {
            state = 'failed';
            mismatches.push({ entity: 'package', reason: 'digest_mismatch' });
          }
          if (pkg) {
            const check = validatePracticeExport(pkg, { tenantId: ctx.tenantId });
            if (!check.accepted || sha256(canonicalJson(pkg.manifest)) !== row.manifest_digest) {
              state = 'failed';
              mismatches.push({
                entity: check.accepted ? 'manifest' : check.entity,
                reason:
                  check.accepted || check.reason !== 'count_mismatch' ? 'digest_mismatch' : 'count_mismatch',
              });
            } else {
              const live = buildPracticeManifest(row.id, pkg.manifest.exportedAt, await compose(ctx));
              for (const [i, d] of pkg.manifest.documents.entries()) {
                const now = live.documents[i];
                for (const [t, n] of Object.entries(d.tables))
                  if (now?.tables[t] !== n)
                    mismatches.push({ entity: `${d.format}:${t}`, reason: 'count_mismatch' });
                if (now?.digestSha256 !== d.digestSha256)
                  mismatches.push({ entity: d.format, reason: 'digest_mismatch' });
              }
              if (canonicalJson(live.blobs) !== canonicalJson(pkg.manifest.blobs))
                mismatches.push({ entity: 'blobs', reason: 'digest_mismatch' });
              if (mismatches.length > 0) state = 'drifted';
            }
          }
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'practiceExport',
            resourceRefs: [row.id],
            queryFields: ['exportRef'],
          });
          return {
            data: {
              exportRef: row.id,
              state,
              manifestDigest: row.manifest_digest,
              mismatches: mismatches.slice(0, 512),
            },
          };
        });
      });
    },
  };
}
