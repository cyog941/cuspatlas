import type { AttachmentRefResolver } from '@cuspatlas/domain';

/**
 * Test double for I's attachment reference read (another branch; the integration seam is the
 * AttachmentRefResolver port). A reference "exists" only when registered here for its tenant and
 * patient. Synthetic references only.
 */
export class FakeAttachmentRefs implements AttachmentRefResolver {
  private readonly known = new Map<string, { tenantId: string; patientRef: string; kind: string }>();
  readonly lookups: string[] = [];

  register(tenantId: string, patientRef: string, kind: 'imageRef' | 'objectRef', ref: string): string {
    this.known.set(ref, { tenantId, patientRef, kind });
    return ref;
  }

  async belongsToPatient(
    tx: Parameters<AttachmentRefResolver['belongsToPatient']>[0],
    patientRef: string,
    attachment: { kind: 'imageRef' | 'objectRef'; ref: string },
  ): Promise<boolean> {
    this.lookups.push(attachment.ref);
    const k = this.known.get(attachment.ref);
    return (
      k !== undefined &&
      k.tenantId === tx.ctx.tenantId &&
      k.patientRef === patientRef &&
      k.kind === attachment.kind
    );
  }
}
