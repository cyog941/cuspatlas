// Reduces a raw Vitest JSON report to counts and per-file status only (no test titles or messages,
// which may legitimately mention the synthetic marker), for upload as a CI artifact.
// Usage: node scripts/test-summary.mjs <raw-report.json> [output.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

const [input, output = 'artifacts/test-summary.json'] = process.argv.slice(2);
if (!input) {
  process.stderr.write('usage: test-summary.mjs <raw-report.json> [output.json]\n');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(input, 'utf8'));
const summary = {
  schemaVersion: 1,
  success: raw.success === true,
  // When the run started (Vitest JSON `startTime`, ms since epoch); the evidence manifest compares it
  // with the commit time so evidence from before the commit is rejected as stale.
  testRunAt: Number.isFinite(raw.startTime) ? new Date(raw.startTime).toISOString() : null,
  numTotalTestSuites: raw.numTotalTestSuites,
  numTotalTests: raw.numTotalTests,
  numPassedTests: raw.numPassedTests,
  numFailedTests: raw.numFailedTests,
  numPendingTests: raw.numPendingTests,
  files: (raw.testResults ?? []).map((f) => ({
    file: relative(process.cwd(), String(f.name)).split('\\').join('/'),
    status: f.status,
    tests: (f.assertionResults ?? []).length,
  })),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`test-summary: ${summary.numPassedTests}/${summary.numTotalTests} passed\n`);
