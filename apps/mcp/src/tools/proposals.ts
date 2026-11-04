import { actionProposalSchema } from '@cuspatlas/contracts';
import { inputSchema, type ToolDefinition, without } from './synthetic-tasks';

const DEFS = actionProposalSchema.$defs as Record<string, unknown>;
const approveProperties = (DEFS.ProposalApprove as { properties: Record<string, object> }).properties;

/**
 * MCP twins of the proposal routes (F Task 7a). Input schemas are built mechanically from
 * action-proposal.schema.json; `idempotencyKey` (prepare's Idempotency-Key header) and `proposalRef`
 * (the path parameter) are the only transport additions. Every handler forwards the arguments to the
 * same domain service REST uses, which authorizes first and then validates, so invalid input yields
 * the identical refusal (and attempt row) on both transports.
 */
export const PROPOSAL_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'synthetic_tasks_propose',
    operationId: 'syntheticTasks.proposals.prepare',
    description:
      'Prepare a proposal to create or relabel a synthetic task. Nothing changes until a human approves it and it is committed.',
    inputSchema: inputSchema(
      { operation: 'ProposalOperation', payload: 'ProposalPayload', idempotencyKey: 'IdempotencyKey' },
      ['operation', 'payload', 'idempotencyKey'],
      DEFS,
    ),
    readOnly: false,
    // The domain validates the whole body (and the key) after authorization, before any domain read.
    onInvalid: 'domain',
    run: (deps, actor, args) =>
      deps.proposals.prepareProposal(actor, {
        operation: 'syntheticTasks.proposals.prepare',
        idempotencyKey: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '',
        payload: without(args, 'idempotencyKey'),
      }),
  },
  {
    name: 'synthetic_tasks_get_proposal',
    operationId: 'syntheticTasks.proposals.read',
    description: 'Read a proposal visible to the caller. Hidden and missing proposals are indistinguishable.',
    inputSchema: inputSchema({ proposalRef: 'ProposalRef' }, ['proposalRef'], DEFS),
    readOnly: true,
    onInvalid: { action: 'syntheticTasks.proposals.read', recordAll: true },
    async run(deps, actor, args) {
      return { data: await deps.proposals.getProposal(actor, String(args.proposalRef)) };
    },
  },
  {
    name: 'synthetic_tasks_approve',
    operationId: 'syntheticTasks.proposals.approve',
    description:
      'Approve a prepared proposal over the payloadDigest you reviewed. Human approvers only; automation cannot approve its own proposal.',
    inputSchema: inputSchema(
      {
        proposalRef: 'ProposalRef',
        payloadDigest: 'PayloadDigest',
        execution: approveProperties.execution as object,
      },
      ['proposalRef', 'payloadDigest'],
      DEFS,
    ),
    readOnly: false,
    // As REST: visibility and approver authorization (which read the proposal) precede body validation.
    onInvalid: 'domain',
    run: (deps, actor, args) =>
      deps.proposals.approveProposal(actor, String(args.proposalRef), without(args, 'proposalRef')),
  },
  {
    name: 'synthetic_tasks_commit',
    operationId: 'syntheticTasks.proposals.commit',
    description:
      'Execute an approved proposal; repeat its payload. Executes at most once; a repeat returns the recorded result.',
    inputSchema: inputSchema(
      { proposalRef: 'ProposalRef', payload: 'ProposalPayload' },
      ['proposalRef', 'payload'],
      DEFS,
    ),
    readOnly: false,
    // As REST: visibility and executor authorization precede body validation.
    onInvalid: 'domain',
    run: (deps, actor, args) =>
      deps.proposals.commitProposal(actor, String(args.proposalRef), without(args, 'proposalRef')),
  },
];
