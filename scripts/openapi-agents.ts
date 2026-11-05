// Regenerates the AGENT_OPS block of docs/api/openapi.yaml from the workstream A batch 2 operation
// table and the agents JSON Schema: `corepack pnpm run openapi:agents`. The contract drift check
// renders the same block and fails when the committed document differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGENT_OPS, AGENT_OPS_BLOCK, renderAgentOpsBlock, spliceOpsBlock } from '../apps/api/src/index';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'docs/api/openapi.yaml');
const defs = JSON.parse(
  readFileSync(resolve(root, 'packages/contracts/src/agents.schema.json'), 'utf8'),
).$defs;
writeFileSync(file, spliceOpsBlock(readFileSync(file, 'utf8'), renderAgentOpsBlock(defs), AGENT_OPS_BLOCK));
process.stdout.write(`openapi: wrote ${AGENT_OPS.length} agent operations\n`);
