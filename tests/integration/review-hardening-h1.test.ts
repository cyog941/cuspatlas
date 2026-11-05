import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BillingDeps } from '@cuspatlas/domain';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/catalog/build-catalog';

/** Hardening H1 review fixes that are checked statically (synthetic, no database). */
describe('H1 R8 claims attachment source', () => {
  it('BillingDeps requires an explicit attachment source; the worker passes the I3 source', () => {
    // @ts-expect-error R8: `attachments` is required (no silent fake default outside fixtures).
    const missing: Pick<BillingDeps, 'attachments'> = {};
    expect(missing).toStrictEqual({});
    const worker = readFileSync(resolve(ROOT, 'apps/worker/src/compose.ts'), 'utf8');
    expect(worker).toMatch(/attachments: createImagingAttachmentSource\(\)/);
    const claims = readFileSync(resolve(ROOT, 'packages/domain/src/rcm/claims.ts'), 'utf8');
    expect(claims).not.toMatch(/objects: AttachmentSourcePort = createFakeAttachmentSource\(\)/);
  });
});
