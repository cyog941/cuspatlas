import { describe, expect, it } from 'vitest';
import { checkAgainstTemplate } from './template-check';

/**
 * C-D4 (recommended-pending-clinical-approval): the same synthetic draft produces a blocking deficit
 * list under an enforced template and only a warning under a non-enforced one. The code rule
 * (structured entry only; a mention in text never satisfies it) is an engineering placeholder for
 * the blocking question C-S2-Q2.
 */
const sections = [
  { sectionKey: 'subjective', label: 'Synthetic S', required: true },
  { sectionKey: 'objective', label: 'Synthetic O', required: true },
  { sectionKey: 'plan', label: 'Synthetic P', required: false },
];
const template = (enforced: boolean) => ({
  enforced,
  sections,
  procedureCodeRefs: ['SYN-PROC-001', 'SYN-PROC-002'],
});
const draft = {
  sections: [
    { sectionKey: 'subjective', text: 'Synthetic complaint; mentions SYN-PROC-002 in text only' },
    { sectionKey: 'objective', text: '   ' },
    { sectionKey: 'extra', text: 'Synthetic section the template does not define' },
  ],
  procedureCodeRefs: ['SYN-PROC-001'],
};

describe('checkAgainstTemplate', () => {
  it('an enforced template with an unaddressed required section blocks signing with the deficit list', () => {
    expect(checkAgainstTemplate(template(true), draft)).toStrictEqual({
      enforced: true,
      satisfied: false,
      blocksSigning: true,
      missingSections: ['objective'],
      missingCodeRefs: ['SYN-PROC-002'],
      unresolvedSections: ['extra'],
    });
  });

  it('a non-enforced template permits the same draft and records a warning', () => {
    expect(checkAgainstTemplate(template(false), draft)).toStrictEqual({
      enforced: false,
      satisfied: false,
      blocksSigning: false,
      missingSections: ['objective'],
      missingCodeRefs: ['SYN-PROC-002'],
      unresolvedSections: ['extra'],
    });
  });

  it('a complete draft satisfies an enforced template; an optional section may be absent', () => {
    const complete = {
      sections: [
        { sectionKey: 'subjective', text: 'Synthetic S text' },
        { sectionKey: 'objective', text: 'Synthetic O text' },
      ],
      procedureCodeRefs: ['SYN-PROC-002', 'SYN-PROC-001', 'SYN-PROC-999'],
    };
    expect(checkAgainstTemplate(template(true), complete)).toStrictEqual({
      enforced: true,
      satisfied: true,
      blocksSigning: false,
      missingSections: [],
      missingCodeRefs: [],
      unresolvedSections: [],
    });
  });

  it('an empty draft lists every required section and code, never an empty deficit', () => {
    const r = checkAgainstTemplate(template(true), { sections: [], procedureCodeRefs: [] });
    expect([r.missingSections, r.missingCodeRefs, r.blocksSigning]).toStrictEqual([
      ['subjective', 'objective'],
      ['SYN-PROC-001', 'SYN-PROC-002'],
      true,
    ]);
  });
});
