import {
  type ActorContext,
  CommitThenRefuse,
  isObjectStoreError,
  type TenantTransaction,
} from '@cuspatlas/contracts';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { checkRef, type ImagingBase, refused } from './base';
import { loadObject, OBJECT_RESOURCE, type ObjectRow, quarantineObject } from './objects';

/**
 * I5 DICOM boundary. I-S2 (conformance samples and parser licensing) is blocked-on-discovery, so the
 * only capability is recognition of the `DICM` marker at offset 128 (I2 gating) and opaque storage of
 * the original. Parsing is refused: no element, identifier, transfer syntax or summary is ever read,
 * so parser budgets, external file references and identifier disagreements cannot arise. There is no
 * parser port implementation and no network DICOM service. A future parser lands only after I-S2
 * closes, behind a reviewed port, recording each parse separately from the original.
 */
export const DICOM_BOUNDARY = Object.freeze({
  parsing: 'refused',
  limitation: 'dicom_parser_not_qualified',
  blockedOn: 'I-S2',
  networkServices: 'out_of_scope',
  recognition: 'dicm_marker_at_offset_128',
} as const);

/** Magic-byte recognition only (the same signature I2 sniffs); never reads past the marker. */
export function hasDicomMarker(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 132 &&
    bytes[128] === 0x44 &&
    bytes[129] === 0x49 &&
    bytes[130] === 0x43 &&
    bytes[131] === 0x4d
  );
}

/**
 * Verified bytes of an available object; a digest mismatch or missing bytes quarantine it (the caller
 * commits that and refuses) exactly like the I1 content read.
 */
export async function verifiedBytes(
  base: ImagingBase,
  tx: TenantTransaction,
  ctx: ActorContext,
  op: string,
  row: ObjectRow,
): Promise<{ bytes: Uint8Array } | { failure: string }> {
  const store = base.store();
  try {
    return { bytes: await store.read(ctx.tenantId, row.storage_key, row.digest_sha256) };
  } catch (err) {
    if (!isObjectStoreError(err) || (err.code !== 'digest_mismatch' && err.code !== 'missing')) throw err;
    const reason = err.code === 'missing' ? 'bytes_missing' : 'digest_mismatch';
    if (err.code === 'digest_mismatch')
      await store.quarantineStored(ctx.tenantId, row.storage_key, row.id).catch(() => undefined);
    await quarantineObject(tx, op, row, reason);
    base.alert('imaging_object_integrity_failed');
    return { failure: reason };
  }
}

export function createDicomOperations(base: ImagingBase) {
  const { deps } = base;
  return {
    /** Container inspection: recognition plus the pinned refusal; never a parse, never a summary. */
    inspectContainer(ctx: ActorContext, objectRef: string) {
      const op = 'imaging.containers.inspect';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(objectRef);
        base.store();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadObject(tx, objectRef, 'FOR SHARE');
          if (row.state !== 'available') throw refused('object_not_available');
          const read = await verifiedBytes(base, tx, ctx, op, row);
          if ('failure' in read)
            throw new CommitThenRefuse(refused(read.failure, {}, { reasonCode: 'object_integrity_failed' }));
          const dicom = hasDicomMarker(read.bytes);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: OBJECT_RESOURCE,
            resourceRefs: [row.id],
            queryFields: [],
          });
          return {
            objectRef: row.id,
            digestSha256: row.digest_sha256,
            container: dicom ? ('dicom' as const) : ('none' as const),
            markerRecognized: dicom,
            supported: false,
            parsing: DICOM_BOUNDARY.parsing,
            limitation: dicom ? DICOM_BOUNDARY.limitation : 'not_a_container',
            blockedOn: DICOM_BOUNDARY.blockedOn,
            summary: null,
          };
        });
      });
    },
  };
}
