import type { RouteContract } from './manifest';

const B = (name: string) => `billing:${name}`;
const READ = ['401', '403', '404', '503'] as const;

/**
 * Route contracts of the billing service (B1 journal, B2 payments and allocations), spread into
 * ROUTES so the drift check and route registration see one table. Every command that posts a journal
 * entry answers 201: the entry is a new resource, even when it belongs to an existing aggregate.
 */
export const BILLING_ROUTES: readonly RouteContract[] = [
  {
    method: 'post',
    path: '/v1/billing/charges',
    operationId: 'billing.charges.post',
    protected: true,
    requestBody: B('ChargePost'),
    success: { status: '201', schema: B('ChargeCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'get',
    path: '/v1/billing/charges/{chargeRef}',
    operationId: 'billing.charges.read',
    protected: true,
    success: { status: '200', schema: B('ChargeRead') },
    refusals: READ,
  },
  {
    method: 'get',
    path: '/v1/billing/entries/{entryRef}',
    operationId: 'billing.entries.read',
    protected: true,
    success: { status: '200', schema: B('JournalEntryRead') },
    refusals: READ,
  },
  {
    method: 'post',
    path: '/v1/billing/entries/{entryRef}/reverse',
    operationId: 'billing.entries.reverse',
    protected: true,
    requestBody: B('EntryReverse'),
    success: { status: '201', schema: B('ReversalCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'get',
    path: '/v1/billing/patients/{patientRef}/ledger',
    operationId: 'billing.ledger.list',
    protected: true,
    success: { status: '200', schema: B('LedgerPage') },
    refusals: ['400', '401', '403', '404', '503'],
  },
  {
    method: 'get',
    path: '/v1/billing/patients/{patientRef}/balance',
    operationId: 'billing.balances.read',
    protected: true,
    success: { status: '200', schema: B('BalanceRead') },
    refusals: ['400', '401', '403', '404', '422', '503'],
  },
];
