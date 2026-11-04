import type { ActorContext } from '@cuspatlas/contracts';
import { billingSchema } from '@cuspatlas/contracts';
import type { ActionName } from '@cuspatlas/domain';
import { type Args, inputSchema, type ToolDefinition, type ToolDeps, without } from './synthetic-tasks';

const DEFS = billingSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };
const def = (name: string) => DEFS[name] as Def;

/** Transport-only properties (Idempotency-Key header and path parameters) and their definitions. */
export const BILLING_TRANSPORT: Readonly<Record<string, string>> = {
  idempotencyKey: 'IdempotencyKey',
  chargeRef: 'ChargeRef',
  entryRef: 'EntryRef',
  patientRef: 'PatientRef',
  paymentRef: 'PaymentRef',
  attemptRef: 'AttemptRef',
};

/** Input schema = the REST body (or query) properties plus the transport-only properties. */
function schemaFor(body: string | null, transport: readonly string[]) {
  const d = body === null ? { properties: {}, required: [] } : def(body);
  const props: Record<string, object | string> = { ...d.properties };
  for (const t of transport) props[t] = BILLING_TRANSPORT[t] as string;
  return inputSchema(props, [...(d.required ?? []), ...transport], DEFS);
}

export interface BillingSpec {
  readonly name: string;
  readonly operationId: ActionName;
  readonly description: string;
  readonly body: string | null;
  readonly transport: readonly string[];
  readonly readOnly: boolean;
  run(deps: ToolDeps, actor: ActorContext, args: Args): Promise<unknown>;
}

export const billingEnvelope = (operation: string, args: Args, ...pathParams: string[]) => ({
  operation,
  idempotencyKey: args.idempotencyKey as string,
  payload: without(args, 'idempotencyKey', ...pathParams),
});
const s = (args: Args, name: string) => args[name] as string;

