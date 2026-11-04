import {
  type PatientAccess,
  type PatientAccessReason,
  RELATIONSHIP_SCOPES,
  RefusalError,
  type Relationship,
  type RelationshipKind,
  type RelationshipRevokeReason,
  type RelationshipScope,
  type RelationshipStatus,
  type RelationshipStatusReason,
  type SecurityReasonCode,
  type TenantTransaction,
} from '@cuspatlas/contracts';

/**
 * Relationship authority (S5). One place evaluates expiry, revocation and age of majority, with the
 * database clock of the transaction that runs the command, from current rows (ADR 0003 Q10-Q13,
 * recommended-pending-approval). Staff roles never inherit these scopes and these scopes grant no
 * staff capability.
 *
 * Seam for E1: the counterparty is data (a patient-identity record). A portal principal will be
 * mapped to a counterparty by E1 and must call the same `requireRelationshipScope` /
 * `evaluatePatientAccess`; E1 defines no second grant model or expiry rule.
 */
export const PATIENT_ACCESS_POLICY_VERSION = 'patient-access.pending-approval.1';

export interface PatientPolicySettings {
  readonly ageOfMajorityYears: number;
  readonly proxyMaxDays: number;
}

/** ADR 0003 defaults; a tenant row in cuspatlas.patient_policy_settings overrides them. */
export const DEFAULT_PATIENT_POLICY: PatientPolicySettings = Object.freeze({
  ageOfMajorityYears: 18,
  proxyMaxDays: 365,
});

export async function loadPatientPolicy(tx: TenantTransaction): Promise<PatientPolicySettings> {
  const { rows } = await tx.query<{ age_of_majority_years: number; proxy_max_days: number }>(
    'SELECT age_of_majority_years, proxy_max_days FROM cuspatlas.patient_policy_settings',
  );
  const r = rows[0];
  return r
    ? { ageOfMajorityYears: r.age_of_majority_years, proxyMaxDays: r.proxy_max_days }
    : DEFAULT_PATIENT_POLICY;
}

/**
 * The earliest instant the subject can have reached majority. Coarse birth dates fail closed: a
 * month precision uses the first of the month, a year precision the first of January.
 */
export function majorityInstant(
  birth: string | null,
  precision: 'day' | 'month' | 'year' | 'unknown',
  years: number,
): Date | null {
  if (birth === null || precision === 'unknown') return null;
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number];
  if (precision === 'year') return new Date(Date.UTC(y + years, 0, 1));
  if (precision === 'month') return new Date(Date.UTC(y + years, m - 1, 1));
  return new Date(Date.UTC(y + years, m - 1, d));
}

export interface RelationshipRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  counterparty_patient_id: string;
  kind: RelationshipKind;
  scopes: RelationshipScope[];
  effective_from: Date;
  effective_until: Date | null;
  evidence_ref: string | null;
  revoked_at: Date | null;
  revoke_reason: RelationshipRevokeReason | null;
  version: number;
  subject_birth: string | null;
  subject_precision: 'day' | 'month' | 'year' | 'unknown';
  evaluated_at: Date;
}

/**
 * Relationship columns plus the subject's birth date and the statement clock. clock_timestamp(), not
 * now(): a command whose transaction began before a revocation or an expiry and that evaluates (and
 * locks) the row afterwards must see the world as of the evaluation, never as of its transaction start.
 */
