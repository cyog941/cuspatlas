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
