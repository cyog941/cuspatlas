import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './imaging.schema.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/**
 * Imaging contract (workstream I: I1-I4, I8). Types mirror imaging.schema.json, which is authoritative
 * for validation. Synthetic data only: no device, sensor SDK, DICOM library or acquisition software is
 * qualified (I-S1, I-S2, I-S3 blocked-on-discovery).
 */
export type ImagingContentType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/tiff'
  | 'application/pdf'
  | 'application/dicom';
export const IMAGING_CONTENT_TYPES: readonly ImagingContentType[] = schema.$defs.ContentType
  .enum as ImagingContentType[];
export type ImageObjectState = 'available' | 'quarantined' | 'deleted';
export type ImageObjectKind = 'original' | 'derived';
export type ProvenanceSource = 'operatorUpload' | 'bridgeImport' | 'migrationArchive';

export interface ProvenanceInput {
  readonly source: ProvenanceSource;
  readonly deviceRef?: string;
  readonly captureSoftware?: string;
  readonly originalFilename?: string;
  readonly acquiredAt?: string;
  readonly acquiredTimeZone?: string;
}

export interface ProvenanceRecord {
  readonly provenanceRef: string;
  readonly source: ProvenanceSource;
  readonly operatorRef: string;
  readonly deviceRef: string | null;
  readonly captureSoftware: string | null;
  readonly originalFilename: string | null;
  readonly acquiredAt: string | null;
  readonly acquiredTimeZone: string | null;
  readonly ingressRef: string | null;
  readonly recordedAt: string;
}

export interface ImageObjectData {
  readonly objectRef: string;
  readonly kind: ImageObjectKind;
  readonly state: ImageObjectState;
  readonly contentType: ImagingContentType;
  readonly byteLength: number;
  readonly digestSha256: string;
  readonly receivedAt: string;
  readonly quarantineReason: string | null;
  readonly version: number;
  readonly provenance: readonly ProvenanceRecord[];
}

export interface ObjectListQuery {
  readonly state?: ImageObjectState;
  readonly limit?: string;
}
export interface ReadGrantRequest {
  readonly ttlSeconds?: number;
}
export interface ReadGrantData {
  readonly grantRef: string;
  readonly objectRef: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly contentPath: string;
}

/** Bytes and media type of an object read through a verified grant (REST only). */
export interface ObjectContent {
  readonly contentType: ImagingContentType;
  readonly bytes: Uint8Array;
  readonly digestSha256: string;
}

/**
 * Failure of the object store, typed so the domain never inspects messages. `path_traversal` covers
 * any key outside the tenant's own fixed prefixes; `digest_mismatch` means the stored bytes no longer
 * hash to the registered digest; `missing` means no bytes exist under the key; `unavailable` is an
 * outage (surfaced to callers as a retryable 503, never as an empty result).
 */
export type ObjectStoreErrorCode = 'path_traversal' | 'digest_mismatch' | 'missing' | 'unavailable';

export class ObjectStoreError extends Error {
  readonly code: ObjectStoreErrorCode;
  constructor(code: ObjectStoreErrorCode) {
    super(code);
    this.name = 'ObjectStoreError';
    this.code = code;
  }
}

export const isObjectStoreError = (err: unknown): err is ObjectStoreError => err instanceof ObjectStoreError;

/**
 * Private, content-addressed object storage boundary (I1). Every method is tenant-scoped: keys are
 * built and checked by the adapter from the server-derived tenant, never taken from a caller. There is
 * no public URL, no listing and no path input on this port; maintenance listings live on a separate
 * interface that request paths never receive.
 */
