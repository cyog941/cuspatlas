// Regenerates the AUTOMATION_OPS block of docs/api/openapi.yaml from the workstream A batch 4 operation
// table (A14 webhooks, A15 exports) and the automation JSON Schema: `corepack pnpm run openapi:automation`.
// The contract drift check renders the same block and fails when the committed document differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTOMATION_OPS,
  AUTOMATION_OPS_BLOCK,
  renderAutomationOpsBlock,
  spliceOpsBlock,
} from '../apps/api/src/index';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'docs/api/openapi.yaml');
const defs = JSON.parse(
  readFileSync(resolve(root, 'packages/contracts/src/automation.schema.json'), 'utf8'),
).$defs;
writeFileSync(
  file,
  spliceOpsBlock(readFileSync(file, 'utf8'), renderAutomationOpsBlock(defs), AUTOMATION_OPS_BLOCK),
);
process.stdout.write(`openapi: wrote ${AUTOMATION_OPS.length} automation operations\n`);
