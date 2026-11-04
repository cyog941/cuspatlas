import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  ENGAGEMENT_PROPERTIES,
  RefusalError,
  type TenantTransaction,
  validateChannelPolicyDefine,
  validateConsentRecordInput,
  validateEmptyQuery,
  validateOptOutInput,
  validatePortalConsentInput,
  validateSuppressionPreviewQuery,
  validateTemplateDefine,
  validateTemplateWithdraw,
} from '@cuspatlas/contracts';
import { executeOnce } from '../../commands/execute-once';
import { recordCommand } from '../../events/record-command';
import { assertRef, checkEnvelope, conflict, type EngagementBase, failedAt, notFound } from '../common';
import { requirePortalAccess } from '../portal/access';
import {
  CONSENT_PURPOSE,
  currentChannelPolicy,
  evaluateSuppression,
  type IntentPurpose,
  type MessageChannel,
  SUPPRESSION_POLICY_VERSION,
} from './suppression';

/**
 * E6 commands and reads: consent and opt-out facts (staff and portal), channel policy with quiet
 * hours, notice-only templates, decision reads and the side-effect-free decision preview that S and B
 * consumers call instead of evaluating consent themselves.
 */
export const CONSENT_RESOURCE = 'communicationConsent';
const STATE_OUT: Record<string, string> = { granted: 'granted', denied: 'denied', opted_out: 'opted_out' };

interface ConsentRow extends Record<string, unknown> {
  id: string;
  channel: string;
  purpose: string;
  state: string;
  source: string;
  consent_version: string;
  via_relationship_id: string | null;
  recorded_at: Date;
}
const consentRecord = (r: ConsentRow, patientRef: string) => ({
  consentRef: r.id,
  patientRef,
  channel: r.channel,
  purpose: r.purpose,
  state: STATE_OUT[r.state] ?? r.state,
  source: r.source,
  version: r.consent_version,
  viaRelationshipRef: r.via_relationship_id,
  recordedAt: r.recorded_at.toISOString(),
});

