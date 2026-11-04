import type { TenantTransaction } from '@cuspatlas/contracts';
import type { ImageRefResolution, ImageRefResolver } from '@cuspatlas/domain';

/**
 * Test double for the I3 seam (C15 `ImageRefResolver`): I owns image objects, storage, digests and the
 * patient association; C asks only "what does this imageRef currently resolve to". Records are keyed by
 * tenant, so another tenant's imageRef is `not_found`, exactly as a missing one. Synthetic data only.
 */
export interface FakeImageResolver extends ImageRefResolver {
  put(tenant: string, imageRef: string, r: ImageRefResolution): void;
}

export function fakeImageResolver(): FakeImageResolver {
  const records = new Map<string, ImageRefResolution>();
  const tenantOf = async (tx: TenantTransaction) =>
    (await tx.query<{ t: string }>('SELECT cuspatlas.current_tenant_id()::text AS t')).rows[0]?.t ?? '';
  return {
    put(tenant, imageRef, r) {
      records.set(`${tenant}:${imageRef}`, r);
    },
    async resolve(tx, imageRef) {
      return records.get(`${await tenantOf(tx)}:${imageRef}`) ?? { status: 'not_found' };
    },
  };
}