export const RELATIONSHIP_SELECT = `SELECT r.id, r.subject_patient_id, r.counterparty_patient_id, r.kind, r.scopes,
    r.effective_from, r.effective_until, r.evidence_ref, r.revoked_at, r.revoke_reason, r.version,
    to_char(s.birth_date, 'YYYY-MM-DD') AS subject_birth, s.birth_date_precision AS subject_precision,
    clock_timestamp() AS evaluated_at
  FROM cuspatlas.patient_relationships r JOIN cuspatlas.patients s ON s.id = r.subject_patient_id`;

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** Status of one relationship at the transaction's clock. */
export function relationshipView(r: RelationshipRow, policy: PatientPolicySettings): Relationship {
  const now = r.evaluated_at.getTime();
  const majority =
    r.kind === 'guardian'
      ? majorityInstant(r.subject_birth, r.subject_precision, policy.ageOfMajorityYears)
      : null;
  const candidates = [r.effective_until, majority].filter((x): x is Date => x !== null);
  const end = candidates.length === 0 ? null : new Date(Math.min(...candidates.map((c) => c.getTime())));
  let status: RelationshipStatus;
  let statusReason: RelationshipStatusReason;
  // Any recorded revocation is final: revoked_at is set to the revoking transaction's clock, which may
  // be later than an older evaluating transaction's clock (the race fixed in review hardening).
  if (r.revoked_at !== null) {
    status = 'revoked';
    statusReason = 'revoked';
  } else if (r.effective_from.getTime() > now) {
    status = 'pending';
    statusReason = 'not_yet_effective';
  } else if (end !== null && end.getTime() <= now) {
    status = 'expired';
    statusReason =
      majority !== null && majority.getTime() === end.getTime() ? 'age_of_majority_reached' : 'window_ended';
  } else {
    status = 'active';
    statusReason = 'active';
  }
  return {
    relationshipRef: r.id,
    subjectRef: r.subject_patient_id,
    counterpartyRef: r.counterparty_patient_id,
    kind: r.kind,
    scopes: [...r.scopes],
    effectiveFrom: r.effective_from.toISOString(),
    effectiveUntil: iso(r.effective_until),
    effectiveEnd: iso(end),
    evidenceRef: r.evidence_ref,
    revokedAt: iso(r.revoked_at),
    revokeReason: r.revoke_reason,
    status,
    statusReason,
    version: r.version,
  };
}

const REASON_OF: Record<Exclude<RelationshipStatus, 'active'>, PatientAccessReason> = {
  revoked: 'relationship_revoked',
  expired: 'relationship_expired',
  pending: 'relationship_pending',
};

/**
 * Effective access of `counterpartyRef` to `subjectRef`, computed now from current rows. With
 * `lock`, the relationship rows are locked FOR SHARE until the command's transaction ends, so a
 * concurrent revocation waits for it (and a command arriving after a revocation sees the revocation).
 */
export async function evaluatePatientAccess(
  tx: TenantTransaction,
  subjectRef: string,
  counterpartyRef: string,
  lock = false,
): Promise<PatientAccess> {
  const policy = await loadPatientPolicy(tx);
  const { rows } = await tx.query<RelationshipRow>(
    `${RELATIONSHIP_SELECT} WHERE r.subject_patient_id = $1 AND r.counterparty_patient_id = $2
     ORDER BY r.created_at, r.id LIMIT 100 ${lock ? 'FOR SHARE OF r' : ''}`,
    [subjectRef, counterpartyRef],
  );
  const clock =
    rows[0]?.evaluated_at ?? (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now;
  const views = rows.map((r) => relationshipView(r, policy));
  const active = views.filter((v) => v.status === 'active');
  const scopes = RELATIONSHIP_SCOPES.filter((s) => active.some((v) => v.scopes.includes(s)));
  let reason: PatientAccessReason = 'relationship_missing';
  if (active.length > 0) reason = 'relationship_active';
  else {
    for (const s of ['revoked', 'expired', 'pending'] as const) {
      if (views.some((v) => v.status === s)) {
        reason = REASON_OF[s];
        break;
      }
    }
  }
  return {
    subjectRef,
    counterpartyRef,
    evaluatedAt: (clock ?? new Date()).toISOString(),
    policyVersion: PATIENT_ACCESS_POLICY_VERSION,
    scopes,
    reason,
    relationships: views,
  };
}

/** True only for one of the five relationship scopes held by an active relationship. */
export function relationshipPermits(access: PatientAccess, action: string): boolean {
  return (
    access.reason === 'relationship_active' &&
    (RELATIONSHIP_SCOPES as readonly string[]).includes(action) &&
    access.scopes.includes(action as RelationshipScope)
  );
}

function denyRelationship(reason: SecurityReasonCode): never {
  throw new RefusalError({ code: 'forbidden', reasonCode: reason, detail: { reason } });
}

/**
 * Fresh authorization of an act on behalf of a related person: denies (403, recorded as a security
 * attempt by the command boundary) unless an active relationship grants `scope` now. Any action
 * outside the five relationship scopes, such as `clinical.sign`, is always denied.
 */
export async function requireRelationshipScope(
  tx: TenantTransaction,
  subjectRef: string,
  counterpartyRef: string,
  scope: string,
): Promise<PatientAccess> {
  const access = await evaluatePatientAccess(tx, subjectRef, counterpartyRef, true);
  if (access.reason !== 'relationship_active') denyRelationship(access.reason);
  if (!relationshipPermits(access, scope)) denyRelationship('relationship_scope_missing');
  return access;
}
