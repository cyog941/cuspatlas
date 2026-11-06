import { resolve } from 'node:path';
import { checkContractDrift, loadContractSources } from './contract-drift';

const problems = checkContractDrift(loadContractSources(resolve(import.meta.dirname, '../../..')));
if (problems.length > 0) {
  for (const p of problems) process.stderr.write(`contract drift: ${p}\n`);
  process.exit(1);
}
process.stdout.write('contract drift check: OpenAPI, JSON Schema and service routes agree\n');
