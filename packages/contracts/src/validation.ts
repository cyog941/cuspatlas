import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { auditEventSchema, RefusalError, securityAttemptEventSchema } from './context';

// ajv-formats ships CommonJS; normalise the default export across loaders.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false });
  addFormats(ajv);
  return ajv;
}

const ajv = createAjv();
export const validateAuditEvent: ValidateFunction = ajv.compile(auditEventSchema);
export const validateSecurityAttemptEvent: ValidateFunction = ajv.compile(securityAttemptEventSchema);

/**
 * Converts schema errors into safe violations. A pointer keeps a segment only when it is a property
 * name the schema itself declares, so caller-controlled keys or values never reach a response.
 */
export function safeViolations(
  errors: readonly ErrorObject[] | null | undefined,
  knownProperties: ReadonlySet<string>,
): { pointer: string; rule: string }[] {
  return (errors ?? []).slice(0, 5).map((e) => {
    const segments = e.instancePath.split('/').slice(1);
    const kept: string[] = [];
    for (const s of segments) {
      if (!knownProperties.has(s)) break;
      kept.push(s);
    }
    if (e.keyword === 'required') {
      const missing = (e.params as { missingProperty?: string }).missingProperty;
      if (missing !== undefined && knownProperties.has(missing)) kept.push(missing);
    }
    return {
      pointer: `/${kept.join('/')}`,
      rule: /^[a-zA-Z]{1,32}$/.test(e.keyword) ? e.keyword : 'invalid',
    };
  });
}

export function assertValid<T>(
  validate: ValidateFunction,
  value: unknown,
  knownProperties: ReadonlySet<string>,
): asserts value is T {
  if (!validate(value)) {
    throw new RefusalError({
      code: 'invalid_request',
      detail: { violations: safeViolations(validate.errors, knownProperties) },
    });
  }
}

export function collectPropertyNames(schema: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) collectPropertyNames(s, into);
  } else if (schema !== null && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'properties' && v !== null && typeof v === 'object') {
        for (const name of Object.keys(v)) into.add(name);
      }
      collectPropertyNames(v, into);
    }
  }
  return into;
}
