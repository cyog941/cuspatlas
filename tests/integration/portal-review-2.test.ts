import { randomUUID } from 'node:crypto';
import type { TenantTransaction, WithTenantTransaction } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createEngagementService,
  createPatientService,
  SYNTHETIC_TEST_MATCH_KEY_PEPPER,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { T_ALPHA, T_BETA, USER_A1 } from './support/fixtures';

/**
 * Independent review of E4-E9, second pass: portal-side items (lock ordering, abuse bounds on
 * threads, messages and forms, attachment references, review atomicity). Synthetic data only.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let victim: string;
let victimP: string;
let stranger: string;
let strangerP: string;
const REQ = (p: string) => `/portal/v1/patients/${p}/appointment-requests`;

beforeAll(async () => {
  db = await openTestDatabase('portal_review_2');
  h = await openEngagementHarness(db);
  loc = await seedLocation(h, 'loc-portal-rv2');
  victim = await h.person('Synthetic Lock Victim', [email('rv2.victim')]);
  victimP = await h.enroll(victim, { channel: 'email', value: 'rv2.victim@example.invalid' });
  stranger = await h.person('Synthetic Lock Stranger', [email('rv2.stranger')]);
  strangerP = await h.enroll(stranger, { channel: 'email', value: 'rv2.stranger@example.invalid' });
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('item 6: bounds locks are taken only after a relationship pre-check', () => {
  it('an unrelated portal principal is refused without waiting on a lock held on another patient', async () => {
    const holder = await db.admin.connect();
    await holder.query('BEGIN');
    try {
      await holder.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1 FOR UPDATE', [victim]);
      const attempt = h.portal(strangerP, 'POST', REQ(victim), {
        locationRef: loc.locationRef,
        flexibility: 'mornings',
        contactConsent: 'granted',
      });
      const outcome = await Promise.race([
        attempt.then((r) => r.statusCode),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked_on_lock'), 4000)),
      ]);
      expect(outcome).toBe(404);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // The victim's own principal still submits normally once the lock is gone.
    const own = await h.portal(victimP, 'POST', REQ(victim), {
      locationRef: loc.locationRef,
      flexibility: 'mornings',
      contactConsent: 'granted',
    });
    expect(own.statusCode).toBe(201);
  });
});

/** Holds each transaction right after its bound count until `n` have counted (or 1.5 s pass). */
function gatedRunner(match: RegExp, n: number): WithTenantTransaction {
  const inner = createTenantTransactionRunner(db.appPool(12));
  let arrived = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return (ctx, work) =>
    inner(ctx, (tx) => {
      const gated: TenantTransaction = {
        ctx: tx.ctx,
        savepoint: (w) => tx.savepoint(w),
        async query(text, values) {
          const r = await tx.query(text, values);
          if (match.test(text)) {
            arrived += 1;
            if (arrived >= n) open();
            await Promise.race([gate, new Promise((res) => setTimeout(res, 1500))]);
          }
          return r as never;
        },
      };
      return work(gated);
    });
}
function portalService(runner: WithTenantTransaction) {
  return createEngagementService({
    authorize: createAuthorize(createMembershipSource(db.app)),
    withTenantTransaction: runner,
    recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
    matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
  });
}
const portalCtx = (principal: string) => ({
  tenantId: T_ALPHA,
  actorId: principal,
  principal: 'portal' as const,
  sessionId: randomUUID(),
  scopes: [] as string[],
  correlationId: randomUUID(),
});
const outcome = async (work: Promise<unknown>): Promise<number> => {
  try {
    await work;
    return 201;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === 'rate_limited' ? 429 : code === 'conflict' ? 409 : 500;
  }
};
const THREADS = (p: string) => `/portal/v1/patients/${p}/message-threads`;
const attemptsOf = async (principal: string) =>
  (
    await db.admin.query(
      `SELECT reason_code FROM cuspatlas.security_attempt_events WHERE actor_id = $1 AND reason_code = 'portal_rate_limited'`,
      [principal],
    )
  ).rows.length;

