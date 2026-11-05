import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, BillingService } from '@cuspatlas/domain';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the B6, B7 and B9 operations (and the C14 consumer's REST twin): the REST route
 * contract, the MCP tool name and the call into the shared billing service. REST registration
 * (billing-ops-routes.ts), the MCP tools (apps/mcp/src/tools/billing-ops.ts) and the drift checks
 * derive from it, so an operation cannot exist on one surface only.
 */
export interface BillingOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the billing.schema.json definition of the query object. */
  readonly query?: string;
  /** A POST without a request body or Idempotency-Key (consumer twin; idempotent by its own key). */
  readonly unkeyed?: boolean;
  invoke(svc: BillingService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const B = (name: string) => `billing:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
export const BILLING_READ_REFUSALS = ['401', '403', '404', '503'] as const;
const LIST = ['400', '401', '403', '503'] as const;

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const param = (input: OpInput, name: string) => input.params[name] ?? '';
const data = async (p: Promise<unknown>) => ({ data: await p });

export const BILLING_OPS: BillingOp[] = [
  {
    method: 'post',
    path: '/v1/billing/fee-schedules/versions',
    operationId: 'billing.feeSchedules.publish',
    protected: true,
    requestBody: B('FeeSchedulePublish'),
    success: { status: '201', schema: B('FeeScheduleCommandResult') },
    refusals: COMMAND,
    tool: 'billing_fee_schedules_publish',
    description:
      'B9: publish a new version of a practice or allowance fee schedule (SYN- codes, integer minor units, effective date). A version is never edited and never reprices a posted charge; a version effective before the latest one is 409 effective_date_out_of_order.',
    invoke: (svc, actor, i) => svc.publishFeeSchedule(actor, env('billing.feeSchedules.publish', i)),
  },
  {
    method: 'get',
    path: '/v1/billing/fees',
    operationId: 'billing.fees.resolve',
    protected: true,
    query: 'FeeResolveQuery',
    success: { status: '200', schema: B('FeeResolutionResult') },
    refusals: LIST,
    tool: 'billing_fees_resolve',
    description:
      'B9 / C12 seam: the practice fee and (with a coverage) the payer allowance of one SYN- code on a service date at a location. null means no configured fee, never a guessed amount.',
    invoke: (svc, actor, i) => data(svc.resolveFee(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/billing/procedure-events/{procedureRef}/consume',
    operationId: 'billing.procedures.consume',
    protected: true,
    unkeyed: true,
    success: { status: '200', schema: B('ProcedureConsumeResult') },
    refusals: COMMAND,
    tool: 'billing_procedures_consume',
    description:
      'C14 -> B consumer (service principals only; the worker calls the same function): posts the charge of a rendered procedure or the reversal of a reversed one, idempotently per procedure event version.',
    invoke: (svc, actor, i) => data(svc.consumeRenderedProcedure(actor, param(i, 'procedureRef'))),
  },
  {
    method: 'post',
    path: '/v1/billing/charges/{chargeRef}/adjustments',
    operationId: 'billing.adjustments.post',
    protected: true,
    requestBody: B('AdjustmentPost'),
    success: { status: '201', schema: B('AdjustmentCommandResult') },
    refusals: COMMAND,
    tool: 'billing_adjustments_post',
    description:
      'B9: adjust one charge with a configured reason. Contractual (insurer) posts a journal entry; courtesy and write-off create a request another human must approve (no silent write-off).',
    invoke: (svc, actor, i) =>
      svc.postAdjustment(actor, param(i, 'chargeRef'), env('billing.adjustments.post', i)),
  },
  {
    method: 'post',
    path: '/v1/billing/adjustment-requests/{requestRef}/decision',
    operationId: 'billing.adjustments.decide',
    protected: true,
    requestBody: B('AdjustmentDecision'),
    success: { status: '201', schema: B('AdjustmentCommandResult') },
    refusals: COMMAND,
    tool: 'billing_adjustments_decide',
    description:
      'B9: approve (posts the entry) or reject an adjustment request. Human-only billing.correct; the requester can never decide their own request.',
    invoke: (svc, actor, i) =>
      svc.decideAdjustment(actor, param(i, 'requestRef'), env('billing.adjustments.decide', i)),
  },
  {
    method: 'get',
    path: '/v1/billing/reports/receivables',
    operationId: 'billing.reports.receivables',
    protected: true,
    query: 'ReceivablesQuery',
    success: { status: '200', schema: B('ReceivablesReportResult') },
    refusals: LIST,
    tool: 'billing_reports_receivables',
    description:
      'B9 report scope: open patient and insurer receivables by charge location. Requires receivables.read; a location-restricted reader sees only its locations.',
    invoke: (svc, actor, i) => data(svc.receivablesReport(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims',
    operationId: 'rcm.claims.prepare',
    protected: true,
    requestBody: B('ClaimPrepare'),
    success: { status: '201', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_prepare',
    description:
      'B6: prepare a claim (version 1) only from C14 rendered procedures with posted charges, for one coverage of the patient account. Lines carry SYN- codes, billed amounts and the coverage allowance.',
    invoke: (svc, actor, i) => svc.prepareClaim(actor, env('rcm.claims.prepare', i)),
  },
  {
    method: 'get',
    path: '/v1/rcm/claims/worklist',
    operationId: 'rcm.claims.worklist',
    protected: true,
    query: 'ClaimWorklistQuery',
    success: { status: '200', schema: B('ClaimWorklistResult') },
    refusals: LIST,
    tool: 'rcm_claims_worklist',
    description:
      'B6 (CL-08): open claim work with owner, reason, due time and next action: validation issues by owner, submit, reconcile an unknown submission, correct a rejection, review a denial or appeal draft, follow up a silent payer.',
    invoke: (svc, actor, i) => data(svc.listClaimWorklist(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/rcm/claims/{claimRef}',
    operationId: 'rcm.claims.read',
    protected: true,
    success: { status: '200', schema: B('ClaimReadResult') },
    refusals: BILLING_READ_REFUSALS,
    tool: 'rcm_claims_get',
    description:
      'B6: one claim with every immutable version, validation (and whether it is still current), submissions, distinct response events (with code source and version) and appeals.',
    invoke: (svc, actor, i) => data(svc.getClaim(actor, param(i, 'claimRef'))),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/validation',
    operationId: 'rcm.claims.validate',
    protected: true,
    requestBody: B('ClaimVersioned'),
    success: { status: '201', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_validate',
    description:
      'B6 (CL-03): deterministic readiness rules naming each missing fact, its owner and source; bound to the head version and its inputs (any change invalidates it).',
    invoke: (svc, actor, i) => svc.validateClaim(actor, param(i, 'claimRef'), env('rcm.claims.validate', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/attachments',
    operationId: 'rcm.claims.attach',
    protected: true,
    requestBody: B('ClaimAttach'),
    success: { status: '201', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_attach',
    description:
      'B6: attach an object reference (imaging is I-owned; no bytes) as a new immutable claim version; a submitted version is never changed.',
    invoke: (svc, actor, i) => svc.attachToClaim(actor, param(i, 'claimRef'), env('rcm.claims.attach', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/replacement',
    operationId: 'rcm.claims.replace',
    protected: true,
    requestBody: B('ClaimReplace'),
    success: { status: '201', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_replace',
    description:
      'B6 (CL-06/CL-10): a corrective replacement version linked to the rejected or denied one; it needs its own validation and submission.',
    invoke: (svc, actor, i) => svc.replaceClaim(actor, param(i, 'claimRef'), env('rcm.claims.replace', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/submissions',
    operationId: 'rcm.claims.submit',
    protected: true,
    requestBody: B('ClaimSubmit'),
    success: { status: '201', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_submit',
    description:
      'B6 (CL-04/CL-05): submit the validated head version through the fake clearinghouse under explicit human approval or a standing policy rechecked now; one submission per version; an unknown outcome is reconciled, never resubmitted.',
    invoke: (svc, actor, i) => svc.submitClaim(actor, param(i, 'claimRef'), env('rcm.claims.submit', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/poll',
    operationId: 'rcm.claims.poll',
    protected: true,
    unkeyed: true,
    success: { status: '200', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_poll',
    description:
      'B6: reconcile an unknown submission by lookup and record new partner responses (acknowledgement, rejection, adjudication, denial codes) once each.',
    invoke: (svc, actor, i) => svc.pollClaim(actor, param(i, 'claimRef')),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/appeals',
    operationId: 'rcm.appeals.draft',
    protected: true,
    requestBody: B('AppealDraft'),
    success: { status: '201', schema: B('AppealCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_appeals_draft',
    description:
      'B6 (CL-07): draft an appeal package for a recorded denial; it is never sent before another human reviews it; one appeal per basis.',
    invoke: (svc, actor, i) => svc.draftAppeal(actor, param(i, 'claimRef'), env('rcm.appeals.draft', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/appeals/{appealRef}/review',
    operationId: 'rcm.appeals.review',
    protected: true,
    requestBody: B('AppealReview'),
    success: { status: '201', schema: B('AppealCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_appeals_review',
    description:
      'B6: review an appeal draft (never by its drafter): approve and send through the fake clearinghouse, or reject.',
    invoke: (svc, actor, i) => svc.reviewAppeal(actor, param(i, 'appealRef'), env('rcm.appeals.review', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/submission-policies',
    operationId: 'rcm.submissionPolicies.create',
    protected: true,
    requestBody: B('SubmissionPolicyCreate'),
    success: { status: '201', schema: B('PolicyCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_submission_policies_create',
    description:
      'B6: a revocable standing submission policy (payer and billed limit), rechecked at every execution.',
    invoke: (svc, actor, i) => svc.createSubmissionPolicy(actor, env('rcm.submissionPolicies.create', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/submission-policies/{policyRef}/revoke',
    operationId: 'rcm.submissionPolicies.revoke',
    protected: true,
    requestBody: B('SubmissionPolicyRevoke'),
    success: { status: '201', schema: B('PolicyCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_submission_policies_revoke',
    description: 'B6: revoke a standing submission policy; later submissions under it are refused.',
    invoke: (svc, actor, i) =>
      svc.revokeSubmissionPolicy(actor, param(i, 'policyRef'), env('rcm.submissionPolicies.revoke', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/secondary',
    operationId: 'rcm.claims.prepareSecondary',
    protected: true,
    requestBody: B('SecondaryClaimPrepare'),
    success: { status: '201', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_prepare_secondary',
    description:
      'B8 (CL-11): prepare the secondary claim of a primary claim from its paid adjudication and posted remittance (COB evidence by reference). It claims only the patient responsibility the primary left, which stays off the patient while unresolved; its own lifecycle reuses B6. One per primary; tertiary is refused.',
    invoke: (svc, actor, i) =>
      svc.prepareSecondaryClaim(actor, param(i, 'claimRef'), env('rcm.claims.prepareSecondary', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/remittances',
    operationId: 'rcm.remittances.ingest',
    protected: true,
    requestBody: B('RemittanceIngest'),
    success: { status: '201', schema: B('RemittanceCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_remittances_ingest',
    description:
      'B7: ingest a synthetic ERA-like remittance from the fake clearinghouse (idempotent per reference). Matched lines post insurer payment to clearing, contractual adjustment and patient responsibility; unmatched, mismatched or underpaid lines go to review; an ERA is never cash.',
    invoke: (svc, actor, i) => svc.ingestRemittance(actor, env('rcm.remittances.ingest', i)),
  },
  {
    method: 'get',
    path: '/v1/rcm/remittances/{remittanceRef}',
    operationId: 'rcm.remittances.read',
    protected: true,
    success: { status: '200', schema: B('RemittanceReadResult') },
    refusals: BILLING_READ_REFUSALS,
    tool: 'rcm_remittances_get',
    description:
      'B7: one remittance with its line statuses, the clearing balance (reported, not received) and the settled cash.',
    invoke: (svc, actor, i) => data(svc.getRemittance(actor, param(i, 'remittanceRef'))),
  },
  {
    method: 'post',
    path: '/v1/rcm/remittances/{remittanceRef}/settlements',
    operationId: 'rcm.remittances.settle',
    protected: true,
    requestBody: B('RemittanceSettle'),
    success: { status: '201', schema: B('RemittanceCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_remittances_settle',
    description:
      'B7: record the EFT/check settlement of a remittance (a separate fact). An amount that differs from the open clearing balance is 409 settlement_mismatch, never posted.',
    invoke: (svc, actor, i) =>
      svc.settleRemittance(actor, param(i, 'remittanceRef'), env('rcm.remittances.settle', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/remittances/{remittanceRef}/reversal',
    operationId: 'rcm.remittances.reverse',
    protected: true,
    requestBody: B('RemittanceReverse'),
    success: { status: '201', schema: B('RemittanceCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_remittances_reverse',
    description:
      'B7: correct a remittance by reversing every posting it made (newest first, settlement included); nothing is edited. Human-only billing.correct.',
    invoke: (svc, actor, i) =>
      svc.reverseRemittance(actor, param(i, 'remittanceRef'), env('rcm.remittances.reverse', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/remittances/{remittanceRef}/lines/{lineNo}/resolutions',
    operationId: 'rcm.remittances.resolveLine',
    protected: true,
    requestBody: B('RemittanceLineResolve'),
    success: { status: '201', schema: B('RemittanceResolutionCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_remittances_resolve_line',
    description:
      'B7 (CL-10): resolve one review line as a separate fact: match an unmatched line to a transmitted claim line (posts), post the reported amounts with the residual as an adjustment or write it off (both after another human approves; a write-off also under a workflow policy limit), or route it to appeal (only the paid amount posts; the rest stays insurer responsibility). The line is never edited.',
    invoke: (svc, actor, i) =>
      svc.resolveRemittanceLine(
        actor,
        param(i, 'remittanceRef'),
        param(i, 'lineNo'),
        env('rcm.remittances.resolveLine', i),
      ),
  },
  {
    method: 'post',
    path: '/v1/rcm/remittance-resolutions/{resolutionRef}/decision',
    operationId: 'rcm.remittances.decideResolution',
    protected: true,
    requestBody: B('RemittanceResolutionDecide'),
    success: { status: '201', schema: B('RemittanceResolutionCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_remittances_decide_resolution',
    description:
      'B7: approve (posts the reported amounts and the residual entry) or reject a residual adjustment or write-off. Human-only billing.correct, never the requester; the write-off limit and balances are rechecked now.',
    invoke: (svc, actor, i) =>
      svc.decideRemittanceResolution(
        actor,
        param(i, 'resolutionRef'),
        env('rcm.remittances.decideResolution', i),
      ),
  },
  {
    method: 'post',
    path: '/v1/rcm/workflow-policies',
    operationId: 'rcm.workflowPolicies.publish',
    protected: true,
    requestBody: B('WorkflowPolicyPublish'),
    success: { status: '201', schema: B('WorkflowPolicyCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_workflow_policies_publish',
    description:
      'CL-08 policy data: a new version of the claims-workflow deadlines (acknowledgement, payer follow-up, exception due), bounded escalation and the residual write-off limit for one synthetic payer or the tenant default. Earlier versions are never changed.',
    invoke: (svc, actor, i) => svc.publishWorkflowPolicy(actor, env('rcm.workflowPolicies.publish', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/claims/{claimRef}/attachment-packages',
    operationId: 'rcm.claims.packageAttachments',
    protected: true,
    requestBody: B('AttachmentPackageCreate'),
    success: { status: '201', schema: B('ClaimCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_claims_package_attachments',
    description:
      'CL-04: bind the head claim version object references (I owns the bytes) and their digests into one attachment package; each digest is checked now and again before dispatch (an altered original refuses the submission).',
    invoke: (svc, actor, i) =>
      svc.packageClaimAttachments(actor, param(i, 'claimRef'), env('rcm.claims.packageAttachments', i)),
  },
  {
    method: 'get',
    path: '/v1/rcm/patients/{patientRef}/visit-preparation',
    operationId: 'rcm.visits.prepare',
    protected: true,
    query: 'VisitPreparationQuery',
    success: { status: '200', schema: B('VisitPreparationResult') },
    refusals: ['400', '401', '403', '404', '503'],
    tool: 'rcm_visits_prepare',
    description:
      'CL-01: coverage status, eligibility freshness and source per coverage for a service date, and the missing facts with their owner. Unknown or stale stays unknown or stale; payment is never implied.',
    invoke: (svc, actor, i) => data(svc.prepareVisit(actor, param(i, 'patientRef'), i.body)),
  },
  {
    method: 'post',
    path: '/v1/rcm/workflows',
    operationId: 'rcm.workflows.start',
    protected: true,
    requestBody: B('ClaimWorkflowStart'),
    success: { status: '201', schema: B('WorkflowCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_workflows_start',
    description:
      'CL workflow: start the persistent workflow of a primary claim lineage, optionally under a standing submission policy (the workflow then drives validate, submit, poll and the secondary through the owning commands) and a workflow policy version (deadlines, escalation).',
    invoke: (svc, actor, i) => svc.startClaimWorkflow(actor, env('rcm.workflows.start', i)),
  },
  {
    method: 'get',
    path: '/v1/rcm/workflows/{workflowRef}',
    operationId: 'rcm.workflows.read',
    protected: true,
    success: { status: '200', schema: B('ClaimWorkflowReadResult') },
    refusals: BILLING_READ_REFUSALS,
    tool: 'rcm_workflows_get',
    description:
      'CL workflow: linked steps (by reference; input versions, authority, outcome, attempt, next expected event), owned exceptions with escalation, durable timers, open responsibilities per charge and the closure fact.',
    invoke: (svc, actor, i) => data(svc.getClaimWorkflow(actor, param(i, 'workflowRef'))),
  },
  {
    method: 'post',
    path: '/v1/rcm/workflows/{workflowRef}/advance',
    operationId: 'rcm.workflows.advance',
    protected: true,
    unkeyed: true,
    success: { status: '200', schema: B('WorkflowAdvanceResult') },
    refusals: COMMAND,
    tool: 'rcm_workflows_advance',
    description:
      'CL workflow: under the standing policy drive the next owned claim work items (bounded attempts), then record every new fact as a step, open or resolve one exception per underlying issue and schedule the durable timers. Idempotent: a repeat records nothing twice.',
    invoke: (svc, actor, i) => svc.advanceClaimWorkflow(actor, param(i, 'workflowRef')),
  },
  {
    method: 'post',
    path: '/v1/rcm/workflows/{workflowRef}/closure',
    operationId: 'rcm.workflows.close',
    protected: true,
    requestBody: B('ClaimWorkflowClose'),
    success: { status: '201', schema: B('WorkflowCommandResult') },
    refusals: COMMAND,
    tool: 'rcm_workflows_close',
    description:
      'CL-12: close the lineage only when every patient and insurer responsibility is zero and no exception is open (409 closure_blocked naming each); the closure fact breaks each charge down into insurer payment, patient payment, adjustments, write-off and transfers. No silent write-off.',
    invoke: (svc, actor, i) =>
      svc.closeClaimWorkflow(actor, param(i, 'workflowRef'), env('rcm.workflows.close', i)),
  },
  {
    method: 'post',
    path: '/v1/rcm/workflow-timers/{timerRef}/fire',
    operationId: 'rcm.workflows.fireTimer',
    protected: true,
    unkeyed: true,
    success: { status: '200', schema: B('WorkflowAdvanceResult') },
    refusals: COMMAND,
    tool: 'rcm_workflows_fire_timer',
    description:
      'CL-08 durable timer (service principals only; the outbox worker calls the same function): records the firing once, escalates an open exception one bounded level or opens the payer follow-up, then advances the workflow.',
    invoke: (svc, actor, i) => svc.fireWorkflowTimer(actor, param(i, 'timerRef')),
  },
  {
    method: 'get',
    path: '/v1/billing/export',
    operationId: 'billing.export',
    protected: true,
    success: { status: '200', schema: B('BillingExportResult') },
    refusals: BILLING_READ_REFUSALS,
    tool: 'billing_export',
    description:
      'B10: versioned JSON export of every billing and rcm record of the tenant (journal, payments, plans, statements, coverage, eligibility, claims, remittances, workflows), references preserved, no tenant field, every amount as Money. Tenant-wide human administrators only; sensitive-read logged.',
    invoke: (svc, actor) => data(svc.exportBilling(actor)),
  },
];

export const BILLING_OP_ROUTES = (): readonly RouteContract[] =>
  BILLING_OPS.map((o) => ({
    method: o.method,
    path: o.path,
    operationId: o.operationId,
    protected: o.protected,
    ...(o.requestBody === undefined ? {} : { requestBody: o.requestBody }),
    success: o.success,
    refusals: o.refusals,
  }));
