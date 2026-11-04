import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          env: { CUSPATLAS_ENV: 'synthetic-test' },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
