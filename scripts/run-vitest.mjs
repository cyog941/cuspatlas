// Runs `vitest run` and drops a literal `--` so `pnpm test -- <filter>` filters as documented in the plan.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('vitest/package.json');
const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin.vitest;
const args = process.argv.slice(2).filter((a) => a !== '--');
const result = spawnSync(process.execPath, [join(dirname(pkgPath), bin), 'run', ...args], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
