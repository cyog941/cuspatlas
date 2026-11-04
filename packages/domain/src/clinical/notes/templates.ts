import {
  type ActorContext,
  type ApplicableTemplate,
  assertValid,
  CLINICAL_PROPERTIES,
  type CommandEnvelope,
  type CommandResult,
  type NoteTemplate,
  type NoteTemplateApplicableData,
  type NoteTemplateApplicableQuery,
  type NoteTemplateDefine,
  type NoteTemplateRetire,
  type NoteTemplateRevise,
  type NoteTemplateSection,
  type NoteTemplateVersion,
  RefusalError,
  type TenantTransaction,
  validateNoteTemplateApplicableQuery,
  validateNoteTemplateDefine,
  validateNoteTemplateRetire,
  validateNoteTemplateRevise,
} from '@cuspatlas/contracts';
import { recordCommand } from '../../events/record-command';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from '../base';
import { loadEncounter } from '../encounters';

export const NOTE_TEMPLATE_RESOURCE = 'clinicalNoteTemplate';
/** Engineering bound (not a clinical rule): a larger catalogue is refused, never truncated. */
const MAX_TEMPLATES = 200;

interface TemplateRow extends Record<string, unknown> {
  id: string;
  note_type: string;
  label: string;
  state: 'active' | 'retired';
  head_sequence: number;
  retired_reason_code: string | null;
  retired_by: string | null;
  retired_at: Date | null;
  version: number;
  created_by: string;
  created_at: Date;
}

export interface TemplateVersionRow extends Record<string, unknown> {
  id: string;
  template_id: string;
  sequence: number;
  enforced: boolean;
  sections: NoteTemplateSection[];
  procedure_code_refs: string[];
  defined_by: string;
  defined_at: Date;
}

const TEMPLATE_COLUMNS = `id, note_type, label, state, head_sequence, retired_reason_code, retired_by, retired_at,
  version, created_by, created_at`;
const VERSION_COLUMNS =
  'id, template_id, sequence, enforced, sections, procedure_code_refs, defined_by, defined_at';

export const toTemplateVersion = (v: TemplateVersionRow): NoteTemplateVersion => ({
  templateVersionRef: v.id,
  templateRef: v.template_id,
  sequence: v.sequence,
  enforced: v.enforced,
  sections: v.sections,
  procedureCodeRefs: v.procedure_code_refs,
  definedBy: { actorRef: v.defined_by },
  definedAt: v.defined_at.toISOString(),
});

async function loadTemplateRow(tx: TenantTransaction, templateRef: string, lock = ''): Promise<TemplateRow> {
  if (!UUID.test(templateRef)) throw notFound();
  const { rows } = await tx.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM cuspatlas.clinical_note_templates WHERE id = $1 ${lock}`,
    [templateRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** One template version by reference (retired templates included). Hidden and missing are one 404. */
export async function loadTemplateVersion(
  tx: TenantTransaction,
  templateVersionRef: string,
): Promise<TemplateVersionRow & { note_type: string; state: 'active' | 'retired'; head_sequence: number }> {
  if (!UUID.test(templateVersionRef)) throw notFound();
  const { rows } = await tx.query<
    TemplateVersionRow & { note_type: string; state: 'active' | 'retired'; head_sequence: number }
  >(
    `SELECT v.id, v.template_id, v.sequence, v.enforced, v.sections, v.procedure_code_refs, v.defined_by, v.defined_at,
       t.note_type, t.state, t.head_sequence
     FROM cuspatlas.clinical_note_template_versions v
     JOIN cuspatlas.clinical_note_templates t ON t.id = v.template_id AND t.tenant_id = v.tenant_id
     WHERE v.id = $1`,
    [templateVersionRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function versionsOf(
  tx: TenantTransaction,
  templateIds: readonly string[],
): Promise<TemplateVersionRow[]> {
  if (templateIds.length === 0) return [];
  const { rows } = await tx.query<TemplateVersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM cuspatlas.clinical_note_template_versions
     WHERE template_id = ANY ($1::uuid[]) ORDER BY template_id, sequence`,
    [templateIds],
  );
  return rows;
}

