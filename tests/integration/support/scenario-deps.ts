/**
 * Workspace packages for tests/scenarios (that directory has no package of its own, so bare
 * specifiers resolve here, next to the integration package's dependencies).
 */
export {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
export { createAuthorize, SUPPRESSION_REASONS, SYNTHETIC_TEST_MATCH_KEY_PEPPER } from '@cuspatlas/domain';
export { createOutboundSender } from '@cuspatlas/worker';
