import type { TenantTransaction } from '@cuspatlas/contracts';
import { evaluatePatientAccess } from '../../policy/patient-access';
import { addDays, formatLocal, localToInstant, minutesOf } from '../../scheduling/zoned-time';
import { type ContactDigester, DIGEST_SCHEME } from '../digests';

/**
 * E6: the single suppression decision. S14 (intent time) and E7 (send time) call it; S and B never
 * evaluate consent themselves. A decision is recorded once per evaluation with exactly one reason from
 * SUPPRESSION_REASONS (the plan's single vocabulary, enforced by a database CHECK too).
 *
 * Evaluation order (recommended-pending-approval): channel policy (policy_off), subject state
 * (appointment_missing, appointment_cancelled, subject_past for a reminder whose visit has started,
 * offer_closed for a waitlist offer that is decided or expired), template (template_withdrawn),
 * consent (opt_out, no_consent, grant_expired), contact data (missing_contact; at send time also
 * no_verified_channel when no contact point of the channel carries a recorded verification), and at
 * send time quiet hours (quiet_hours, with the end of the window as `deferredUntil`). Any read failure throws and the
 * caller fails closed: nothing is ever allowed by default.
 */
export const SUPPRESSION_POLICY_VERSION = 'suppression.pending-approval.1';

export const SUPPRESSION_REASONS = [
  'no_consent',
  'opt_out',
  'quiet_hours',
  'missing_contact',
  'policy_off',
  'appointment_cancelled',
  'appointment_missing',
  'template_withdrawn',
  'recall_not_due',
  'grant_expired',
  // Review hardening (added to the plan's vocabulary first).
  'offer_closed',
  'subject_past',
  'no_verified_channel',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** S14 intent purposes plus E5's notice of a staff reply in a secure-message thread. */
export type IntentPurpose = 'reminder' | 'cancellation' | 'waitlist_offer' | 'recall' | 'message_notice';
export type MessageChannel = 'email' | 'sms';
/** Treatment consent is C13's and is never an E consent fact (the table CHECK excludes it too). */
export type ConsentPurpose = 'reminders' | 'recall' | 'messaging';

/** Intent purpose to consent purpose (cancellation notices ride on reminder consent). */
export const CONSENT_PURPOSE: Readonly<Record<IntentPurpose, ConsentPurpose>> = {
  reminder: 'reminders',
  cancellation: 'reminders',
  waitlist_offer: 'messaging',
  recall: 'recall',
  message_notice: 'messaging',
};
/** Message channel to the S4 contact-point channel that can reach it. */
export const CONTACT_CHANNEL: Readonly<Record<MessageChannel, 'email' | 'phone'>> = {
  email: 'email',
  sms: 'phone',
};

/**
 * The patient's contact points of a channel that are not `avoid` and whose current value carries a
 * verification fact (E-owned, keyed to the HMAC digest of the value, scheme 2). The digests are computed
 * in the application with the tenant's keyed digester: the database never sees the pepper.
 */
export async function verifiedPoints(
  tx: TenantTransaction,
  digester: ContactDigester,
  patientRef: string,
  channel: 'email' | 'phone',
): Promise<{ value: string; preferred: boolean }[]> {
  const points = await tx.query<{ value: string; preferred: boolean }>(
    `SELECT cp ->> 'value' AS value, (cp ->> 'preference') = 'preferred' AS preferred
     FROM cuspatlas.patients p, jsonb_array_elements(
       CASE WHEN (p.contact ->> 'known')::boolean THEN p.contact -> 'points' ELSE '[]'::jsonb END) AS cp
     WHERE p.id = $1 AND p.merged_into IS NULL AND cp ->> 'channel' = $2 AND cp ->> 'preference' <> 'avoid'`,
    [patientRef, channel],
  );
  if (points.rows.length === 0) return [];
  const verified = await tx.query<{ contact_digest: string }>(
    `SELECT contact_digest FROM cuspatlas.contact_verifications
     WHERE patient_id = $1 AND channel = $2 AND digest_scheme = ${DIGEST_SCHEME}`,
    [patientRef, channel],
  );
  const have = new Set(verified.rows.map((r) => r.contact_digest));
  return points.rows.filter((p) => have.has(digester.contact(channel, p.value)));
}

export interface ChannelPolicyRow extends Record<string, unknown> {
  id: string;
  purpose: IntentPurpose;
  version: number;
  channel: 'none' | MessageChannel;
  template_ref: string | null;
  quiet_start: string | null;
  quiet_end: string | null;
  reminder_lead_minutes: number | null;
  created_at: Date;
}

export async function currentChannelPolicy(
  tx: TenantTransaction,
  purpose: IntentPurpose,
): Promise<ChannelPolicyRow | null> {
  const { rows } = await tx.query<ChannelPolicyRow>(
    `SELECT id, purpose, version, channel, template_ref, to_char(quiet_start, 'HH24:MI') AS quiet_start,
       to_char(quiet_end, 'HH24:MI') AS quiet_end, reminder_lead_minutes, created_at
     FROM cuspatlas.channel_policies WHERE purpose = $1 ORDER BY version DESC LIMIT 1`,
    [purpose],
  );
  return rows[0] ?? null;
}

export interface SubjectRef {
  readonly kind: 'appointment' | 'waitlist_offer' | 'recall_task' | 'message_thread';
  readonly id: string;
}

export interface DecisionInput {
  readonly stage: 'intent' | 'send';
  readonly purpose: IntentPurpose;
  /** The intent's subject record; null for a preview about the patient only. */
  readonly subject: SubjectRef | null;
  /** The patient the decision is about; resolved from the subject when omitted. */
  readonly patientRef?: string;
  readonly intentId?: string | null;
  readonly messageId?: string | null;
  /** The instant the message would be sent (send stage and previews): quiet hours apply to it. */
  readonly sendAt?: Date | null;
  readonly timeZone?: string | null;
  /** Previews may ask about a channel the policy does not name (never recorded). */
  readonly channelOverride?: MessageChannel;
  /** Required at the send stage (keyed verification digests); a missing digester fails closed. */
  readonly digester?: ContactDigester;
}

export interface Evaluation {
  readonly patientRef: string;
  readonly purpose: IntentPurpose;
  readonly channel: 'none' | MessageChannel;
  readonly outcome: 'allowed' | 'suppressed';
  readonly reason: SuppressionReason | null;
  readonly deferredUntil: Date | null;
  readonly consentId: string | null;
  readonly policyId: string | null;
  readonly templateId: string | null;
  readonly policy: ChannelPolicyRow | null;
}

/** The subject's patient and whether it is still in the state the purpose needs. */
async function subjectState(
  tx: TenantTransaction,
  purpose: IntentPurpose,
  subject: SubjectRef,
  at: Date | null,
): Promise<{ patientRef: string | null; reason: SuppressionReason | null }> {
  if (subject.kind === 'appointment') {
    const { rows } = await tx.query<{ subject_patient_id: string; status: string; past: boolean }>(
      `SELECT subject_patient_id, status, starts_at <= coalesce($2::timestamptz, now()) AS past
       FROM cuspatlas.appointments WHERE id = $1`,
      [subject.id, at],
    );
    const r = rows[0];
    if (!r) return { patientRef: null, reason: 'appointment_missing' };
    if (purpose === 'reminder' && r.status !== 'booked') {
      return { patientRef: r.subject_patient_id, reason: 'appointment_cancelled' };
    }
    // A reminder whose visit has already started (a worker outage, a late lease) is stale.
    if (purpose === 'reminder' && r.past) return { patientRef: r.subject_patient_id, reason: 'subject_past' };
    return { patientRef: r.subject_patient_id, reason: null };
  }
  if (subject.kind === 'waitlist_offer') {
    const { rows } = await tx.query<{ subject_patient_id: string; closed: boolean }>(
      `SELECT e.subject_patient_id,
         (o.outcome IS NOT NULL OR o.expires_at <= coalesce($2::timestamptz, now())) AS closed
       FROM cuspatlas.waitlist_offers o
       JOIN cuspatlas.waitlist_entries e ON e.id = o.entry_id AND e.tenant_id = o.tenant_id WHERE o.id = $1`,
      [subject.id, at],
    );
    const r = rows[0];
    if (!r) return { patientRef: null, reason: 'appointment_missing' };
    // An accepted, declined, expired or withdrawn offer is never announced after the fact.
    return { patientRef: r.subject_patient_id, reason: r.closed ? 'offer_closed' : null };
  }
  if (subject.kind === 'message_thread') {
    // A staff reply is noticed even on a closed thread (staff may reply after closing).
    const { rows } = await tx.query<{ patient_id: string }>(
      'SELECT patient_id FROM cuspatlas.message_threads WHERE id = $1',
      [subject.id],
    );
    return { patientRef: rows[0]?.patient_id ?? null, reason: rows[0] ? null : 'appointment_missing' };
  }
  const { rows } = await tx.query<{ subject_patient_id: string; state: string }>(
    'SELECT subject_patient_id, state FROM cuspatlas.recall_tasks WHERE id = $1',
    [subject.id],
  );
  const r = rows[0];
  if (!r) return { patientRef: null, reason: 'recall_not_due' };
  return { patientRef: r.subject_patient_id, reason: r.state === 'open' ? null : 'recall_not_due' };
}

interface ConsentRow extends Record<string, unknown> {
  id: string;
  state: 'granted' | 'denied' | 'opted_out';
  via_relationship_id: string | null;
}

/** The latest consent fact for the channel and purpose (an opt-out of 'all' counts for every purpose). */
export async function effectiveConsent(
  tx: TenantTransaction,
  patientRef: string,
  channel: string,
  purpose: ConsentPurpose,
): Promise<ConsentRow | null> {
  const { rows } = await tx.query<ConsentRow>(
    `SELECT id, state, via_relationship_id FROM cuspatlas.communication_consents
     WHERE patient_id = $1 AND channel = $2 AND (purpose = $3 OR purpose = 'all')
     ORDER BY seq DESC LIMIT 1`,
    [patientRef, channel, purpose],
  );
  return rows[0] ?? null;
}

/** Quiet-hours window test at an instant, in the location's zone; returns the window end if inside. */
export function quietWindowEnd(at: Date, start: string, end: string, timeZone: string): Date | null {
  const local = formatLocal(at.getTime(), timeZone);
  const date = local.slice(0, 10);
  const m = minutesOf(local.slice(11, 16));
  const qs = minutesOf(start);
  const qe = minutesOf(end);
  const inside = qs < qe ? m >= qs && m < qe : m >= qs || m < qe;
  if (!inside) return null;
  const endDate = qs > qe && m >= qs ? addDays(date, 1) : date;
  return new Date(localToInstant(endDate, qe, timeZone));
}

/** Evaluates without recording (previews, and the body of `decide`). */
export async function evaluateSuppression(tx: TenantTransaction, input: DecisionInput): Promise<Evaluation> {
  const policy = await currentChannelPolicy(tx, input.purpose);
  const subject =
    input.subject === null
      ? { patientRef: null, reason: null }
      : await subjectState(tx, input.purpose, input.subject, input.sendAt ?? null);
  const patientRef = input.patientRef ?? subject.patientRef;
  if (patientRef === null) throw new Error('decision subject has no patient');
  const channel: 'none' | MessageChannel = input.channelOverride ?? policy?.channel ?? 'none';
  const base = {
    patientRef,
    purpose: input.purpose,
    channel,
    deferredUntil: null,
    consentId: null,
    policyId: policy?.id ?? null,
    templateId: null as string | null,
    policy,
  };
  const out = (reason: SuppressionReason | null, extra: Partial<Evaluation> = {}): Evaluation => ({
    ...base,
    outcome: reason === null ? 'allowed' : 'suppressed',
    reason,
    ...extra,
  });
  if (policy === null || policy.channel === 'none' || channel === 'none') return out('policy_off');
  if (subject.reason !== null) return out(subject.reason);
  const template = await tx.query<{ id: string; state: string }>(
    `SELECT id, state FROM cuspatlas.message_templates WHERE template_ref = $1 AND channel = $2 AND purpose = $3
     ORDER BY version DESC LIMIT 1`,
    [policy.template_ref, channel, input.purpose],
  );
  const t = template.rows[0];
  if (t?.state !== 'approved') return out('template_withdrawn', { templateId: t?.id ?? null });
  base.templateId = t.id;
  const consent = await effectiveConsent(tx, patientRef, channel, CONSENT_PURPOSE[input.purpose]);
  if (consent === null) return out('no_consent');
  if (consent.state === 'opted_out') return out('opt_out', { consentId: consent.id });
  if (consent.state !== 'granted') return out('no_consent', { consentId: consent.id });
  if (consent.via_relationship_id !== null) {
    // Consent given on the patient's behalf counts only while that relationship still grants it.
    const rel = await tx.query<{ counterparty_patient_id: string }>(
      'SELECT counterparty_patient_id FROM cuspatlas.patient_relationships WHERE id = $1',
      [consent.via_relationship_id],
    );
    const counterparty = rel.rows[0]?.counterparty_patient_id;
    const access = counterparty ? await evaluatePatientAccess(tx, patientRef, counterparty) : null;
    const live =
      access?.relationships.some(
        (r) =>
          r.relationshipRef === consent.via_relationship_id &&
          r.status === 'active' &&
          r.scopes.includes('consent'),
      ) ?? false;
    if (!live) return out('grant_expired', { consentId: consent.id });
  }
  const contact = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM cuspatlas.patients p, jsonb_array_elements(
         CASE WHEN (p.contact ->> 'known')::boolean THEN p.contact -> 'points' ELSE '[]'::jsonb END) AS cp
       WHERE p.id = $1 AND p.merged_into IS NULL AND cp ->> 'channel' = $2 AND cp ->> 'preference' <> 'avoid') AS ok`,
    [patientRef, CONTACT_CHANNEL[channel]],
  );
  if (!contact.rows[0]?.ok) return out('missing_contact', { consentId: consent.id });
  if (input.stage === 'send') {
    // Send time: the contact point must carry a recorded verification of its current value.
    if (!input.digester) throw new Error('send-stage decision needs the keyed contact digester');
    const verified = await verifiedPoints(tx, input.digester, patientRef, CONTACT_CHANNEL[channel]);
    if (verified.length === 0) return out('no_verified_channel', { consentId: consent.id });
  }
  if (input.sendAt && input.timeZone && policy.quiet_start && policy.quiet_end) {
    const end = quietWindowEnd(input.sendAt, policy.quiet_start, policy.quiet_end, input.timeZone);
    if (end !== null) return out('quiet_hours', { consentId: consent.id, deferredUntil: end });
  }
  return out(null, { consentId: consent.id });
}

export interface RecordedDecision extends Evaluation {
  readonly decisionRef: string;
}

/** Evaluates and records one decision in the caller's transaction (fail closed on any error). */
export async function decideSuppression(
  tx: TenantTransaction,
  input: DecisionInput,
): Promise<RecordedDecision> {
  const e = await evaluateSuppression(tx, input);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.suppression_decisions (tenant_id, subject_patient_id, intent_id, message_id, stage, purpose,
       channel, outcome, reason, deferred_until, consent_id, channel_policy_id, template_id, policy_version, actor_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       cuspatlas.current_actor_id())
     RETURNING id`,
    [
      e.patientRef,
      input.intentId ?? null,
      input.messageId ?? null,
      input.stage,
      input.purpose,
      e.channel,
      e.outcome,
      e.reason,
      e.deferredUntil,
      e.consentId,
      e.policyId,
      e.templateId,
      SUPPRESSION_POLICY_VERSION,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no row');
  return { ...e, decisionRef: id };
}

/**
 * The published S14 seam: called by `recordNotificationIntent` inside the transaction that records
 * the intent, so every new intent carries a real decision reference. Returns the decision reference.
 */
export async function decideForIntent(
  tx: TenantTransaction,
  intent: { intentId: string; subjectKind: SubjectRef['kind']; subjectId: string; purpose: IntentPurpose },
): Promise<string> {
  const d = await decideSuppression(tx, {
    stage: 'intent',
    purpose: intent.purpose,
    subject: { kind: intent.subjectKind, id: intent.subjectId },
    intentId: intent.intentId,
  });
  return d.decisionRef;
}

export interface DecisionDescription {
  readonly ref: string;
  readonly state: 'allowed' | 'suppressed';
  readonly reason: SuppressionReason | null;
  readonly channel: string;
  readonly decidedAt: string;
}

/** The S14 intent read reports E7's delivery state through this function. */
export async function describeDelivery(
  tx: TenantTransaction,
  intentId: string,
  decided: 'allowed' | 'suppressed' | null,
): Promise<{ owner: 'E7'; state: string; messageRef: string | null }> {
  const { rows } = await tx.query<{ id: string; state: string }>(
    'SELECT id, state FROM cuspatlas.outbound_messages WHERE intent_id = $1',
    [intentId],
  );
  const m = rows[0];
  if (m) return { owner: 'E7', state: m.state, messageRef: m.id };
  return {
    owner: 'E7',
    state: decided === 'allowed' ? 'not_queued' : 'not_sent_no_verified_channel',
    messageRef: null,
  };
}

/** The S14 intent read reports the decision through this function (E6 owns its shape). */
export async function describeDecision(
  tx: TenantTransaction,
  ref: string | null,
): Promise<DecisionDescription | null> {
  if (ref === null) return null;
  const { rows } = await tx.query<{
    outcome: 'allowed' | 'suppressed';
    reason: SuppressionReason | null;
    channel: string;
    decided_at: Date;
  }>('SELECT outcome, reason, channel, decided_at FROM cuspatlas.suppression_decisions WHERE id = $1', [ref]);
  const r = rows[0];
  if (!r) return null;
  return {
    ref,
    state: r.outcome,
    reason: r.reason,
    channel: r.channel,
    decidedAt: r.decided_at.toISOString(),
  };
}
