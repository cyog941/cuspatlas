import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalAuthor,
  type ClinicalRole,
  type CommandEnvelope,
  type CommandResult,
  type HistoryAtSigning,
  isRefusalError,
  type Note,
  type NoteAddendum,
  type NoteAmend,
  type NoteContentRead,
  type NoteCosign,
  type NoteDraftCreate,
  type NoteDraftUpdate,
  type NoteSectionEntry,
  type NoteSign,
  type NoteSourceKind,
  type NoteTemplateCheck,
  type NoteVersion,
  RefusalError,
  type TenantTransaction,
  validateNoteAddendum,
  validateNoteAmend,
  validateNoteCosign,
  validateNoteDraftCreate,
  validateNoteDraftUpdate,
  validateNoteSign,
} from '@cuspatlas/contracts';
import { recordCommand } from '../../events/record-command';
import { recordSensitiveRead } from '../../events/record-sensitive-read';
import type { PostMergeFactProbe } from '../../patients/merge';
import type { AuthorizationDecision } from '../../policy/authorize';
import { authorOf, resolveClinicalAuthor } from '../authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from '../base';
import { assertNotMerged, loadClinicalPatient, loadEncounter, requireOpenEncounter } from '../encounters';
import { type DigestInput, noteVersionDigest } from './digest';
import { checkAgainstTemplate } from './template-check';
import { loadTemplateVersion, NOTE_TEMPLATE_RESOURCE, type TemplateVersionRow } from './templates';

export const NOTE_RESOURCE = 'clinicalNote';
const NOTE_COSIGNATURE_RESOURCE = 'clinicalNoteCosignature';
const NOTE_TEMPLATE_VERSION_RESOURCE = 'clinicalNoteTemplateVersion';
/** Engineering bound per encounter (not a clinical rule): more is refused, never truncated. */
const MAX_NOTES_PER_ENCOUNTER = 50;

type NoteKind = 'original' | 'amendment' | 'addendum';

interface NoteRow extends Record<string, unknown> {
  id: string;
  encounter_id: string;
  note_type: string;
  template_version_id: string | null;
  source: NoteSourceKind;
  ai_model_ref: string | null;
  ai_prompt_version_ref: string | null;
  state: 'draft' | 'signed';
  draft_sections: NoteSectionEntry[];
  draft_code_refs: string[];
  draft_updated_by: string;
  draft_updated_by_role: ClinicalRole;
  draft_updated_by_credential_ref: string | null;
  draft_updated_at: Date;
  head_sequence: number;
  version: number;
  created_by: string;
  created_by_role: ClinicalRole;
  created_by_credential_ref: string | null;
  created_at: Date;
}

interface VersionRow extends Record<string, unknown> {
  id: string;
  sequence: number;
  kind: NoteKind;
  references_sequence: number | null;
  reason_code: string | null;
  sections: NoteSectionEntry[] | null;
  code_refs: string[] | null;
  addendum_text: string | null;
  template_version_id: string | null;
  template_check: NoteTemplateCheck | null;
  history_refs: HistoryAtSigning['versions'];
  authored_by: string;
  authored_by_role: ClinicalRole;
  authored_by_credential_ref: string | null;
  authored_at: Date;
  cosign_required: boolean;
  supervising_resource_id: string | null;
  content_digest: string;
  cosigned_by: string | null;
  cosigned_by_role: ClinicalRole | null;
  cosigned_by_credential_ref: string | null;
  cosigned_at: Date | null;
}

const NOTE_COLUMNS = `id, encounter_id, note_type, template_version_id, source, ai_model_ref, ai_prompt_version_ref, state,
  draft_sections, draft_code_refs, draft_updated_by, draft_updated_by_role, draft_updated_by_credential_ref,
  draft_updated_at, head_sequence, version, created_by, created_by_role, created_by_credential_ref, created_at`;

interface Located {
  readonly note: NoteRow;
  readonly encounter: { readonly id: string; readonly subject_patient_id: string };
}