describe('item 7: portal threads, messages and forms have abuse bounds that hold under concurrency', () => {
  it('open threads per patient: ten, the eleventh is 429 with an attempt row; concurrent opens stay within ten', async () => {
    const p = await h.person('Synthetic Thread Bound', [email('rv2.threadbound')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'rv2.threadbound@example.invalid' });
    for (let i = 0; i < 10; i += 1) {
      h.ok(
        await h.portal(principal, 'POST', THREADS(p), {
          topic: 'general',
          locationRef: loc.locationRef,
          body: `T${i}`,
        }),
        201,
      );
    }
    const eleventh = await h.portal(principal, 'POST', THREADS(p), {
      topic: 'general',
      locationRef: loc.locationRef,
      body: 'T6',
    });
    expect([eleventh.statusCode, eleventh.json().detail.limit.name]).toStrictEqual([
      429,
      'portalOpenThreadsPerPatient',
    ]);
    expect(await attemptsOf(principal)).toBe(1);

    const q = await h.person('Synthetic Thread Bound Two', [email('rv2.threadbound2')]);
    const qp = await h.enroll(q, { channel: 'email', value: 'rv2.threadbound2@example.invalid' });
    // Eight open portal threads already (written directly); four concurrent opens may add only two.
    const loc0 = await db.admin.query('SELECT id FROM cuspatlas.scheduling_locations LIMIT 1');
    await db.admin.query(
      `INSERT INTO cuspatlas.message_threads (tenant_id, patient_id, location_id, topic, queue, awaiting, opened_via, opened_by)
       SELECT $1, $2, $3, 'general', 'front_desk', 'practice', 'portal', $4 FROM generate_series(1, 8)`,
      [T_ALPHA, q, loc0.rows[0].id, qp],
    );
    const svc = portalService(gatedRunner(/opened_via = 'portal' AND state = 'open'/, 4));
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        outcome(
          svc.openPortalThread(portalCtx(qp), q, {
            operation: 'portal.threads.open',
            idempotencyKey: randomUUID(),
            payload: { topic: 'general', locationRef: loc.locationRef, body: `C${i}` },
          }),
        ),
      ),
    );
    expect(results.filter((c) => c === 201)).toHaveLength(2);
    expect(results.every((c) => c === 201 || c === 429)).toBe(true);
    const n = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.message_threads WHERE patient_id = $1',
      [q],
    );
    expect(n.rows[0].n).toBe(10);
  });

  it('messages per principal per day: the cap holds sequentially and for concurrent posts', async () => {
    const p = await h.person('Synthetic Message Bound', [email('rv2.msgbound')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'rv2.msgbound@example.invalid' });
    const t = h.ok<{ data: { threadRef: string } }>(
      await h.portal(principal, 'POST', THREADS(p), {
        topic: 'general',
        locationRef: loc.locationRef,
        body: 'first',
      }),
      201,
    ).data.threadRef;
    // 47 more portal messages already today (the opening message counts too): 48 in all.
    await db.admin.query(
      `INSERT INTO cuspatlas.thread_messages (tenant_id, thread_id, author_id, author_kind, body)
       SELECT $1, $2, $3, 'portal', 'bulk ' || g FROM generate_series(1, 47) g`,
      [T_ALPHA, t, principal],
    );
    const svc = portalService(gatedRunner(/author_kind = 'portal'\s+AND created_at/, 4));
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        outcome(
          svc.postPortalMessage(portalCtx(principal), p, t, {
            operation: 'portal.threads.post',
            idempotencyKey: randomUUID(),
            payload: { body: `race ${i}` },
          }),
        ),
      ),
    );
    expect(results.filter((c) => c === 201)).toHaveLength(2);
    const over = await h.portal(principal, 'POST', `${THREADS(p)}/${t}/messages`, { body: 'one too many' });
    expect([over.statusCode, over.json().detail.limit.name]).toStrictEqual([429, 'portalMessagesPerDay']);
    const total = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.thread_messages WHERE author_id = $1 AND author_kind = 'portal'`,
      [principal],
    );
    expect(total.rows[0].n).toBe(50);
  });

  it('form submissions per principal per day: ten, then 429; concurrent submissions stay within ten', async () => {
    h.ok(
      await h.call('a1', 'POST', '/v1/intake/forms', {
        formRef: 'rv2-bound-intake',
        title: 'Synthetic bound intake',
        fields: [{ key: 'agree', label: 'Agree', kind: 'boolean', required: true }],
        consents: [],
      }),
      201,
    );
    const p = await h.person('Synthetic Form Bound', [email('rv2.formbound')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'rv2.formbound@example.invalid' });
    const submit = () =>
      h.portal(principal, 'POST', `/portal/v1/patients/${p}/intake-submissions`, {
        formRef: 'rv2-bound-intake',
        formVersion: 1,
        answers: { agree: true },
      });
    for (let i = 0; i < 8; i += 1) h.ok(await submit(), 201);
    const svc = portalService(gatedRunner(/submitted_via = 'portal'/, 4));
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        outcome(
          svc.submitPortalForm(portalCtx(principal), p, {
            operation: 'portal.forms.submit',
            idempotencyKey: randomUUID(),
            payload: { formRef: 'rv2-bound-intake', formVersion: 1, answers: { agree: true } },
          }),
        ),
      ),
    );
    expect(results.filter((c) => c === 201)).toHaveLength(2);
    const eleventh = await submit();
    expect([eleventh.statusCode, eleventh.json().detail.limit.name]).toStrictEqual([
      429,
      'portalFormSubmissionsPerDay',
    ]);
    const total = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.intake_submissions WHERE submitted_by = $1',
      [principal],
    );
    expect(total.rows[0].n).toBe(10);
  });
});

describe('item 8: attachment references are validated through the I port', () => {
  it('a spoofed, foreign-patient or foreign-tenant reference is refused on portal and staff paths; a real one is accepted', async () => {
    const p = await h.person('Synthetic Attach Owner', [email('rv2.attach')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'rv2.attach@example.invalid' });
    const other = await h.person('Synthetic Attach Other', [email('rv2.attach.other')]);
    const real = h.attachments.register(T_ALPHA, p, 'imageRef', randomUUID());
    const ofOther = h.attachments.register(T_ALPHA, other, 'imageRef', randomUUID());
    const ofBeta = h.attachments.register(T_BETA, p, 'imageRef', randomUUID());
    const open = (ref: string, kind = 'imageRef') =>
      h.portal(principal, 'POST', THREADS(p), {
        topic: 'general',
        locationRef: loc.locationRef,
        body: 'With attachment',
        attachments: [{ kind, ref }],
      });
    for (const spoof of [randomUUID(), ofOther, ofBeta]) {
      const r = await open(spoof);
      expect([r.statusCode, r.json().detail.violations[0].rule]).toStrictEqual([422, 'attachmentRefInvalid']);
    }
    // The right reference of the wrong kind is not that reference.
    expect((await open(real, 'objectRef')).statusCode).toBe(422);
    const threadsBefore = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.message_threads WHERE patient_id = $1',
      [p],
    );
    expect(threadsBefore.rows[0].n).toBe(0);
    const ok = h.ok<{ data: { threadRef: string } }>(await open(real), 201).data;
    // Posting into the thread and the staff paths validate the same way.
    const post = await h.portal(principal, 'POST', `${THREADS(p)}/${ok.threadRef}/messages`, {
      body: 'Again',
      attachments: [{ kind: 'imageRef', ref: ofOther }],
    });
    expect(post.statusCode).toBe(422);
    const staffOpen = await h.call('a1', 'POST', `/v1/patients/${p}/message-threads`, {
      topic: 'general',
      locationRef: loc.locationRef,
      body: 'Staff attachment',
      attachments: [{ kind: 'imageRef', ref: ofOther }],
    });
    expect(staffOpen.statusCode).toBe(422);
    const staffReply = await h.call('a1', 'POST', `/v1/messaging/threads/${ok.threadRef}/messages`, {
      body: 'Staff reply',
      attachments: [{ kind: 'imageRef', ref: randomUUID() }],
    });
    expect(staffReply.statusCode).toBe(422);
  });
});

describe('item 9: applying an intake review is atomic with resolving it', () => {
  it('a failure after S4 applied the answer rolls both back; the retry applies once', async () => {
    h.ok(
      await h.call('a1', 'POST', '/v1/intake/forms', {
        formRef: 'rv2-demo-intake',
        title: 'Synthetic demographics intake',
        fields: [
          {
            key: 'preferred_name',
            label: 'Preferred name',
            kind: 'text',
            required: false,
            target: 'demographics.preferredName',
          },
        ],
        consents: [],
      }),
      201,
    );
    const p = await h.person('Synthetic Atomic Review', [email('rv2.atomic')], {
      preferredName: { known: true, value: 'Old' },
    });
    const principal = await h.enroll(p, { channel: 'email', value: 'rv2.atomic@example.invalid' });
    const sub = h.ok<{ data: { submissionRef: string; demographicsReview: boolean } }>(
      await h.portal(principal, 'POST', `/portal/v1/patients/${p}/intake-submissions`, {
        formRef: 'rv2-demo-intake',
        formVersion: 1,
        answers: { preferred_name: 'New' },
      }),
      201,
    ).data;
    expect(sub.demographicsReview).toBe(true);
    const reviewRef = (
      await db.admin.query('SELECT id FROM cuspatlas.intake_review_items WHERE submission_id = $1', [
        sub.submissionRef,
      ])
    ).rows[0].id as string;
    const review = h.ok<{ data: { version: number; patientVersion: number } }>(
      await h.call('a1', 'GET', `/v1/intake/reviews/${reviewRef}`),
    ).data;

    // A runner that fails the item's resolution UPDATE once, after S4's update ran in the same transaction.
    const inner = createTenantTransactionRunner(db.appPool(4));
    let armed = true;
    const faulty: WithTenantTransaction = (ctx, work) =>
      inner(ctx, (tx) =>
        work({
          ctx: tx.ctx,
          savepoint: (w) => tx.savepoint(w),
          async query(text, values) {
            if (armed && /UPDATE cuspatlas\.intake_review_items SET state/.test(text)) {
              armed = false;
              throw new Error('injected failure after the S4 update');
            }
            return tx.query(text, values) as never;
          },
        }),
      );
    const authorize = createAuthorize(createMembershipSource(db.app));
    const recording = { sink: createSecurityAttemptSink(db.sink), alert: () => undefined };
    const patients = createPatientService({
      matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
      authorize,
      withTenantTransaction: faulty,
      recording,
    });
    const svc = createEngagementService({
      authorize,
      patients,
      withTenantTransaction: faulty,
      recording,
      matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
    });
    const staff = {
      tenantId: T_ALPHA,
      actorId: USER_A1,
      principal: 'human' as const,
      sessionId: randomUUID(),
      scopes: ['patients.write', 'patients.read'],
      correlationId: randomUUID(),
    };
    const envelope = {
      operation: 'intake.reviews.resolve',
      idempotencyKey: randomUUID(),
      payload: { decision: 'apply', expectedVersion: review.version, patientVersion: review.patientVersion },
    };
    await expect(svc.resolveReview(staff, reviewRef, envelope)).rejects.toThrow(/injected failure/);
    const after = await db.admin.query(
      `SELECT p.version, p.preferred_name->>'value' AS name, r.state, r.version AS rv
       FROM cuspatlas.patients p, cuspatlas.intake_review_items r WHERE p.id = $1 AND r.id = $2`,
      [p, reviewRef],
    );
    expect(after.rows[0]).toStrictEqual({
      version: review.patientVersion,
      name: 'Old',
      state: 'open',
      rv: review.version,
    });
    // The retry (same key) applies exactly once.
    const done = await svc.resolveReview(staff, reviewRef, envelope);
    expect(done.data).toMatchObject({ state: 'applied', appliedPatientVersion: review.patientVersion + 1 });
    const final = await db.admin.query(
      `SELECT version, preferred_name->>'value' AS name FROM cuspatlas.patients WHERE id = $1`,
      [p],
    );
    expect(final.rows[0]).toStrictEqual({ version: review.patientVersion + 1, name: 'New' });
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE resource_ref = $1 AND operation = 'patients.updateDemographics'`,
      [p],
    );
    expect(audit.rows[0].n).toBe(1);
  });
});

