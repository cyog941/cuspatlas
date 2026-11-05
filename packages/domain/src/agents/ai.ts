import { createHash } from 'node:crypto';
import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  listEnvelope,
  RefusalError,
  type TenantTransaction,
  validateAiDraftAccept,
  validateAiDraftCreate,
  validateAiDraftListQuery,
  validateAiDraftQuery,
  validateAiDraftReject,
  validateAiUseCaseConfigure,
  validateAiUseCaseListQuery,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import {
  AI_USE_CASE_REGISTRY,
  type AiSourceKind,
  type AiUseCase,
  adapterNotConfigured,
  evaluateEgress,
  looksLikeInjection,
  type ModelAdapter,
  type ModelSource,
  quoteSource,
  unsupportedReferences,
} from './ai-port';
import { type AgentBase, checkEnvelope, conflict, failed, notFound, stale, validate } from './base';

/**
 * A11 draft-only AI pipeline. A draft is built only from records the caller may already read (each
 * source is read through its owning service AS the caller), minimized (references and identifiers
 * dropped), wrapped as quoted data, sent to the configured model adapter (synthetic only) and stored
 * as a draft with model, prompt version, source versions and review flags (suspected injection,
 * unsupported references). It never becomes a fact by itself: a human holding ai.review accepts it
 * through the owning command (a clinical note draft labelled source ai_draft, or a staff message),
 * edits it, or rejects it. A draft whose sources changed is stale and cannot be accepted. Use cases
 * are off per tenant until enabled; the tenant-wide switch turns every use case off. Disabling AI or
 * removing the adapter leaves every deterministic workflow untouched.
 */
export const AI_DRAFT_RESOURCE = 'aiDraft';

export interface AiSourceReaders {
  read(kind: AiSourceKind, ctx: ActorContext, ref: string): Promise<{ version: number; text: string }>;
}
export interface AiOwners {
  createNoteDraft?(
    ctx: ActorContext,
    encounterRef: string,
    env: CommandEnvelope<unknown>,
  ): Promise<CommandResult<unknown>>;
  postStaffMessage?(
    ctx: ActorContext,
    threadRef: string,
    env: CommandEnvelope<unknown>,
  ): Promise<CommandResult<unknown>>;
}
export interface AiDeps {
  readonly model: ModelAdapter | null;
  readonly readers: AiSourceReaders | null;
  readonly owners: AiOwners;
  /** A12: the gate consulted before a use case can be enabled (absent: no evaluation requirement). */
  readonly gate?: (
    tx: TenantTransaction,
    useCase: AiUseCase,
    modelRef: string,
  ) => Promise<'pass' | 'fail' | 'inconclusive' | 'stale' | 'none'>;
}

const SKIP_KEY = /(Ref|Id|Refs|Ids|Digest|digest|At|correlationId|version)$/;
/** Minimizes a record read into `key: value` lines of short scalars; references and ids are dropped. */
export function minimize(data: unknown, max = 4000): string {
  const lines: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (lines.join('\n').length > max) return;
    if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) if (!SKIP_KEY.test(k)) walk(x, k);
    } else if (
      (typeof v === 'string' && v.length <= 2000) ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      lines.push(`${key}: ${String(v)}`);
    }
  };
  walk(data, 'record');
  return lines.join('\n').slice(0, max);
}

/** Reads each AI source through its owning service as the caller (wired by the API and MCP builders). */
export function createAiSourceReaders(s: {
  // biome-ignore lint/suspicious/noExplicitAny: owning services are structurally typed here.
  clinical?: {
    readEncounter(ctx: ActorContext, ref: string): Promise<any>;
    readNote(ctx: ActorContext, ref: string): Promise<any>;
  };
  // biome-ignore lint/suspicious/noExplicitAny: owning services are structurally typed here.
  engagement?: { readStaffThread(ctx: ActorContext, ref: string): Promise<any> };
  // biome-ignore lint/suspicious/noExplicitAny: owning services are structurally typed here.
  billing?: { getClaim(ctx: ActorContext, ref: string): Promise<any> };
}): AiSourceReaders {
  const of = (data: unknown) => {
    const inner = (data as { encounter?: unknown })?.encounter ?? data;
    const version = Number(
      (inner as { version?: unknown })?.version ?? (data as { version?: unknown })?.version ?? 0,
    );
    return { version: Number.isInteger(version) ? version : 0, text: minimize(data) };
  };
  const missing = () =>
    new RefusalError({
      code: 'service_unavailable',
      retryable: false,
      detail: { reason: 'owner_not_configured' },
    });
  return {
    async read(kind, ctx, ref) {
      if (kind === 'encounter' && s.clinical) return of(await s.clinical.readEncounter(ctx, ref));
      if (kind === 'note' && s.clinical) return of(await s.clinical.readNote(ctx, ref));
      if (kind === 'thread' && s.engagement) return of(await s.engagement.readStaffThread(ctx, ref));
      if (kind === 'claim' && s.billing) return of(await s.billing.getClaim(ctx, ref));
      throw missing();
    },
  };
}

