import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './engagement.schema.json' with { type: 'json' };
import type { RelationshipScope } from './patient';
import { collectPropertyNames, createAjv } from './validation';

/**
 * Workstream E (portal and communications) contracts. engagement.schema.json is authoritative for
 * validation; these types mirror it. Synthetic implementation; every rule here is
 * recommended-pending-approval (docs/execution/engagement-progress.md).
 */
export const engagementSchema = schema;
export const ENGAGEMENT_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

/** E-S3 is blocked-on-discovery: every portal principal carries this proofing level until it closes. */
export const PORTAL_PROOFING_LEVEL = 'unverified-synthetic';
export type PortalPrincipalState = 'pending' | 'active' | 'revoked';

export interface ContactValue {
  readonly channel: 'email' | 'phone';
  readonly value: string;
}
export interface PortalEnroll {
  readonly personRef: string;
  readonly contact: ContactValue;
}
export interface PortalRequestSubmit {
  readonly locationRef: string;
  readonly appointmentTypeCode?: string;
  readonly providerPreference?: string;
  readonly preferredWindows?: readonly { readonly startsAt: string; readonly endsAt: string }[];
  readonly flexibility?: string;
  readonly contactConsent: 'granted' | 'declined';
}
export interface PortalVerify {
  readonly expectedVersion: number;
  readonly method: 'synthetic_attested';
}
export interface PortalRevoke {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}

/** A projection of one S5 relationship; grantRef equals relationshipRef (no second grant model). */
export interface PortalGrant {
  readonly grantRef: string;
  readonly relationshipRef: string;
  readonly patientRef: string;
  readonly granteeRef: string;
  readonly kind: 'guardian' | 'guarantor' | 'dependent' | 'proxy';
  readonly scope: readonly RelationshipScope[];
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly revokedAt: string | null;
  readonly status: 'active' | 'pending' | 'expired' | 'revoked';
  readonly statusReason: string;
  readonly projectedAt: string;
}

export interface PortalPrincipalRecord {
  readonly principalRef: string;
  readonly personRef: string;
  readonly state: PortalPrincipalState;
  readonly proofingLevel: string;
  readonly contactChannel: 'email' | 'phone';
  readonly verifiedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  readonly version: number;
  readonly createdAt: string;
}

/** Live portal enrolment of a verified token subject (read before any tenant context exists). */
export interface PortalPrincipalRow {
  readonly principalId: string;
  readonly tenantId: string;
  readonly kind: 'human' | 'service' | 'portal';
  readonly state: PortalPrincipalState | null;
}

export interface PortalPrincipalSource {
  /** Live lookup, never cached. Null when the subject has no principal row at all. */
  load(principalId: string, tenantId: string): Promise<PortalPrincipalRow | null>;
}

export const validatePortalEnroll = def('PortalEnroll');
export const validatePortalVerify = def('PortalVerify');
export const validatePortalRevoke = def('PortalRevoke');
export const validateEmptyQuery = def('EmptyQuery');
export const validatePortalRequestSubmit = def('PortalRequestSubmit');
export const validateEngagementEntityRef = def('EntityRef');
