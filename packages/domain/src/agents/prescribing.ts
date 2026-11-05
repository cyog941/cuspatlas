import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  validatePrescriptionCancel,
  validatePrescriptionDraftCreate,
  validatePrescriptionSubmit,
} from '@cuspatlas/contracts';
import { type AgentBase, checkEnvelope, validate } from './base';

/**
 * A13 prescribing envelope (no qualified e-prescribing partner; blocked on the prescribing
 * qualification). The contract is shaped for a partner to plug in later: a prescriber identity
 * verified by a named source, a draft, a submission bound to an approved A10 proposal, and a port
 * with an explicit `unsupported` outcome. Today every prescribing operation refuses with a typed 503
 * (`service_unavailable`, reason `prescribing_not_available`) whose blocking references name each
 * missing fact and capability; nothing is written and no success is ever fabricated. Submission is a
 * human prescriber's act only (prescriptions.submit is non-delegable); agents never prescribe.
 */
export interface PrescriberIdentity {
  readonly prescriberRef: string;
  readonly credentialRef: string;
  readonly verifiedAt: string;
  readonly verificationSource: string;
}

export type PrescribingOutcome =
  | { readonly outcome: 'submitted'; readonly partnerRef: string; readonly submissionRef: string }
  | { readonly outcome: 'unknown'; readonly requestRef: string }
  | { readonly outcome: 'unsupported'; readonly reason: string };

export interface PrescribingPort {
  readonly partnerRef: string;
  capabilities(): { readonly qualified: boolean; readonly controlledSubstances: boolean };
  submit(request: {
    readonly requestRef: string;
    readonly prescriber: PrescriberIdentity;
  }): Promise<PrescribingOutcome>;
}

/** Verified prescriber identities by source. No verification source is qualified, so none exist. */
export interface PrescriberVerification {
  verified(ctx: ActorContext): Promise<PrescriberIdentity | null>;
}
const NO_VERIFICATION: PrescriberVerification = { verified: async () => null };

const notAvailable = (blockingRefs: { kind: string; ref: string }[]) =>
  new RefusalError({
    code: 'service_unavailable',
    retryable: false,
    detail: { reason: 'prescribing_not_available', blockingRefs },
  });

export function createPrescribingEnvelope(
  base: AgentBase,
  port: PrescribingPort | null,
  verification: PrescriberVerification = NO_VERIFICATION,
) {
  /** Every fact and capability a submission would need that is missing right now, in a fixed order. */
  async function missing(ctx: ActorContext, controlled: boolean) {
    const refs: { kind: string; ref: string }[] = [];
    const prescriber = await verification.verified(ctx);
    if (!prescriber) refs.push({ kind: 'fact', ref: 'prescriber_identity_verified' });
    const caps = port?.capabilities() ?? { qualified: false, controlledSubstances: false };
    if (!port || !caps.qualified) refs.push({ kind: 'capability', ref: 'eprescribing_partner' });
    if (controlled && !caps.controlledSubstances)
      refs.push({ kind: 'capability', ref: 'controlled_substance_submission' });
    return { refs, prescriber };
  }

  async function refuse(ctx: ActorContext, controlled: boolean): Promise<never> {
    const { refs } = await missing(ctx, controlled);
    // With a qualified partner and a verified prescriber this is where the draft record, the A10
    // proposal check and the port call (unknown outcomes reconciled by request identity) would run;
    // until that is built and qualified, even a complete set of facts refuses.
    if (refs.length === 0) refs.push({ kind: 'capability', ref: 'prescribing_envelope_not_enabled' });
    throw notAvailable(refs);
  }

  return {
    createPrescriptionDraft(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<never>> {
      const op = 'prescriptions.drafts.create';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        validate<{ controlledSubstance: boolean }>(validatePrescriptionDraftCreate, envelope.payload);
        return refuse(ctx, envelope.payload.controlledSubstance);
      });
    },
    submitPrescription(ctx: ActorContext, envelope: CommandEnvelope<unknown>): Promise<CommandResult<never>> {
      const op = 'prescriptions.submit';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        validate(validatePrescriptionSubmit, envelope.payload);
        return refuse(ctx, false);
      });
    },
    cancelPrescription(ctx: ActorContext, envelope: CommandEnvelope<unknown>): Promise<CommandResult<never>> {
      const op = 'prescriptions.cancel';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        validate(validatePrescriptionCancel, envelope.payload);
        return refuse(ctx, false);
      });
    },
  };
}
