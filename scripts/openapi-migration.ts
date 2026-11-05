// Regenerates the MIGRATION_OPS block of docs/api/openapi.yaml from the operation table and the
// migration JSON Schema: `corepack pnpm run openapi:migration`. The contract drift check renders the
// same block and fails when the committed document differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MIGRATION_OPS, renderMigrationOpsBlock, spliceMigrationOpsBlock } from '../apps/api/src/index';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'docs/api/openapi.yaml');
const defs = JSON.parse(
  readFileSync(resolve(root, 'packages/contracts/src/migration.schema.json'), 'utf8'),
).$defs;
writeFileSync(
  file,
  spliceMigrationOpsBlock(readFileSync(file, 'utf8'), renderMigrationOpsBlock(MIGRATION_OPS, defs)),
);
process.stdout.write(`openapi: wrote ${MIGRATION_OPS.length} migration operations\n`);
