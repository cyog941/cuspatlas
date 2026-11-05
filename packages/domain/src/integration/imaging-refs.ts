import { RefusalError, type TenantTransaction } from '@cuspatlas/contracts';
import type { ImageRefResolver } from '../clinical/image-links';
import type { AttachmentRefResolver } from '../engagement/common';
import { imageReference } from '../imaging/association';
import type { AttachmentSourcePort } from '../rcm/attachments';

/**
 * Integration seams to I3's consumer reference read (`imageReference`), the one read C15 image links,
 * E5 message attachments and B's CL-04 attachment packages use. Every call runs in the caller's tenant
 * transaction (RLS), names the patient the consumer expects, and treats a missing, malformed or
 * other-tenant reference identically (`not_found` / not attachable). I owns objects, bytes, digests
 * and matching; consumers learn only whether the reference is current for the patient they expect.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** I3's reference read, or null for anything a caller must treat as absent (missing, malformed, foreign). */
export async function imageReferenceOrNull(
  tx: TenantTransaction,
  imageRef: string,
  expectedPatientRef: string,
) {
  if (!UUID.test(imageRef) || !UUID.test(expectedPatientRef)) return null;
  try {
    return await imageReference(tx, imageRef, expectedPatientRef);
  } catch (err) {
    if (err instanceof RefusalError && (err.code === 'not_found' || err.code === 'invalid_request'))
      return null;
    throw err;
  }
}

/** C15: an encounter image link is claimable only while I3 says the imageRef is current. */
export function createImagingImageRefResolver(): ImageRefResolver {
  return {
    async resolve(tx, imageRef, expectedPatientRef) {
      const r = await imageReferenceOrNull(tx, imageRef, expectedPatientRef);
      if (r === null) return { status: 'not_found' };
      if (r.objectState !== 'available') return { status: 'unavailable', reason: `object_${r.objectState}` };
      if (r.association.status !== 'associated') return { status: 'unavailable', reason: 'unassociated' };
      return {
        status: 'current',
        patientRef: r.association.patientRef,
        associationRef: r.association.decisionRef,
      };
    },
  };
}

/**
 * E5: a message attachment is accepted only when I3 confirms the reference is current for the
 * message's patient. An `objectRef` is checked through the object's own imageRef (an object without
 * one, such as an unassociated or derived object, is not attachable: fail closed).
 */
export function createImagingAttachmentRefResolver(): AttachmentRefResolver {
  return {
    async belongsToPatient(tx, patientRef, attachment) {
      let imageRef = attachment.ref;
      if (attachment.kind === 'objectRef') {
        if (!UUID.test(attachment.ref)) return false;
        const { rows } = await tx.query<{ id: string }>(
          'SELECT id FROM cuspatlas.imaging_image_refs WHERE object_id = $1 ORDER BY minted_at DESC, id LIMIT 1',
          [attachment.ref],
        );
        const ref = rows[0]?.id;
        if (ref === undefined) return false;
        imageRef = ref;
      }
      const r = await imageReferenceOrNull(tx, imageRef, patientRef);
      return r?.matchesExpected === true;
    },
  };
}

/**
 * B CL-04: the digest of a claim attachment is I3's digest of the image, reported only while the
 * imageRef is current for the claim's patient (another patient, tenant, a missing or malformed
 * reference all read null, so the package or dispatch is refused).
 */
export function createImagingAttachmentSource(): AttachmentSourcePort {
  return {
    async digestOf(tx, objectRef, expectedPatientRef) {
      const r = await imageReferenceOrNull(tx, objectRef, expectedPatientRef);
      if (r === null || r.matchesExpected !== true || r.objectState !== 'available') return null;
      return r.digestSha256 ?? null;
    },
  };
}
