import {
  type ActorContext,
  type AssociationConfirm,
  type AssociationCorrect,
  assertValid,
  type CommandEnvelope,
  IMAGING_PROPERTIES,
  type ImageRefQuery,
  type PatientHints,
  type TenantTransaction,
  validateAssociationConfirm,
  validateAssociationCorrect,
  validateImageRefQuery,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { createMatchKeyer, MATCH_KEY, type MatchKeyer, normalizeText, phoneKey } from '../patients/model';
import { checkEnvelope, checkRef, failed, type ImagingBase, notFound, refused } from './base';
import { loadObject, OBJECT_RESOURCE, type ObjectReadExtension, type ObjectRow } from './objects';

export const DECISION_RESOURCE = 'imagingAssociation';
export const IMAGE_REF_RESOURCE = 'imagingImageRef';

export type MatchBasis = 'operatorSelected' | 'metadataExact' | 'metadataAssisted';
type MatchReason =
  | 'operator_selected'
  | 'same_identifier'
  | 'same_legal_name'
  | 'same_birth_date'
  | 'same_phone';

/**
 * Tenant-bound HMAC keys of the patient hints an upload carried (the same keys S stores for patients),
 * so no hint plaintext is ever stored by imaging. Name keys need both parts; a phone key alone never
 * qualifies a candidate.
 */
export function hintKeys(h: PatientHints | undefined, keyer: MatchKeyer): string[] {
  if (!h) return [];
  const keys: string[] = [];
  if (h.familyName !== undefined && h.givenName !== undefined)
    keys.push(keyer.key(MATCH_KEY.name, `${normalizeText(h.familyName)}|${normalizeText(h.givenName)}`));
  if (h.birthDate !== undefined) keys.push(keyer.key(MATCH_KEY.birthDate, h.birthDate));
  if (h.identifier)
    keys.push(
      keyer.key(
        MATCH_KEY.identifier,
        `${h.identifier.type}|${h.identifier.issuer.toLowerCase()}|${h.identifier.value.toLowerCase()}`,
      ),
    );
  if (h.phone !== undefined) keys.push(phoneKey(h.phone, keyer));
  return keys;
}

const REASON_OF: Record<string, MatchReason> = {
  [MATCH_KEY.identifier]: 'same_identifier',
  [MATCH_KEY.name]: 'same_legal_name',
  [MATCH_KEY.birthDate]: 'same_birth_date',
  [MATCH_KEY.phone]: 'same_phone',
};
const IDENTITY: ReadonlySet<MatchReason> = new Set(['same_identifier', 'same_legal_name', 'same_birth_date']);

/** Exact metadata = a shared identifier, or legal name and birth date together. */
const isExact = (r: ReadonlySet<MatchReason>) =>
  r.has('same_identifier') || (r.has('same_legal_name') && r.has('same_birth_date'));

interface DecisionRow extends Record<string, unknown> {
  id: string;
  object_id: string;
  subject_patient_id: string;
  basis: MatchBasis;
  reason_code: string | null;
  decided_by: string;
  decided_at: Date;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  superseded_at: Date | null;
  version: number;
}
const DECISION_COLUMNS = `d.id, d.object_id, d.subject_patient_id, d.basis, d.reason_code, d.decided_by, d.decided_at,
  d.supersedes_id, d.superseded_by_id, d.superseded_at, d.version`;

const decisionData = (d: DecisionRow) => ({
  decisionRef: d.id,
  objectRef: d.object_id,
  patientRef: d.subject_patient_id,
  basis: d.basis,
  confidence: 'confirmed' as const,
  reasonCode: d.reason_code,
  decidedBy: d.decided_by,
  decidedAt: d.decided_at.toISOString(),
  supersedes: d.supersedes_id,
  supersededBy: d.superseded_by_id,
  supersededAt: d.superseded_at === null ? null : d.superseded_at.toISOString(),
});

async function currentDecision(
  tx: TenantTransaction,
  objectId: string,
  lock = false,
): Promise<DecisionRow | null> {
  const { rows } = await tx.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM cuspatlas.imaging_match_decisions d
     WHERE d.object_id = $1 AND d.superseded_by_id IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [objectId],
  );
  return rows[0] ?? null;
}

