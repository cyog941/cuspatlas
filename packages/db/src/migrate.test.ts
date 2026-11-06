import { describe, expect, it } from 'vitest';
import { isSharedCatalogRace } from './migrate';

describe('isSharedCatalogRace (migration race)', () => {
  it('matches only the two shared-catalog race errors', () => {
    expect(isSharedCatalogRace({ code: 'XX000', message: 'tuple concurrently updated' })).toBe(true);
    expect(isSharedCatalogRace({ code: '23505', constraint: 'pg_authid_rolname_index' })).toBe(true);
  });

  it('never matches any other error', () => {
    expect(isSharedCatalogRace({ code: 'XX000', message: 'cache lookup failed for relation 1' })).toBe(false);
    expect(isSharedCatalogRace({ code: '23505', constraint: 'tenants_pkey' })).toBe(false);
    expect(isSharedCatalogRace({ code: '40001', message: 'tuple concurrently updated' })).toBe(false);
    expect(isSharedCatalogRace(new Error('tuple concurrently updated'))).toBe(false);
    expect(isSharedCatalogRace(null)).toBe(false);
    expect(isSharedCatalogRace('tuple concurrently updated')).toBe(false);
  });
});
