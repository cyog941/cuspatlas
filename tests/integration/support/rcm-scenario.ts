/**
 * Package re-exports for tests/scenarios (which resolve workspace packages through this integration
 * package): the refusal type and the fake clearinghouse of the closed-loop claims scenario.
 */
export { RefusalError } from '@cuspatlas/contracts';
export { createFakeClearinghouse } from '@cuspatlas/domain';