async function imageRefOf(tx: TenantTransaction, objectId: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.imaging_image_refs WHERE object_id = $1',
    [objectId],
  );
  return rows[0]?.id ?? null;
}

/** The association owner of an object: a derived object follows its source original. */
export type AssociationSource = (tx: TenantTransaction, row: ObjectRow) => Promise<string>;
export const sameObject: AssociationSource = async (_tx, row) => row.id;

/**
 * Object read projection (I3): the current association decision and `imageRef`, or `unassociated`.
 * Derived objects report their source's association (I4 supplies the resolver).
 */
export function associationExtension(sourceOf: () => AssociationSource): ObjectReadExtension {
  return async (tx, rows) => {
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const owner = await sourceOf()(tx, r);
      const d = await currentDecision(tx, owner);
      const imageRef = d ? await imageRefOf(tx, owner) : null;
      out.set(r.id, {
        association:
          d === null
            ? { status: 'unassociated' }
            : {
                status: 'associated',
                decisionRef: d.id,
                patientRef: d.subject_patient_id,
                imageRef,
                basis: d.basis,
                decidedAt: d.decided_at.toISOString(),
                inherited: owner !== r.id,
              },
      });
    }
    return out;
  };
}

/**
 * The reference read C15 and B (CL-04 attachment packages) consume: everything a consumer needs to
 * bind an image by hash to the patient it believes, and nothing about how the match was made beyond
 * the current decision. `matchesExpected` is false when the association moved (correction) or the
 * object is no longer available; a consumer must then refuse to use it.
 */
export async function imageReference(tx: TenantTransaction, imageRef: string, expectedPatientRef?: string) {
  checkRef(imageRef);
  const { rows } = await tx.query<{ object_id: string; minted_at: Date }>(
    'SELECT object_id, minted_at FROM cuspatlas.imaging_image_refs WHERE id = $1',
    [imageRef],
  );
  const ref = rows[0];
  if (!ref) throw notFound();
  const obj = await loadObject(tx, ref.object_id);
  const d = await currentDecision(tx, obj.id);
  const history = await tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM cuspatlas.imaging_match_decisions WHERE object_id = $1',
    [obj.id],
  );
  const current = obj.state === 'available' && d !== null;
  return {
    imageRef,
    objectRef: obj.id,
    objectState: obj.state,
    contentType: obj.content_type,
    byteLength: Number(obj.byte_length),
    digestSha256: obj.digest_sha256,
    mintedAt: ref.minted_at.toISOString(),
    association:
      d === null
        ? { status: 'unassociated' as const }
        : {
            status: 'associated' as const,
            decisionRef: d.id,
            patientRef: d.subject_patient_id,
            basis: d.basis,
            decidedAt: d.decided_at.toISOString(),
          },
    decisionCount: history.rows[0]?.n ?? 0,
    matchesExpected:
      expectedPatientRef === undefined
        ? null
        : current && d !== null && d.subject_patient_id === expectedPatientRef,
  };
}

/** Correction guards other tasks add (I4: an object in a current mount needs the mount amended). */
export type CorrectionGuard = (tx: TenantTransaction, objectId: string) => Promise<void>;

