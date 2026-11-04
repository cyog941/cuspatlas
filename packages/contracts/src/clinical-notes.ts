import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { ClinicalAuthor } from './clinical';
import schema from './clinical.schema.json' with { type: 'json' };
import { createAjv } from './validation';

/**
 * Types mirroring the C9 note-template and C10 note definitions of clinical.schema.json (the schema
 * is authoritative). Semantics are recommended-pending-clinical-approval (ADR 0006: C-D4, C-D5);
 * required sections and procedure codes are synthetic placeholders (SYN- codes only).
 */
export interface ActorStamp {
  readonly actorRef: string;
}

export interface NoteTemplateSection {
  readonly sectionKey: string;
  readonly label: string;
  readonly required: boolean;
}

export interface NoteTemplateDefine {
  readonly noteType: string;
  readonly label: string;
  readonly enforced: boolean;
  readonly sections: readonly NoteTemplateSection[];
  readonly procedureCodeRefs?: readonly string[];
}

export interface NoteTemplateRevise {
  readonly expectedVersion: number;
  readonly enforced: boolean;
  readonly sections: readonly NoteTemplateSection[];
  readonly procedureCodeRefs?: readonly string[];
}

export interface NoteTemplateRetire {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}

export interface NoteTemplateApplicableQuery {
  readonly procedureCodeRefs?: string;
}

export interface NoteTemplateVersion {
  readonly templateVersionRef: string;
  readonly templateRef: string;
  readonly sequence: number;
  readonly enforced: boolean;
  readonly sections: readonly NoteTemplateSection[];
  readonly procedureCodeRefs: readonly string[];
  readonly definedBy: ActorStamp;
  readonly definedAt: string;
}

export interface NoteTemplate {
  readonly templateRef: string;
  readonly noteType: string;
  readonly label: string;
  readonly state: 'active' | 'retired';
  readonly retirement: {
    readonly reasonCode: string;
    readonly retiredBy: ActorStamp;
    readonly retiredAt: string;
  } | null;
  readonly currentVersion: NoteTemplateVersion;
  readonly versions: readonly NoteTemplateVersion[];
  readonly createdBy: ActorStamp;
  readonly createdAt: string;
  readonly version: number;
}

export interface ApplicableTemplate {
  readonly templateRef: string;
  readonly noteType: string;
  readonly label: string;
  readonly current: NoteTemplateVersion;
  readonly matchedCodeRefs: readonly string[];
}

export interface NoteTemplateApplicableData {
  readonly encounterRef: string;
  readonly procedureCodeRefs: readonly string[];
  readonly procedureSource: 'caller_supplied';
  readonly associated: readonly ApplicableTemplate[];
  readonly general: readonly ApplicableTemplate[];
}

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateNoteTemplateDefine = def('NoteTemplateDefine');
export const validateNoteTemplateRevise = def('NoteTemplateRevise');
export const validateNoteTemplateRetire = def('NoteTemplateRetire');
export const validateNoteTemplateApplicableQuery = def('NoteTemplateApplicableQuery');
/** Response schemas, used by tests to prove REST and MCP results conform to the contract. */
export const validateNoteTemplateCommandResult = def('NoteTemplateCommandResult');
export const validateNoteTemplateRead = def('NoteTemplateRead');
export const validateNoteTemplateVersionRead = def('NoteTemplateVersionRead');
export const validateNoteTemplateApplicable = def('NoteTemplateApplicable');

/** C10 notes: drafts are mutable; every signed, amended or addended version is frozen with a digest. */
export type NoteSourceKind = 'human' | 'ai_draft';

export interface NoteSectionEntry {
  readonly sectionKey: string;
  readonly text: string;
}

export interface NoteContent {
  readonly sections: readonly NoteSectionEntry[];
  readonly procedureCodeRefs?: readonly string[];
}

export interface NoteContentRead {
  readonly sections: readonly NoteSectionEntry[];
  readonly procedureCodeRefs: readonly string[];
}

export interface NoteDraftCreate {
  readonly noteType: string;
  readonly templateVersionRef?: string;
  readonly source?: NoteSourceKind;
  readonly aiModelRef?: string;
  readonly aiPromptVersionRef?: string;
  readonly content?: NoteContent;
}

export interface NoteDraftUpdate {
  readonly expectedVersion: number;
  readonly templateVersionRef?: string;
  readonly content: NoteContent;
}

export interface NoteSign {
  readonly expectedVersion: number;
}

export interface NoteAmend {
  readonly expectedVersion: number;
  readonly reasonCode: string;
  readonly content: NoteContent;
}

export interface NoteAddendum {
  readonly expectedVersion: number;
  readonly reasonCode: string;
  readonly text: string;
}

export interface NoteCosign {
  readonly sequence: number;
  readonly contentDigest: string;
}

export interface NoteTemplateCheck {
  readonly enforced: boolean;
  readonly satisfied: boolean;
  readonly blocksSigning: boolean;
  readonly missingSections: readonly string[];
  readonly missingCodeRefs: readonly string[];
  readonly unresolvedSections: readonly string[];
}

export interface HistoryAtSigning {
  readonly recorded: boolean;
  readonly versions: readonly {
    readonly streamRef: string;
    readonly version: number;
    readonly historyVersionRef: string | null;
  }[];
}

export interface NoteCosignature {
  readonly required: boolean;
  readonly supervisingResourceRef: string | null;
  readonly status: 'not_required' | 'pending' | 'cosigned';
  readonly cosignedBy: ClinicalAuthor | null;
  readonly cosignedAt: string | null;
}

export interface NoteVersion {
  readonly noteVersionRef: string;
  readonly sequence: number;
  readonly kind: 'original' | 'amendment' | 'addendum';
  readonly referencesSequence: number | null;
  readonly supersededBySequence: number | null;
  readonly reasonCode: string | null;
  readonly content: NoteContentRead | null;
  readonly addendumText: string | null;
  readonly templateVersionRef: string | null;
  readonly templateCheck: NoteTemplateCheck | null;
  readonly historyAtSigning: HistoryAtSigning;
  readonly authoredBy: ClinicalAuthor;
  readonly authoredAt: string;
  readonly contentDigest: string;
  readonly digestVerified: boolean;
  readonly cosignature: NoteCosignature;
}

export interface NoteDraft {
  readonly content: NoteContentRead;
  readonly templateCheck: NoteTemplateCheck | null;
  readonly updatedBy: ClinicalAuthor;
  readonly updatedAt: string;
}

export interface Note {
  readonly noteRef: string;
  readonly encounterRef: string;
  readonly patientRef: string;
  readonly noteType: string;
  readonly status: 'draft' | 'signed' | 'amended';
  readonly source: {
    readonly kind: NoteSourceKind;
    readonly aiModelRef: string | null;
    readonly aiPromptVersionRef: string | null;
  };
  readonly templateVersionRef: string | null;
  readonly draft: NoteDraft | null;
  readonly versions: readonly NoteVersion[];
  readonly createdBy: ClinicalAuthor;
  readonly createdAt: string;
  readonly version: number;
}

export const validateNoteDraftCreate = def('NoteDraftCreate');
export const validateNoteDraftUpdate = def('NoteDraftUpdate');
export const validateNoteSign = def('NoteSign');
export const validateNoteAmend = def('NoteAmend');
export const validateNoteAddendum = def('NoteAddendum');
export const validateNoteCosign = def('NoteCosign');
export const validateNoteCommandResult = def('NoteCommandResult');
export const validateNoteRead = def('NoteRead');
export const validateNoteList = def('NoteList');