describe('nits: database agreements and typed conflicts', () => {
  it('a closed thread cannot reopen; the writing principal must match the side of the record; a review item agrees with its submission', async () => {
    const p = await h.person('Synthetic Db Agreement', [email('rv2.dbagree')]);
    const principal = await h.enroll(p, { channel: 'email', value: 'rv2.dbagree@example.invalid' });
    const t = h.ok<{ data: { threadRef: string } }>(
      await h.portal(principal, 'POST', THREADS(p), {
        topic: 'general',
        locationRef: loc.locationRef,
        body: 'x',
      }),
      201,
    ).data.threadRef;
    const read = h.ok<{ data: { version: number } }>(
      await h.call('a1', 'GET', `/v1/messaging/threads/${t}`),
    ).data;
    h.ok(
      await h.call('a1', 'POST', `/v1/messaging/threads/${t}/close`, {
        expectedVersion: read.version,
        reasonCode: 'resolved',
      }),
    );
    await expect(
      db.admin.query(
        `UPDATE cuspatlas.message_threads SET state = 'open', closed_at = NULL, version = version + 1 WHERE id = $1`,
        [t],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // A staff-side message written by a portal principal (and the reverse) is refused by the database.
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.thread_messages (tenant_id, thread_id, author_id, author_kind, body) VALUES ($1, $2, $3, 'staff', 'spoof')`,
        [T_ALPHA, t, principal],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.thread_messages (tenant_id, thread_id, author_id, author_kind, body) VALUES ($1, $2, $3, 'portal', 'spoof')`,
        [T_ALPHA, t, USER_A1],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // A review item must name the patient of its submission.
    h.ok(
      await h.call('a1', 'POST', '/v1/intake/forms', {
        formRef: 'rv2-agree-intake',
        title: 'Synthetic agreement intake',
        fields: [{ key: 'agree', label: 'Agree', kind: 'boolean', required: true }],
        consents: [],
      }),
      201,
    );
    const sub = h.ok<{ data: { submissionRef: string } }>(
      await h.portal(principal, 'POST', `/portal/v1/patients/${p}/intake-submissions`, {
        formRef: 'rv2-agree-intake',
        formVersion: 1,
        answers: { agree: true },
      }),
      201,
    ).data.submissionRef;
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.intake_review_items (tenant_id, submission_id, patient_id, kind, proposed, payload_ref)
         VALUES ($1, $2, $3, 'demographics_update', '{}'::jsonb, $4)`,
        [T_ALPHA, sub, victim, `intake-submission:${sub}`],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('concurrent publication of one form version never yields a 500', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.call('a1', 'POST', '/v1/intake/forms', {
          formRef: 'rv2-concurrent-form',
          title: 'Synthetic concurrent form',
          fields: [{ key: 'agree', label: 'Agree', kind: 'boolean', required: true }],
          consents: [],
        }),
      ),
    );
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    const versions = await db.admin.query(
      `SELECT version FROM cuspatlas.intake_form_versions WHERE form_ref = 'rv2-concurrent-form' ORDER BY version`,
    );
    expect(versions.rows.map((v) => v.version)).toStrictEqual(
      Array.from({ length: versions.rows.length }, (_, i) => i + 1),
    );
  });
});