async function loadNote(tx: TenantTransaction, noteRef: string, lock = ''): Promise<NoteRow> {
  if (!UUID.test(noteRef)) throw notFound();
  const { rows } = await tx.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM cuspatlas.clinical_notes WHERE id = $1 ${lock}`,
    [noteRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** A note is visible only through its encounter: another tenant or location is the same 404. */
async function locate(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  noteRef: string,
): Promise<Located> {
  const note = await loadNote(tx, noteRef);
  const encounter = await loadEncounter(tx, decision, note.encounter_id);
  return { note, encounter };
}

async function versionRows(tx: TenantTransaction, noteId: string): Promise<VersionRow[]> {
  const { rows } = await tx.query<VersionRow>(
    `SELECT v.id, v.sequence, v.kind, v.references_sequence, v.reason_code, v.sections, v.code_refs, v.addendum_text,
       v.template_version_id, v.template_check, v.history_refs, v.authored_by, v.authored_by_role,
       v.authored_by_credential_ref, v.authored_at, v.cosign_required, v.supervising_resource_id, v.content_digest,
       c.cosigned_by, c.cosigned_by_role, c.cosigned_by_credential_ref, c.cosigned_at
     FROM cuspatlas.clinical_note_versions v
     LEFT JOIN cuspatlas.clinical_note_cosignatures c ON c.note_version_id = v.id AND c.tenant_id = v.tenant_id
     WHERE v.note_id = $1 ORDER BY v.sequence`,
    [noteId],
  );
  return rows;
}

const sourceOf = (n: NoteRow) => ({
  kind: n.source,
  aiModelRef: n.ai_model_ref,
  aiPromptVersionRef: n.ai_prompt_version_ref,
});

const contentOf = (sections: readonly NoteSectionEntry[], codes: readonly string[]): NoteContentRead => ({
  sections: sections.map((s) => ({ sectionKey: s.sectionKey, text: s.text })),
  procedureCodeRefs: [...codes],
});

const historyOf = (refs: HistoryAtSigning['versions']): HistoryAtSigning => ({
  recorded: refs.some((r) => r.version > 0),
  versions: refs.map((r) => ({
    streamRef: r.streamRef,
    version: r.version,
    historyVersionRef: r.historyVersionRef,
  })),
});

function digestInputOf(n: NoteRow, v: VersionRow): DigestInput {
  return {
    noteRef: n.id,
    encounterRef: n.encounter_id,
    noteType: n.note_type,
    source: sourceOf(n),
    sequence: v.sequence,
    kind: v.kind,
    referencesSequence: v.references_sequence,
    reasonCode: v.reason_code,
    content: v.sections === null ? null : contentOf(v.sections, v.code_refs ?? []),
    addendumText: v.addendum_text,
    templateVersionRef: v.template_version_id,
    templateCheck: v.template_check,
    historyAtSigning: historyOf(v.history_refs),
    authoredBy: authorOf(v.authored_by, v.authored_by_role, v.authored_by_credential_ref),
    authoredAt: v.authored_at.toISOString(),
    cosignRequired: v.cosign_required,
    supervisingResourceRef: v.supervising_resource_id,
  };
}

/** A minimal query surface (a privileged pg client during an import). */
export interface DigestQueryable {
  query<R extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * C18 import verification: recomputes the digest of every frozen note version of one tenant from its
 * stored content (the same function the reads verify with) and returns the versions whose stored
 * digest does not match. The C18 import runs it before commit, with triggers off.
 */
export async function verifyImportedNoteDigests(q: DigestQueryable, tenantId: string): Promise<string[]> {
  const notes = await q.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM cuspatlas.clinical_notes WHERE tenant_id = $1`,
    [tenantId],
  );
  const byId = new Map(notes.rows.map((n) => [n.id, n]));
  const versions = await q.query<VersionRow & { note_id: string }>(
    `SELECT v.note_id, v.id, v.sequence, v.kind, v.references_sequence, v.reason_code, v.sections, v.code_refs,
       v.addendum_text, v.template_version_id, v.template_check, v.history_refs, v.authored_by, v.authored_by_role,
       v.authored_by_credential_ref, v.authored_at, v.cosign_required, v.supervising_resource_id, v.content_digest
     FROM cuspatlas.clinical_note_versions v WHERE v.tenant_id = $1 ORDER BY v.note_id, v.sequence`,
    [tenantId],
  );
  const bad: string[] = [];
  for (const v of versions.rows) {
    const n = byId.get(v.note_id);
    if (!n || noteVersionDigest(digestInputOf(n, v)) !== v.content_digest) bad.push(v.id);
  }
  return bad;
}

