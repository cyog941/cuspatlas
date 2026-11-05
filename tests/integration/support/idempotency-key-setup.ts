import { configureIdempotencyDigestKey, SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY } from '@cuspatlas/domain';

// Integration tests build domain services directly as well as through the API and MCP builders; the
// process key is the test-only key (CUSPATLAS_ENV=synthetic-test), exactly what the builders resolve.
configureIdempotencyDigestKey(SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY);
