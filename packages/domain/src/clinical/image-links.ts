import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type CommandEnvelope,
  type CommandResult,
  type EncounterImageLink,
  type ImageLinkCreate,
  type ImageLinkRelink,
  type ImageLinkUnlink,
  type ImageResolutionStatus,
  RefusalError,
  type TenantTransaction,
  validateImageLinkCreate,
  validateImageLinkRelink,
  validateImageLinkUnlink,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { AuthorizationDecision } from '../policy/authorize';
import { resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, notFound, UUID, uniqueOr } from './base';
import { loadClinicalPatient, loadEncounter } from './encounters';

export const IMAGE_LINK_RESOURCE = 'clinicalEncounterImageLink';
const MAX_LINKS = 500;

/**
 * What I3 currently says about an imageRef. I owns the image object, bytes, digest, patient
 * association and matching; C asks only whether the reference is current and for which patient.
 */
export type ImageRefResolution =
  | { readonly status: 'current'; readonly patientRef: string; readonly associationRef: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * Seam to I3 (`imageRef` resolution). Runs inside the caller's tenant transaction, so it can answer for
 * the caller's tenant only; another tenant's imageRef must be `not_found`. A link is claimable only
 * while I3 yields a `current` imageRef. Not wired in this branch: the integrator connects I3 (see the
 * C15 seam in docs/execution/clinical-progress.md); until then every link command is refused typed.
 */
export interface ImageRefResolver {
  resolve(tx: TenantTransaction, imageRef: string): Promise<ImageRefResolution>;
}

interface LinkRow extends Record<string, unknown> {
  id: string;
  encounter_id: string;
  subject_patient_id: string;
  image_ref: string;
  association_ref: string;
  relinked_from_id: string | null;
  linked_by: string;
  linked_by_role: EncounterImageLink['linkedByRole'];
  linked_at: Date;
  state: 'active' | 'ended';
  end_kind: 'unlinked' | 'relinked' | null;
  end_reason_code: string | null;
  relinked_to_id: string | null;
  ended_by: string | null;
  ended_at: Date | null;
  version: number;
}
const SELECT = `SELECT k.id, k.encounter_id, e.subject_patient_id, k.image_ref, k.association_ref, k.relinked_from_id,
    k.linked_by, k.linked_by_role, k.linked_at, k.state, k.end_kind, k.end_reason_code, k.relinked_to_id, k.ended_by,
    k.ended_at, k.version
  FROM cuspatlas.clinical_encounter_image_links k
  JOIN cuspatlas.clinical_encounters e ON e.id = k.encounter_id AND e.tenant_id = k.tenant_id`;

type Ack = { readonly ref: string };

/** C15 commands and reads. Nothing here registers an image, stores a digest or decides a match. */
export function createImageLinkOperations(base: ClinicalBase) {
  const { deps, execute } = base;
  const resolver = (): ImageRefResolver => {
    const r = deps.imageRefResolver;
    if (!r) {
      throw new RefusalError({
        code: 'conflict',
        replayable: false,
        detail: { reason: 'image_resolver_unavailable' },
      });
    }
    return r;
  };
  /** A current imageRef of this patient, or the typed refusal (missing and foreign are both 404). */
  const claimable = async (tx: TenantTransaction, imageRef: string, patientId: string) => {
    const r = await resolver().resolve(tx, imageRef);
    if (r.status === 'not_found') throw notFound();
    if (r.status === 'unavailable') {
      throw new RefusalError({
        code: 'conflict',
        replayable: false,
        detail: { reason: 'image_unavailable' },
      });
    }
    if (r.patientRef !== patientId) {
      throw new RefusalError({
        code: 'conflict',
        replayable: false,
        detail: { reason: 'image_patient_mismatch' },
      });
    }
    return r;
  };
  const loadLink = async (tx: TenantTransaction, decision: AuthorizationDecision, ref: string, lock = '') => {
    if (!UUID.test(ref)) throw notFound();
    const { rows } = await tx.query<LinkRow>(`${SELECT} WHERE k.id = $1 ${lock}`, [ref]);
    const row = rows[0];
    if (!row) throw notFound();
    await loadEncounter(tx, decision, row.encounter_id);
    return row;
  };
  const activeFor = async (tx: TenantTransaction, imageRef: string) =>
    (
      await tx.query<LinkRow>(`${SELECT} WHERE k.image_ref = $1 AND k.state = 'active' FOR UPDATE OF k`, [
        imageRef,
      ])
    ).rows[0];
  const linkedConflict = (existing: LinkRow | undefined, encounterId: string) =>
    existing
      ? conflict(existing.encounter_id === encounterId ? 'image_already_linked' : 'image_linked_elsewhere', {
          blockingRefs: [{ kind: 'imageLink', ref: existing.id }],
          alternative: 'clinical.imageLinks.relink',
        })
      : conflict('image_linked_elsewhere', { alternative: 'clinical.imageLinks.relink' });
  const view = async (tx: TenantTransaction, r: LinkRow): Promise<EncounterImageLink> => {
    let status: ImageResolutionStatus = 'resolver_unavailable';
    const res = deps.imageRefResolver ? await deps.imageRefResolver.resolve(tx, r.image_ref) : null;
    if (res !== null) {
      if (res.status === 'current')
        status = res.associationRef === r.association_ref ? 'current' : 'association_changed';
      else status = res.status;
    }
    return {
      imageLinkRef: r.id,
      encounterRef: r.encounter_id,
      patientRef: r.subject_patient_id,
      imageRef: r.image_ref,
      state: r.state,
      endKind: r.end_kind,
      endReasonCode: r.end_reason_code,
      relinkedFromRef: r.relinked_from_id,
      relinkedToRef: r.relinked_to_id,
      linkedBy: r.linked_by,
      linkedByRole: r.linked_by_role,
      linkedAt: r.linked_at.toISOString(),
      endedBy: r.ended_by,
      endedAt: r.ended_at?.toISOString() ?? null,
      // An active link whose image is no longer current with the same association needs a person to look.
      image: { status, reviewRequired: r.state === 'active' && status !== 'current' },
    };
  };
  const answer = async (tx: TenantTransaction, ref: string) => {
    const { rows } = await tx.query<LinkRow>(`${SELECT} WHERE k.id = $1`, [ref]);
    const row = rows[0];
    if (!row) throw notFound();
    return view(tx, row);
  };
  const insertLink = async (
    tx: TenantTransaction,
    o: {
      id?: string;
      encounterId: string;
      imageRef: string;
      associationRef: string;
      reason: string | null;
      from: string | null;
    },
    who: { role: string; credentialRef: string | null },
  ) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.clinical_encounter_image_links (id, tenant_id, encounter_id, image_ref, association_ref,
         reason_code, relinked_from_id, linked_by, linked_by_role, linked_by_credential_ref)
       VALUES (coalesce($1::uuid, gen_random_uuid()), cuspatlas.current_tenant_id(), $2, $3, $4, $5, $6,
         cuspatlas.current_actor_id(), $7, $8) RETURNING id`,
      [
        o.id ?? null,
        o.encounterId,
        o.imageRef,
        o.associationRef,
        o.reason,
        o.from,
        who.role,
        who.credentialRef,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('insert returned no row');
    return id;
  };
  const audit = (tx: TenantTransaction, op: string, ref: string, version: number, fields: string[]) =>
    recordCommand(
      tx,
      { operation: op, resourceType: IMAGE_LINK_RESOURCE, resourceRef: ref, resourceVersion: version },
      { changedFields: fields },
    );

  return {
    linkImageToEncounter(
      ctx: ActorContext,
      encounterRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<EncounterImageLink>> {
      const op = 'clinical.imageLinks.link';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ImageLinkCreate>(validateImageLinkCreate, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await loadEncounter(tx, decision, encounterRef, 'FOR SHARE OF e');
          await loadClinicalPatient(tx, encounter.subject_patient_id);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { encounterRef, ...p } },
            tx,
            async () => {
              const image = await claimable(tx, p.imageRef, encounter.subject_patient_id);
              const existing = await activeFor(tx, p.imageRef);
              if (existing) throw linkedConflict(existing, encounter.id);
              const { rows: n } = await tx.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM cuspatlas.clinical_encounter_image_links WHERE encounter_id = $1',
                [encounter.id],
              );
              if ((n[0]?.n ?? 0) >= MAX_LINKS) throw conflict('too_many_image_links');
              const id = await uniqueOr(
                tx,
                () =>
                  insertLink(
                    tx,
                    {
                      encounterId: encounter.id,
                      imageRef: p.imageRef,
                      associationRef: image.associationRef,
                      reason: p.reasonCode ?? null,
                      from: null,
                    },
                    who,
                  ),
                // A concurrent link of the same image won the one-active index: the same typed answer
                // as the pre-check, naming the link that is now active.
                async () => {
                  const winner = await activeFor(tx, p.imageRef);
                  return linkedConflict(winner, encounter.id);
                },
              );
              await audit(tx, op, id, 1, ['encounterRef', 'imageRef']);
              return { data: { ref: id }, version: 1 };
            },
          );
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    relinkImage(
      ctx: ActorContext,
      imageLinkRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<EncounterImageLink>> {
      const op = 'clinical.imageLinks.relink';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ImageLinkRelink>(validateImageLinkRelink, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const old = await loadLink(tx, decision, imageLinkRef, 'FOR UPDATE OF k');
          const target = await loadEncounter(tx, decision, p.encounterRef, 'FOR SHARE OF e');
          await loadClinicalPatient(tx, target.subject_patient_id);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { imageLinkRef, ...p } },
            tx,
            async () => {
              const current = await loadLink(tx, decision, imageLinkRef, 'FOR UPDATE OF k');
              if (current.state !== 'active') {
                throw conflict('image_link_ended', {
                  blockingRefs: [{ kind: 'imageLink', ref: current.id }],
                });
              }
              if (target.id === old.encounter_id) {
                throw conflict('image_already_linked', {
                  blockingRefs: [{ kind: 'imageLink', ref: current.id }],
                });
              }
              const image = await claimable(tx, current.image_ref, target.subject_patient_id);
              const next = (await tx.query<{ id: string }>('SELECT gen_random_uuid()::text AS id')).rows[0]
                ?.id;
              if (!next) throw new Error('no id');
              await tx.query(
                `UPDATE cuspatlas.clinical_encounter_image_links SET state = 'ended', end_kind = 'relinked',
                 end_reason_code = $2, relinked_to_id = $3, ended_by = cuspatlas.current_actor_id(), ended_at = now(),
                 version = version + 1, updated_at = now()
               WHERE id = $1`,
                [current.id, p.reasonCode, next],
              );
              await audit(tx, op, current.id, current.version + 1, ['state', 'relinkedToRef']);
              const id = await insertLink(
                tx,
                {
                  id: next,
                  encounterId: target.id,
                  imageRef: current.image_ref,
                  associationRef: image.associationRef,
                  reason: p.reasonCode,
                  from: current.id,
                },
                who,
              );
              await audit(tx, op, id, 1, ['encounterRef', 'imageRef', 'relinkedFromRef']);
              return { data: { ref: id }, version: 1 };
            },
          );
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    unlinkImage(
      ctx: ActorContext,
      imageLinkRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<EncounterImageLink>> {
      const op = 'clinical.imageLinks.unlink';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<ImageLinkUnlink>(validateImageLinkUnlink, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await loadLink(tx, decision, imageLinkRef);
          await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(
            ctx,
            { ...envelope, payload: { imageLinkRef, ...p } },
            tx,
            async () => {
              const current = await loadLink(tx, decision, imageLinkRef, 'FOR UPDATE OF k');
              if (current.state !== 'active') {
                throw conflict('image_link_ended', {
                  blockingRefs: [{ kind: 'imageLink', ref: current.id }],
                });
              }
              await tx.query(
                `UPDATE cuspatlas.clinical_encounter_image_links SET state = 'ended', end_kind = 'unlinked',
                 end_reason_code = $2, ended_by = cuspatlas.current_actor_id(), ended_at = now(), version = version + 1,
                 updated_at = now()
               WHERE id = $1`,
                [current.id, p.reasonCode],
              );
              await audit(tx, op, current.id, current.version + 1, ['state', 'endReasonCode']);
              return { data: { ref: current.id }, version: current.version + 1 };
            },
          );
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    readImageLink(ctx: ActorContext, imageLinkRef: string): Promise<EncounterImageLink> {
      const op = 'clinical.imageLinks.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadLink(tx, decision, imageLinkRef);
          const out = await view(tx, row);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: IMAGE_LINK_RESOURCE,
            resourceRefs: [row.id],
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** Every link of an encounter, active and ended, oldest first. A sensitive read. */
    listEncounterImages(ctx: ActorContext, encounterRef: string): Promise<{ links: EncounterImageLink[] }> {
      const op = 'clinical.imageLinks.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const encounter = await loadEncounter(tx, decision, encounterRef);
          const { rows } = await tx.query<LinkRow>(
            `${SELECT} WHERE k.encounter_id = $1 ORDER BY k.linked_at, k.id LIMIT ${MAX_LINKS}`,
            [encounter.id],
          );
          const links: EncounterImageLink[] = [];
          for (const r of rows) links.push(await view(tx, r));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: IMAGE_LINK_RESOURCE,
            resourceRefs: [encounter.id, ...rows.map((r) => r.id)].slice(0, 100),
            queryFields: [],
          });
          return { links };
        });
      });
    },
  };
}