/** B1 journal tools. B2 appends payment and allocation tools to the same list. */
export const BILLING_SPECS: BillingSpec[] = [
  {
    name: 'billing_charges_post',
    operationId: 'billing.charges.post',
    description:
      'Post a charge from a synthetic procedure reference (the C14 seam): Dr patient receivable, Cr production revenue, in the tenant currency.',
    body: 'ChargePost',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.billing.postCharge(actor, billingEnvelope('billing.charges.post', args)),
  },
  {
    name: 'billing_charges_get',
    operationId: 'billing.charges.read',
    description: 'Read one charge with its derived open patient and insurer responsibility.',
    body: null,
    transport: ['chargeRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.billing.getCharge(actor, s(args, 'chargeRef')) };
    },
  },
  {
    name: 'billing_entries_get',
    operationId: 'billing.entries.read',
    description: 'Read one posted journal entry with its signed lines and reversal links.',
    body: null,
    transport: ['entryRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.billing.getEntry(actor, s(args, 'entryRef')) };
    },
  },
  {
    name: 'billing_entries_reverse',
    operationId: 'billing.entries.reverse',
    description:
      'Reverse a posted entry with a reason (human only). The reversal exactly negates the original; both stay readable.',
    body: 'EntryReverse',
    transport: ['entryRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.billing.reverseEntry(
        actor,
        s(args, 'entryRef'),
        billingEnvelope('billing.entries.reverse', args, 'entryRef'),
      ),
  },
  {
    name: 'billing_ledger_list',
    operationId: 'billing.ledger.list',
    description:
      "List the journal entries of a patient's account (merge set), oldest first, one page at a time.",
    body: 'LedgerQuery',
    transport: ['patientRef'],
    readOnly: true,
    run: (d, actor, args) => d.billing.listLedger(actor, s(args, 'patientRef'), without(args, 'patientRef')),
  },
  {
    name: 'billing_balances_get',
    operationId: 'billing.balances.read',
    description:
      'Derived patient balance (responsibility, insurer responsibility, unapplied credit) at an instant.',
    body: 'BalanceQuery',
    transport: ['patientRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.billing.readBalance(actor, s(args, 'patientRef'), without(args, 'patientRef')) };
    },
  },
  // B2 payments, allocations and the worklist.
  {
    name: 'billing_payments_record',
    operationId: 'billing.payments.record',
    description:
      'Record patient money as a received fact (cash, check) or through the synthetic card provider; an unknown outcome becomes a reconciliation item.',
    body: 'PaymentRecord',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.billing.recordPayment(actor, billingEnvelope('billing.payments.record', args)),
  },
  {
    name: 'billing_payments_get',
    operationId: 'billing.payments.read',
    description:
      'Read one payment with its allocations, unapplied funds per patient, refunds and settlement.',
    body: null,
    transport: ['paymentRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.billing.getPayment(actor, s(args, 'paymentRef')) };
    },
  },
  {
    name: 'billing_payments_settle',
    operationId: 'billing.payments.settle',
    description: 'Record settlement of the unsettled cash of a payment (received is not settled).',
    body: 'PaymentSettle',
    transport: ['paymentRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.billing.settlePayment(
        actor,
        s(args, 'paymentRef'),
        billingEnvelope('billing.payments.settle', args, 'paymentRef'),
      ),
  },
  {
    name: 'billing_payments_allocate',
    operationId: 'billing.payments.allocate',
    description:
      'Allocate unapplied payment funds to charges, all or nothing, never beyond funds or open responsibility.',
    body: 'PaymentAllocate',
    transport: ['paymentRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.billing.allocatePayment(
        actor,
        s(args, 'paymentRef'),
        billingEnvelope('billing.payments.allocate', args, 'paymentRef'),
      ),
  },
  {
    name: 'billing_payments_refund',
    operationId: 'billing.payments.refund',
    description: 'Record a refund of unapplied money to the original payer (human only, reason required).',
    body: 'PaymentRefund',
    transport: ['paymentRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.billing.refundPayment(
        actor,
        s(args, 'paymentRef'),
        billingEnvelope('billing.payments.refund', args, 'paymentRef'),
      ),
  },
  {
    name: 'billing_funds_transfer',
    operationId: 'billing.funds.transfer',
    description:
      'Move unapplied payment funds from one patient to another (human only, reason required, audited).',
    body: 'FundsTransfer',
    transport: ['paymentRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.billing.transferFunds(
        actor,
        s(args, 'paymentRef'),
        billingEnvelope('billing.funds.transfer', args, 'paymentRef'),
      ),
  },
  {
    name: 'billing_responsibility_transfer',
    operationId: 'billing.responsibility.transfer',
    description: 'Move open responsibility for a charge between the patient and a synthetic payer.',
    body: 'ResponsibilityTransfer',
    transport: ['chargeRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.billing.transferResponsibility(
        actor,
        s(args, 'chargeRef'),
        billingEnvelope('billing.responsibility.transfer', args, 'chargeRef'),
      ),
  },
  {
    name: 'billing_payments_reconcile',
    operationId: 'billing.payments.reconcile',
    description: 'Resolve an unknown provider outcome by lookup with the original key; never a new capture.',
    body: 'AttemptReconcile',
    transport: ['attemptRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.billing.reconcileAttempt(
        actor,
        s(args, 'attemptRef'),
        billingEnvelope('billing.payments.reconcile', args, 'attemptRef'),
      ),
  },
  {
    name: 'billing_worklist_list',
    operationId: 'billing.worklist.list',
    description: 'Owned billing work items: undistributed funds and unknown provider outcomes, by due time.',
    body: 'WorklistQuery',
    transport: [],
    readOnly: true,
    run: (d, actor, args) => d.billing.listWorklist(actor, { ...args }),
  },
];

/**
 * MCP twins of the billing routes. Every handler calls the same domain service REST uses, which
 * authorizes before it validates; invalid arguments are refused after authorization for the same
 * action, so a caller without access gets the identical denial and attempt row.
 */
export const billingTools = (): ToolDefinition[] =>
  BILLING_SPECS.map((spec) => ({
    name: spec.name,
    operationId: spec.operationId,
    description: spec.description,
    inputSchema: schemaFor(spec.body, spec.transport),
    readOnly: spec.readOnly,
    onInvalid: { action: spec.operationId },
    run: (deps, actor, args) => spec.run(deps, actor, args),
  }));

export const BILLING_TOOLS: readonly ToolDefinition[] = billingTools();