function project(t: TemplateRow, versions: readonly TemplateVersionRow[]): NoteTemplate {
  const own = versions.filter((v) => v.template_id === t.id).map(toTemplateVersion);
  const current = own.find((v) => v.sequence === t.head_sequence);
  if (!current) throw new Error('note template head version is missing');
  return {
    templateRef: t.id,
    noteType: t.note_type,
    label: t.label,
    state: t.state,
    retirement:
      t.state === 'retired' && t.retired_reason_code && t.retired_by && t.retired_at
        ? {
            reasonCode: t.retired_reason_code,
            retiredBy: { actorRef: t.retired_by },
            retiredAt: t.retired_at.toISOString(),
          }
        : null,
    currentVersion: current,
    versions: own,
    createdBy: { actorRef: t.created_by },
    createdAt: t.created_at.toISOString(),
    version: t.version,
  };
}

async function loadTemplate(tx: TenantTransaction, templateRef: string): Promise<NoteTemplate> {
  const t = await loadTemplateRow(tx, templateRef);
  return project(t, await versionsOf(tx, [t.id]));
}

function checkSections(sections: readonly NoteTemplateSection[]): void {
  const seen = new Set<string>();
  sections.forEach((s, i) => {
    if (seen.has(s.sectionKey)) throw failedAt(`/sections/${i}/sectionKey`, 'duplicateSection');
    seen.add(s.sectionKey);
  });
}

