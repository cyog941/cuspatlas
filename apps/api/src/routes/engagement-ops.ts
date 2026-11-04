import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, EngagementService } from '@cuspatlas/domain';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the workstream E staff operations (E1-E7): the REST route contract, the MCP tool
 * name and the call into the shared engagement service. REST registration, the MCP tool list, the
 * drift checks and the E negative harness are derived from it, so a staff operation cannot exist on
 * one surface only. Portal-audience operations live in portal.ts and are never MCP tools.
 */
export interface EngagementOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the engagement.schema.json definition of the query object. */
  readonly query?: string;
  invoke(svc: EngagementService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const E = (name: string) => `engagement:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['400', '401', '403', '404', '503'] as const;

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const param = (input: OpInput, name: string) => input.params[name] ?? '';
const data = async (p: Promise<unknown>) => ({ data: await p });
const PRINCIPAL = '/v1/portal/principals/{principalRef}';

export const ENGAGEMENT_OPS: readonly EngagementOp[] = [
  // E1 portal principals (staff side) and the S5 grant projection.
  {
    method: 'post',
    path: '/v1/portal/principals',
    operationId: 'portal.principals.enroll',
    protected: true,
    requestBody: E('PortalEnroll'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'portal_principals_enroll',
    description:
      'Enroll a portal principal bound to exactly one person record, invited through a contact already on that record. A contact shared with another identity is refused (shared_contact_ambiguous). The principal is pending until verified; proofing level unverified-synthetic (E-S3 open).',
    invoke: (svc, actor, i) => svc.enrollPortalPrincipal(actor, env('portal.principals.enroll', i)),
  },
  {
    method: 'post',
    path: `${PRINCIPAL}/verify`,
    operationId: 'portal.principals.verify',
    protected: true,
    requestBody: E('PortalVerify'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'portal_principals_verify',
    description:
      'Record the (synthetic, staff-attested) contact verification of a pending portal principal; it becomes active. Human staff only.',
    invoke: (svc, actor, i) =>
      svc.verifyPortalPrincipal(actor, param(i, 'principalRef'), env('portal.principals.verify', i)),
  },
  {
    method: 'post',
    path: `${PRINCIPAL}/revoke`,
    operationId: 'portal.principals.revoke',
    protected: true,
    requestBody: E('PortalRevoke'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'portal_principals_revoke',
    description: 'Revoke a portal principal; its existing sessions are denied at their next request. Final.',
    invoke: (svc, actor, i) =>
      svc.revokePortalPrincipal(actor, param(i, 'principalRef'), env('portal.principals.revoke', i)),
  },
  {
    method: 'get',
    path: PRINCIPAL,
    operationId: 'portal.principals.read',
    protected: true,
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['401', '403', '404', '503'],
    tool: 'portal_principals_get',
    description:
      'One portal principal: person binding, state, proofing level and contact channel (never the value).',
    invoke: (svc, actor, i) => data(svc.readPortalPrincipal(actor, param(i, 'principalRef'))),
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/portal-grants',
    operationId: 'portal.grants.list',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: READ,
    tool: 'portal_grants_list',
    description:
      'Portal grants of a patient: its S5 relationships projected with their current status (grantRef = relationshipRef), plus the portal principals of the people involved.',
    invoke: (svc, actor, i) => data(svc.listPortalGrants(actor, param(i, 'patientRef'), i.body)),
  },
  // E6 consent, opt-out, channel policy, templates, decisions and recall enrollment.
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/consents',
    operationId: 'communications.consents.record',
    protected: true,
    requestBody: E('ConsentRecordInput'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_consents_record',
    description:
      'Record a consent fact (granted or denied) for one channel and purpose with its source and consent version. Append-only; the latest fact wins.',
    invoke: (svc, actor, i) =>
      svc.recordConsent(actor, param(i, 'patientRef'), env('communications.consents.record', i)),
  },
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/opt-outs',
    operationId: 'communications.consents.optOut',
    protected: true,
    requestBody: E('OptOutInput'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_consents_opt_out',
    description:
      'Record an opt-out of every purpose on one channel. It applies before any message is sent, including messages queued earlier.',
    invoke: (svc, actor, i) =>
      svc.recordOptOut(actor, param(i, 'patientRef'), env('communications.consents.optOut', i)),
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/consents',
    operationId: 'communications.consents.list',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: READ,
    tool: 'communications_consents_list',
    description:
      'Consent and opt-out facts of a patient with provenance, and the effective state per channel and purpose.',
    invoke: (svc, actor, i) => data(svc.listConsents(actor, param(i, 'patientRef'), i.body)),
  },
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/contact-verifications',
    operationId: 'communications.contacts.verify',
    protected: true,
    requestBody: E('ContactVerify'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_contacts_verify',
    description:
      'Record a staff-attested verification of a contact point on the record (only its digest is stored). E7 addresses only verified contact points; an unverified channel is suppressed no_verified_channel. Human staff only.',
    invoke: (svc, actor, i) =>
      svc.verifyContact(actor, param(i, 'patientRef'), env('communications.contacts.verify', i)),
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/suppression-preview',
    operationId: 'communications.suppression.preview',
    protected: true,
    query: 'SuppressionPreviewQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    tool: 'communications_suppression_preview',
    description:
      'What E6 would decide (recorded false) for a patient, intent purpose and channel at an instant, including quiet hours. Consumers call this instead of evaluating consent.',
    invoke: (svc, actor, i) => data(svc.previewSuppression(actor, param(i, 'patientRef'), i.body)),
  },
  {
    method: 'post',
    path: '/v1/communications/channel-policies',
    operationId: 'communications.channelPolicies.define',
    protected: true,
    requestBody: E('ChannelPolicyDefine'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_channel_policies_define',
    description:
      'Define the next version of the channel policy for one intent purpose. Default none; a live channel needs an approved template and explicit quiet hours. Human administrators only.',
    invoke: (svc, actor, i) =>
      svc.defineChannelPolicy(actor, env('communications.channelPolicies.define', i)),
  },
  {
    method: 'get',
    path: '/v1/communications/channel-policies',
    operationId: 'communications.channelPolicies.list',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '503'],
    tool: 'communications_channel_policies_list',
    description:
      'Current channel policy per intent purpose (none by default), with template and quiet hours.',
    invoke: (svc, actor, i) => data(svc.listChannelPolicies(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/communications/templates',
    operationId: 'communications.templates.define',
    protected: true,
    requestBody: E('TemplateDefine'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_templates_define',
    description:
      'Approve the next version of a notice-only template (no placeholders, no clinical content). Human administrators only.',
    invoke: (svc, actor, i) => svc.defineTemplate(actor, env('communications.templates.define', i)),
  },
  {
    method: 'post',
    path: '/v1/communications/templates/{templateRef}/withdraw',
    operationId: 'communications.templates.withdraw',
    protected: true,
    requestBody: E('TemplateWithdraw'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_templates_withdraw',
    description:
      'Withdraw the current template version; queued messages using it are suppressed (template_withdrawn).',
    invoke: (svc, actor, i) =>
      svc.withdrawTemplate(actor, param(i, 'templateRef'), env('communications.templates.withdraw', i)),
  },
  {
    method: 'get',
    path: '/v1/communications/decisions/{decisionRef}',
    operationId: 'communications.decisions.read',
    protected: true,
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['401', '403', '404', '503'],
    tool: 'communications_decisions_get',
    description:
      'One recorded suppression decision: stage, outcome, the single-vocabulary reason, consent and policy used.',
    invoke: (svc, actor, i) => data(svc.readDecision(actor, param(i, 'decisionRef'))),
  },
  {
    method: 'post',
    path: '/v1/communications/recall-enrollments',
    operationId: 'communications.recall.enroll',
    protected: true,
    requestBody: E('RecallEnroll'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_recall_enroll',
    description:
      'Enroll S16 due items of a recall category (never re-derived); S16 exclusions are reported with their reason. Sends nothing.',
    invoke: (svc, actor, i) => svc.enrollRecallCohort(actor, env('communications.recall.enroll', i)),
  },
  {
    method: 'get',
    path: '/v1/communications/recall-enrollments',
    operationId: 'communications.recall.enrollments',
    protected: true,
    query: 'RecallEnrollmentsQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: READ,
    tool: 'communications_recall_enrollments',
    description:
      'Recall enrollments of a category with their S16 due item (policy version, due date, qualifying event).',
    invoke: (svc, actor, i) => data(svc.listRecallEnrollments(actor, i.body)),
  },
  // E7 delivery: worklist, read, staff resolution and provider receipts (fake provider only).
  {
    method: 'get',
    path: '/v1/communications/deliveries/worklist',
    operationId: 'communications.deliveries.worklist',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: 'scheduling:WorkItemList' },
    refusals: ['400', '401', '403', '503'],
    tool: 'communications_deliveries_worklist',
    description:
      'Failed and unknown deliveries as owned work items (reason, explanation, evidence, queue, due time, next action). Unknown outcomes are never resent automatically.',
    invoke: (svc, actor, i) => data(svc.deliveryWorklist(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/communications/deliveries/{messageRef}',
    operationId: 'communications.deliveries.read',
    protected: true,
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['401', '403', '404', '503'],
    tool: 'communications_deliveries_get',
    description:
      'One outbound message: state, the E6 decisions at intent and send time, every attempt and every receipt (never the body or recipient).',
    invoke: (svc, actor, i) => data(svc.readDelivery(actor, param(i, 'messageRef'))),
  },
  {
    method: 'post',
    path: '/v1/communications/deliveries/{messageRef}/resolve',
    operationId: 'communications.deliveries.resolve',
    protected: true,
    requestBody: E('DeliveryResolve'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_deliveries_resolve',
    description:
      'Resolve a failed or unknown delivery: resend with the same delivery key (E6 decides again at send time) or abandon. Human staff only.',
    invoke: (svc, actor, i) =>
      svc.resolveDelivery(actor, param(i, 'messageRef'), env('communications.deliveries.resolve', i)),
  },
  {
    method: 'post',
    path: '/v1/communications/receipts',
    operationId: 'communications.receipts.record',
    protected: true,
    requestBody: E('ReceiptInput'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'communications_receipts_record',
    description:
      'Record a normalized provider receipt (receipts integration principal only). Deduplicated on the provider event, monotonic, and never resurrects a suppressed or abandoned message.',
    invoke: (svc, actor, i) => svc.recordReceipt(actor, env('communications.receipts.record', i)),
  },
  // E4 intake forms: versioned definitions, staff entry, submissions and the staff review queue.
  {
    method: 'post',
    path: '/v1/intake/forms',
    operationId: 'intake.forms.publish',
    protected: true,
    requestBody: E('FormPublish'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'intake_forms_publish',
    description:
      'Publish the next version of an intake form (synthetic content; clinical sign-off pending). Only the latest published version accepts new submissions; earlier submissions stay bound to theirs. Human administrators only.',
    invoke: (svc, actor, i) => svc.publishForm(actor, env('intake.forms.publish', i)),
  },
  {
    method: 'post',
    path: '/v1/intake/forms/{formRef}/retire',
    operationId: 'intake.forms.retire',
    protected: true,
    requestBody: E('FormRetire'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'intake_forms_retire',
    description:
      'Retire the current version of a form: new submissions are refused (form_version_expired); stored submissions are kept.',
    invoke: (svc, actor, i) => svc.retireForm(actor, param(i, 'formRef'), env('intake.forms.retire', i)),
  },
  {
    method: 'get',
    path: '/v1/intake/forms',
    operationId: 'intake.forms.list',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '503'],
    tool: 'intake_forms_list',
    description:
      'Current version of every intake form with its fields, consent questions, state and content-review status.',
    invoke: (svc, actor, i) => data(svc.listForms(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/intake-submissions',
    operationId: 'intake.submissions.submit',
    protected: true,
    requestBody: E('FormSubmissionInput'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'intake_submissions_submit',
    description:
      'Enter a completed intake form for a patient (front desk or paper). Same rules as a portal submission: bound to the current version, idempotent on its key, consents recorded once, record changes only as review items. Human staff only.',
    invoke: (svc, actor, i) =>
      svc.submitStaffForm(actor, param(i, 'patientRef'), env('intake.submissions.submit', i)),
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/intake-submissions',
    operationId: 'intake.submissions.list',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: READ,
    tool: 'intake_submissions_list',
    description:
      'Intake submissions of a patient with provenance, linked consent facts and review status (no answers).',
    invoke: (svc, actor, i) => data(svc.listSubmissions(actor, param(i, 'patientRef'), i.body)),
  },
  {
    method: 'get',
    path: '/v1/intake/submissions/{submissionRef}',
    operationId: 'intake.submissions.read',
    protected: true,
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['401', '403', '404', '503'],
    tool: 'intake_submissions_get',
    description:
      'One intake submission with its answers against the form version it answered (sensitive-read logged).',
    invoke: (svc, actor, i) => data(svc.readSubmission(actor, param(i, 'submissionRef'))),
  },
  {
    method: 'get',
    path: '/v1/intake/reviews/worklist',
    operationId: 'intake.reviews.worklist',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: 'scheduling:WorkItemList' },
    refusals: ['400', '401', '403', '503'],
    tool: 'intake_reviews_worklist',
    description:
      'Open intake review items as work items: demographics changes awaiting staff review, and medical-history hand-offs held by reference for C8 (blocked on C8).',
    invoke: (svc, actor, i) => data(svc.reviewWorklist(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/intake/reviews/{reviewRef}',
    operationId: 'intake.reviews.read',
    protected: true,
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['401', '403', '404', '503'],
    tool: 'intake_reviews_get',
    description:
      'One intake review item with the live difference between the patient record and the proposed values.',
    invoke: (svc, actor, i) => data(svc.readReview(actor, param(i, 'reviewRef'))),
  },
  {
    method: 'post',
    path: '/v1/intake/reviews/{reviewRef}/resolve',
    operationId: 'intake.reviews.resolve',
    protected: true,
    requestBody: E('IntakeReviewResolve'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'intake_reviews_resolve',
    description:
      'Apply a demographics review through the patient record (with the patient version the reviewer saw; a changed record is stale) or reject a review item. Medical-history hand-offs cannot be applied here. Human staff only.',
    invoke: (svc, actor, i) =>
      svc.resolveReview(actor, param(i, 'reviewRef'), env('intake.reviews.resolve', i)),
  },
];

export const ENGAGEMENT_OP_ROUTES: readonly RouteContract[] = ENGAGEMENT_OPS.map((o) => ({
  method: o.method,
  path: o.path,
  operationId: o.operationId,
  protected: o.protected,
  ...(o.requestBody ? { requestBody: o.requestBody } : {}),
  success: o.success,
  refusals: o.refusals,
}));
