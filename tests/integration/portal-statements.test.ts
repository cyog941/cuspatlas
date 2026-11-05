import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addGuarantor, postCharge, seedBillingScopes, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { T_ALPHA } from './support/fixtures';
import { seedImagingScopes } from './support/imaging-fixtures';
import { MARKER } from './support/marker';

/**
 * Closeout C: B4 statements releasable to the portal. A staff human releases one generated statement
 * to the portal of its guarantor (the E2 release fact, item kind `billing_statement`) and may revoke
 * it once. The portal `statements` view lists live releases only and the portal read returns the
 * stored, digest-verified snapshot without staff references, through E1 `requirePortalAccess` with
 * relationship scope `financial`. Release and revoke are human-only billing.write commands on REST
 * and MCP, audited, refused cross-tenant, for a role without billing.write and for a revoked member.
 * Synthetic data only.
 */
let db: TestDatabase;
let h: EngagementHarness;
let guarantor: string;
let dependent: string;
let proxy: string;
let other: string;
let guarantorP: string;
let proxyP: string;
let otherP: string;

beforeAll(async () => {
  db = await openTestDatabase('portal_statements');
  h = await openEngagementHarness(db, { mcp: true });
  await seedBillingScopes(db.admin);
  await seedImagingScopes(db.admin);
  guarantor = await h.person(`Synthetic Stmt Guarantor ${MARKER}`, [email('stmt.guarantor')]);
  dependent = await h.person(`Synthetic Stmt Dependent ${MARKER}`, [email('stmt.dependent')]);
  proxy = await h.person(`Synthetic Stmt Proxy ${MARKER}`, [email('stmt.proxy')]);
  other = await h.person(`Synthetic Stmt Other ${MARKER}`, [email('stmt.other')]);
  await addGuarantor(h, dependent, guarantor);
  // A proxy of the guarantor holding `financial` may read the guarantor's released statements.
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${guarantor}/relationships`, {
      counterpartyRef: proxy,
      kind: 'proxy',
      scopes: ['financial'],
      effectiveUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    }),
    201,
  );
  guarantorP = await h.enroll(guarantor, { channel: 'email', value: 'stmt.guarantor@example.invalid' });
  proxyP = await h.enroll(proxy, { channel: 'email', value: 'stmt.proxy@example.invalid' });
  otherP = await h.enroll(other, { channel: 'email', value: 'stmt.other@example.invalid' });
  await postCharge(h, guarantor, 3000);
  await postCharge(h, dependent, 5000);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const generate = async (g: string) =>
  h.ok<{ data: { statementRef: string } }>(
    await h.call('a1', 'POST', '/v1/billing/statements', {
      guarantorRef: g,
      cutoffAt: new Date().toISOString(),
      basis: 'posted_through_cutoff',
    }),
    201,
  ).data.statementRef;
const release = (statementRef: string, who = 'a1', key: string = randomUUID()) =>
  h.call(who, 'POST', `/v1/billing/statements/${statementRef}/portal-releases`, {}, key);
const revoke = (releaseRef: string, who = 'a1') =>
  h.call(who, 'POST', `/v1/billing/statement-releases/${releaseRef}/revoke`, {});
type Item = { releaseRef: string; statementVersion: number; amountDue: unknown; superseded: boolean };
const listed = async (principal: string, patientRef: string) => {
  const v = h.ok<{ data: { coverage: { status: string }; fields: { statements: Item[] } } }>(
    await h.portal(principal, 'GET', `/portal/v1/patients/${patientRef}/views/statements`),
  ).data;
  expect(v.coverage).toStrictEqual({ status: 'available' });
  return v.fields.statements;
};
const readOne = (principal: string, patientRef: string, releaseRef: string) =>
  h.portal(principal, 'GET', `/portal/v1/patients/${patientRef}/statements/${releaseRef}`);

describe('Closeout C: B4 statements on the portal', () => {
  it('a released statement is listed and readable by the guarantor and a financial proxy, without staff refs', async () => {
    const statementRef = await generate(guarantor);
    expect(await listed(guarantorP, guarantor)).toStrictEqual([]);
    const key = randomUUID();
    const r = h.ok<{ data: { releaseRef: string; statementRef: string; patientRef: string; state: string } }>(
      await release(statementRef, 'a1', key),
      201,
    ).data;
    expect(r).toMatchObject({ statementRef, patientRef: guarantor, state: 'released' });
    // Idempotent replay of the same release.
    const again = h.ok<{ data: { releaseRef: string }; replayed: boolean }>(
      await release(statementRef, 'a1', key),
      201,
    );
    expect([again.data.releaseRef, again.replayed]).toStrictEqual([r.releaseRef, true]);
    const items = await listed(guarantorP, guarantor);
    expect(items.map((i) => [i.releaseRef, i.statementVersion, i.amountDue, i.superseded])).toStrictEqual([
      [r.releaseRef, 1, usd(8000), false],
    ]);
    expect(JSON.stringify(items)).not.toContain(statementRef);
    const res = readOne(guarantorP, guarantor, r.releaseRef);
    const body = h.ok<{
      data: Record<string, unknown> & { accounts: { lines: Record<string, unknown>[] }[] };
    }>(await res).data;
    expect(body).toMatchObject({ releaseRef: r.releaseRef, total: usd(8000), integrity: 'verified' });
    expect(body.accounts.flatMap((a) => a.lines.map((l) => Object.keys(l).sort()))).toStrictEqual([
      ['amount', 'kind', 'postedAt', 'serviceDate'],
      ['amount', 'kind', 'postedAt', 'serviceDate'],
    ]);
    expect(JSON.stringify(body)).not.toContain(statementRef);
    expect((await readOne(proxyP, guarantor, r.releaseRef)).statusCode).toBe(200);
    // Audited: the release command and the portal read.
    const { rows } = await db.admin.query(
      'SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at',
      [r.releaseRef],
    );
    expect(rows.map((x) => x.operation)).toStrictEqual(['billing.statements.releaseToPortal']);
    const reads = await db.admin.query(
      "SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE operation = 'portal.statements.read'",
    );
    expect(reads.rows[0].n).toBeGreaterThanOrEqual(2);
    // A second live release of the same statement is refused.
    expect((await release(statementRef)).json().detail?.reason).toBe('already_released');
  });

  it('a revoked release disappears from the view and its read is 404; the row is kept', async () => {
    const statementRef = await generate(guarantor);
    const r = h.ok<{ data: { releaseRef: string } }>(await release(statementRef), 201).data;
    expect((await readOne(guarantorP, guarantor, r.releaseRef)).statusCode).toBe(200);
    h.ok<{ data: { state: string } }>(await revoke(r.releaseRef));
    expect((await listed(guarantorP, guarantor)).map((i) => i.releaseRef)).not.toContain(r.releaseRef);
    expect((await readOne(guarantorP, guarantor, r.releaseRef)).statusCode).toBe(404);
    expect((await revoke(r.releaseRef)).json().detail?.reason).toBe('release_already_revoked');
    const { rows } = await db.admin.query(
      'SELECT revoked_at IS NOT NULL AS revoked FROM cuspatlas.portal_document_releases WHERE id = $1',
      [r.releaseRef],
    );
    expect(rows[0]?.revoked).toBe(true);
    // The superseded first statement cannot be released anew.
    const older = (
      await db.admin.query(
        `SELECT id FROM cuspatlas.billing_statements WHERE guarantor_id = $1 AND statement_version = 1`,
        [guarantor],
      )
    ).rows[0].id as string;
    expect((await release(older)).json().detail?.reason).toBe('statement_superseded');
  });

  it("another patient's portal sees nothing: not listed, not readable, not via another path", async () => {
    const statementRef = await generate(guarantor);
    const r = h.ok<{ data: { releaseRef: string } }>(await release(statementRef), 201).data;
    expect(
      (await h.portal(otherP, 'GET', `/portal/v1/patients/${guarantor}/views/statements`)).statusCode,
    ).toBe(404);
    expect(await listed(otherP, other)).toStrictEqual([]);
    expect((await readOne(otherP, other, r.releaseRef)).statusCode).toBe(404);
    expect((await readOne(otherP, guarantor, r.releaseRef)).statusCode).toBe(404);
    // A statement release is never served by the imaging document path, and vice versa.
    expect(
      (await h.call('a1', 'POST', `/v1/imaging/portal-releases/${r.releaseRef}/revoke`, {})).statusCode,
    ).toBe(404);
    // The dependent's own portal path does not carry the guarantor's statement.
    const dependentP = await h.enroll(dependent, {
      channel: 'email',
      value: 'stmt.dependent@example.invalid',
    });
    expect(await listed(dependentP, dependent)).toStrictEqual([]);
    expect((await readOne(dependentP, dependent, r.releaseRef)).statusCode).toBe(404);
  });

  it('release and revoke: cross-tenant, role, service and revoked-member negatives on REST and MCP', async () => {
    const statementRef = await generate(guarantor);
    const before = await db.admin.query(
      "SELECT count(*)::int AS n FROM cuspatlas.portal_document_releases WHERE item_kind = 'billing_statement'",
    );
    expect((await release(statementRef, 'b1')).statusCode).toBe(404); // another tenant
    expect((await release(statementRef, 'a4')).statusCode).toBe(403); // reads only, no billing.write
    expect((await release(statementRef, 'svcA1')).statusCode).toBe(403); // service principal
    expect([401, 403]).toContain((await release(statementRef, 'a2')).statusCode); // revoked membership
    expect(
      (
        await h.mcp('b1', 'billing_statements_release_to_portal', {
          statementRef,
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.mcp('a4', 'billing_statements_release_to_portal', {
          statementRef,
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(403);
    const after = await db.admin.query(
      "SELECT count(*)::int AS n FROM cuspatlas.portal_document_releases WHERE item_kind = 'billing_statement'",
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // MCP parity: the same release and revoke through the tools.
    const m = await h.mcp(
      'a1',
      'billing_statements_release_to_portal',
      { statementRef, idempotencyKey: randomUUID() },
      201,
    );
    const releaseRef = (m.body as { data: { releaseRef: string } }).data.releaseRef;
    expect(
      (await h.mcp('b1', 'billing_statement_releases_revoke', { releaseRef, idempotencyKey: randomUUID() }))
        .status,
    ).toBe(404);
    expect((await revoke(releaseRef, 'a4')).statusCode).toBe(403);
    expect([401, 403]).toContain((await revoke(releaseRef, 'a2')).statusCode);
    const done = await h.mcp('a1', 'billing_statement_releases_revoke', {
      releaseRef,
      idempotencyKey: randomUUID(),
    });
    expect((done.body as { data: { state: string } }).data.state).toBe('revoked');
    // The database refuses a release naming a patient other than the statement's guarantor.
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.portal_document_releases (tenant_id, patient_id, item_kind, item_id, released_by)
         SELECT $1, $2, 'billing_statement', $3, created_by FROM cuspatlas.billing_statements WHERE id = $3`,
        [T_ALPHA, other, statementRef],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
