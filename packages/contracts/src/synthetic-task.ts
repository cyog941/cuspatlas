import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './synthetic-task.schema.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/** Types mirroring synthetic-task.schema.json. The JSON Schema is authoritative for validation. */
export interface SyntheticTaskCreate {
  readonly label: string;
  readonly locationRef?: string;
}
export interface SyntheticTaskRelabel {
  readonly label: string;
  readonly expectedVersion: number;
}
export interface SyntheticTaskListQuery {
  readonly limit?: string;
  readonly cursor?: string;
}
export interface SyntheticTask {
  readonly taskRef: string;
  readonly label: string;
  readonly locationRef: string | null;
  readonly version: number;
}
export interface SyntheticTaskList {
  readonly data: readonly SyntheticTask[];
  readonly nextCursor: string | null;
}

export const syntheticTaskSchema = schema;
export const SYNTHETIC_TASK_SCHEMA_ID = schema.$id;
export const SYNTHETIC_TASK_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateSyntheticTaskCreate = def('SyntheticTaskCreate');
export const validateSyntheticTaskRelabel = def('SyntheticTaskRelabel');
export const validateSyntheticTaskListQuery = def('SyntheticTaskListQuery');
export const validateIdempotencyKey = def('IdempotencyKey');
export const validateTaskRef = def('TaskRef');