interface DraftRow extends Record<string, unknown> {
  id: string;
  use_case: AiUseCase;
  state: 'offered' | 'flagged' | 'accepted' | 'rejected' | 'stale';
  text: string;
  model_ref: string;
  prompt_version_ref: string;
  source_refs: { kind: AiSourceKind; ref: string; version: number }[];
  flags: string[];
  created_by: string;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  accepted_kind: string | null;
  accepted_ref: string | null;
  version: number;
}

/** Stable reference of one tenant's use-case setting (its audit resource). */
function settingRef(tenantId: string, useCase: string): string {
  const h = createHash('sha256').update(`ai-use-case:${tenantId}:${useCase}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const disabled = (reason: string) =>
  new RefusalError({ code: 'forbidden', reasonCode: 'ai_use_case_disabled', detail: { reason } });

export function createAiPipeline(base: AgentBase, ai: AiDeps) {
  const { deps, execute } = base;
  const load = async (tx: TenantTransaction, ref: string, lock = false) =>
    (
      await tx.query<DraftRow>(
        `SELECT * FROM cuspatlas.ai_drafts WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
        [ref],
      )
    ).rows[0];
  const present = (r: DraftRow, fresh: boolean, checkedAt: Date) => ({
    draftRef: r.id,
    useCase: r.use_case,
    state: r.state,
    text: r.text,
    modelRef: r.model_ref,
    promptVersionRef: r.prompt_version_ref,
    sourceRefs: r.source_refs,
    freshness: { fresh, checkedAt: checkedAt.toISOString() },
    flags: r.flags,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    decidedBy: r.state === 'accepted' || r.state === 'rejected' ? r.decided_by : null,
    acceptedAs: r.accepted_ref === null ? null : { kind: r.accepted_kind ?? 'record', ref: r.accepted_ref },
    version: r.version,
  });
  const audit = (tx: TenantTransaction, op: string, ref: string, version: number, field: string) =>
    recordCommand(
      tx,
      { operation: op, resourceType: AI_DRAFT_RESOURCE, resourceRef: ref, resourceVersion: version },
      {
        changedFields: [field],
      },
    );

  /** Use-case gate: registered and not refused (AS-07), tenant switch on, use case enabled. */
  async function assertRunnable(tx: TenantTransaction, useCase: AiUseCase): Promise<void> {
    const entry = AI_USE_CASE_REGISTRY[useCase];
    if (!entry?.registered || entry.approval === 'notApproved') throw disabled('use_case_not_approved');
    const { rows } = await tx.query<{ use_case: string; enabled: boolean }>(
      `SELECT use_case, enabled FROM cuspatlas.ai_use_case_settings WHERE use_case IN ('*', $1)`,
      [useCase],
    );
    if (rows.some((r) => r.use_case === '*' && !r.enabled)) throw disabled('tenant_ai_disabled');
    if (!rows.some((r) => r.use_case === useCase && r.enabled)) throw disabled('use_case_disabled');
  }

  /** Current source versions as the caller; false when any source changed or is no longer visible. */
  async function fresh(ctx: ActorContext, r: DraftRow): Promise<boolean> {
    if (!ai.readers) return false;
    for (const s of r.source_refs) {
      const now = await ai.readers.read(s.kind, ctx, s.ref).catch(() => null);
      if (!now || now.version !== s.version) return false;
    }
    return true;
  }

  return {
    createAiDraft(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'ai.drafts.create';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ useCase: AiUseCase; sourceRefs: { kind: AiSourceKind; ref: string }[] }>(
          validateAiDraftCreate,
          p,
        );
        const entry = AI_USE_CASE_REGISTRY[p.useCase];
        if (entry.approval === 'notApproved') throw disabled('use_case_not_approved');
        const model = ai.model ?? adapterNotConfigured();
        // A-D5: nothing leaves the process unless the egress policy says so (never, today).
        if (evaluateEgress(model) !== 'localOnly') {
          throw new RefusalError({
            code: 'service_unavailable',
            retryable: false,
            detail: { reason: 'egress_refused' },
          });
        }
        if (!ai.readers) adapterNotConfigured();
        await deps.withTenantTransaction(ctx, (tx) => assertRunnable(tx, p.useCase));
        const kinds = p.sourceRefs.map((s) => s.kind);
        const required = kinds.filter((k) => k === entry.sources.required).length;
        const bad = kinds.findIndex(
          (k) => k !== entry.sources.required && !entry.sources.optional.includes(k),
        );
        if (bad >= 0) throw failed('source_kind_not_allowed', `/sourceRefs/${bad}/kind`);
        if (required !== 1) throw failed('required_source_missing', '/sourceRefs');
        // Every source through its owner, as the caller: hidden and missing are one 404.
        const sources: (ModelSource & { version: number })[] = [];
        for (const s of p.sourceRefs) {
          const read = await (ai.readers as AiSourceReaders).read(s.kind, ctx, s.ref);
          sources.push({ kind: s.kind, ref: s.ref, text: read.text, version: read.version });
        }
        const response = await model.generate({
          useCase: p.useCase,
          promptVersionRef: entry.promptVersionRef,
          instructions: `${entry.instructions}\n${sources.map(quoteSource).join('\n')}`,
          sources,
        });
        if (response.kind === 'unavailable') {
          // An availability failure, not a clinical event: nothing is persisted.
          throw new RefusalError({
            code: 'service_unavailable',
            retryable: true,
            detail: { reason: 'model_unavailable' },
          });
        }
        const flags = [
          ...(sources.some((s) => looksLikeInjection(s.text)) ? ['injection_suspected'] : []),
          ...(unsupportedReferences(response.text, sources).length > 0 ? ['unsupported_reference'] : []),
        ];
        const r = await deps.withTenantTransaction(ctx, (tx) =>
          execute<{ draftRef: string }>(ctx, envelope, tx, async () => {
            await assertRunnable(tx, p.useCase);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.ai_drafts (tenant_id, use_case, state, text, model_ref, prompt_version_ref,
                 source_refs, flags, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, cuspatlas.current_actor_id())
               RETURNING id`,
              [
                p.useCase,
                flags.length > 0 ? 'flagged' : 'offered',
                response.text,
                model.modelRef,
                entry.promptVersionRef,
                JSON.stringify(sources.map((s) => ({ kind: s.kind, ref: s.ref, version: s.version }))),
                flags,
              ],
            );
            const id = rows[0]?.id as string;
            await audit(tx, op, id, 1, 'draft');
            return { data: { draftRef: id }, version: 1 };
          }),
        );
        const row = await deps.withTenantTransaction(ctx, (tx) => load(tx, r.data.draftRef));
        if (!row) throw notFound();
        return {
          data: { draftRef: row.id, state: row.state, acceptedAs: null },
          version: row.version,
          correlationId: ctx.correlationId,
          replayed: r.replayed,
        };
      });
    },

    readAiDraft(ctx: ActorContext, query: unknown) {
      const op = 'ai.drafts.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ draftRef: string }>(validateAiDraftQuery, query);
        const row = await deps.withTenantTransaction(ctx, (tx) => load(tx, query.draftRef));
        if (!row || (ctx.agent && row.created_by !== ctx.actorId)) throw notFound();
        const open = row.state === 'offered' || row.state === 'flagged';
        const isFresh = open ? await fresh(ctx, row) : row.state !== 'stale';
        if (open && !isFresh) {
          // A draft whose sources changed is marked stale rather than silently re-offered.
          const after = await deps.withTenantTransaction(ctx, async (tx) => {
            await tx.query(
              `UPDATE cuspatlas.ai_drafts SET state = 'stale', version = version + 1
               WHERE id = $1 AND state IN ('offered', 'flagged')`,
              [row.id],
            );
            return load(tx, row.id);
          });
          return present(after ?? row, false, new Date());
        }
        return present(row, isFresh, new Date());
      });
    },

    listAiDrafts(ctx: ActorContext, query: unknown) {
      const op = 'ai.drafts.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ useCase?: string; state?: string; limit?: number; cursor?: string }>(
          validateAiDraftListQuery,
          query,
        );
        const pg = base.page(ctx, query);
        const mine = ctx.agent ? ctx.actorId : null;
        const args = [query.useCase ?? null, query.state ?? null, mine];
        const where = `WHERE ($1::text IS NULL OR use_case = $1) AND ($2::text IS NULL OR state = $2)
          AND ($3::uuid IS NULL OR created_by = $3)`;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          const total = Number(
            (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM cuspatlas.ai_drafts ${where}`, args))
              .rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<DraftRow>(
            `SELECT * FROM cuspatlas.ai_drafts ${where} ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
            [...args, pg.limit, pg.offset],
          );
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { useCase: query.useCase ?? null, state: query.state ?? null },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'draftRef' },
              total,
            }),
            items: rows.map((r) => present(r, r.state !== 'stale', at)),
          };
        });
      });
    },

    /** A human accepts (optionally edited) through the owning command; the draft records the result. */
    acceptAiDraft(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'ai.drafts.accept';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ draftRef: string; expectedVersion: number; editedText?: string }>(
          validateAiDraftAccept,
          p,
        );
        const row = await deps.withTenantTransaction(ctx, (tx) => load(tx, p.draftRef));
        if (!row) throw notFound();
        if (row.version !== p.expectedVersion) throw stale(row.version);
        if (row.state !== 'offered' && row.state !== 'flagged') throw conflict(`draft_${row.state}`);
        if (row.state === 'flagged' && p.editedText === undefined)
          throw conflict('flagged_draft_requires_edit');
        if (!(await fresh(ctx, row))) {
          await deps.withTenantTransaction(ctx, (tx) =>
            tx.query(
              `UPDATE cuspatlas.ai_drafts SET state = 'stale', version = version + 1 WHERE id = $1 AND state IN ('offered', 'flagged')`,
              [row.id],
            ),
          );
          throw conflict('draft_stale');
        }
        // Claim the decision for this human (a concurrent decider gets a retryable conflict).
        await deps.withTenantTransaction(ctx, async (tx) => {
          const { rowCount } = await tx.query(
            `UPDATE cuspatlas.ai_drafts SET decided_by = cuspatlas.current_actor_id()
             WHERE id = $1 AND state IN ('offered', 'flagged') AND (decided_by IS NULL OR decided_by = cuspatlas.current_actor_id())`,
            [row.id],
          );
          if (rowCount !== 1)
            throw new RefusalError({
              code: 'conflict',
              retryable: true,
              detail: { reason: 'decision_in_progress' },
            });
        });
        const text = p.editedText ?? row.text;
        const entry = AI_USE_CASE_REGISTRY[row.use_case];
        let accepted: { kind: string; ref: string } | null = null;
        try {
          const key = `ai-draft:${row.id}`;
          if (entry.acceptInto === 'clinical.notes.createDraft') {
            const encounter = row.source_refs.find((s) => s.kind === 'encounter')?.ref as string;
            const owner = ai.owners.createNoteDraft ?? adapterNotConfigured;
            const r = await owner(ctx, encounter, {
              operation: 'clinical.notes.createDraft',
              idempotencyKey: key,
              payload: {
                noteType: 'progress',
                source: 'ai_draft',
                aiModelRef: row.model_ref,
                aiPromptVersionRef: row.prompt_version_ref,
                content: { sections: [{ sectionKey: 'subjective', text: text.slice(0, 4000) }] },
              },
            });
            accepted = { kind: 'clinicalNote', ref: (r.data as { noteRef: string }).noteRef };
          } else if (entry.acceptInto === 'messaging.messages.post') {
            const thread = row.source_refs.find((s) => s.kind === 'thread')?.ref as string;
            const owner = ai.owners.postStaffMessage ?? adapterNotConfigured;
            const r = await owner(ctx, thread, {
              operation: 'messaging.messages.post',
              idempotencyKey: key,
              payload: { body: text.slice(0, 4000) },
            });
            const ref = Object.entries((r.data ?? {}) as Record<string, unknown>).find(([k]) =>
              k.endsWith('Ref'),
            )?.[1];
            accepted = typeof ref === 'string' ? { kind: 'message', ref } : null;
          }
        } catch (err) {
          await deps.withTenantTransaction(ctx, (tx) =>
            tx.query('UPDATE cuspatlas.ai_drafts SET decided_by = NULL WHERE id = $1 AND state IN ($2, $3)', [
              row.id,
              'offered',
              'flagged',
            ]),
          );
          throw err;
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          await tx.query(
            `UPDATE cuspatlas.ai_drafts SET state = 'accepted', decided_at = now(), accepted_kind = $2, accepted_ref = $3,
               version = version + 1 WHERE id = $1 AND state IN ('offered', 'flagged')`,
            [row.id, accepted?.kind ?? null, accepted?.ref ?? null],
          );
          await audit(tx, op, row.id, row.version + 1, 'decision');
          return {
            data: { draftRef: row.id, state: 'accepted' as const, acceptedAs: accepted },
            version: row.version + 1,
            correlationId: ctx.correlationId,
            replayed: false,
          };
        });
      });
    },

    rejectAiDraft(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'ai.drafts.reject';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ draftRef: string; expectedVersion: number; reason: string }>(validateAiDraftReject, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await load(tx, p.draftRef, true);
          if (!row) throw notFound();
          if (row.version !== p.expectedVersion) throw stale(row.version);
          if (row.state === 'accepted' || row.state === 'rejected') throw conflict(`draft_${row.state}`);
          await tx.query(
            `UPDATE cuspatlas.ai_drafts SET state = 'rejected', decided_by = cuspatlas.current_actor_id(), decided_at = now(),
               rejection_reason = $2, version = version + 1 WHERE id = $1`,
            [row.id, p.reason],
          );
          await audit(tx, op, row.id, row.version + 1, 'decision');
          return {
            data: { draftRef: row.id, state: 'rejected' as const, acceptedAs: null },
            version: row.version + 1,
            correlationId: ctx.correlationId,
            replayed: false,
          };
        });
      });
    },

    listAiUseCases(ctx: ActorContext, query: unknown) {
      const op = 'ai.useCases.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ limit?: number; cursor?: string }>(validateAiUseCaseListQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          const settings = new Map(
            (
              await tx.query<{ use_case: string; enabled: boolean }>(
                'SELECT use_case, enabled FROM cuspatlas.ai_use_case_settings',
              )
            ).rows.map((r) => [r.use_case, r.enabled]),
          );
          const tenantOn = settings.get('*') !== false;
          const items = [];
          for (const [useCase, e] of Object.entries(AI_USE_CASE_REGISTRY) as [
            AiUseCase,
            (typeof AI_USE_CASE_REGISTRY)[AiUseCase],
          ][]) {
            items.push({
              useCase,
              registered: e.registered,
              approval: e.approval,
              enabled: tenantOn && settings.get(useCase) === true && e.approval !== 'notApproved',
              gate: ai.gate ? await ai.gate(tx, useCase, ai.model?.modelRef ?? 'none') : ('none' as const),
              modelRef: ai.model?.modelRef ?? 'none',
              promptVersionRef: e.promptVersionRef,
              caseSetVersion: e.caseSetVersion,
            });
          }
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: {},
              locationRefs: decision.locationRefs,
              limit: query.limit ?? 25,
              nextCursor: null,
              ordering: { key: 'useCase', direction: 'asc', tieBreak: 'useCase' },
              total: items.length,
            }),
            items,
          };
        });
      });
    },

    /** Tenant switch per use case or for every use case ('*'). Enabling a refused use case is refused. */
    configureAiUseCase(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'ai.useCases.configure';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ useCase?: AiUseCase; enabled: boolean }>(validateAiUseCaseConfigure, p);
        const key = p.useCase ?? '*';
        if (p.enabled && p.useCase && AI_USE_CASE_REGISTRY[p.useCase].approval === 'notApproved') {
          throw disabled('use_case_not_approved');
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (p.enabled && p.useCase && ai.gate) {
            const verdict = await ai.gate(tx, p.useCase, ai.model?.modelRef ?? 'none');
            if (verdict !== 'pass') throw conflict(`evaluation_${verdict}`);
          }
          const { rows } = await tx.query<{ version: number }>(
            `INSERT INTO cuspatlas.ai_use_case_settings (tenant_id, use_case, enabled, updated_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())
             ON CONFLICT (tenant_id, use_case) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by,
               updated_at = now(), version = cuspatlas.ai_use_case_settings.version + 1
             RETURNING version`,
            [key, p.enabled],
          );
          const version = rows[0]?.version ?? 1;
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'aiUseCaseSetting',
              resourceRef: settingRef(ctx.tenantId, key),
              resourceVersion: version,
            },
            { changedFields: ['enabled'] },
          );
          return {
            data: { useCase: key, enabled: p.enabled },
            version,
            correlationId: ctx.correlationId,
            replayed: false,
          };
        });
      });
    },
  };
}
