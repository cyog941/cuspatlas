import { describe, expect, it } from 'vitest';
import { type DigestInput, noteVersionDigest } from './digest';

const input: DigestInput = {
  noteRef: '00000000-0000-4000-8000-000000000001',
  encounterRef: '00000000-0000-4000-8000-000000000002',
  noteType: 'progress',
  source: { kind: 'human', aiModelRef: null, aiPromptVersionRef: null },
  sequence: 1,
  kind: 'original',
  referencesSequence: null,
  reasonCode: null,
  content: {
    sections: [{ sectionKey: 'subjective', text: 'Synthetic text' }],
    procedureCodeRefs: ['SYN-PROC-001'],
  },
  addendumText: null,
  templateVersionRef: null,
  templateCheck: null,
  historyAtSigning: { recorded: false, versions: [] },
  authoredBy: { actorRef: '00000000-0000-4000-8000-000000000003', role: 'dentist', credentialRef: null },
  authoredAt: '2030-01-07T14:00:00.000Z',
  cosignRequired: false,
  supervisingResourceRef: null,
};

describe('noteVersionDigest', () => {
  it('is stable forever for a fixed input (golden value) and independent of key order', () => {
    const golden = noteVersionDigest(input);
    expect(golden).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as DigestInput;
    expect(noteVersionDigest(reordered)).toBe(golden);
    expect(golden).toBe('sha256:577ac9217c48088ab8e80590ad065ca67b87e3349750c981f60cc021e7d61fac');
  });

  it('changes when any stated field changes', () => {
    const base = noteVersionDigest(input);
    for (const changed of [
      {
        ...input,
        content: {
          sections: [{ sectionKey: 'subjective', text: 'Synthetic text!' }],
          procedureCodeRefs: ['SYN-PROC-001'],
        },
      },
      { ...input, authoredAt: '2030-01-07T14:00:00.001Z' },
      { ...input, authoredBy: { ...input.authoredBy, role: 'hygienist' as const } },
      { ...input, sequence: 2 },
      {
        ...input,
        historyAtSigning: {
          recorded: true,
          versions: [{ streamRef: input.noteRef, version: 1, historyVersionRef: input.noteRef }],
        },
      },
      { ...input, cosignRequired: true, supervisingResourceRef: input.noteRef },
    ]) {
      expect(noteVersionDigest(changed)).not.toBe(base);
    }
  });
});