export interface ObjectStorePort {
  /** Writes bytes to a fresh staging key and reports their digest and length. */
  stage(
    tenantId: string,
    bytes: Uint8Array,
  ): Promise<{ stagingKey: string; digestSha256: string; byteLength: number }>;
  /** Reads staged bytes (bounded) for gating; never served to a caller. */
  readStaged(tenantId: string, stagingKey: string): Promise<Uint8Array>;
  /**
   * Verifies the staged bytes against `expectedDigest` and moves them to the content-addressed key
   * `t/<tenant>/sha256/<aa>/<digest>`. Identical bytes already stored stay as they are (`created:
   * false`) after their own digest is verified.
   */
  promote(
    tenantId: string,
    stagingKey: string,
    expectedDigest: string,
  ): Promise<{ storageKey: string; created: boolean }>;
  /** Moves staged bytes to the tenant's quarantine area (retained for investigation, never served). */
  quarantineStaged(tenantId: string, stagingKey: string): Promise<{ quarantineKey: string }>;
  /** Copies stored bytes that failed verification into quarantine for investigation. */
  quarantineStored(
    tenantId: string,
    storageKey: string,
    objectRef: string,
  ): Promise<{ quarantineKey: string }>;
  /** Discards staged bytes (abandoned or replaced ingress). Idempotent. */
  discardStaged(tenantId: string, stagingKey: string): Promise<void>;
  /** Reads stored bytes and verifies them against the registered digest on every read. */
  read(tenantId: string, storageKey: string, expectedDigest: string): Promise<Uint8Array>;
  /** Byte length of stored bytes, or null when absent. */
  head(tenantId: string, storageKey: string): Promise<{ byteLength: number } | null>;
  /** Writes content-addressed bytes produced by the server itself (derived images). */
  putContent(tenantId: string, bytes: Uint8Array): Promise<{ storageKey: string; digestSha256: string }>;
  /** Removes stored bytes. Idempotent (absent bytes are not an error). */
  remove(tenantId: string, storageKey: string): Promise<void>;
  /** Records that an object was deleted, outside the database, so a restored backup cannot resurrect it. */
  writeTombstone(tenantId: string, objectRef: string, digestSha256: string): Promise<void>;
  hasTombstone(tenantId: string, objectRef: string): Promise<boolean>;
}

/** Verdict of a malware scanner. `unknown` is never treated as clean. */
export type ScanVerdict = 'clean' | 'infected' | 'unknown';

/** Malware-gating port (I2). No real scanner is qualified; tests use a synthetic fake. */
export interface MalwareScannerPort {
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

export const imagingSchema = schema;
export const IMAGING_SCHEMA_ID = schema.$id;
export const IMAGING_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateImagingEntityRef = def('EntityRef');
export const validateImagingIdempotencyKey = def('IdempotencyKey');
export const validateObjectListQuery = def('ObjectListQuery');
export const validateReadGrantRequest = def('ReadGrantRequest');
export const validateReadGrantRevoke = def('ReadGrantRevoke');
export const validateStorageReconcile = def('StorageReconcile');

// I2 ingress.
export type IngressState = 'awaiting_bytes' | 'staged' | 'accepted' | 'quarantined' | 'abandoned';
export interface IngressBegin {
  readonly contentType: ImagingContentType;
  readonly byteLength: number;
  readonly declaredDigest: string;
  readonly provenance: ProvenanceInput;
  readonly intendedPatientRef?: string;
  readonly patientHints?: PatientHints;
}
export interface IngressComplete {
  readonly observedDigest: string;
}
export interface IngressRead {
  readonly ingressRef: string;
  readonly state: IngressState;
  readonly declaredContentType: ImagingContentType;
  readonly declaredByteLength: number;
  readonly declaredDigest: string;
  readonly observedDigest: string | null;
  readonly observedByteLength: number | null;
  readonly scan: ScanVerdict | null;
  readonly quarantineReason: string | null;
  readonly objectRef: string | null;
  readonly createdAt: string;
  readonly version: number;
}
export const validateIngressBegin = def('IngressBegin');
export const validateIngressComplete = def('IngressComplete');
export const validateIngressFailureQuery = def('IngressFailureQuery');

// I3 matching, association and the imageRef.
export interface PatientHints {
  readonly familyName?: string;
  readonly givenName?: string;
  readonly birthDate?: string;
  readonly identifier?: { readonly type: string; readonly issuer: string; readonly value: string };
  readonly phone?: string;
}
export type MatchBasis = 'operatorSelected' | 'metadataExact' | 'metadataAssisted';
export interface AssociationConfirm {
  readonly patientRef: string;
  readonly basis: MatchBasis;
  readonly reasonCode?: string;
}
export interface AssociationCorrect {
  readonly patientRef: string;
  readonly reasonCode: string;
}
export interface ImageRefQuery {
  readonly expectedPatientRef?: string;
}
export const validateAssociationConfirm = def('AssociationConfirm');
export const validateAssociationCorrect = def('AssociationCorrect');
export const validateImageRefQuery = def('ImageRefQuery');
