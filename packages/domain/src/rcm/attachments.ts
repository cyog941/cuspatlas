import { createHash } from 'node:crypto';
import type { TenantTransaction } from '@cuspatlas/contracts';

/**
 * CL-04 object source port (workstream I owns imaging bytes, storage and manifests). B holds object
 * references and the digests I reports. The I3 implementation (`createImagingAttachmentSource`)
 * accepts an I3 imageRef current for the claim's patient; the fake below accepts only synthetic
 * syn-img-/syn-obj- references and its `alter` simulates a changed original.
 */
export interface AttachmentSourcePort {
  /**
   * The current content digest of one object for the claim's patient, read in the caller's tenant
   * transaction; null when it is unknown, unavailable, another patient's or another tenant's.
   */
  digestOf(tx: TenantTransaction, objectRef: string, expectedPatientRef: string): Promise<string | null>;
}

export function createFakeAttachmentSource() {
  const altered = new Set<string>();
  const digest = (ref: string) =>
    createHash('sha256')
      .update(`syn-object:${ref}${altered.has(ref) ? ':altered' : ''}`)
      .digest('hex');
  return {
    async digestOf(_tx: TenantTransaction, ref: string, _expectedPatientRef: string) {
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