function toVersion(n: NoteRow, v: VersionRow, all: readonly VersionRow[]): NoteVersion {
  const supersededBy =
    v.kind === 'addendum'
      ? null
      : (all.find((x) => x.kind === 'amendment' && x.sequence > v.sequence)?.sequence ?? null);
  const input = digestInputOf(n, v);
  return {
    noteVersionRef: v.id,
    sequence: v.sequence,
    kind: v.kind,
    referencesSequence: v.references_sequence,
    supersededBySequence: supersededBy,
    reasonCode: v.reason_code,
    content: input.content,
    addendumText: v.addendum_text,
    templateVersionRef: v.template_version_id,
    templateCheck: v.template_check,
    historyAtSigning: input.historyAtSigning,
    authoredBy: input.authoredBy,
    authoredAt: input.authoredAt,
    contentDigest: v.content_digest,
    // Recomputed on every read: a row altered behind every guard no longer verifies.
    digestVerified: noteVersionDigest(input) === v.content_digest,
    cosignature: {
      required: v.cosign_required,
      supervisingResourceRef: v.supervising_resource_id,
      status: !v.cosign_required ? 'not_required' : v.cosigned_by === null ? 'pending' : 'cosigned',
      cosignedBy:
        v.cosigned_by !== null && v.cosigned_by_role !== null
          ? authorOf(v.cosigned_by, v.cosigned_by_role, v.cosigned_by_credential_ref)
          : null,
      cosignedAt: v.cosigned_at?.toISOString() ?? null,
    },
  };
}

const draftContent = (n: NoteRow): NoteContentRead => contentOf(n.draft_sections, n.draft_code_refs);

async function checkOf(
  tx: TenantTransaction,
  templateVersionId: string | null,
  content: NoteContentRead,
): Promise<NoteTemplateCheck | null> {
  if (templateVersionId === null) return null;
  const t = await loadTemplateVersion(tx, templateVersionId);
  return checkAgainstTemplate(
    { enforced: t.enforced, sections: t.sections, procedureCodeRefs: t.procedure_code_refs },
    content,
  );
}

async function project(tx: TenantTransaction, located: Located): Promise<Note> {
  const n = located.note;
  const rows = await versionRows(tx, n.id);
  const content = draftContent(n);
  return {
    noteRef: n.id,
    encounterRef: n.encounter_id,
    patientRef: located.encounter.subject_patient_id,
    noteType: n.note_type,
    status: n.state === 'draft' ? 'draft' : rows.some((v) => v.kind === 'amendment') ? 'amended' : 'signed',
    source: sourceOf(n),
    templateVersionRef: n.template_version_id,
    draft:
      n.state === 'draft'
        ? {
            content,
            templateCheck: await checkOf(tx, n.template_version_id, content),
            updatedBy: authorOf(
              n.draft_updated_by,
              n.draft_updated_by_role,
              n.draft_updated_by_credential_ref,
            ),
            updatedAt: n.draft_updated_at.toISOString(),
          }
        : null,
    versions: rows.map((v) => toVersion(n, v, rows)),
    createdBy: authorOf(n.created_by, n.created_by_role, n.created_by_credential_ref),
    createdAt: n.created_at.toISOString(),
    version: n.version,
  };
}

/** The C8 history versions current for the encounter's patient (one per source stream). */
async function historySnapshot(
  tx: TenantTransaction,
  patientId: string,
): Promise<HistoryAtSigning['versions']> {
  const { rows } = await tx.query<{ stream_id: string; head_sequence: number; version_id: string | null }>(
    `SELECT s.id AS stream_id, s.head_sequence, v.id AS version_id FROM cuspatlas.clinical_history_streams s
     LEFT JOIN cuspatlas.clinical_history_versions v
       ON v.stream_id = s.id AND v.tenant_id = s.tenant_id AND v.sequence = s.head_sequence
     WHERE s.subject_patient_id = $1 ORDER BY s.id`,
    [patientId],
  );
  return rows.map((r) => ({
    streamRef: r.stream_id,
    version: r.head_sequence,
    historyVersionRef: r.version_id,
  }));
}

/** The encounter's current supervising-provider assignment, if any (C5 assignments, append-only). */
async function supervisingResource(tx: TenantTransaction, encounterId: string): Promise<string | null> {
  const { rows } = await tx.query<{ resource_id: string | null }>(
    `SELECT resource_id FROM cuspatlas.clinical_encounter_assignments
     WHERE encounter_id = $1 AND role = 'supervising_provider' ORDER BY sequence DESC LIMIT 1`,
    [encounterId],
  );
  return rows[0]?.resource_id ?? null;
}

const hasText = (c: NoteContentRead) => c.sections.some((s) => s.text.trim().length > 0);

function checkSectionKeys(sections: readonly NoteSectionEntry[], pointer: string): void {
  const seen = new Set<string>();
  sections.forEach((s, i) => {
    if (seen.has(s.sectionKey)) throw failedAt(`${pointer}/sections/${i}/sectionKey`, 'duplicateSection');
    seen.add(s.sectionKey);
  });
}

