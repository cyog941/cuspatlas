/**
 * Shared foundation contracts. See docs/execution/foundation-contract-decisions.md (frozen) and
 * docs/SHARED-CONTRACTS.md. Transport inputs never carry tenant authority; these types describe
 * server-derived context and server-produced records only.
 */

/**
 * `device` (I6): a paired imaging bridge authenticated by its own Ed25519 key on the bridge audience.
 * It never holds a staff membership (the database refuses one) and no staff action policy admits it.
 */
export type PrincipalKind = 'human' | 'service' | 'device';

/** Built server-side from a verified token plus a live membership row. Never from caller input. */
export interface ActorContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly principal: PrincipalKind;
  readonly sessionId: string;
  readonly scopes: readonly string[];
  readonly correlationId: string;
}

export interface CommandEnvelope<T> {
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly expectedVersion?: number;
  readonly payload: T;
}

/** Success only. Refusals are DomainRefusal values, never a CommandResult. */
export interface CommandResult<T> {
  readonly data: T;
  readonly version: number;
  readonly correlationId: string;
  readonly replayed: boolean;
}

/** Committed-change audit. Written in the same transaction as the change (Task 4). */
export interface AuditEvent {
  readonly eventRef: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly principal: PrincipalKind;
  readonly operation: string;
  readonly resourceType: string;
  readonly resourceRef: string;
  readonly resourceVersion: number;
  readonly correlationId: string;
  readonly occurredAt: string;
}

/**
 * Denied or failed attempt. Written after rollback through an independent connection.
 * tenantId/actorId are null when not authenticated or not established; never fabricated.
 */
export interface SecurityAttemptEvent {
  readonly attemptRef: string;
  readonly correlationId: string;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly operation: string;
  readonly reasonCode: SecurityReasonCode;
  readonly occurredAt: string;
}

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly operation: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  /** Classified and minimized; never logged automatically. */
  readonly payload: unknown;
}