async function insertVersion(
  tx: TenantTransaction,
  templateId: string,
  sequence: number,
  p: { enforced: boolean; sections: readonly NoteTemplateSection[]; procedureCodeRefs?: readonly string[] },
): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.clinical_note_template_versions (tenant_id, template_id, sequence, enforced, sections,
       procedure_code_refs, defined_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::jsonb, $5::text[], cuspatlas.current_actor_id())`,
    [
      templateId,
      sequence,
      p.enforced,
      JSON.stringify(
        p.sections.map((s) => ({ sectionKey: s.sectionKey, label: s.label, required: s.required })),
      ),
      [...(p.procedureCodeRefs ?? [])],
    ],
  );
}

const isPgError = (err: unknown, code: string) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;

type Ack = { readonly ref: string };

/**
 * C9 commands and reads. Templates are practice configuration (`admin.configure`, human only);
 * reads need `clinical.read`. Nothing here applies a template to a note: C10 pins a version on a
 * draft and evaluates it at signing.
 */
export function createNoteTemplateOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  async function activeDuplicate(
    tx: TenantTransaction,
    noteType: string,
    label: string,
  ): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM cuspatlas.clinical_note_templates
       WHERE state = 'active' AND note_type = $1 AND lower(label) = lower($2)`,
      [noteType, label],
    );
    return rows[0]?.id ?? null;
  }

  return {
    defineNoteTemplate(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<NoteTemplate>> {
      const op = 'clinical.noteTemplates.define';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteTemplateDefine>(validateNoteTemplateDefine, p, CLINICAL_PROPERTIES);
        checkSections(p.sections);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            const existing = await activeDuplicate(tx, p.noteType, p.label);
            const exists = (ref: string) =>
              conflict('template_exists', { blockingRefs: [{ kind: NOTE_TEMPLATE_RESOURCE, ref }] });
            if (existing) throw exists(existing);
            const { rows: count } = await tx.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM cuspatlas.clinical_note_templates WHERE state = 'active'`,
            );
            if ((count[0]?.n ?? 0) >= MAX_TEMPLATES) throw failedAt('/', 'tooManyTemplates');
            let id: string | undefined;
            try {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_note_templates (tenant_id, note_type, label, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id()) RETURNING id`,
                [p.noteType, p.label],
              );
              id = rows[0]?.id;
            } catch (err) {
              // A concurrent definition of the same active type and label won the unique index.
              if (isPgError(err, '23505')) throw conflict('template_exists');
              throw err;
            }
            if (!id) throw new Error('insert returned no row');
            await insertVersion(tx, id, 1, p);
            await recordCommand(
              tx,
              { operation: op, resourceType: NOTE_TEMPLATE_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['noteType', 'label', 'enforced', 'sections', 'procedureCodeRefs'] },
            );
            return { data: { ref: id }, version: 1 };
          });
          return { ...r, data: await loadTemplate(tx, r.data.ref) };
        });
      });
    },

    reviseNoteTemplate(
      ctx: ActorContext,
      templateRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<NoteTemplate>> {
      const op = 'clinical.noteTemplates.revise';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteTemplateRevise>(validateNoteTemplateRevise, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const found = await loadTemplateRow(tx, templateRef);
          checkSections(p.sections);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { templateRef, ...p } }, tx, async () => {
            const t = await loadTemplateRow(tx, found.id, 'FOR UPDATE');
            if (t.state === 'retired') throw conflict('template_retired');
            if (t.version !== p.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: t.version } });
            }
            const sequence = t.head_sequence + 1;
            await insertVersion(tx, t.id, sequence, p);
            const { rows } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.clinical_note_templates SET head_sequence = $2, version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version`,
              [t.id, sequence],
            );
            const version = rows[0]?.version;
            if (version === undefined) throw new Error('update returned no row');
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: NOTE_TEMPLATE_RESOURCE,
                resourceRef: t.id,
                resourceVersion: version,
              },
              { changedFields: ['enforced', 'sections', 'procedureCodeRefs'] },
            );
            return { data: { ref: t.id }, version };
          });
          return { ...r, data: await loadTemplate(tx, r.data.ref) };
        });
      });
    },

    retireNoteTemplate(
      ctx: ActorContext,
      templateRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<NoteTemplate>> {
      const op = 'clinical.noteTemplates.retire';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteTemplateRetire>(validateNoteTemplateRetire, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const found = await loadTemplateRow(tx, templateRef);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { templateRef, ...p } }, tx, async () => {
            const t = await loadTemplateRow(tx, found.id, 'FOR UPDATE');
            if (t.state === 'retired') throw conflict('template_retired');
            if (t.version !== p.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: t.version } });
            }
            const { rows } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.clinical_note_templates SET state = 'retired', retired_reason_code = $2,
                 retired_by = cuspatlas.current_actor_id(), retired_at = now(), version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version`,
              [t.id, p.reasonCode],
            );
            const version = rows[0]?.version;
            if (version === undefined) throw new Error('update returned no row');
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: NOTE_TEMPLATE_RESOURCE,
                resourceRef: t.id,
                resourceVersion: version,
              },
              { changedFields: ['state', 'retirement'] },
            );
            return { data: { ref: t.id }, version };
          });
          return { ...r, data: await loadTemplate(tx, r.data.ref) };
        });
      });
    },

    /** A template with every version (retired templates included). */
    readNoteTemplate(ctx: ActorContext, templateRef: string): Promise<NoteTemplate> {
      const op = 'clinical.noteTemplates.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, (tx) => loadTemplate(tx, templateRef));
      });
    },

    /** One template version; resolvable for as long as anything references it. */
    readNoteTemplateVersion(ctx: ActorContext, templateVersionRef: string): Promise<NoteTemplateVersion> {
      const op = 'clinical.noteTemplates.readVersion';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) =>
          toTemplateVersion(await loadTemplateVersion(tx, templateVersionRef)),
        );
      });
    },

    /**
     * Active templates for an encounter: those whose current version associates one of the given
     * procedure codes, and, separately, those without any code association. Nothing is applied.
     */
    listApplicableTemplates(
      ctx: ActorContext,
      encounterRef: string,
      query: unknown,
    ): Promise<NoteTemplateApplicableData> {
      const op = 'clinical.noteTemplates.applicable';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<NoteTemplateApplicableQuery>(
          validateNoteTemplateApplicableQuery,
          query,
          CLINICAL_PROPERTIES,
        );
        const codes =
          query.procedureCodeRefs === undefined ? [] : [...new Set(query.procedureCodeRefs.split(','))];
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await loadEncounter(tx, decision, encounterRef);
          const { rows } = await tx.query<TemplateRow>(
            `SELECT ${TEMPLATE_COLUMNS} FROM cuspatlas.clinical_note_templates WHERE state = 'active'
             ORDER BY created_at, id LIMIT ${MAX_TEMPLATES}`,
          );
          const versions = await versionsOf(
            tx,
            rows.map((t) => t.id),
          );
          const associated: ApplicableTemplate[] = [];
          const general: ApplicableTemplate[] = [];
          for (const t of rows) {
            const current = project(t, versions).currentVersion;
            const entry = (matched: string[]): ApplicableTemplate => ({
              templateRef: t.id,
              noteType: t.note_type,
              label: t.label,
              current,
              matchedCodeRefs: matched,
            });
            if (current.procedureCodeRefs.length === 0) {
              general.push(entry([]));
              continue;
            }
            const matched = current.procedureCodeRefs.filter((c) => codes.includes(c));
            if (matched.length > 0) associated.push(entry(matched));
          }
          return {
            encounterRef: encounter.id,
            procedureCodeRefs: codes,
            procedureSource: 'caller_supplied',
            associated,
            general,
          };
        });
      });
    },
  };
}