/**
 * Freezes one version: content, references, the C8 history versions current now, the supervising
 * assignment (co-signature, C-S2-Q5 pending), the author and the database instant, then the digest
 * over all of them. Written once; nothing updates it.
 */
async function freeze(
  tx: TenantTransaction,
  located: Located,
  author: ClinicalAuthor,
  v: {
    readonly sequence: number;
    readonly kind: NoteKind;
    readonly referencesSequence: number | null;
    readonly reasonCode: string | null;
    readonly content: NoteContentRead | null;
    readonly addendumText: string | null;
    readonly templateVersionRef: string | null;
    readonly templateCheck: NoteTemplateCheck | null;
  },
): Promise<void> {
  const n = located.note;
  const history = await historySnapshot(tx, located.encounter.subject_patient_id);
  const supervising = await supervisingResource(tx, located.encounter.id);
  const { rows } = await tx.query<{ now: Date }>(
    `SELECT date_trunc('milliseconds', clock_timestamp()) AS now`,
  );
  const now = rows[0]?.now;
  if (!now) throw new Error('clock read returned no row');
  const input: DigestInput = {
    noteRef: n.id,
    encounterRef: n.encounter_id,
    noteType: n.note_type,
    source: sourceOf(n),
    sequence: v.sequence,
    kind: v.kind,
    referencesSequence: v.referencesSequence,
    reasonCode: v.reasonCode,
    content: v.content,
    addendumText: v.addendumText,
    templateVersionRef: v.templateVersionRef,
    templateCheck: v.templateCheck,
    historyAtSigning: historyOf(history),
    authoredBy: author,
    authoredAt: now.toISOString(),
    cosignRequired: supervising !== null,
    supervisingResourceRef: supervising,
  };
  await tx.query(
    `INSERT INTO cuspatlas.clinical_note_versions (tenant_id, note_id, sequence, kind, references_sequence, reason_code,
       sections, code_refs, addendum_text, template_version_id, template_check, history_refs, authored_by,
       authored_by_role, authored_by_credential_ref, authored_at, cosign_required, supervising_resource_id, content_digest)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb, $7::text[], $8, $9, $10::jsonb, $11::jsonb,
       cuspatlas.current_actor_id(), $12, $13, $14, $15, $16, $17)`,
    [
      n.id,
      v.sequence,
      v.kind,
      v.referencesSequence,
      v.reasonCode,
      v.content === null ? null : JSON.stringify(v.content.sections),
      v.content === null ? null : v.content.procedureCodeRefs,
      v.addendumText,
      v.templateVersionRef,
      v.templateCheck === null ? null : JSON.stringify(v.templateCheck),
      JSON.stringify(history),
      author.role,
      author.credentialRef,
      now,
      supervising !== null,
      supervising,
      noteVersionDigest(input),
    ],
  );
}

async function bumpHead(tx: TenantTransaction, noteId: string, signing: boolean): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.clinical_notes SET ${signing ? `state = 'signed', ` : ''}head_sequence = head_sequence + 1,
       version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
    [noteId],
  );
  const version = rows[0]?.version;
  if (version === undefined) throw new Error('update returned no row');
  return version;
}

/** The pinned template version must be the current version of an active template of the note type. */
async function pinTemplate(
  tx: TenantTransaction,
  ref: string,
  noteType: string,
): Promise<TemplateVersionRow> {
  const v = await loadTemplateVersion(tx, ref);
  if (v.note_type !== noteType) throw failedAt('/noteType', 'templateNoteTypeMismatch');
  if (v.state === 'retired') {
    throw conflict('template_retired', {
      blockingRefs: [{ kind: NOTE_TEMPLATE_RESOURCE, ref: v.template_id }],
    });
  }
  if (v.sequence !== v.head_sequence) {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM cuspatlas.clinical_note_template_versions WHERE template_id = $1 AND sequence = $2',
      [v.template_id, v.head_sequence],
    );
    throw conflict('template_version_superseded', {
      blockingRefs: rows.map((r) => ({ kind: NOTE_TEMPLATE_VERSION_RESOURCE, ref: r.id })),
    });
  }
  return v;
}

function checkSource(p: NoteDraftCreate): void {
  const ai = (p.source ?? 'human') === 'ai_draft';
  if (ai) {
    if (p.aiModelRef === undefined) throw failedAt('/aiModelRef', 'aiDraftUnattributed');
    if (p.aiPromptVersionRef === undefined) throw failedAt('/aiPromptVersionRef', 'aiDraftUnattributed');
  } else if (p.aiModelRef !== undefined || p.aiPromptVersionRef !== undefined) {
    throw failedAt(
      p.aiModelRef !== undefined ? '/aiModelRef' : '/aiPromptVersionRef',
      'aiRefsOnlyForAiDraft',
    );
  }
}

