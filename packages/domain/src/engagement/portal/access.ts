import {
  type PatientAccess,
  RELATIONSHIP_SCOPES,
  type RelationshipScope,
  type TenantTransaction,
  validateEngagementEntityRef,
} from '@cuspatlas/contracts';
import { evaluatePatientAccess, loadPatientPolicy, majorityInstant } from '../../policy/patient-access';
import { forbidden, notFound } from '../common';

/**
 * E1 portal authority, evaluated freshly inside the transaction of every portal query and command.
 *
 * - The principal's live enrolment is re-read (and share-locked, so a concurrent revocation waits for
 *   the command and a later command sees it).
 * - Acting for the person record itself ("self") needs the person to have reached the tenant's age of
 *   majority, computed with S5's policy and S5's majority rule (recommended-pending-approval; a
 *   coarse or unknown birth date fails closed). Self holds all five relationship scopes.
 * - Acting for anyone else is S5's `evaluatePatientAccess` (the single place expiry, revocation and
 *   majority are evaluated), with the relationship rows share-locked. No relationship at all, another
 *   tenant's patient and a random reference are the same 404; a revoked, expired or pending
 *   relationship and a missing scope are typed 403 denials.
 */
export const PORTAL_ACCESS_POLICY_VERSION = 'portal-access.pending-approval.1';

export interface PortalPrincipalContext {
  readonly principalRef: string;
  readonly personRef: string;
  readonly proofingLevel: string;
}

export interface SelfStatus {
  readonly patientRef: string;
  readonly status: 'active' | 'denied';
  readonly reason: 'self' | 'self_below_majority' | 'self_identity_merged';
}

export interface PortalAccessResult {
  readonly principal: PortalPrincipalContext;
  readonly patientRef: string;
  readonly via: 'self' | 'guardian' | 'guarantor' | 'dependent' | 'proxy';
  readonly scopes: readonly RelationshipScope[];
  readonly relationshipRefs: readonly string[];
  readonly access: PatientAccess | null;
}

/** The acting principal's live enrolment and person binding (403 when no longer usable). */
export async function loadPortalPrincipal(tx: TenantTransaction): Promise<PortalPrincipalContext> {
  if (tx.ctx.principal !== 'portal') throw forbidden('principal_kind_denied');
  const { rows } = await tx.query<{
    person_patient_id: string;
    state: string;
    proofing_level: string;
    merged_into: string | null;
  }>(
    `SELECT pp.person_patient_id, pp.state, pp.proofing_level, p.merged_into
     FROM cuspatlas.portal_principals pp JOIN cuspatlas.patients p ON p.id = pp.person_patient_id
     WHERE pp.principal_id = cuspatlas.current_actor_id() FOR SHARE OF pp`,
  );
  const row = rows[0];
  if (!row || row.state === 'revoked') throw forbidden('membership_inactive');
  if (row.state !== 'active') throw forbidden('portal_contact_unverified');
  if (row.merged_into !== null) throw forbidden('portal_identity_merged');
  return {
    principalRef: tx.ctx.actorId,
    personRef: row.person_patient_id,
    proofingLevel: row.proofing_level,
  };
}

/** Whether the person may act for themselves now (majority per S5's tenant policy). */
export async function selfStatus(tx: TenantTransaction, personRef: string): Promise<SelfStatus> {
  const policy = await loadPatientPolicy(tx);
  const { rows } = await tx.query<{
    birth: string | null;
    precision: 'day' | 'month' | 'year' | 'unknown';
    merged_into: string | null;
    now: Date;
  }>(
    `SELECT to_char(birth_date, 'YYYY-MM-DD') AS birth, birth_date_precision AS precision, merged_into,
       clock_timestamp() AS now
     FROM cuspatlas.patients WHERE id = $1`,
    [personRef],
  );
  const r = rows[0];
  if (!r) throw notFound();
  if (r.merged_into !== null)
    return { patientRef: personRef, status: 'denied', reason: 'self_identity_merged' };
  const majority = majorityInstant(r.birth, r.precision, policy.ageOfMajorityYears);
  if (majority === null || majority.getTime() > r.now.getTime()) {
    return { patientRef: personRef, status: 'denied', reason: 'self_below_majority' };
  }
  return { patientRef: personRef, status: 'active', reason: 'self' };
}

/**
 * Authorizes one portal act on `patientRef` needing every scope in `required`. Throws the typed
 * refusal; never returns a partial grant.
 */
export async function requirePortalAccess(
  tx: TenantTransaction,
  patientRef: string,
  required: readonly RelationshipScope[],
): Promise<PortalAccessResult> {
  const principal = await loadPortalPrincipal(tx);
  if (!validateEngagementEntityRef(patientRef)) throw notFound();
  if (patientRef === principal.personRef) {
    const self = await selfStatus(tx, patientRef);
    if (self.status !== 'active') throw forbidden('portal_self_below_majority', self.reason);
    return {
      principal,
      patientRef,
      via: 'self',
      scopes: RELATIONSHIP_SCOPES,
      relationshipRefs: [],
      access: null,
    };
  }
  const access = await evaluatePatientAccess(tx, patientRef, principal.personRef, true);
  if (access.reason === 'relationship_missing') throw notFound();
  if (access.reason !== 'relationship_active') throw forbidden(access.reason, access.reason);
  for (const s of required) {
    if (!access.scopes.includes(s))
      throw forbidden('relationship_scope_missing', 'relationship_scope_missing');
  }
  const active = access.relationships.filter((r) => r.status === 'active');
  const kinds = active.filter((r) => required.every((s) => r.scopes.includes(s)));
  return {
    principal,
    patientRef,
    via: (kinds[0] ?? active[0])?.kind ?? 'proxy',
    scopes: access.scopes,
    relationshipRefs: active.map((r) => r.relationshipRef),
    access,
  };
}
