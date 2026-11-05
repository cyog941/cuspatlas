// Regenerates the BILLING_OPS block of docs/api/openapi.yaml from the operation table and the billing
// JSON Schema: `corepack pnpm run openapi:billing`. The contract drift check renders the same block and
// fails when the committed document differs, so the generator and the document cannot drift apart.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BILLING_OPS, renderBillingOpsBlock, spliceBillingOpsBlock } from '../apps/api/src/index';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'docs/api/openapi.yaml');
const defs = JSON.parse(
  readFileSync(resolve(root, 'packages/contracts/src/billing.schema.json'), 'utf8'),
).$defs;
writeFileSync(
  file,
  spliceBillingOpsBlock(readFileSync(file, 'utf8'), renderBillingOpsBlock(BILLING_OPS, defs)),
);
process.stdout.write(`openapi: wrote ${BILLING_OPS.length} billing operations\n`);
