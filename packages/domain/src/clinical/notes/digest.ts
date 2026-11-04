import type {
  ClinicalAuthor,
  HistoryAtSigning,
  NoteContentRead,
  NoteTemplateCheck,
} from '@cuspatlas/contracts';
import { canonicalJson, sha256Hex } from '../../commands/digest';

/**
 * Everything a frozen note version states, bound into its digest: the note identity, the version's
 * position and kind, its content, the template version and C8 history versions it was recorded
 * against, the co-signature requirement, the author and the instant. The format tag is part of the
 * hashed value, so a later format can never collide with this one. Stable forever: changing this
 * function or its canonical form would make every stored digest fail verification.
 */
export interface DigestInput {
  readonly noteRef: string;
  readonly encounterRef: string;
  readonly noteType: string;
  readonly source: {
    readonly kind: 'human' | 'ai_draft';
    readonly aiModelRef: string | null;
    readonly aiPromptVersionRef: string | null;
  };
  readonly sequence: number;
  readonly kind: 'original' | 'amendment' | 'addendum';
  readonly referencesSequence: number | null;
  readonly reasonCode: string | null;
  readonly content: NoteContentRead | null;
  readonly addendumText: string | null;
  readonly templateVersionRef: string | null;
  readonly templateCheck: NoteTemplateCheck | null;
  readonly historyAtSigning: HistoryAtSigning;
  readonly authoredBy: ClinicalAuthor;
  readonly authoredAt: string;
  readonly cosignRequired: boolean;
  readonly supervisingResourceRef: string | null;
}

export const NOTE_DIGEST_FORMAT = 'cuspatlas.clinical-note-version.v1';

export function noteVersionDigest(input: DigestInput): string {
  const plain = JSON.parse(JSON.stringify({ format: NOTE_DIGEST_FORMAT, ...input })) as unknown;
  return `sha256:${sha256Hex(canonicalJson(plain))}`;
}
