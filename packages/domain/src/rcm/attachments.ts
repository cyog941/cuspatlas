import { createHash } from 'node:crypto';

/**
 * CL-04 object source port (workstream I owns imaging bytes, storage and manifests). B holds only
 * synthetic object references (syn-img-/syn-obj-) and the digests I reports; the only implementation
 * is the fake below, whose `alter` simulates a changed original so a stale package is refused.
 */
export interface AttachmentSourcePort {
  /** The current content digest of one object, or null when it is unknown or unavailable. */
  digestOf(objectRef: string): Promise<string | null>;
}

export function createFakeAttachmentSource() {
  const altered = new Set<string>();
  const digest = (ref: string) =>
    createHash('sha256')
      .update(`syn-object:${ref}${altered.has(ref) ? ':altered' : ''}`)
      .digest('hex');
  return {
    async digestOf(ref: string) {
      return /^syn-(img|obj)-[a-z0-9-]{1,60}$/.test(ref) ? digest(ref) : null;
    },
    /** The digest the fake reports now (what I would hand B with its manifest). */
    digestFor: digest,
    alter(ref: string) {
      altered.add(ref);
    },
  };
}
export type FakeAttachmentSource = ReturnType<typeof createFakeAttachmentSource>;