export const REFUSAL_CODES = [
  'invalid_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'stale_version',
  'idempotency_conflict',
  'conflict',
  'rate_limited',
  'internal_error',
  'service_unavailable',
  // F Task 7a: proposal and approval boundary.
  'self_approval_denied',
  'payload_mismatch',
  'proposal_expired',
  'policy_changed',
  'approval_invalid',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Transport mapping from SHARED-CONTRACTS. REST adapters use this table and nothing else. */
export const REFUSAL_HTTP_STATUS: Readonly<Record<RefusalCode, number>> = {
  invalid_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  stale_version: 409,
  idempotency_conflict: 409,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
  self_approval_denied: 403,
  payload_mismatch: 409,
  proposal_expired: 409,
  policy_changed: 409,
  approval_invalid: 409,
};

export const SECURITY_REASON_CODES = [
  'token_missing',
  'token_invalid',
  'membership_inactive',
  'principal_kind_denied',
  'scope_missing',
  'tenant_mismatch',
  'location_denied',
  'resource_hidden_or_missing',
  // F Task 7a: every proposal refusal is recorded; these name the non-denial reasons.
  'self_approval_denied',
  'payload_mismatch',
  'proposal_expired',
  'stale_version',
  'policy_changed',
  'approval_invalid',
  'approver_unauthorized',
  'proposer_unauthorized',
  'proposal_state_conflict',
  'request_invalid',
  'idempotency_conflict',
  'proposal_refused',
  // S5: relationship authority (guardian, guarantor, proxy) evaluated at command time.
  'relationship_missing',
  'relationship_pending',
  'relationship_expired',
  'relationship_revoked',
  'relationship_scope_missing',
  // S6: merge confirmation and reversal policy.
  'merge_confirmation_invalid',
  'unmerge_review_required',
  // S10: every booking, hold, reschedule and cancel refusal leaves an attempt row with its reason.
  'booking_conflict',
  'booking_refused',
  // I (imaging): every imaging refusal leaves an attempt row; integrity and grant failures are named.
  'imaging_refused',
  'object_token_invalid',
  'object_integrity_failed',
  'upload_gated',
  // I6: device principals (their own audience and kind; never staff). Pairing failures carry no tenant.
  'device_pairing_invalid',
  'device_pairing_expired',
  'device_pairing_used',
  'device_assertion_invalid',
  'device_assertion_replayed',
  'device_revoked',
  'device_signature_invalid',
] as const;
export type SecurityReasonCode = (typeof SECURITY_REASON_CODES)[number];

/** S7/S10 shared ResourceRef: the only composite reference; its inner identifier is itself a ref. */
export type ResourceKind = 'provider' | 'operatory' | 'equipment' | 'staff';
export interface ResourceRef {
  readonly kind: ResourceKind;
  readonly resourceRef: string;
}

/** Conflict kinds fixed by the scheduling plan's Shared interfaces. */
export type ConflictKind =
  | 'resource_overlap'
  | 'provider_assignment'
  | 'outside_availability'
  | 'insufficient_duration'
  | 'patient_unavailable'
  | 'patient_inactive'
  | 'policy_override_required';

/** One inspectable conflict. Server-authored only, filtered to what the caller may see. */
export interface Conflict {
  readonly kind: ConflictKind;
  readonly resourceRef?: ResourceRef;
  readonly existingRef?: string;
  readonly explanation: string;
  readonly overrideable: boolean;
}

/** Safe, server-authored detail only. Never request payload text. */
export interface RefusalDetail {
  readonly currentVersion?: number;
  readonly violations?: readonly { readonly pointer: string; readonly rule: string }[];
  /**
   * S workstream addition (2026-11-04): a server-authored reason enumeration (pattern
   * ^[a-z_]{1,64}), for example patient_deceased. Never caller text.
   */
  readonly reason?: string;
  /** S6 addition: references that block an operation, limited to the caller's own tenant. */
  readonly blockingRefs?: readonly { readonly kind: string; readonly ref: string }[];
  /** S7 addition: the conflicts behind a `conflict` refusal (at most 50). */
  readonly conflicts?: readonly Conflict[];
  /** S13 addition: the published configuration limit a request exceeded. */
  readonly limit?: { readonly name: string; readonly value: number };
  /** I8 addition: the computed earliest instant an imaging deletion would be allowed. */
  readonly earliestAllowedAt?: string;
  /** S13 addition: per-occurrence conflicts of a refused series (at most 52). */
  readonly occurrences?: readonly {
    readonly index: number;
    readonly startsAt: string;
    readonly conflicts: readonly Conflict[];
  }[];
}

export interface DomainRefusal {
  readonly code: RefusalCode;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly detail?: RefusalDetail;
}

export interface RefusalInit {
  readonly code: RefusalCode;
  readonly retryable?: boolean;
  readonly detail?: RefusalDetail;
  /** Internal reason for the security-attempt record; never sent to the caller. */
  readonly reasonCode?: SecurityReasonCode;
  /**
   * S13 addition: false for a refusal that depends on other records' current state (a resource
   * conflict another command can clear). The idempotency executor then neither stores nor replays
   * it, so a same-key retry is evaluated again. Default true (terminal refusals are replayed).
   */
  readonly replayable?: boolean;
}

/** Typed denial thrown inside the domain; the command boundary normalizes it. */
export class RefusalError extends Error {
  readonly code: RefusalCode;
  readonly retryable: boolean;
  readonly detail: RefusalDetail | undefined;
  readonly reasonCode: SecurityReasonCode | undefined;
  readonly replayable: boolean;
  /** Set once the boundary has persisted the security attempt, so it is never recorded twice. */
  attemptRecorded = false;

  constructor(init: RefusalInit) {
    super(init.code);
    this.name = 'RefusalError';
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.detail = init.detail;
    this.reasonCode = init.reasonCode;
    this.replayable = init.replayable ?? true;
  }

  toRefusal(correlationId: string): DomainRefusal {
    return this.detail === undefined
      ? { code: this.code, retryable: this.retryable, correlationId }
      : { code: this.code, retryable: this.retryable, correlationId, detail: this.detail };
  }
}

/**
 * Thrown by command work to ask the tenant-transaction runner to COMMIT what is already written
 * (for example an idempotency reservation that records a terminal refusal) and then surface
 * `refusal` to the caller. The runner never commits for any other error.
 */
export class CommitThenRefuse extends Error {
  readonly refusal: RefusalError;
  constructor(refusal: RefusalError) {
    super('commit_then_refuse');
    this.name = 'CommitThenRefuse';
    this.refusal = refusal;
  }
}

export function isRefusalError(err: unknown): err is RefusalError {
  return err instanceof RefusalError;
}

/** Refusal codes that are denials and must produce a SecurityAttemptEvent. */
export const DENIAL_CODES: ReadonlySet<RefusalCode> = new Set([
  'unauthenticated',
  'forbidden',
  'not_found',
  'self_approval_denied',
]);

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const OPERATION_PATTERN = '^[a-z][A-Za-z]{0,40}(\\.[a-z][A-Za-z]{0,40}){0,3}$';

/** Runtime JSON Schema (2020-12) for AuditEvent. */
export const auditEventSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cuspatlas.invalid/schemas/audit-event/v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'eventRef',
    'tenantId',
    'actorId',
    'principal',
    'operation',
    'resourceType',
    'resourceRef',
    'resourceVersion',
    'correlationId',
    'occurredAt',
  ],
  properties: {
    eventRef: { type: 'string', pattern: UUID_PATTERN },
    tenantId: { type: 'string', pattern: UUID_PATTERN },
    actorId: { type: 'string', pattern: UUID_PATTERN },
    principal: { enum: ['human', 'service', 'device'] },
    operation: { type: 'string', pattern: OPERATION_PATTERN },
    resourceType: { type: 'string', pattern: '^[a-z][A-Za-z]{0,63}$' },
    resourceRef: { type: 'string', pattern: UUID_PATTERN },
    resourceVersion: { type: 'integer', minimum: 1 },
    correlationId: { type: 'string', pattern: UUID_PATTERN },
    occurredAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Runtime JSON Schema (2020-12) for SecurityAttemptEvent. */
export const securityAttemptEventSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cuspatlas.invalid/schemas/security-attempt-event/v1',
  type: 'object',
  additionalProperties: false,
  required: ['attemptRef', 'correlationId', 'tenantId', 'actorId', 'operation', 'reasonCode', 'occurredAt'],
  properties: {
    attemptRef: { type: 'string', pattern: UUID_PATTERN },
    correlationId: { type: 'string', pattern: UUID_PATTERN },
    tenantId: { anyOf: [{ type: 'string', pattern: UUID_PATTERN }, { type: 'null' }] },
    actorId: { anyOf: [{ type: 'string', pattern: UUID_PATTERN }, { type: 'null' }] },
    operation: { type: 'string', pattern: OPERATION_PATTERN },
    reasonCode: { enum: [...SECURITY_REASON_CODES] },
    occurredAt: { type: 'string', format: 'date-time' },
  },
} as const;
