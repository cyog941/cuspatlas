import { describe, expect, it } from 'vitest';
import { REFUSAL_CODES, REFUSAL_HTTP_STATUS, RefusalError } from './context';
import {
  collectPropertyNames,
  safeViolations,
  validateAuditEvent,
  validateSecurityAttemptEvent,
} from './validation';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('runtime event schemas', () => {
  const attempt = {
    attemptRef: A,
    correlationId: B,
    tenantId: null,
    actorId: null,
    operation: 'syntheticTasks.create',
    reasonCode: 'token_invalid',
    occurredAt: '2026-11-03T12:00:00.000Z',
  };

  it('accepts an unauthenticated attempt with null tenant and actor, never requiring fabricated identity', () => {
    expect(validateSecurityAttemptEvent(attempt)).toBe(true);
  });

  it('rejects attempts carrying extra fields such as a payload or free-text reason', () => {
    expect(validateSecurityAttemptEvent({ ...attempt, payload: { label: 'x' } })).toBe(false);
    expect(validateSecurityAttemptEvent({ ...attempt, reasonCode: 'because the caller said so' })).toBe(
      false,
    );
    expect(validateSecurityAttemptEvent({ ...attempt, tenantId: 'tenant-alpha' })).toBe(false);
  });

  it('requires authenticated tenant and actor on committed audit events', () => {
    const audit = {
      eventRef: A,
      tenantId: A,
      actorId: B,
      principal: 'human',
      operation: 'syntheticTasks.create',
      resourceType: 'syntheticTask',
      resourceRef: B,
      resourceVersion: 1,
      correlationId: A,
      occurredAt: '2026-11-03T12:00:00.000Z',
    };
    expect(validateAuditEvent(audit)).toBe(true);
    expect(validateAuditEvent({ ...audit, tenantId: null })).toBe(false);
    expect(validateAuditEvent({ ...audit, body: 'x' })).toBe(false);
  });
});

describe('refusal contract', () => {
  it('maps every refusal code to a non-2xx status', () => {
    for (const code of REFUSAL_CODES) {
      expect(REFUSAL_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('never exposes the internal reason code to callers', () => {
    const r = new RefusalError({ code: 'forbidden', reasonCode: 'scope_missing' }).toRefusal(A);
    expect(r).toStrictEqual({ code: 'forbidden', retryable: false, correlationId: A });
  });

  it('keeps only schema-declared property names in violation pointers', () => {
    const known = collectPropertyNames({ properties: { label: {}, nested: { properties: { x: {} } } } });
    const v = safeViolations(
      [
        { instancePath: '/label', keyword: 'maxLength', schemaPath: '', params: {} },
        { instancePath: '/SYNTHETIC_SECRET_42/x', keyword: 'type', schemaPath: '', params: {} },
        { instancePath: '', keyword: 'required', schemaPath: '', params: { missingProperty: 'label' } },
      ],
      known,
    );
    expect(v).toStrictEqual([
      { pointer: '/label', rule: 'maxLength' },
      { pointer: '/', rule: 'type' },
      { pointer: '/label', rule: 'required' },
    ]);
  });
});
