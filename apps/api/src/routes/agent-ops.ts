import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, AgentService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { type OpsBlockSpec, renderOpsBlock } from '../migration-openapi';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the workstream A batch 2 operations (A8-A13): the REST route contract, the MCP tool
 * name and the call into the shared agent service. REST registration, the MCP tools
 * (apps/mcp/src/tools/agent-ops.ts), the generated OpenAPI block and the drift checks derive from it.
 * No route takes a path parameter: references travel in the validated body or query, and the tenant
 * always comes from the token. List operations return the OR-01 ListEnvelope from the start.
 */
export interface AgentOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the agents.schema.json definition of the query object. */
  readonly query?: string;
  invoke(svc: AgentService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const A = (name: string) => `agents:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['400', '401', '403', '404', '503'] as const;

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const data = async (p: Promise<unknown>) => ({ data: await p });

const lifecycle = (
  path: string,
  operationId: ActionName,
  tool: string,
  description: string,
  call: (svc: AgentService) => (a: ActorContext, e: CommandEnvelope<unknown>) => Promise<unknown>,
  body = 'AgentTransition',
): AgentOp => ({
  method: 'post',
  path,
  operationId,
  protected: true,
  requestBody: A(body),
  success: { status: '200', schema: A('AgentCommandResult') },
  refusals: COMMAND,
  tool,
  description,
  invoke: (svc, actor, i) => call(svc)(actor, env(operationId, i)),
});

export const AGENT_OPS: AgentOp[] = [
  {
    method: 'post',
    path: '/v1/agents/principals',
    operationId: 'agents.principals.create',
    protected: true,
    requestBody: A('AgentCreate'),
    success: { status: '201', schema: A('AgentCommandResult') },
    refusals: COMMAND,
    tool: 'agents_principals_create',
    description:
      'A8: create an agent principal sponsored by the calling human: purpose, scope set (never a human-only scope or one the sponsor lacks) and expiry are required. Returns the credential reference the agent token must carry as its session id. Human only (agents.manage).',
    invoke: (svc, actor, i) => svc.createAgentPrincipal(actor, env('agents.principals.create', i)),
  },
  lifecycle(
    '/v1/agents/principals/suspend',
    'agents.principals.suspend',
    'agents_principals_suspend',
    'A8: suspend an agent. Its mutations are refused at the next call; the reads its scopes allow remain.',
    (svc) => svc.suspendAgentPrincipal,
  ),
  lifecycle(
    '/v1/agents/principals/resume',
    'agents.principals.resume',
    'agents_principals_resume',
    'A8: resume a suspended agent.',
    (svc) => svc.resumeAgentPrincipal,
  ),
  lifecycle(
    '/v1/agents/principals/revoke',
    'agents.principals.revoke',
    'agents_principals_revoke',
    'A8: revoke an agent (terminal). Effective at the next authorization, including open MCP sessions and work it already queued.',
    (svc) => svc.revokeAgentPrincipal,
  ),
  lifecycle(
    '/v1/agents/credentials/rotate',
    'agents.credentials.rotate',
    'agents_credentials_rotate',
    'A8: rotate the agent credential reference. A token carrying the earlier reference is unauthenticated from the next call.',
    (svc) => svc.rotateAgentCredential,
  ),
  lifecycle(
    '/v1/agents/sponsors/change',
    'agents.sponsors.change',
    'agents_sponsors_change',
    'A8 / H3 3c: offer the sponsorship to a live human member holding every scope of the agent. The offer is pending (7 days) until that human accepts; the sponsor of record does not change before. A newer offer supersedes a pending one. Earlier agent actions keep their sponsor of record.',
    (svc) => svc.changeAgentSponsor,
    'AgentSponsorChange',
  ),
  lifecycle(
    '/v1/agents/sponsors/accept',
    'agents.sponsors.accept',
    'agents_sponsors_accept',
    'H3 3c: the offered human accepts a pending, unexpired sponsor offer and becomes the sponsor of record (still holding every scope of the agent). Only the offered human sees the offer. Human only.',
    (svc) => svc.acceptAgentSponsor,
    'AgentSponsorDecision',
  ),
  lifecycle(
    '/v1/agents/sponsors/decline',
    'agents.sponsors.decline',
    'agents_sponsors_decline',
    'H3 3c: the offered human declines a pending sponsor offer; the sponsor of record is unchanged. Human only.',
    (svc) => svc.declineAgentSponsor,
    'AgentSponsorDecision',
  ),
  {
    method: 'get',
    path: '/v1/agents/principals/state',
    operationId: 'agents.principals.read',
    protected: true,
    query: 'AgentQuery',
    success: { status: '200', schema: A('AgentRead') },
    refusals: READ,
    tool: 'agents_principals_get',
    description:
      'A8: one agent with its live grants (describeAgentGrants). An agent can read only its own record. Never returns the credential reference.',
    invoke: (svc, actor, i) => data(svc.readAgentPrincipal(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/agents/principals',
    operationId: 'agents.principals.list',
    protected: true,
    query: 'AgentListQuery',
    success: { status: '200', schema: A('AgentList') },
    refusals: READ,
    tool: 'agents_principals_list',
    description: 'A8: agent principals of the tenant, oldest first (OR-01 list envelope). Human only.',
    invoke: (svc, actor, i) => svc.listAgentPrincipals(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/agents/audit',
    operationId: 'agents.audit.list',
    protected: true,
    query: 'AgentAuditQuery',
    success: { status: '200', schema: A('AgentAuditList') },
    refusals: READ,
    tool: 'agents_audit_list',
    description:
      'A8: the separate agent-audit stream of one agent (actor = the agent, sponsor = the sponsor of record at the time), OR-01 list envelope. Human only.',
    invoke: (svc, actor, i) => svc.listAgentAudit(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/agents/consents',
    operationId: 'agents.consents.record',
    protected: true,
    requestBody: A('ConsentRecord'),
    success: { status: '201', schema: A('ConsentCommandResult') },
    refusals: COMMAND,
    tool: 'agents_consents_record',
    description:
      'A9: record that the calling human consents to one agent calling the listed catalog operations on one MCP deployment, within a call/record/PHI-field budget, until an expiry. Operations outside the agent scope set or not callable by an agent are refused. Human only (agents.manage).',
    invoke: (svc, actor, i) => svc.recordConsent(actor, env('agents.consents.record', i)),
  },
  {
    method: 'post',
    path: '/v1/agents/consents/revoke',
    operationId: 'agents.consents.revoke',
    protected: true,
    requestBody: A('ConsentRevoke'),
    success: { status: '200', schema: A('ConsentCommandResult') },
    refusals: COMMAND,
    tool: 'agents_consents_revoke',
    description:
      'A9: revoke a consent. The next tool call it covered is refused, including in an open session.',
    invoke: (svc, actor, i) => svc.revokeConsent(actor, env('agents.consents.revoke', i)),
  },
  {
    method: 'get',
    path: '/v1/agents/consents',
    operationId: 'agents.consents.list',
    protected: true,
    query: 'ConsentListQuery',
    success: { status: '200', schema: A('ConsentList') },
    refusals: READ,
    tool: 'agents_consents_list',
    description: 'A9: consent records, newest first (OR-01 list envelope). Human only.',
    invoke: (svc, actor, i) => svc.listConsents(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/agents/budgets',
    operationId: 'agents.budgets.read',
    protected: true,
    query: 'BudgetQuery',
    success: { status: '200', schema: A('BudgetRead') },
    refusals: READ,
    tool: 'agents_budgets_get',
    description:
      'A9: live budget usage of one agent on one deployment in the current period. An agent can read only its own.',
    invoke: (svc, actor, i) => data(svc.readBudget(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/actions/proposals',
    operationId: 'actions.proposals.prepare',
    protected: true,
    requestBody: A('ActionPrepare'),
    success: { status: '201', schema: A('ActionProposalResult') },
    refusals: COMMAND,
    tool: 'actions_proposals_prepare',
    description:
      'A10: prepare a proposal for an operation whose catalog approval mode is proposal (portal enrolment, consent record, relationship add, payment-plan authorization). Binds the payload digest, resource versions, policy version, the proposer and its sponsor, and a one-hour expiry. The proposer must hold the operation authority itself. Nothing is executed.',
    invoke: (svc, actor, i) => svc.prepareProposal(actor, env('actions.proposals.prepare', i)),
  },
  {
    method: 'post',
    path: '/v1/actions/proposals/approve',
    operationId: 'actions.proposals.approve',
    protected: true,
    requestBody: A('ActionApprove'),
    success: { status: '200', schema: A('ActionProposalResult') },
    refusals: COMMAND,
    tool: 'actions_proposals_approve',
    description:
      'A10: approve a prepared proposal over the digest the approver reviewed. Human only (actions.approve) and authorized for the proposed operation; never the proposer, never an agent proposer sponsor (self_approval_denied).',
    invoke: (svc, actor, i) => svc.approveProposal(actor, env('actions.proposals.approve', i)),
  },
  {
    method: 'post',
    path: '/v1/actions/proposals/commit',
    operationId: 'actions.proposals.commit',
    protected: true,
    requestBody: A('ActionCommit'),
    success: { status: '200', schema: A('ActionProposalResult') },
    refusals: COMMAND,
    tool: 'actions_proposals_commit',
    description:
      'A10: commit an approved proposal. Rechecks proposer and approver memberships, digest, expiry, policy version and resource versions, then runs the owning command as the committing human, once per proposal; a repeat replays. Human only.',
    invoke: (svc, actor, i) => svc.commitProposal(actor, env('actions.proposals.commit', i)),
  },
  {
    method: 'post',
    path: '/v1/actions/proposals/abandon',
    operationId: 'actions.proposals.abandon',
    protected: true,
    requestBody: A('ActionAbandon'),
    success: { status: '200', schema: A('ActionProposalResult') },
    refusals: COMMAND,
    tool: 'actions_proposals_abandon',
    description:
      'A10: abandon a prepared or approved proposal (the proposer, or a person). It stays readable for audit and cannot be revived.',
    invoke: (svc, actor, i) => svc.abandonProposal(actor, env('actions.proposals.abandon', i)),
  },
  {
    method: 'get',
    path: '/v1/actions/proposals/state',
    operationId: 'actions.proposals.read',
    protected: true,
    query: 'ActionQuery',
    success: { status: '200', schema: A('ActionProposalRead') },
    refusals: READ,
    tool: 'actions_proposals_get',
    description: 'A10: one proposal. An agent sees only its own.',
    invoke: (svc, actor, i) => data(svc.readProposal(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/actions/proposals',
    operationId: 'actions.proposals.list',
    protected: true,
    query: 'ActionListQuery',
    success: { status: '200', schema: A('ActionProposalList') },
    refusals: READ,
    tool: 'actions_proposals_list',
    description: 'A10: proposals, newest first (OR-01 list envelope). An agent sees only its own.',
    invoke: (svc, actor, i) => svc.listProposals(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/ai/drafts',
    operationId: 'ai.drafts.create',
    protected: true,
    requestBody: A('AiDraftCreate'),
    success: { status: '201', schema: A('AiDraftCommandResult') },
    refusals: COMMAND,
    tool: 'ai_drafts_create',
    description:
      'A11: request an AI draft (note draft, message draft or claim-readiness explanation) from records the caller can already read. Synthetic model only; output is always a draft with model, prompt version, source versions and review flags; never signed, sent, submitted or booked. 403 when the use case is not enabled or not approved; 503 adapter_not_configured without a model.',
    invoke: (svc, actor, i) => svc.createAiDraft(actor, env('ai.drafts.create', i)),
  },
  {
    method: 'get',
    path: '/v1/ai/drafts/state',
    operationId: 'ai.drafts.read',
    protected: true,
    query: 'AiDraftQuery',
    success: { status: '200', schema: A('AiDraftRead') },
    refusals: READ,
    tool: 'ai_drafts_get',
    description:
      'A11: one AI draft with provenance and freshness; a draft whose sources changed is marked stale. An agent sees only its own drafts.',
    invoke: (svc, actor, i) => data(svc.readAiDraft(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/ai/drafts',
    operationId: 'ai.drafts.list',
    protected: true,
    query: 'AiDraftListQuery',
    success: { status: '200', schema: A('AiDraftList') },
    refusals: READ,
    tool: 'ai_drafts_list',
    description: 'A11: AI drafts, newest first (OR-01 list envelope). An agent sees only its own.',
    invoke: (svc, actor, i) => svc.listAiDrafts(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/ai/drafts/accept',
    operationId: 'ai.drafts.accept',
    protected: true,
    requestBody: A('AiDraftAccept'),
    success: { status: '200', schema: A('AiDraftCommandResult') },
    refusals: COMMAND,
    tool: 'ai_drafts_accept',
    description:
      'A11: a person accepts a fresh draft (a flagged one only with an edit) through the owning command as that person: a clinical note DRAFT labelled source ai_draft (signing stays clinical.notes.sign) or a staff message; an explanation is acknowledged only. Human only (ai.review).',
    invoke: (svc, actor, i) => svc.acceptAiDraft(actor, env('ai.drafts.accept', i)),
  },
  {
    method: 'post',
    path: '/v1/ai/drafts/reject',
    operationId: 'ai.drafts.reject',
    protected: true,
    requestBody: A('AiDraftReject'),
    success: { status: '200', schema: A('AiDraftCommandResult') },
    refusals: COMMAND,
    tool: 'ai_drafts_reject',
    description: 'A11: a person rejects a draft with a reason. Human only (ai.review).',
    invoke: (svc, actor, i) => svc.rejectAiDraft(actor, env('ai.drafts.reject', i)),
  },
  {
    method: 'get',
    path: '/v1/ai/use-cases',
    operationId: 'ai.useCases.list',
    protected: true,
    query: 'AiUseCaseListQuery',
    success: { status: '200', schema: A('AiUseCaseList') },
    refusals: READ,
    tool: 'ai_use_cases_list',
    description:
      'A11/AS-07: the AI use-case registry with approval status, the tenant switch and the evaluation gate (OR-01 list envelope).',
    invoke: (svc, actor, i) => svc.listAiUseCases(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/ai/use-cases/configure',
    operationId: 'ai.useCases.configure',
    protected: true,
    requestBody: A('AiUseCaseConfigure'),
    success: { status: '200', schema: A('AiUseCaseCommandResult') },
    refusals: COMMAND,
    tool: 'ai_use_cases_configure',
    description:
      'A11: switch one AI use case, or every AI use case of the tenant, on or off. A use case that is not approved cannot be enabled. Disabling never affects deterministic workflows. Human only (admin.configure).',
    invoke: (svc, actor, i) => svc.configureAiUseCase(actor, env('ai.useCases.configure', i)),
  },
  {
    method: 'post',
    path: '/v1/ai/evaluations',
    operationId: 'ai.evaluations.run',
    protected: true,
    requestBody: A('AiEvaluationRun'),
    success: { status: '201', schema: A('AiEvaluationCommandResult') },
    refusals: COMMAND,
    tool: 'ai_evaluations_run',
    description:
      'A12: run the versioned synthetic case set (with its red-team part) of one use case against the configured model, optionally for a candidate prompt version. The verdict is per case (one failing case fails, and is named); fewer than three repetitions or too many outages is inconclusive. Never clinical validation. Human only (admin.configure).',
    invoke: (svc, actor, i) => svc.runAiEvaluation(actor, env('ai.evaluations.run', i)),
  },
  {
    method: 'get',
    path: '/v1/ai/evaluations',
    operationId: 'ai.evaluations.list',
    protected: true,
    query: 'AiEvaluationListQuery',
    success: { status: '200', schema: A('AiEvaluationList') },
    refusals: READ,
    tool: 'ai_evaluations_list',
    description:
      'A12: evaluation runs with model, prompt and case-set versions, newest first (OR-01 list envelope).',
    invoke: (svc, actor, i) => svc.listAiEvaluations(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/prescriptions/drafts',
    operationId: 'prescriptions.drafts.create',
    protected: true,
    requestBody: A('PrescriptionDraftCreate'),
    success: { status: '201', schema: A('PrescriptionCommandResult') },
    refusals: COMMAND,
    tool: 'prescriptions_drafts_create',
    description:
      'A13: draft a prescription for a human prescriber. No e-prescribing partner is qualified: always refused with 503 service_unavailable, reason prescribing_not_available, naming each missing fact and capability. Never a fabricated success.',
    invoke: (svc, actor, i) => svc.createPrescriptionDraft(actor, env('prescriptions.drafts.create', i)),
  },
  {
    method: 'post',
    path: '/v1/prescriptions/submit',
    operationId: 'prescriptions.submit',
    protected: true,
    requestBody: A('PrescriptionSubmit'),
    success: { status: '200', schema: A('PrescriptionCommandResult') },
    refusals: COMMAND,
    tool: 'prescriptions_submit',
    description:
      'A13: submit a prescription draft bound to an approved A10 proposal, by a verified human prescriber only. No partner is qualified and no prescriber verification source exists: always refused (prescribing_not_available). Agents never prescribe.',
    invoke: (svc, actor, i) => svc.submitPrescription(actor, env('prescriptions.submit', i)),
  },
  {
    method: 'post',
    path: '/v1/prescriptions/cancel',
    operationId: 'prescriptions.cancel',
    protected: true,
    requestBody: A('PrescriptionCancel'),
    success: { status: '200', schema: A('PrescriptionCommandResult') },
    refusals: COMMAND,
    tool: 'prescriptions_cancel',
    description:
      'A13: cancel a prescription draft. Refused like every prescribing operation (prescribing_not_available).',
    invoke: (svc, actor, i) => svc.cancelPrescription(actor, env('prescriptions.cancel', i)),
  },
];

export const AGENT_OP_ROUTES = (): RouteContract[] =>
  AGENT_OPS.map(({ method, path, operationId, protected: p, requestBody, success, refusals }) => ({
    method,
    path,
    operationId,
    protected: p,
    ...(requestBody ? { requestBody } : {}),
    success,
    refusals,
  }));

export const AGENT_OPS_BLOCK: OpsBlockSpec = {
  begin: '  # BEGIN generated: AGENT_OPS (scripts/openapi-agents.ts)',
  end: '  # END generated: AGENT_OPS',
  schema: '../../packages/contracts/src/agents.schema.json',
  prefix: 'agents:',
};

export const renderAgentOpsBlock = (defs: Parameters<typeof renderOpsBlock>[1]) =>
  renderOpsBlock(AGENT_OPS, defs, AGENT_OPS_BLOCK);

/** GET query object; a decimal `limit` string becomes the integer the schema expects. */
function queryOf(raw: unknown): Record<string, unknown> {
  const q: Record<string, unknown> = { ...(raw as object) };
  if (typeof q.limit === 'string' && /^[0-9]{1,4}$/.test(q.limit)) q.limit = Number(q.limit);
  return q;
}

/** Registers every AGENT_OPS route; authentication in `onRequest`, no tenant read from input. */
export function registerAgentOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; agents: AgentService },
): void {
  for (const op of AGENT_OPS) {
    const input = (request: FastifyRequest): OpInput => {
      const key = request.headers['idempotency-key'];
      return {
        params: {},
        body: op.method === 'get' ? queryOf(request.query) : request.body,
        key: typeof key === 'string' ? key : '',
      };
    };
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, op.operationId) };
    if (op.method === 'get') {
      app.get(op.path, opts, async (request) =>
        op.invoke(deps.agents, requireActor(request), input(request)),
      );
    } else {
      app.post(op.path, opts, async (request, reply) =>
        reply
          .code(op.success.status === '201' ? 201 : 200)
          .send(await op.invoke(deps.agents, requireActor(request), input(request))),
      );
    }
  }
}
