export {
  createFakeEligibilityAdapter,
  type EligibilityAnswer,
  type EligibilityPort,
  type EligibilityRequest,
} from '../rcm/coverage';
export { type BillingDeps, mergeSet } from './base';
export { BILLING_REPLAY_CODECS } from './codecs';
export { assertBalancedEntry, type EntryInput, type LineInput } from './journal';
export { BILLING_POST_MERGE_PROBE } from './merge-probe';
export {
  type CaptureRequest,
  createSyntheticPaymentProvider,
  type PaymentProviderPort,
  type ProviderAnswer,
} from './payment-port';
export { type BillingService, createBillingService } from './service';
