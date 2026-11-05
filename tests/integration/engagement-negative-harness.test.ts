import { randomUUID } from 'node:crypto';
import { REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, SYNTHETIC_TEST_MATCH_KEY_PEPPER } from '@cuspatlas/domain';
import { buildMcpServer } from '@cuspatlas/mcp';
import { createOutboundSender } from '@cuspatlas/worker';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  E_ALL,
  type EngagementHarness,
  email,
  MCP_AUDIENCE,
  openEngagementHarness,
  PORTAL_AUDIENCE,
  SVC_R1,
  SVC_T1,
  SVC_W1,
} from './support/engagement-fixtures';
import { FakeMessaging } from './support/fake-messaging';
import { T_ALPHA, T_BETA, USER_A1, USER_A2, USER_A4, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { USER_A5 } from './support/patient-fixtures';

/**
 * Negative harness for workstream E (stated once in the plan's Global Constraints). Every E staff
 * command is attempted cross-tenant, with a revoked membership, with a downgraded role and through
 * MCP, under the runtime role; every portal route is attempted with a staff token, an MCP token, a
 * revoked portal principal and another tenant's token; every staff E route is attempted with a portal
 * token. It is a separate file from the S harness so parallel workstreams append without conflicts;
 * the dimensions and assertions are the same. Append a row to COMMANDS for each new E command.
 */
let db: TestDatabase;
let h: EngagementHarness;
let mcpUrl: string;
let closeMcp: (() => Promise<void>) | undefined;
const mcpTokens: Record<string, string> = {};
const rest: Record<string, string> = {};

interface Fixture {
  readonly [name: string]: string;
}
let fixture: Fixture;

interface RestCall {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body?: unknown;
  readonly keyed: boolean;
  readonly status: number;
}
interface HarnessCommand {
  readonly operation: string;
  readonly tool: string;
  readonly crossTenant: 'not_found' | 'own_tenant_only' | 'tenant_own_data';
  readonly downgradedTo: 'readOnly' | 'noScopes';
  /** Per-dimension expectation overrides (a service-only command refuses people by principal kind). */
  readonly expect?: Partial<
    Record<'crossTenant' | 'revoked' | 'downgraded', { status: number; code: string; reason: string }>
  >;
  rest(f: Fixture): RestCall;
  mcpArgs(f: Fixture): Record<string, unknown>;
}
interface PortalCall {
  readonly operation: string;
  rest(f: Fixture): RestCall;
}

const CONSENT = {
  channel: 'email',
  purpose: 'reminders',
  state: 'granted',
  source: 'staff_recorded',
  consentVersion: 'synthetic-consent-1',
};
const TEMPLATE = {
  templateRef: 'e-harness-other',
  purpose: 'recall',
  channel: 'email',
  body: 'It is time to plan your next visit. Sign in to the patient portal.',
};
const INTAKE_FORM = {
  formRef: 'e-harness-intake',
  title: 'Synthetic harness intake',
  fields: [
    { key: 'agree', label: 'Agree', kind: 'boolean', required: true },
    {
      key: 'nickname',
      label: 'Nickname',
      kind: 'text',
      required: false,
      target: 'demographics.preferredName',
    },
  ],
};
const OTHER_FORM = { ...INTAKE_FORM, formRef: 'e-harness-other-form' };
const PHONE_CONFIG = {
  numbers: ['+1-202-555-0110'],
  timeZone: 'America/New_York',
  hours: [{ weekday: 1, start: '08:00', end: '17:00' }],
  routing: { open: { action: 'ring_queue', queue: 'front_desk' }, closed: { action: 'voicemail' } },
  recording: 'off',
};
const CALL_EVENT = {
  providerCallRef: 'fake-call-harness',
  direction: 'inbound',
  callerNumber: '+1-202-555-0177',
  dialedNumber: '+1-202-555-0110',
  occurredAt: '2031-01-06T15:00:00Z',
  outcome: 'missed',
};
const THREAD = { topic: 'general', locationRef: 'loc-e-harness', body: 'Synthetic harness thread' };
const INTAKE_ANSWERS = { formRef: 'e-harness-intake', formVersion: 1, answers: { agree: true } };

export const COMMANDS: HarnessCommand[] = [
  // E1 portal principals (staff side).
  {
    operation: 'portal.principals.enroll',
    tool: 'portal_principals_enroll',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/portal/principals',
      body: {
        personRef: f.unenrolled,
        contact: { channel: 'email', value: 'e.harness.unenrolled@example.invalid' },
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      personRef: f.unenrolled,
      contact: { channel: 'email', value: 'e.harness.unenrolled@example.invalid' },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'portal.principals.verify',
    tool: 'portal_principals_verify',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/portal/principals/${f.pendingPrincipal}/verify`,
      body: { expectedVersion: 1, method: 'synthetic_attested' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      principalRef: f.pendingPrincipal,
      expectedVersion: 1,
      method: 'synthetic_attested',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'portal.principals.revoke',
    tool: 'portal_principals_revoke',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/portal/principals/${f.activePrincipal}/revoke`,
      body: { expectedVersion: 2, reasonCode: 'patient_request' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      principalRef: f.activePrincipal,
      expectedVersion: 2,
      reasonCode: 'patient_request',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'portal.principals.read',
    tool: 'portal_principals_get',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/portal/principals/${f.activePrincipal}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ principalRef: f.activePrincipal }),
  },
  {
    operation: 'portal.grants.list',
    tool: 'portal_grants_list',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/patients/${f.child}/portal-grants`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: f.child }),
  },
  // E6 consent, opt-out, channel policy, templates, decisions and recall enrollment.
  {
    operation: 'communications.consents.record',
    tool: 'communications_consents_record',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${f.parent}/consents`,
      body: CONSENT,
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ patientRef: f.parent, ...CONSENT, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'communications.consents.optOut',
    tool: 'communications_consents_opt_out',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${f.parent}/opt-outs`,
      body: { channel: 'sms', source: 'staff_recorded' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      patientRef: f.parent,
      channel: 'sms',
      source: 'staff_recorded',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'communications.contacts.verify',
    tool: 'communications_contacts_verify',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${f.parent}/contact-verifications`,
      body: { channel: 'email', value: 'e.harness.parent@example.invalid', method: 'synthetic_attested' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      patientRef: f.parent,
      channel: 'email',
      value: 'e.harness.parent@example.invalid',
      method: 'synthetic_attested',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'communications.consents.list',
    tool: 'communications_consents_list',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/patients/${f.parent}/consents`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: f.parent }),
  },
  {
    operation: 'communications.suppression.preview',
    tool: 'communications_suppression_preview',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/patients/${f.parent}/suppression-preview?purpose=reminder`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: f.parent, purpose: 'reminder' }),
  },
  {
    operation: 'communications.channelPolicies.define',
    tool: 'communications_channel_policies_define',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/communications/channel-policies',
      body: { purpose: 'cancellation', channel: 'none' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({ purpose: 'cancellation', channel: 'none', idempotencyKey: randomUUID() }),
  },
  {
    operation: 'communications.channelPolicies.list',
    tool: 'communications_channel_policies_list',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noScopes',
    rest: () => ({ method: 'GET', url: '/v1/communications/channel-policies', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'communications.templates.define',
    tool: 'communications_templates_define',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/communications/templates',
      body: TEMPLATE,
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({ ...TEMPLATE, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'communications.templates.withdraw',
    tool: 'communications_templates_withdraw',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/communications/templates/e-harness-alpha/withdraw',
      body: { expectedVersion: 1 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: () => ({ templateRef: 'e-harness-alpha', expectedVersion: 1, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'communications.decisions.read',
    tool: 'communications_decisions_get',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/communications/decisions/${f.decision}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ decisionRef: f.decision }),
  },
  {
    operation: 'communications.recall.enroll',
    tool: 'communications_recall_enroll',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/communications/recall-enrollments',
      body: { category: 'e-harness-recall', asOf: '2031-01-01T12:00:00Z', patientRefs: [f.parent] },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      category: 'e-harness-recall',
      asOf: '2031-01-01T12:00:00Z',
      patientRefs: [f.parent],
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'communications.recall.enrollments',
    tool: 'communications_recall_enrollments',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: () => ({
      method: 'GET',
      url: '/v1/communications/recall-enrollments?category=e-harness-recall',
      keyed: false,
      status: 200,
    }),
    mcpArgs: () => ({ category: 'e-harness-recall' }),
  },
  // E7 delivery: worklist, read, staff resolution and receipt ingestion (service principal only).
  {
    operation: 'communications.deliveries.worklist',
    tool: 'communications_deliveries_worklist',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noScopes',
    rest: () => ({ method: 'GET', url: '/v1/communications/deliveries/worklist', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'communications.deliveries.read',
    tool: 'communications_deliveries_get',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/communications/deliveries/${f.message}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ messageRef: f.message }),
  },
  {
    operation: 'communications.deliveries.resolve',
    tool: 'communications_deliveries_resolve',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/communications/deliveries/${f.message}/resolve`,
      body: { expectedVersion: 1, action: 'abandon' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      messageRef: f.message,
      expectedVersion: 1,
      action: 'abandon',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'communications.receipts.record',
    tool: 'communications_receipts_record',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    // Receipts come from the provider-integration service principal only: people are refused by kind.
    expect: {
      crossTenant: { status: 403, code: 'forbidden', reason: 'principal_kind_denied' },
      downgraded: { status: 403, code: 'forbidden', reason: 'principal_kind_denied' },
    },
    rest: (f) => ({
      method: 'POST',
      url: '/v1/communications/receipts',
      body: {
        providerRef: f.providerRef,
        providerEventId: 'e-harness-evt',
        state: 'delivered',
        occurredAt: '2030-01-01T00:00:00Z',
      },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      providerRef: f.providerRef,
      providerEventId: 'e-harness-evt',
      state: 'delivered',
      occurredAt: '2030-01-01T00:00:00Z',
      idempotencyKey: randomUUID(),
    }),
  },
  // E4 intake forms.
  {
    operation: 'intake.forms.publish',
    tool: 'intake_forms_publish',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({ method: 'POST', url: '/v1/intake/forms', body: OTHER_FORM, keyed: true, status: 201 }),
    mcpArgs: () => ({ ...OTHER_FORM, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'intake.forms.retire',
    tool: 'intake_forms_retire',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/intake/forms/e-harness-intake/retire',
      body: { expectedVersion: 1 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: () => ({ formRef: 'e-harness-intake', expectedVersion: 1, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'intake.forms.list',
    tool: 'intake_forms_list',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noScopes',
    rest: () => ({ method: 'GET', url: '/v1/intake/forms', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'intake.submissions.submit',
    tool: 'intake_submissions_submit',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${f.parent}/intake-submissions`,
      body: INTAKE_ANSWERS,
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ patientRef: f.parent, ...INTAKE_ANSWERS, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'intake.submissions.list',
    tool: 'intake_submissions_list',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/patients/${f.parent}/intake-submissions`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: f.parent }),
  },
  {
    operation: 'intake.submissions.read',
    tool: 'intake_submissions_get',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/intake/submissions/${f.submission}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ submissionRef: f.submission }),
  },
  {
    operation: 'intake.reviews.worklist',
    tool: 'intake_reviews_worklist',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noScopes',
    rest: () => ({ method: 'GET', url: '/v1/intake/reviews/worklist', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'intake.reviews.read',
    tool: 'intake_reviews_get',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/intake/reviews/${f.review}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ reviewRef: f.review }),
  },
  {
    operation: 'intake.reviews.resolve',
    tool: 'intake_reviews_resolve',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/intake/reviews/${f.review}/resolve`,
      body: { decision: 'reject', expectedVersion: 1, reasonCode: 'duplicate' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      reviewRef: f.review,
      decision: 'reject',
      expectedVersion: 1,
      reasonCode: 'duplicate',
      idempotencyKey: randomUUID(),
    }),
  },
  // E5 secure messaging (a patient-read scope alone never opens a thread: downgraded = readOnly).
  {
    operation: 'messaging.threads.open',
    tool: 'messaging_threads_open',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${f.parent}/message-threads`,
      body: THREAD,
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ patientRef: f.parent, ...THREAD, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'messaging.threads.worklist',
    tool: 'messaging_threads_worklist',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'readOnly',
    rest: () => ({ method: 'GET', url: '/v1/messaging/threads/worklist', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'messaging.threads.list',
    tool: 'messaging_threads_list',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'GET',
      url: '/v1/messaging/threads?filter=needs_reply',
      keyed: false,
      status: 200,
    }),
    mcpArgs: () => ({ filter: 'needs_reply' }),
  },
  {
    operation: 'messaging.replyPolicy.set',
    tool: 'messaging_reply_policy_set',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/messaging/reply-policies',
      body: { queue: 'clinical_team', replyDueBusinessDays: 2 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: () => ({ queue: 'clinical_team', replyDueBusinessDays: 2, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'messaging.threads.read',
    tool: 'messaging_threads_get',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({ method: 'GET', url: `/v1/messaging/threads/${f.thread}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ threadRef: f.thread }),
  },
  {
    operation: 'messaging.messages.post',
    tool: 'messaging_messages_post',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/messaging/threads/${f.thread}/messages`,
      body: { body: 'Synthetic harness reply' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ threadRef: f.thread, body: 'Synthetic harness reply', idempotencyKey: randomUUID() }),
  },
  {
    operation: 'messaging.threads.close',
    tool: 'messaging_threads_close',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/messaging/threads/${f.thread}/close`,
      body: { expectedVersion: 1, reasonCode: 'resolved' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      threadRef: f.thread,
      expectedVersion: 1,
      reasonCode: 'resolved',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'messaging.threads.assign',
    tool: 'messaging_threads_assign',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/messaging/threads/${f.thread}/assign`,
      body: { expectedVersion: 1, assigneeRef: null },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      threadRef: f.thread,
      expectedVersion: 1,
      assigneeRef: null,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'messaging.threads.hold',
    tool: 'messaging_threads_legal_hold',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/messaging/threads/${f.thread}/legal-hold`,
      body: { expectedVersion: 1, hold: false },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({ threadRef: f.thread, expectedVersion: 1, hold: false, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'messaging.retention.evaluate',
    tool: 'messaging_retention_evaluate',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/messaging/threads/${f.thread}/retention`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ threadRef: f.thread }),
  },
  // E8 telephony (fake adapter; call events from the telephony integration principal only).
  {
    operation: 'telephony.config.define',
    tool: 'telephony_config_define',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/telephony/config',
      body: PHONE_CONFIG,
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({ ...PHONE_CONFIG, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'telephony.config.read',
    tool: 'telephony_config_get',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noScopes',
    rest: () => ({ method: 'GET', url: '/v1/telephony/config', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'telephony.handling.resolve',
    tool: 'telephony_handling_resolve',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noScopes',
    rest: () => ({
      method: 'GET',
      url: `/v1/telephony/handling?at=${encodeURIComponent('2031-01-06T15:00:00Z')}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: () => ({ at: '2031-01-06T15:00:00Z' }),
  },
  {
    operation: 'telephony.calls.record',
    tool: 'telephony_calls_record',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    // Call events come from the telephony integration principal only: people are refused by kind.
    expect: {
      crossTenant: { status: 403, code: 'forbidden', reason: 'principal_kind_denied' },
      downgraded: { status: 403, code: 'forbidden', reason: 'principal_kind_denied' },
    },
    rest: () => ({ method: 'POST', url: '/v1/telephony/calls', body: CALL_EVENT, keyed: true, status: 201 }),
    mcpArgs: () => ({ ...CALL_EVENT, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'telephony.calls.list',
    tool: 'telephony_calls_list',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noScopes',
    rest: () => ({ method: 'GET', url: '/v1/telephony/calls', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'telephony.calls.read',
    tool: 'telephony_calls_get',
    crossTenant: 'not_found',
    downgradedTo: 'noScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/telephony/calls/${f.call}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ callRef: f.call }),
  },
  {
    operation: 'telephony.calls.link',
    tool: 'telephony_calls_link',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/telephony/calls/${f.call}/link`,
      body: { patientRef: f.parent, reasonCode: 'caller_confirmed_identity' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      callRef: f.call,
      patientRef: f.parent,
      reasonCode: 'caller_confirmed_identity',
      idempotencyKey: randomUUID(),
    }),
  },
  // E9 export (tenant-wide administrators; beta exports only its own rows).
  {
    operation: 'communications.export',
    tool: 'communications_export',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'readOnly',
    rest: () => ({ method: 'GET', url: '/v1/communications/export', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
];

/** Every portal-audience route (E1-E6, the S15 seam). */
export const PORTAL_CALLS: PortalCall[] = [
  {
    operation: 'portal.session.read',
    rest: () => ({ method: 'GET', url: '/portal/v1/session', keyed: false, status: 200 }),
  },
  {
    operation: 'portal.views.read',
    rest: (f) => ({
      method: 'GET',
      url: `/portal/v1/patients/${f.child}/views/demographics`,
      keyed: false,
      status: 200,
    }),
  },
  // Closeout B portal documents (release ref unknown here: credentials are refused before any lookup).
  {
    operation: 'portal.documents.grantRead',
    rest: (f) => ({
      method: 'POST',
      url: `/portal/v1/patients/${f.child}/documents/00000000-0000-4000-8000-0000000000f2/read-grants`,
      body: {},
      keyed: false,
      status: 201,
    }),
  },
  {
    operation: 'portal.documents.content',
    rest: (f) => ({
      method: 'GET',
      url: `/portal/v1/patients/${f.child}/documents/00000000-0000-4000-8000-0000000000f2/content`,
      keyed: false,
      status: 200,
    }),
  },
  // Closeout C portal statements (release ref unknown here: credentials are refused before any lookup).
  {
    operation: 'portal.statements.read',
    rest: (f) => ({
      method: 'GET',
      url: `/portal/v1/patients/${f.child}/statements/00000000-0000-4000-8000-0000000000f3`,
      keyed: false,
      status: 200,
    }),
  },
  {
    operation: 'portal.requests.submit',
    rest: (f) => ({
      method: 'POST',
      url: `/portal/v1/patients/${f.child}/appointment-requests`,
      body: { locationRef: 'loc-e-harness', flexibility: 'mornings', contactConsent: 'granted' },
      keyed: true,
      status: 201,
    }),
  },
  {
    operation: 'portal.consents.record',
    rest: (f) => ({
      method: 'POST',
      url: `/portal/v1/patients/${f.child}/consents`,
      body: {
        channel: 'email',
        purpose: 'reminders',
        state: 'granted',
        consentVersion: 'synthetic-consent-1',
      },
      keyed: true,
      status: 201,
    }),
  },
  {
    operation: 'portal.views.describe',
    rest: () => ({ method: 'GET', url: '/portal/v1/views/appointments', keyed: false, status: 200 }),
  },
  {
    operation: 'portal.offers.respond',
    rest: (f) => ({
      method: 'POST',
      url: `/portal/v1/patients/${f.child}/waitlist-offers/00000000-0000-4000-8000-0000000000f1/respond`,
      body: { expectedVersion: 1, outcome: 'declined' },
      keyed: true,
      status: 200,
    }),
  },
  {
    operation: 'portal.forms.describe',
    rest: () => ({ method: 'GET', url: '/portal/v1/forms/e-harness-intake', keyed: false, status: 200 }),
  },
  {
    operation: 'portal.forms.submit',
    rest: (f) => ({
      method: 'POST',
      url: `/portal/v1/patients/${f.child}/intake-submissions`,
      body: INTAKE_ANSWERS,
      keyed: true,
      status: 201,
    }),
  },
  {
    operation: 'portal.threads.open',
    rest: (f) => ({
      method: 'POST',
      url: `/portal/v1/patients/${f.child}/message-threads`,
      body: THREAD,
      keyed: true,
      status: 201,
    }),
  },
  {
    operation: 'portal.threads.read',
    rest: (f) => ({
      method: 'GET',
      url: `/portal/v1/patients/${f.parent}/message-threads/${f.thread}`,
      keyed: false,
      status: 200,
    }),
  },
  {
    operation: 'portal.threads.post',
    rest: (f) => ({
      method: 'POST',
      url: `/portal/v1/patients/${f.parent}/message-threads/${f.thread}/messages`,
      body: { body: 'Synthetic harness portal message' },
      keyed: true,
      status: 201,
    }),
  },
];

beforeAll(async () => {
  db = await openTestDatabase('engagement_harness');
  h = await openEngagementHarness(db, { mcp: false });
  // Its own MCP server, so the revoked member (absent from the shared harness) has an MCP token too.
  const server = buildMcpServer({
    env: 'synthetic-test',
    identity: { ...h.issuer.verifierConfig, audience: MCP_AUDIENCE },
    restAudience: 'urn:cuspatlas:api:synthetic',
    membership: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    tenantTransactions: createTenantTransactionRunner(db.app),
    logger: { stream: { write: (l: string) => h.logLines.push(l) } },
  });
  closeMcp = () => server.close();
  mcpUrl = (await server.listen({ host: '127.0.0.1', port: 0 })).url;
  // USER_A4 keeps only read scopes (downgraded), USER_A5 has no patient or E scope at all.
  rest.owner = h.tokens.a1 as string;
  rest.revoked = await h.issuer.issue({ sub: USER_A2, tid: T_ALPHA });
  rest.readOnly = h.tokens.a4 as string;
  rest.noScopes = h.tokens.a5 as string;
  rest.crossTenant = h.tokens.b1 as string;
  for (const [who, sub, tid] of [
    ['owner', USER_A1, T_ALPHA],
    ['revoked', USER_A2, T_ALPHA],
    ['readOnly', USER_A4, T_ALPHA],
    ['noScopes', USER_A5, T_ALPHA],
    ['crossTenant', USER_B1, T_BETA],
  ] as const) {
    mcpTokens[who] = await h.issuer.issue({ sub, tid, audience: MCP_AUDIENCE });
  }
  expect(E_ALL.length).toBeGreaterThan(0);
  const parent = await h.person('Synthetic Harness Parent', [email('e.harness.parent')]);
  const child = await h.person('Synthetic Harness Child', [], {
    birthDate: { known: true, value: '2016-05-05', precision: 'day' },
  });
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${child}/relationships`, {
      counterpartyRef: parent,
      kind: 'guardian',
      scopes: ['demographics', 'scheduling', 'consent'],
    }),
    201,
  );
  const activePerson = await h.person(`Synthetic Harness Active ${MARKER}`, [email('e.harness.active')]);
  const pendingPerson = await h.person('Synthetic Harness Pending', [email('e.harness.pending')]);
  const unenrolled = await h.person('Synthetic Harness Unenrolled', [email('e.harness.unenrolled')]);
  const revokedPerson = await h.person('Synthetic Harness Revoked', [email('e.harness.revoked')]);
  const parentPrincipal = await h.enroll(parent, {
    channel: 'email',
    value: 'e.harness.parent@example.invalid',
  });
  const activePrincipal = await h.enroll(activePerson, {
    channel: 'email',
    value: 'e.harness.active@example.invalid',
  });
  const pendingPrincipal = await h.enroll(
    pendingPerson,
    { channel: 'email', value: 'e.harness.pending@example.invalid' },
    false,
  );
  const revokedPrincipal = await h.enroll(revokedPerson, {
    channel: 'email',
    value: 'e.harness.revoked@example.invalid',
  });
  h.ok(
    await h.call('a1', 'POST', `/v1/portal/principals/${revokedPrincipal}/revoke`, {
      expectedVersion: 2,
      reasonCode: 'patient_request',
    }),
  );
  // E6 fixtures: an alpha location and booking (its intent carries an E6 decision), an approved
  // alpha template and a recall policy with one attended visit.
  const loc = await seedLocation(h, 'loc-e-harness');
  const booked = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef: parent,
      locationRef: loc.locationRef,
      startsAt: '2030-02-04T14:00:00Z',
      endsAt: '2030-02-04T15:00:00Z',
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data.appointmentRef;
  h.ok(
    await h.call('a1', 'POST', `/v1/scheduling/appointments/${booked}/attendance`, { kind: 'arrived' }),
    201,
  );
  const decision = (
    await db.admin.query(
      `SELECT suppression_decision_ref AS d FROM cuspatlas.notification_intents WHERE subject_id = $1 AND purpose = 'reminder'`,
      [booked],
    )
  ).rows[0].d as string;
  h.ok(
    await h.call('a1', 'POST', '/v1/communications/templates', {
      ...TEMPLATE,
      templateRef: 'e-harness-alpha',
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/scheduling/recall/policies', {
      category: 'e-harness-recall',
      intervalMonths: 6,
      basis: 'attended_visit',
    }),
    201,
  );
  // E7 fixtures: a channel policy, a consenting patient and one message sent through the fake provider.
  h.ok(
    await h.call('a1', 'POST', '/v1/communications/templates', {
      ...TEMPLATE,
      templateRef: 'e-harness-cancel',
      purpose: 'cancellation',
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/communications/channel-policies', {
      purpose: 'cancellation',
      channel: 'email',
      templateRef: 'e-harness-cancel',
      quietHours: { start: '23:00', end: '05:00' },
    }),
    201,
  );
  h.ok(await h.call('a1', 'POST', `/v1/patients/${parent}/consents`, CONSENT), 201);
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${parent}/contact-verifications`, {
      channel: 'email',
      value: 'e.harness.parent@example.invalid',
      method: 'synthetic_attested',
    }),
    201,
  );
  const toCancel = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef: parent,
      locationRef: loc.locationRef,
      startsAt: '2030-02-11T14:00:00Z',
      endsAt: '2030-02-11T15:00:00Z',
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data.appointmentRef;
  h.ok(
    await h.call('a1', 'POST', `/v1/scheduling/appointments/${toCancel}/cancel`, {
      expectedVersion: 1,
      reasonCode: 'patient_request',
    }),
  );
  const port = new FakeMessaging();
  await createOutboundSender({
    workerPrincipalId: SVC_W1,
    withTenantTransaction: createTenantTransactionRunner(db.app),
    authorize: createAuthorize(createMembershipSource(db.app)),
    memberships: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    port,
    matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
    clock: () => new Date('2030-07-10T17:00:00Z'),
  }).runOnce(T_ALPHA);
  const sent = (
    await db.admin.query(
      `SELECT m.id, m.provider_ref FROM cuspatlas.outbound_messages m JOIN cuspatlas.notification_intents i
       ON i.id = m.intent_id WHERE i.subject_id = $1 AND i.purpose = 'cancellation'`,
      [toCancel],
    )
  ).rows[0];
  expect(sent?.provider_ref).toMatch(/^fake-msg-/);
  // E4 fixtures: a published form, one staff-entered submission and its demographics review item.
  h.ok(await h.call('a1', 'POST', '/v1/intake/forms', INTAKE_FORM), 201);
  const submission = h.ok<{ data: { submissionRef: string } }>(
    await h.call('a1', 'POST', `/v1/patients/${parent}/intake-submissions`, {
      ...INTAKE_ANSWERS,
      answers: { agree: true, nickname: 'Harness' },
    }),
    201,
  ).data.submissionRef;
  const review = (
    await db.admin.query('SELECT id FROM cuspatlas.intake_review_items WHERE submission_id = $1', [
      submission,
    ])
  ).rows[0].id as string;
  // E8 fixtures: a configuration in each tenant and one call from the fake adapter in alpha.
  h.ok(await h.call('a1', 'POST', '/v1/telephony/config', PHONE_CONFIG), 201);
  h.ok(await h.call('b1', 'POST', '/v1/telephony/config', PHONE_CONFIG), 201);
  const call = h.ok<{ data: { callRef: string } }>(
    await h.call(await h.issuer.issue({ sub: SVC_T1, tid: T_ALPHA }), 'POST', '/v1/telephony/calls', {
      ...CALL_EVENT,
      providerCallRef: 'fake-call-harness-fixture',
      occurredAt: new Date().toISOString(),
    }),
    201,
  ).data.callRef;
  // E5 fixture: one staff-opened thread to the parent.
  const thread = h.ok<{ data: { threadRef: string } }>(
    await h.call('a1', 'POST', `/v1/patients/${parent}/message-threads`, THREAD),
    201,
  ).data.threadRef;
  fixture = {
    call,
    thread,
    submission,
    review,
    message: sent.id as string,
    providerRef: sent.provider_ref as string,
    decision,
    parent,
    child,
    activePerson,
    unenrolled,
    parentPrincipal,
    activePrincipal,
    pendingPrincipal,
    revokedPrincipal,
  };
});

afterAll(async () => {
  await closeMcp?.();
  await h?.close();
  await db?.close();
});

interface Outcome {
  readonly status: number;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly raw: string;
}

async function viaRest(token: string, call: RestCall): Promise<Outcome> {
  const res = await h.app.inject({
    method: call.method,
    url: call.url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(call.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(call.keyed ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(call.body === undefined ? {} : { payload: JSON.stringify(call.body) }),
  });
  const body = res.json() as Record<string, unknown>;
  return {
    status: res.statusCode,
    code: typeof body.code === 'string' ? body.code : null,
    correlationId: res.headers['x-correlation-id'] as string,
    raw: `${res.body}${JSON.stringify(res.headers)}`,
  };
}

async function viaMcp(
  token: string,
  tool: string,
  args: Record<string, unknown>,
  ok: number,
): Promise<Outcome> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'synthetic-e-harness', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    const body = result.structuredContent as Record<string, unknown>;
    const refused = result.isError === true;
    return {
      status: refused ? REFUSAL_HTTP_STATUS[body.code as RefusalCode] : ok,
      code: refused ? (body.code as string) : null,
      correlationId: typeof body.correlationId === 'string' ? body.correlationId : null,
      raw: JSON.stringify(result),
    };
  } catch (e) {
    const err = e as { code?: unknown; message?: string };
    if (typeof err.code !== 'number') throw e;
    const message = String(err.message);
    const start = message.indexOf('{');
    const body = start >= 0 ? (JSON.parse(message.slice(start)) as Record<string, unknown>) : null;
    return {
      status: err.code,
      code: body && typeof body.code === 'string' ? body.code : null,
      correlationId: body && typeof body.correlationId === 'string' ? body.correlationId : null,
      raw: message,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function attemptReasons(correlationId: string | null): Promise<string[]> {
  if (correlationId === null) return [];
  const { rows } = await db.admin.query(
    'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
    [correlationId],
  );
  return rows.map((r) => r.reason_code);
}

/** Snapshot of every E write surface plus the shared audit/outbox/idempotency tables. */
async function state(): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await db.admin.query(sql)).rows);
  const tables = (
    await db.admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'cuspatlas'
       AND table_name IN ('portal_principals', 'principals', 'appointment_requests', 'communication_consents',
         'suppression_decisions', 'channel_policies', 'message_templates', 'outbound_messages', 'delivery_attempts',
         'message_receipts', 'recall_enrollments', 'contact_verifications', 'intake_form_versions', 'intake_submissions', 'intake_submission_consents', 'intake_review_items', 'message_threads', 'thread_messages', 'telephony_configs', 'call_events', 'call_links', 'audit_events', 'outbox_events', 'command_idempotency')
       ORDER BY table_name`,
    )
  ).rows.map((r) => r.table_name as string);
  const parts: string[] = [];
  for (const t of tables) parts.push(await q(`SELECT count(*)::int AS n FROM cuspatlas.${t}`));
  parts.push(await q('SELECT coalesce(sum(version), 0)::int AS v FROM cuspatlas.portal_principals'));
  return parts.join('|');
}

type Dimension = 'crossTenant' | 'revoked' | 'downgraded';
const DIMENSIONS: Dimension[] = ['crossTenant', 'revoked', 'downgraded'];

function expected(cmd: HarnessCommand, d: Dimension) {
  const override = cmd.expect?.[d];
  if (override) return override;
  if (d === 'revoked') return { status: 403, code: 'forbidden', reason: 'membership_inactive' };
  if (d === 'downgraded') return { status: 403, code: 'forbidden', reason: 'scope_missing' };
  if (cmd.crossTenant === 'not_found')
    return { status: 404, code: 'not_found', reason: 'resource_hidden_or_missing' };
  return { status: cmd.rest(fixture).status, code: null, reason: null };
}

describe('E negative harness: every E staff command, every dimension, REST and MCP', () => {
  const cases = COMMANDS.flatMap((cmd) => DIMENSIONS.map((d) => [cmd.operation, d, cmd] as const));
  it.each(cases)('%s %s', async (_op, d, cmd) => {
    const want = expected(cmd, d);
    const who = d === 'downgraded' ? cmd.downgradedTo : d;
    const before = await state();
    const r = await viaRest(rest[who] as string, cmd.rest(fixture));
    const m = await viaMcp(
      mcpTokens[who] as string,
      cmd.tool,
      cmd.mcpArgs(fixture),
      cmd.rest(fixture).status,
    );
    for (const [surface, o] of [
      ['REST', r],
      ['MCP', m],
    ] as const) {
      expect([surface, o.status, o.code]).toStrictEqual([surface, want.status, want.code]);
      if (want.code !== null) expect(o.raw).not.toContain(MARKER);
      if (want.reason !== null) {
        expect([surface, await attemptReasons(o.correlationId)]).toStrictEqual([surface, [want.reason]]);
      }
    }
    if (want.code !== null) expect(await state()).toBe(before);
    if (want.code === null && cmd.crossTenant === 'tenant_own_data') {
      // Computed over the caller's own tenant: no alpha fixture reference crosses the boundary.
      for (const o of [r, m]) for (const ref of Object.values(fixture)) expect(o.raw).not.toContain(ref);
    }
  });

  it('no caller-supplied tenant is accepted by any E body or tool', async () => {
    for (const cmd of COMMANDS) {
      const call = cmd.rest(fixture);
      if (call.body === undefined) continue;
      // The receipts command is authorized for its integration principal; people never reach validation.
      const integration =
        cmd.operation === 'communications.receipts.record'
          ? SVC_R1
          : cmd.operation === 'telephony.calls.record'
            ? SVC_T1
            : null;
      const service = integration !== null;
      const restToken = service
        ? await h.issuer.issue({ sub: integration, tid: T_ALPHA })
        : (rest.owner as string);
      const mcpToken = service
        ? await h.issuer.issue({ sub: integration, tid: T_ALPHA, audience: MCP_AUDIENCE })
        : (mcpTokens.owner as string);
      const r = await viaRest(restToken, {
        ...call,
        body: { ...(call.body as object), tenantId: T_BETA },
      });
      expect([cmd.operation, r.status]).toStrictEqual([cmd.operation, 400]);
      const m = await viaMcp(mcpToken, cmd.tool, { ...cmd.mcpArgs(fixture), tenantId: T_BETA }, 200);
      expect([cmd.operation, m.code]).toStrictEqual([cmd.operation, 'invalid_request']);
    }
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });
});

describe('E portal negatives: each portal route refuses every non-portal or dead credential', () => {
  it.each(PORTAL_CALLS.map((c) => [c.operation, c] as const))('%s', async (_op, c) => {
    const call = c.rest(fixture);
    const before = await state();
    const credentials: [string, string, number, string | null][] = [
      ['staff token', rest.owner as string, 401, 'token_invalid'],
      ['MCP token', mcpTokens.owner as string, 401, 'token_invalid'],
      [
        'revoked principal',
        await h.portalToken(fixture.revokedPrincipal as string),
        403,
        'membership_inactive',
      ],
      [
        'pending principal',
        await h.portalToken(fixture.pendingPrincipal as string),
        403,
        'portal_contact_unverified',
      ],
      [
        'another tenant',
        await h.issuer.issue({
          sub: fixture.parentPrincipal as string,
          tid: T_BETA,
          audience: PORTAL_AUDIENCE,
        }),
        403,
        'membership_inactive',
      ],
      [
        'staff subject on the portal audience',
        await h.issuer.issue({ sub: USER_A1, tid: T_ALPHA, audience: PORTAL_AUDIENCE }),
        403,
        'principal_kind_denied',
      ],
    ];
    for (const [label, token, status, reason] of credentials) {
      const o = await viaRest(token, call);
      expect([label, o.status]).toStrictEqual([label, status]);
      expect([label, await attemptReasons(o.correlationId)]).toStrictEqual([label, reason ? [reason] : []]);
      expect(o.raw).not.toContain(MARKER);
    }
    if (call.keyed) expect(await state()).toBe(before);
  });

  it('every staff E route and MCP refuse a portal token (401) and write nothing', async () => {
    const token = await h.portalToken(fixture.parentPrincipal as string);
    const before = await state();
    for (const cmd of COMMANDS) {
      const o = await viaRest(token, cmd.rest(fixture));
      expect([cmd.operation, o.status, o.code]).toStrictEqual([cmd.operation, 401, 'unauthenticated']);
      const m = await viaMcp(token, cmd.tool, cmd.mcpArgs(fixture), 200);
      expect([cmd.operation, m.status]).toStrictEqual([cmd.operation, 401]);
    }
    expect(await state()).toBe(before);
  });
});
