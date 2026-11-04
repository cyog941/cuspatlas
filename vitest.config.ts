import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          // Scenarios share the integration database server (one global setup).
          include: ['tests/integration/*.test.ts', 'tests/scenarios/*.test.ts'],
          globalSetup: ['tests/integration/support/global-setup.ts'],
          env: { CUSPATLAS_ENV: 'synthetic-test' },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