const stale = (current: number) =>
  new RefusalError({ code: 'stale_version', detail: { currentVersion: current } });
const noteSigned = (noteId: string, alternative: string) =>
  conflict('note_signed', { blockingRefs: [{ kind: NOTE_RESOURCE, ref: noteId }], alternative });
const notSigned = (noteId: string) =>
  conflict('note_not_signed', {
    blockingRefs: [{ kind: NOTE_RESOURCE, ref: noteId }],
    alternative: 'clinical.notes.sign',
  });

function enforce(check: NoteTemplateCheck | null): void {
  if (check?.blocksSigning) {
    throw conflict('template_deficit', {
      deficits: {
        missingSections: check.missingSections,
        missingCodeRefs: check.missingCodeRefs,
        unresolvedSections: check.unresolvedSections,
      },
    });
  }
}

/**
 * S-D2 seam: notes drafted, signed, amended, addended or co-signed on a merge survivor's encounters
 * after the merge are clinical facts that make a later unmerge need the reconciliation review.
 */
export const NOTE_POST_MERGE_FACT_PROBE: PostMergeFactProbe = {
  factKind: 'clinical',
  async count(tx: TenantTransaction, survivorRef: string, mergedAt: Date): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM cuspatlas.clinical_notes n
                JOIN cuspatlas.clinical_encounters e ON e.id = n.encounter_id AND e.tenant_id = n.tenant_id
                WHERE e.subject_patient_id = $1 AND (n.created_at >= $2 OR n.draft_updated_at >= $2))
            + (SELECT count(*) FROM cuspatlas.clinical_note_versions v
                JOIN cuspatlas.clinical_notes n ON n.id = v.note_id AND n.tenant_id = v.tenant_id
                JOIN cuspatlas.clinical_encounters e ON e.id = n.encounter_id AND e.tenant_id = n.tenant_id
                WHERE e.subject_patient_id = $1 AND v.authored_at >= $2)
            + (SELECT count(*) FROM cuspatlas.clinical_note_cosignatures c
                JOIN cuspatlas.clinical_note_versions v ON v.id = c.note_version_id AND v.tenant_id = c.tenant_id
                JOIN cuspatlas.clinical_notes n ON n.id = v.note_id AND n.tenant_id = v.tenant_id
                JOIN cuspatlas.clinical_encounters e ON e.id = n.encounter_id AND e.tenant_id = n.tenant_id
                WHERE e.subject_patient_id = $1 AND c.cosigned_at >= $2) AS n`,
      [survivorRef, mergedAt],
    );
    return Number(rows[0]?.n ?? 0);
  },
};

type Ack = { readonly ref: string };

/**
 * C10 commands and reads. Signing, amending and co-signing are human-only (`clinical.sign`) with a
 * resolvable clinical author; drafting and addenda need `clinical.write`. No command updates frozen
 * content; template enforcement runs at signing and amendment (C-D4). Nothing generates note text.
 */
export function createNoteOperations(base: ClinicalBase) {
  /**
   * 7. Tamper detection: a frozen version whose stored digest no longer matches its recomputed
   * content writes a security attempt (alert) row through the independent sink, on reads as on
   * commands; commands that build on the note (amend, addendum, co-sign) are then refused.
   */
  async function reportTamper(ctx: ActorContext, operation: string): Promise<void> {
    await base.deps.recording.sink.record({
      correlationId: ctx.correlationId,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      operation,
      reasonCode: 'clinical_note_tampered',
    });
  }
  async function assertIntact(
    ctx: ActorContext,
    operation: string,
    n: NoteRow,
    rows: readonly VersionRow[],
  ): Promise<void> {
    if (rows.every((v) => noteVersionDigest(digestInputOf(n, v)) === v.content_digest)) return;
    await reportTamper(ctx, operation);
    throw conflict('note_integrity_failed', { blockingRefs: [{ kind: NOTE_RESOURCE, ref: n.id }] });
  }
  async function alertIfTampered(
    ctx: ActorContext,
    operation: string,
    notes: readonly Note[],
  ): Promise<void> {
    if (notes.some((n) => n.versions.some((v) => !v.digestVerified))) await reportTamper(ctx, operation);
  }
  const { deps, execute } = base;

  /** Whether the caller holds an additional capability, checked before the transaction. */
  async function holds(ctx: ActorContext, action: 'clinical.notes.amendOthers'): Promise<boolean> {
    try {
      await deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'clinical' });
      return true;
    } catch (err) {
      if (isRefusalError(err) && err.code === 'forbidden') return false;
      throw err;
    }
  }

  const respond = async (tx: TenantTransaction, decision: AuthorizationDecision, r: CommandResult<Ack>) => ({
    ...r,
    data: await project(tx, await locate(tx, decision, r.data.ref)),
  });

  return {
    createNoteDraft(
      ctx: ActorContext,
      encounterRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Note>> {
      const op = 'clinical.notes.createDraft';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteDraftCreate>(validateNoteDraftCreate, p, CLINICAL_PROPERTIES);
        checkSource(p);
        if (p.content) checkSectionKeys(p.content.sections, '/content');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await loadEncounter(tx, decision, encounterRef);
          const patient = await loadClinicalPatient(tx, encounter.subject_patient_id);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { encounterRef, ...p } },
            tx,
            async () => {
              // A closed encounter takes no new note; clarify an existing note with an addendum instead.
              await requireOpenEncounter(tx, decision, encounter.id, {
                patientId: patient.id,
                alternative: 'clinical.notes.addendum',
              });
              assertNotMerged(patient);
              if (p.templateVersionRef !== undefined) await pinTemplate(tx, p.templateVersionRef, p.noteType);
              const { rows: existing } = await tx.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM cuspatlas.clinical_notes WHERE encounter_id = $1',
                [encounter.id],
              );
              if ((existing[0]?.n ?? 0) >= MAX_NOTES_PER_ENCOUNTER) throw failedAt('/', 'tooManyNotes');
              const content = contentOf(p.content?.sections ?? [], p.content?.procedureCodeRefs ?? []);
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.clinical_notes (tenant_id, encounter_id, note_type, template_version_id, source,
                 ai_model_ref, ai_prompt_version_ref, draft_sections, draft_code_refs, draft_updated_by,
                 draft_updated_by_role, draft_updated_by_credential_ref, created_by, created_by_role,
                 created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[],
                 cuspatlas.current_actor_id(), $9, $10, cuspatlas.current_actor_id(), $9, $10)
               RETURNING id`,
                [
                  encounter.id,
                  p.noteType,
                  p.templateVersionRef ?? null,
                  p.source ?? 'human',
                  p.aiModelRef ?? null,
                  p.aiPromptVersionRef ?? null,
                  JSON.stringify(content.sections),
                  content.procedureCodeRefs,
                  author.role,
                  author.credentialRef,
                ],
              );
              const id = rows[0]?.id;
              if (!id) throw new Error('insert returned no row');
              await recordCommand(
                tx,
                { operation: op, resourceType: NOTE_RESOURCE, resourceRef: id, resourceVersion: 1 },
                { changedFields: ['noteType', 'templateVersionRef', 'source', 'draft'] },
              );
              return { data: { ref: id }, version: 1 };
            },
          );
          return respond(tx, decision, r);
        });
      });
    },

    updateNoteDraft(
      ctx: ActorContext,
      noteRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Note>> {
      const op = 'clinical.notes.updateDraft';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteDraftUpdate>(validateNoteDraftUpdate, p, CLINICAL_PROPERTIES);
        checkSectionKeys(p.content.sections, '/content');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const located = await locate(tx, decision, noteRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { noteRef, ...p } }, tx, async () => {
            const n = await loadNote(tx, located.note.id, 'FOR UPDATE');
            if (n.state === 'signed') throw noteSigned(n.id, 'clinical.notes.amend');
            if (n.version !== p.expectedVersion) throw stale(n.version);
            const pin = p.templateVersionRef ?? n.template_version_id;
            if (p.templateVersionRef !== undefined && p.templateVersionRef !== n.template_version_id) {
              await pinTemplate(tx, p.templateVersionRef, n.note_type);
            }
            const content = contentOf(p.content.sections, p.content.procedureCodeRefs ?? []);
            const { rows } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.clinical_notes SET template_version_id = $2, draft_sections = $3::jsonb,
                 draft_code_refs = $4::text[], draft_updated_by = cuspatlas.current_actor_id(), draft_updated_by_role = $5,
                 draft_updated_by_credential_ref = $6, draft_updated_at = date_trunc('milliseconds', clock_timestamp()),
                 version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version`,
              [
                n.id,
                pin,
                JSON.stringify(content.sections),
                content.procedureCodeRefs,
                author.role,
                author.credentialRef,
              ],
            );
            const version = rows[0]?.version;
            if (version === undefined) throw new Error('update returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: NOTE_RESOURCE, resourceRef: n.id, resourceVersion: version },
              {
                changedFields:
                  p.templateVersionRef === undefined ? ['draft'] : ['draft', 'templateVersionRef'],
              },
            );
            return { data: { ref: n.id }, version };
          });
          return respond(tx, decision, r);
        });
      });
    },

    /**
     * Freezes the draft as the signed original (C-D4 enforcement point). Human only, with a resolvable
     * clinical author; the signer, instant, template version, history versions and digest are recorded.
     */
    signNote(
      ctx: ActorContext,
      noteRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Note>> {
      const op = 'clinical.notes.sign';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteSign>(validateNoteSign, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const located = await locate(tx, decision, noteRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { noteRef, ...p } }, tx, async () => {
            const n = await loadNote(tx, located.note.id, 'FOR UPDATE');
            // The loser of a concurrent signature sees the winner's signature, never a merged draft.
            if (n.state === 'signed') throw noteSigned(n.id, 'clinical.notes.addendum');
            if (n.version !== p.expectedVersion) throw stale(n.version);
            const content = draftContent(n);
            if (!hasText(content)) throw conflict('note_empty');
            const check = await checkOf(tx, n.template_version_id, content);
            enforce(check);
            await freeze(tx, { ...located, note: n }, author, {
              sequence: 1,
              kind: 'original',
              referencesSequence: null,
              reasonCode: null,
              content,
              addendumText: null,
              templateVersionRef: n.template_version_id,
              templateCheck: check,
            });
            const version = await bumpHead(tx, n.id, true);
            await recordCommand(
              tx,
              { operation: op, resourceType: NOTE_RESOURCE, resourceRef: n.id, resourceVersion: version },
              { changedFields: ['state', 'signature'] },
            );
            return { data: { ref: n.id }, version };
          });
          return respond(tx, decision, r);
        });
      });
    },

    /**
     * Appends an amendment: a complete replacement statement referencing the latest version, with a
     * reason. Amending another clinician's signed note needs `clinical.oversight` (C-D5).
     */
    amendNote(
      ctx: ActorContext,
      noteRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Note>> {
      const op = 'clinical.notes.amend';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteAmend>(validateNoteAmend, p, CLINICAL_PROPERTIES);
        checkSectionKeys(p.content.sections, '/content');
        const oversight = await holds(ctx, 'clinical.notes.amendOthers');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const located = await locate(tx, decision, noteRef);
          const author = await resolveClinicalAuthor(tx);
          const { rows: signer } = await tx.query<{ authored_by: string }>(
            `SELECT authored_by FROM cuspatlas.clinical_note_versions WHERE note_id = $1 AND sequence = 1`,
            [located.note.id],
          );
          const signedBy = signer[0]?.authored_by;
          if (signedBy !== undefined && signedBy !== ctx.actorId && !oversight) {
            throw new RefusalError({
              code: 'forbidden',
              reasonCode: 'clinical_oversight_required',
              detail: { reason: 'clinical_oversight_required', alternative: 'clinical.notes.addendum' },
            });
          }
          const r = await execute<Ack>(ctx, { ...envelope, payload: { noteRef, ...p } }, tx, async () => {
            const n = await loadNote(tx, located.note.id, 'FOR UPDATE');
            if (n.state === 'draft') throw notSigned(n.id);
            await assertIntact(ctx, op, n, await versionRows(tx, n.id));
            if (n.version !== p.expectedVersion) throw stale(n.version);
            const content = contentOf(p.content.sections, p.content.procedureCodeRefs ?? []);
            if (!hasText(content)) throw conflict('note_empty');
            const check = await checkOf(tx, n.template_version_id, content);
            enforce(check);
            await freeze(tx, { ...located, note: n }, author, {
              sequence: n.head_sequence + 1,
              kind: 'amendment',
              referencesSequence: n.head_sequence,
              reasonCode: p.reasonCode,
              content,
              addendumText: null,
              templateVersionRef: n.template_version_id,
              templateCheck: check,
            });
            const version = await bumpHead(tx, n.id, false);
            await recordCommand(
              tx,
              { operation: op, resourceType: NOTE_RESOURCE, resourceRef: n.id, resourceVersion: version },
              { changedFields: ['amendment'] },
            );
            return { data: { ref: n.id }, version };
          });
          return respond(tx, decision, r);
        });
      });
    },

    /** Appends an addendum (additional text with a reason) to a signed note; the preferred clarification. */
    addNoteAddendum(
      ctx: ActorContext,
      noteRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Note>> {
      const op = 'clinical.notes.addendum';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteAddendum>(validateNoteAddendum, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const located = await locate(tx, decision, noteRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { noteRef, ...p } }, tx, async () => {
            const n = await loadNote(tx, located.note.id, 'FOR UPDATE');
            if (n.state === 'draft') throw notSigned(n.id);
            await assertIntact(ctx, op, n, await versionRows(tx, n.id));
            if (n.version !== p.expectedVersion) throw stale(n.version);
            if (p.text.trim().length === 0) throw failedAt('/text', 'blank');
            await freeze(tx, { ...located, note: n }, author, {
              sequence: n.head_sequence + 1,
              kind: 'addendum',
              referencesSequence: n.head_sequence,
              reasonCode: p.reasonCode,
              content: null,
              addendumText: p.text,
              templateVersionRef: null,
              templateCheck: null,
            });
            const version = await bumpHead(tx, n.id, false);
            await recordCommand(
              tx,
              { operation: op, resourceType: NOTE_RESOURCE, resourceRef: n.id, resourceVersion: version },
              { changedFields: ['addendum'] },
            );
            return { data: { ref: n.id }, version };
          });
          return respond(tx, decision, r);
        });
      });
    },

    /**
     * Records a co-signature of one frozen version that requires it, bound to the digest the
     * co-signer saw. The co-signer is a different human clinician; who must co-sign is C-S2-Q5.
     */
    cosignNote(
      ctx: ActorContext,
      noteRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Note>> {
      const op = 'clinical.notes.cosign';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<NoteCosign>(validateNoteCosign, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const located = await locate(tx, decision, noteRef);
          const author = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, { ...envelope, payload: { noteRef, ...p } }, tx, async () => {
            const n = await loadNote(tx, located.note.id, 'FOR UPDATE');
            const all = await versionRows(tx, n.id);
            const v = all.find((x) => x.sequence === p.sequence);
            if (!v) throw failedAt('/sequence', 'unknownVersion');
            // The digest compared is the one recomputed from the stored content, not only the stored one.
            await assertIntact(ctx, op, n, all);
            if (!v.cosign_required) throw conflict('cosignature_not_required');
            if (v.authored_by === ctx.actorId) throw conflict('cosigner_is_author');
            if (all.find((x) => x.sequence === 1)?.authored_by === ctx.actorId)
              throw conflict('cosigner_is_signer');
            if (v.content_digest !== p.contentDigest) throw conflict('content_digest_mismatch');
            if (v.cosigned_by !== null) throw conflict('already_cosigned');
            const { rows: cosigned } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_note_cosignatures (tenant_id, note_version_id, content_digest, cosigned_by,
                 cosigned_by_role, cosigned_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id(), $3, $4) RETURNING id`,
              [v.id, v.content_digest, author.role, author.credentialRef],
            );
            // The co-signature is its own audited fact; the note version (and its digest) are unchanged.
            const cosignatureId = cosigned[0]?.id;
            if (!cosignatureId) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: NOTE_COSIGNATURE_RESOURCE,
                resourceRef: cosignatureId,
                resourceVersion: 1,
              },
              { changedFields: ['cosignature'] },
            );
            return { data: { ref: n.id }, version: n.version };
          });
          return respond(tx, decision, r);
        });
      });
    },

    /** Every version of a note with its digest verified on read. A sensitive read. */
    readNote(ctx: ActorContext, noteRef: string): Promise<Note> {
      const op = 'clinical.notes.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const note = await project(tx, await locate(tx, decision, noteRef));
          await alertIfTampered(ctx, op, [note]);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: NOTE_RESOURCE,
            resourceRefs: [note.noteRef],
            queryFields: [],
          });
          return note;
        });
      });
    },

    /** The notes of one visible encounter, oldest first. A sensitive read. */
    listNotes(ctx: ActorContext, encounterRef: string): Promise<readonly Note[]> {
      const op = 'clinical.notes.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await loadEncounter(tx, decision, encounterRef);
          const { rows } = await tx.query<NoteRow>(
            `SELECT ${NOTE_COLUMNS} FROM cuspatlas.clinical_notes WHERE encounter_id = $1
             ORDER BY created_at, id LIMIT ${MAX_NOTES_PER_ENCOUNTER}`,
            [encounter.id],
          );
          const notes: Note[] = [];
          for (const note of rows) notes.push(await project(tx, { note, encounter }));
          await alertIfTampered(ctx, op, notes);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: NOTE_RESOURCE,
            resourceRefs: [encounter.id, ...notes.map((n) => n.noteRef)].slice(0, 100),
            queryFields: [],
          });
          return notes;
        });
      });
    },
  };
}
