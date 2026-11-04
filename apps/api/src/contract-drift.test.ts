import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkContractDrift, loadContractSources } from './contract-drift';

const root = resolve(import.meta.dirname, '../../..');

describe('contract drift check', () => {
  it('passes for the committed OpenAPI document and JSON Schema', () => {
    expect(checkContractDrift(loadContractSources(root))).toStrictEqual([]);
  });

  it('fails when OpenAPI references a schema definition that does not exist', () => {
    const src = loadContractSources(root);
    const openapiText = src.openapiText.replace(
      '#/$defs/SyntheticTaskCreate',
      '#/$defs/SyntheticTaskCreateV0',
    );
    expect(checkContractDrift({ ...src, openapiText }).join('\n')).toMatch(/SyntheticTaskCreateV0/);
  });

  it('fails when OpenAPI documents an operation the service does not implement, or omits one it does', () => {
    const src = loadContractSources(root);
    const extra = src.openapiText.replace(
      'paths:\n',
      'paths:\n  /v1/ghost:\n    get:\n      operationId: ghost.read\n      responses: {}\n',
    );
    expect(checkContractDrift({ ...src, openapiText: extra }).join('\n')).toMatch(/ghost/);
    const missing = src.openapiText.replace(
      /operationId: syntheticTasks\.relabel/,
      'operationId: syntheticTasks.renamed',
    );
    expect(checkContractDrift({ ...src, openapiText: missing }).join('\n')).toMatch(
      /syntheticTasks\.relabel/,
    );
  });

  it('fails when the schema loosens additionalProperties or label bounds', () => {
    const src = loadContractSources(root);
    const schema = JSON.parse(src.schemaText);
    schema.$defs.SyntheticTaskCreate.additionalProperties = true;
    schema.$defs.Label.maxLength = 500;
    const problems = checkContractDrift({ ...src, schemaText: JSON.stringify(schema) }).join('\n');
    expect(problems).toMatch(/additionalProperties/);
    expect(problems).toMatch(/maxLength/);
  });

  it('fails when the refusal code enum diverges from the shared contract', () => {
    const src = loadContractSources(root);
    const schema = JSON.parse(src.schemaText);
    schema.$defs.Refusal.properties.code.enum.push('teapot');
    expect(checkContractDrift({ ...src, schemaText: JSON.stringify(schema) }).join('\n')).toMatch(/Refusal/);
    expect(readFileSync(resolve(root, 'docs/api/openapi.yaml'), 'utf8')).toContain(
      'synthetic-task.schema.json',
    );
  });
});
