import type { ValidateFunction } from 'ajv/dist/2020.js';
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