async function insertConsent(
  tx: TenantTransaction,
  operation: string,
  c: {
    patientRef: string;
    channel: string;
    purpose: string;
    state: 'granted' | 'denied' | 'opted_out';
    source: string;
    version: string;
    via: string | null;
  },
) {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.communication_consents (tenant_id, patient_id, channel, purpose, state, source, consent_version,
       via_relationship_id, recorded_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, cuspatlas.current_actor_id()) RETURNING id`,
    [c.patientRef, c.channel, c.purpose, c.state, c.source, c.version, c.via],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no row');
  await recordCommand(
    tx,
    { operation, resourceType: CONSENT_RESOURCE, resourceRef: id, resourceVersion: 1 },
    { changedFields: ['channel', 'purpose', 'state', 'source'] },
  );
  return {
    data: {
      consentRef: id,
      patientRef: c.patientRef,
      channel: c.channel,
      purpose: c.purpose,
      state: STATE_OUT[c.state] ?? c.state,
      source: c.source,
    },
    version: 1,
  };
}

async function requirePatient(tx: TenantTransaction, patientRef: string): Promise<void> {
  assertRef(patientRef);
  const { rows } = await tx.query<{ merged_into: string | null }>(
    'SELECT merged_into FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
    [patientRef],
  );
  if (!rows[0]) throw notFound();
  if (rows[0].merged_into !== null) throw conflict('patient_merged');
}

export function createConsentOperations(base: EngagementBase) {
  const { deps } = base;
  const execute = deps.execute ?? executeOnce;

  function staffCommand<T extends Record<string, unknown>>(
    ctx: ActorContext,
    op:
      | 'communications.consents.record'
      | 'communications.consents.optOut'
      | 'communications.channelPolicies.define'
      | 'communications.templates.define'
      | 'communications.templates.withdraw',
    envelope: CommandEnvelope<unknown>,
    validate: () => void,
    pre: (tx: TenantTransaction) => Promise<void>,
    handler: (tx: TenantTransaction) => Promise<{ data: T; version: number }>,
    payloadExtra: Record<string, unknown> = {},
  ): Promise<CommandResult<T>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      validate();
      return deps.withTenantTransaction(ctx, async (tx) => {
        await pre(tx);
        return execute<T>(
          ctx,
          { ...envelope, payload: { ...payloadExtra, ...(envelope.payload as object) } },
          tx,
          () => handler(tx),
        );
      });
    });
  }

  return {
    recordConsent(ctx: ActorContext, patientRef: string, envelope: CommandEnvelope<unknown>) {
      const p = envelope.payload as {
        channel: string;
        purpose: string;
        state: 'granted' | 'denied';
        source: string;
        consentVersion: string;
      };
      return staffCommand(
        ctx,
        'communications.consents.record',
        envelope,
        () => assertValid(validateConsentRecordInput, envelope.payload, ENGAGEMENT_PROPERTIES),
        (tx) => requirePatient(tx, patientRef),
        (tx) =>
          insertConsent(tx, 'communications.consents.record', {
            patientRef,
            channel: p.channel,
            purpose: p.purpose,
            state: p.state,
            source: p.source,
            version: p.consentVersion,
            via: null,
          }),
        { patientRef },
      );
    },

    recordOptOut(ctx: ActorContext, patientRef: string, envelope: CommandEnvelope<unknown>) {
      const p = envelope.payload as { channel: string; source: string };
      return staffCommand(
        ctx,
        'communications.consents.optOut',
        envelope,
        () => assertValid(validateOptOutInput, envelope.payload, ENGAGEMENT_PROPERTIES),
        (tx) => requirePatient(tx, patientRef),
        (tx) =>
          insertConsent(tx, 'communications.consents.optOut', {
            patientRef,
            channel: p.channel,
            purpose: 'all',
            state: 'opted_out',
            source: p.source,
            version: 'opt-out',
            via: null,
          }),
        { patientRef },
      );
    },

    listConsents(ctx: ActorContext, patientRef: string, query: unknown) {
      const op = 'communications.consents.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(patientRef);
          const exists = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [patientRef]);
          if (exists.rowCount === 0) throw notFound();
          const { rows } = await tx.query<ConsentRow>(
            `SELECT id, channel, purpose, state, source, consent_version, via_relationship_id, recorded_at
             FROM cuspatlas.communication_consents WHERE patient_id = $1 ORDER BY seq LIMIT 200`,
            [patientRef],
          );
          const records = rows.map((r) => consentRecord(r, patientRef));
          // Effective state per channel and purpose: the latest fact, an opt-out covering every purpose.
          const effective: { channel: string; purpose: string; state: string; consentRef: string }[] = [];
          for (const channel of ['portal', 'email', 'sms', 'voice']) {
            for (const purpose of ['reminders', 'recall', 'messaging', 'treatment']) {
              const last = [...rows]
                .reverse()
                .find((r) => r.channel === channel && (r.purpose === purpose || r.purpose === 'all'));
              if (last)
                effective.push({
                  channel,
                  purpose,
                  state: STATE_OUT[last.state] ?? last.state,
                  consentRef: last.id,
                });
            }
          }
          return { patientRef, records, effective };
        });
      });
    },

    /** Portal consent (E6 via E1): self, or a relationship holding the `consent` scope. */
    recordPortalConsent(ctx: ActorContext, patientRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'portal.consents.record';
      return base.guarded(ctx, op, async () => {
        checkEnvelope(envelope, op);
        assertValid(validatePortalConsentInput, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as {
          channel: string;
          purpose: string;
          state: string;
          consentVersion: string;
        };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const access = await requirePortalAccess(tx, patientRef, ['consent']);
          const via =
            access.via === 'self'
              ? null
              : (access.access?.relationships.find(
                  (r) => r.status === 'active' && r.scopes.includes('consent'),
                )?.relationshipRef ?? null);
          return execute(ctx, { ...envelope, payload: { patientRef, ...p } }, tx, () =>
            insertConsent(tx, op, {
              patientRef: access.patientRef,
              channel: p.channel,
              purpose: p.purpose,
              state: p.state === 'opted_out' ? 'opted_out' : (p.state as 'granted' | 'denied'),
              source: access.via === 'self' ? 'patient_portal' : 'guardian_portal',
              version: p.consentVersion,
              via,
            }),
          );
        });
      });
    },

    defineChannelPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const p = envelope.payload as {
        purpose: IntentPurpose;
        channel: 'none' | MessageChannel;
        templateRef?: string;
        quietHours?: { start: string; end: string };
        reminderLeadMinutes?: number;
      };
      return staffCommand(
        ctx,
        'communications.channelPolicies.define',
        envelope,
        () => assertValid(validateChannelPolicyDefine, envelope.payload, ENGAGEMENT_PROPERTIES),
        async () => undefined,
        async (tx) => {
          if (p.channel !== 'none') {
            // E-D7: no shipped default send window; a live channel names its template and quiet hours.
            if (p.templateRef === undefined) throw failedAt('/templateRef', 'required');
            if (p.quietHours === undefined) throw failedAt('/quietHours', 'required');
            if (p.quietHours.start === p.quietHours.end) throw failedAt('/quietHours', 'emptyWindow');
            if (p.purpose === 'reminder' && p.reminderLeadMinutes === undefined)
              throw failedAt('/reminderLeadMinutes', 'required');
            const t = await tx.query<{ state: string; channel: string; purpose: string }>(
              `SELECT state, channel, purpose FROM cuspatlas.message_templates WHERE template_ref = $1
               ORDER BY version DESC LIMIT 1`,
              [p.templateRef],
            );
            const row = t.rows[0];
            if (row?.state !== 'approved') throw failedAt('/templateRef', 'templateNotApproved');
            if (row.channel !== p.channel || row.purpose !== p.purpose)
              throw failedAt('/templateRef', 'templateMismatch');
          }
          const current = await currentChannelPolicy(tx, p.purpose);
          const version = (current?.version ?? 0) + 1;
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO cuspatlas.channel_policies (tenant_id, purpose, version, channel, template_ref, quiet_start, quiet_end,
               reminder_lead_minutes, created_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5::time, $6::time, $7, cuspatlas.current_actor_id())
             RETURNING id`,
            [
              p.purpose,
              version,
              p.channel,
              p.channel === 'none' ? null : (p.templateRef ?? null),
              p.channel === 'none' ? null : (p.quietHours?.start ?? null),
              p.channel === 'none' ? null : (p.quietHours?.end ?? null),
              p.reminderLeadMinutes ?? null,
            ],
          );
          const id = rows[0]?.id as string;
          await recordCommand(
            tx,
            {
              operation: 'communications.channelPolicies.define',
              resourceType: 'channelPolicy',
              resourceRef: id,
              resourceVersion: 1,
            },
            { changedFields: ['purpose', 'channel', 'template', 'quietHours'] },
          );
          return { data: { policyRef: id, purpose: p.purpose, version, channel: p.channel }, version: 1 };
        },
      );
    },

    listChannelPolicies(ctx: ActorContext, query: unknown) {
      const op = 'communications.channelPolicies.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const out = [];
          for (const purpose of ['reminder', 'cancellation', 'waitlist_offer', 'recall'] as const) {
            const c = await currentChannelPolicy(tx, purpose);
            out.push({
              purpose,
              policyRef: c?.id ?? null,
              version: c?.version ?? 0,
              channel: c?.channel ?? 'none',
              templateRef: c?.template_ref ?? null,
              quietHours: c?.quiet_start && c.quiet_end ? { start: c.quiet_start, end: c.quiet_end } : null,
              reminderLeadMinutes: c?.reminder_lead_minutes ?? null,
              isDefault: c === null,
            });
          }
          return out;
        });
      });
    },

    defineTemplate(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const p = envelope.payload as { templateRef: string; purpose: string; channel: string; body: string };
      return staffCommand(
        ctx,
        'communications.templates.define',
        envelope,
        () => assertValid(validateTemplateDefine, envelope.payload, ENGAGEMENT_PROPERTIES),
        async () => undefined,
        async (tx) => {
          const latest = await tx.query<{ version: number }>(
            'SELECT max(version)::int AS version FROM cuspatlas.message_templates WHERE template_ref = $1',
            [p.templateRef],
          );
          const version = (latest.rows[0]?.version ?? 0) + 1;
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO cuspatlas.message_templates (tenant_id, template_ref, version, purpose, channel, body, state, approved_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, 'approved', cuspatlas.current_actor_id()) RETURNING id`,
            [p.templateRef, version, p.purpose, p.channel, p.body],
          );
          const id = rows[0]?.id as string;
          await recordCommand(
            tx,
            {
              operation: 'communications.templates.define',
              resourceType: 'messageTemplate',
              resourceRef: id,
              resourceVersion: 1,
            },
            { changedFields: ['templateRef', 'purpose', 'channel', 'body'] },
          );
          return {
            data: { templateRef: p.templateRef, templateVersion: version, state: 'approved' },
            version,
          };
        },
      );
    },

    withdrawTemplate(ctx: ActorContext, templateRef: string, envelope: CommandEnvelope<unknown>) {
      const p = envelope.payload as { expectedVersion: number };
      return staffCommand(
        ctx,
        'communications.templates.withdraw',
        envelope,
        () => {
          if (!/^[a-z0-9-]{1,64}$/.test(templateRef)) throw notFound();
          assertValid(validateTemplateWithdraw, envelope.payload, ENGAGEMENT_PROPERTIES);
        },
        async () => undefined,
        async (tx) => {
          const { rows } = await tx.query<{ id: string; version: number; state: string }>(
            `SELECT id, version, state FROM cuspatlas.message_templates WHERE template_ref = $1
             ORDER BY version DESC LIMIT 1 FOR UPDATE`,
            [templateRef],
          );
          const t = rows[0];
          if (!t) throw notFound();
          if (t.version !== p.expectedVersion)
            throw new RefusalError({ code: 'stale_version', detail: { currentVersion: t.version } });
          if (t.state !== 'approved') throw conflict('template_already_withdrawn');
          await tx.query(
            `UPDATE cuspatlas.message_templates SET state = 'withdrawn', withdrawn_at = now(),
               withdrawn_by = cuspatlas.current_actor_id() WHERE id = $1`,
            [t.id],
          );
          await recordCommand(
            tx,
            {
              operation: 'communications.templates.withdraw',
              resourceType: 'messageTemplate',
              resourceRef: t.id,
              resourceVersion: 2,
            },
            { changedFields: ['state'] },
          );
          return {
            data: { templateRef, templateVersion: t.version, state: 'withdrawn' },
            version: t.version,
          };
        },
        { templateRef },
      );
    },

    readDecision(ctx: ActorContext, decisionRef: string) {
      const op = 'communications.decisions.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(decisionRef);
          const { rows } = await tx.query<{
            id: string;
            subject_patient_id: string;
            intent_id: string | null;
            message_id: string | null;
            stage: string;
            purpose: string;
            channel: string;
            outcome: string;
            reason: string | null;
            deferred_until: Date | null;
            consent_id: string | null;
            policy_version: string;
            decided_at: Date;
          }>(
            `SELECT id, subject_patient_id, intent_id, message_id, stage, purpose, channel, outcome, reason, deferred_until,
               consent_id, policy_version, decided_at FROM cuspatlas.suppression_decisions WHERE id = $1`,
            [decisionRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          return {
            decisionRef: r.id,
            subjectRef: r.subject_patient_id,
            intentRef: r.intent_id,
            messageRef: r.message_id,
            stage: r.stage,
            purpose: r.purpose,
            channel: r.channel,
            outcome: r.outcome,
            reason: r.reason,
            deferredUntil: r.deferred_until === null ? null : r.deferred_until.toISOString(),
            consentRef: r.consent_id,
            policyVersion: r.policy_version,
            decidedAt: r.decided_at.toISOString(),
          };
        });
      });
    },

    /**
     * decideSuppression without recording (`recorded: false`): what E6 would decide for a patient,
     * purpose and channel at an instant. Read-only; the recorded decisions are made at intent and send.
     */
    previewSuppression(ctx: ActorContext, patientRef: string, query: unknown) {
      const op = 'communications.suppression.preview';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid(validateSuppressionPreviewQuery, query, ENGAGEMENT_PROPERTIES);
        const q = query as {
          purpose: IntentPurpose;
          channel?: MessageChannel;
          at?: string;
          locationRef?: string;
        };
        return deps.withTenantTransaction(ctx, async (tx) => {
          await requirePatient(tx, patientRef);
          let timeZone: string | null = null;
          if (q.locationRef !== undefined) {
            const l = await tx.query<{ time_zone: string }>(
              'SELECT time_zone FROM cuspatlas.scheduling_locations WHERE location_ref = $1',
              [q.locationRef],
            );
            if (!l.rows[0]) throw notFound();
            timeZone = l.rows[0].time_zone;
          }
          const at = q.at === undefined ? new Date() : new Date(q.at);
          if (Number.isNaN(at.getTime())) throw failedAt('/at', 'format');
          // A preview has no subject record: the subject-state checks do not apply.
          const final = await evaluateSuppression(tx, {
            stage: 'send',
            purpose: q.purpose,
            subject: null,
            patientRef,
            sendAt: at,
            timeZone,
            ...(q.channel ? { channelOverride: q.channel } : {}),
          });
          return {
            patientRef,
            purpose: q.purpose,
            consentPurpose: CONSENT_PURPOSE[q.purpose],
            channel: final.channel,
            outcome: final.outcome,
            reason: final.reason,
            deferredUntil: final.deferredUntil === null ? null : final.deferredUntil.toISOString(),
            policyVersion: SUPPRESSION_POLICY_VERSION,
            recorded: false,
          };
        });
      });
    },
  };
}