/** I3: candidates with reasons (never a binding), recorded decisions, corrections and the `imageRef`. */
export function createAssociationOperations(
  base: ImagingBase,
  correctionGuards: readonly CorrectionGuard[],
  escalationHours: number,
) {
  const { deps, execute } = base;

  async function candidatesFor(tx: TenantTransaction, ctx: ActorContext, obj: ObjectRow) {
    const sessions = await tx.query<{ hint_match_keys: string[]; intended_patient_id: string | null }>(
      `SELECT hint_match_keys, intended_patient_id FROM cuspatlas.imaging_ingress_sessions WHERE object_id = $1`,
      [obj.id],
    );
    const keys = [...new Set(sessions.rows.flatMap((r) => r.hint_match_keys))];
    const named = new Set(
      sessions.rows.map((r) => r.intended_patient_id).filter((x): x is string => x !== null),
    );
    const found = new Map<string, Set<MatchReason>>();
    for (const p of named) found.set(p, new Set(['operator_selected']));
    if (keys.length > 0) {
      const { rows } = await tx.query<{ id: string; match_keys: string[] }>(
        `SELECT id, match_keys FROM cuspatlas.patients WHERE match_keys && $1::text[] AND merged_into IS NULL
         ORDER BY id LIMIT 50`,
        [keys],
      );
      for (const p of rows) {
        const reasons = found.get(p.id) ?? new Set<MatchReason>();
        for (const k of p.match_keys.filter((x) => keys.includes(x))) {
          const r = REASON_OF[k.slice(0, k.indexOf(':'))];
          if (r) reasons.add(r);
        }
        found.set(p.id, reasons);
      }
    }
    void ctx;
    const candidates = [...found.entries()]
      // A shared phone or household detail alone never makes a candidate.
      .filter(([, r]) => r.has('operator_selected') || [...r].some((x) => IDENTITY.has(x)))
      .map(([patientRef, r]) => ({
        patientRef,
        reasons: [...r].sort(),
        suggestedBasis: (isExact(r)
          ? 'metadataExact'
          : r.has('operator_selected')
            ? 'operatorSelected'
            : 'metadataAssisted') as MatchBasis,
        exact: isExact(r),
      }))
      .sort(
        (a, b) =>
          Number(b.exact) - Number(a.exact) ||
          b.reasons.length - a.reasons.length ||
          a.patientRef.localeCompare(b.patientRef),
      )
      .slice(0, 20);
    const limitations = keys.length === 0 && named.size === 0 ? ['no_patient_metadata'] : [];
    return { candidates, limitations };
  }

  async function assertPatient(tx: TenantTransaction, patientRef: string) {
    checkRef(patientRef);
    const { rows } = await tx.query<{ merged_into: string | null }>(
      'SELECT merged_into FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
      [patientRef],
    );
    const p = rows[0];
    if (!p) throw notFound();
    if (p.merged_into !== null)
      throw refused('patient_merged', { blockingRefs: [{ kind: 'patient', ref: p.merged_into }] });
  }

  async function associable(tx: TenantTransaction, objectRef: string) {
    const obj = await loadObject(tx, objectRef, 'FOR UPDATE');
    if (obj.kind !== 'original') throw failed('derived_not_associable');
    if (obj.state !== 'available') throw refused('object_not_available');
    return obj;
  }

  async function insertDecision(
    tx: TenantTransaction,
    op: string,
    o: {
      id?: string;
      objectId: string;
      patientRef: string;
      basis: MatchBasis;
      reasonCode: string | null;
      supersedes: string | null;
    },
  ) {
    const { rows } = await tx.query<DecisionRow>(
      `INSERT INTO cuspatlas.imaging_match_decisions AS d (id, tenant_id, object_id, subject_patient_id, basis,
         reason_code, supersedes_id, decided_by)
       VALUES (coalesce($6::uuid, gen_random_uuid()), cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5,
         cuspatlas.current_actor_id())
       RETURNING ${DECISION_COLUMNS}`,
      [o.objectId, o.patientRef, o.basis, o.reasonCode, o.supersedes, o.id ?? null],
    );
    const d = rows[0] as DecisionRow;
    await recordCommand(
      tx,
      { operation: op, resourceType: DECISION_RESOURCE, resourceRef: d.id, resourceVersion: 1 },
      { changedFields: ['patientRef', 'basis', ...(o.supersedes ? ['supersedes'] : [])] },
    );
    return d;
  }

  return {
    proposeMatch(ctx: ActorContext, objectRef: string) {
      const op = 'imaging.associations.candidates';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(objectRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const obj = await loadObject(tx, objectRef);
          const { candidates, limitations } = await candidatesFor(tx, ctx, obj);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: OBJECT_RESOURCE,
            resourceRefs: [obj.id, ...candidates.map((c) => c.patientRef)].slice(0, 100),
            queryFields: [],
          });
          // Candidates never bind: an association exists only after a recorded decision.
          return { objectRef: obj.id, candidates, limitations, autoAssociated: false };
        });
      });
    },

    confirmAssociation(ctx: ActorContext, objectRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.associations.confirm';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(objectRef);
        assertValid<AssociationConfirm>(validateAssociationConfirm, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as AssociationConfirm;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const obj = await associable(tx, objectRef);
          await assertPatient(tx, p.patientRef);
          return execute(ctx, { ...envelope, payload: { objectRef, ...p } }, tx, async () => {
            const current = await currentDecision(tx, obj.id, true);
            if (current)
              throw refused('association_conflict', {
                blockingRefs: [{ kind: DECISION_RESOURCE, ref: current.id }],
              });
            if (p.basis !== 'operatorSelected') {
              const c = (await candidatesFor(tx, ctx, obj)).candidates.find(
                (x) => x.patientRef === p.patientRef,
              );
              if (!c || (p.basis === 'metadataExact' && !c.exact)) throw refused('candidate_not_confirmed');
            }
            const d = await insertDecision(tx, op, {
              objectId: obj.id,
              patientRef: p.patientRef,
              basis: p.basis,
              reasonCode: p.reasonCode ?? null,
              supersedes: null,
            });
            let imageRef = await imageRefOf(tx, obj.id);
            if (imageRef === null) {
              const minted = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.imaging_image_refs (tenant_id, object_id, minted_decision_id, minted_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id()) RETURNING id`,
                [obj.id, d.id],
              );
              imageRef = minted.rows[0]?.id as string;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: IMAGE_REF_RESOURCE,
                  resourceRef: imageRef,
                  resourceVersion: 1,
                },
                { changedFields: ['objectRef'] },
              );
            }
            return {
              data: {
                decisionRef: d.id,
                imageRef,
                objectRef: obj.id,
                patientRef: d.subject_patient_id,
                basis: d.basis,
              },
              version: 1,
            };
          });
        });
      });
    },

    /**
     * Correction appends a decision that supersedes the earlier one (both stay readable, in order);
     * the object is never current for two patients, and the `imageRef` stays stable (I-T8).
     */
    correctAssociation(ctx: ActorContext, decisionRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.associations.correct';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(decisionRef);
        assertValid<AssociationCorrect>(validateAssociationCorrect, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as AssociationCorrect;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const found = await tx.query<{ object_id: string }>(
            'SELECT object_id FROM cuspatlas.imaging_match_decisions WHERE id = $1',
            [decisionRef],
          );
          const objectId = found.rows[0]?.object_id;
          if (!objectId) throw notFound();
          // Lock order: object, then its current decision, then the patient.
          const obj = await associable(tx, objectId);
          const current = await currentDecision(tx, obj.id, true);
          await assertPatient(tx, p.patientRef);
          return execute(ctx, { ...envelope, payload: { decisionRef, ...p } }, tx, async () => {
            if (!current || current.id !== decisionRef)
              throw refused('decision_superseded', {
                ...(current ? { blockingRefs: [{ kind: DECISION_RESOURCE, ref: current.id }] } : {}),
              });
            if (current.subject_patient_id === p.patientRef) throw failed('same_patient');
            for (const guard of correctionGuards) await guard(tx, obj.id);
            const newId = (await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]
              ?.id as string;
            const old = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.imaging_match_decisions SET superseded_by_id = $2, superseded_at = now(),
                 version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
              [current.id, newId],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: DECISION_RESOURCE,
                resourceRef: current.id,
                resourceVersion: old.rows[0]?.version ?? 2,
              },
              { changedFields: ['supersededBy'] },
            );
            const d = await insertDecision(tx, op, {
              id: newId,
              objectId: obj.id,
              patientRef: p.patientRef,
              basis: 'operatorSelected',
              reasonCode: p.reasonCode,
              supersedes: current.id,
            });
            const imageRef = await imageRefOf(tx, obj.id);
            return {
              data: {
                decisionRef: d.id,
                supersededRef: current.id,
                imageRef,
                objectRef: obj.id,
                patientRef: p.patientRef,
              },
              version: 1,
            };
          });
        });
      });
    },

    associationHistory(ctx: ActorContext, objectRef: string) {
      const op = 'imaging.associations.history';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(objectRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const obj = await loadObject(tx, objectRef);
          const { rows } = await tx.query<DecisionRow>(
            `SELECT ${DECISION_COLUMNS} FROM cuspatlas.imaging_match_decisions d WHERE d.object_id = $1
             ORDER BY d.decided_at, d.id LIMIT 100`,
            [obj.id],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: DECISION_RESOURCE,
            resourceRefs: rows.map((r) => r.id),
            queryFields: [],
          });
          return {
            objectRef: obj.id,
            imageRef: await imageRefOf(tx, obj.id),
            decisions: rows.map(decisionData),
          };
        });
      });
    },

    /** Exception-first worklist: available originals with no current decision, with their age. */
    listUnmatched(ctx: ActorContext) {
      const op = 'imaging.associations.unmatched';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          const where = `o.kind = 'original' AND o.state = 'available' AND NOT EXISTS (
            SELECT 1 FROM cuspatlas.imaging_match_decisions d WHERE d.object_id = o.id AND d.superseded_by_id IS NULL)`;
          const { rows } = await tx.query<{ id: string; received_at: Date }>(
            `SELECT o.id, o.received_at FROM cuspatlas.imaging_objects o WHERE ${where}
             ORDER BY o.received_at, o.id LIMIT 100`,
          );
          const total = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM cuspatlas.imaging_objects o WHERE ${where}`,
          );
          const items = rows.map((r) => {
            const ageHours = Math.max(0, Math.floor((now.getTime() - r.received_at.getTime()) / 3_600_000));
            const overdue = ageHours >= escalationHours;
            return {
              workItemRef: r.id,
              kind: 'image_unmatched',
              reasonCode: 'association_missing',
              explanation:
                'This image is not associated with a patient. Review the candidates and record a decision; it is never discarded automatically.',
              evidenceRefs: [{ kind: OBJECT_RESOURCE, ref: r.id }],
              owner: { queue: 'imaging', principalRef: null },
              nextActionOwedBy: 'practice',
              dueAt: new Date(r.received_at.getTime() + escalationHours * 3_600_000).toISOString(),
              priority: overdue ? 'elevated' : 'routine',
              priorityRationale: overdue ? 'unmatched_age_exceeded' : 'default_routine',
              suggestedNextAction: 'review_match_candidates',
              blockingDependencies: [],
              ageHours,
            };
          });
          return {
            asOf: now.toISOString(),
            coverage: { status: 'available' },
            count: total.rows[0]?.n ?? 0,
            items,
          };
        });
      });
    },

    resolveImageRef(ctx: ActorContext, imageRef: string, query: unknown) {
      const op = 'imaging.imageRefs.resolve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(imageRef);
        assertValid<ImageRefQuery>(validateImageRefQuery, query, IMAGING_PROPERTIES);
        const q = query as ImageRefQuery;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const data = await imageReference(tx, imageRef, q.expectedPatientRef);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: IMAGE_REF_RESOURCE,
            resourceRefs: [imageRef, data.objectRef],
            queryFields: q.expectedPatientRef === undefined ? [] : ['expectedPatientRef'],
          });
          return data;
        });
      });
    },
  };
}

export const tenantKeyer = (pepper: Uint8Array, tenantId: string) => createMatchKeyer(pepper, tenantId);
