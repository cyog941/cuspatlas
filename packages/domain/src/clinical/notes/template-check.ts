/**
 * The C9 template validator (`validateAgainstTemplates`), a pure function evaluated at one documented
 * enforcement point: the C10 sign and amend commands, identical for REST and MCP (C-D4,
 * recommended-pending-clinical-approval). Drafting is never blocked; a draft read reports the same
 * result so a clinician sees the deficits before signing.
 *
 * Rules (engineering placeholders pending the blocking questions C-S2-Q1 and C-S2-Q2):
 * - a required section is addressed when the note has that section with non-blank text;
 * - an associated procedure code is addressed only by a structured code entry on the note; a
 *   mention in free text never satisfies it;
 * - a note section the pinned template version does not define cannot be resolved and is listed.
 */
export interface TemplateRules {
  readonly enforced: boolean;
  readonly sections: readonly { readonly sectionKey: string; readonly required: boolean }[];
  readonly procedureCodeRefs: readonly string[];
}

export interface NoteContentForCheck {
  readonly sections: readonly { readonly sectionKey: string; readonly text: string }[];
  readonly procedureCodeRefs: readonly string[];
}

export interface TemplateCheck {
  readonly enforced: boolean;
  readonly satisfied: boolean;
  /** True only for an enforced template that is not satisfied: the sign command refuses. */
  readonly blocksSigning: boolean;
  readonly missingSections: readonly string[];
  readonly missingCodeRefs: readonly string[];
  readonly unresolvedSections: readonly string[];
}

export function checkAgainstTemplate(t: TemplateRules, content: NoteContentForCheck): TemplateCheck {
  const filled = new Set(content.sections.filter((s) => s.text.trim().length > 0).map((s) => s.sectionKey));
  const defined = new Set(t.sections.map((s) => s.sectionKey));
  const codes = new Set(content.procedureCodeRefs);
  const missingSections = t.sections
    .filter((s) => s.required && !filled.has(s.sectionKey))
    .map((s) => s.sectionKey);
  const missingCodeRefs = t.procedureCodeRefs.filter((c) => !codes.has(c));
  const unresolvedSections = content.sections.map((s) => s.sectionKey).filter((k) => !defined.has(k));
  const satisfied =
    missingSections.length === 0 && missingCodeRefs.length === 0 && unresolvedSections.length === 0;
  return {
    enforced: t.enforced,
    satisfied,
    blocksSigning: t.enforced && !satisfied,
    missingSections,
    missingCodeRefs,
    unresolvedSections,
  };
}
