import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { MARKER } from './support/marker';

/**
 * E4 intake forms (synthetic content; clinical sign-off pending). Submissions are append-only facts
 * bound to a form version, idempotent on their key, with provenance; intake consent becomes E6 facts
 * once; demographic answers reach S4 only through a staff review applied by S4's own command; medical
 * history is handed to C8 by reference only. Treatment consent (C13) is never captured here.
 */
let db: TestDatabase;
let h: EngagementHarness;
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };
let adult: string;
let adultP: string;
let kid: string;
let parent: string;
let parentP: string;
let proxyP: string;
let stranger: string;

const FORM = {
  formRef: 'synthetic-intake',
  title: 'Synthetic new patient intake',
  fields: [
    {
      key: 'preferred_name',
      label: 'Preferred name',
      kind: 'text',
      required: false,
      target: 'demographics.preferredName',
    },
    {
      key: 'language',
      label: 'Preferred language',
      kind: 'text',
      required: false,
      target: 'demographics.language',
    },
    {
      key: 'visit_reason',
      label: 'Reason for visit',
      kind: 'choice',
      required: true,
      options: ['checkup', 'concern'],
    },
    {
      key: 'allergies',
      label: 'Allergies (synthetic)',
      kind: 'text',
      required: false,
      target: 'medical_history',
    },
    { key: 'agree_policy', label: 'I read the office policy', kind: 'boolean', required: true },
  ],
  consents: [
    {
      key: 'email_reminders',
      label: 'Email me appointment reminders',
      channel: 'email',
      purpose: 'reminders',
      consentVersion: 'synthetic-intake-1',
    },
  ],
};
const answers = (extra: Record<string, unknown> = {}) => ({
  visit_reason: 'checkup',
  agree_policy: true,
  ...extra,
});
const SUBMIT = (p: string) => `/portal/v1/patients/${p}/intake-submissions`;
type Sub = {
  submissionRef: string;
  formVersion: number;
  viaRelationshipRef: string | null;
  consentCount: number;
  demographicsReview: boolean;
  historyHandoff: boolean;
};

beforeAll(async () => {
  db = await openTestDatabase('portal_intake');
  h = await openEngagementHarness(db, { mcp: true });
  adult = await h.person(`Synthetic Intake Adult ${MARKER}`, [email('e4.adult')]);
  kid = await h.person('Synthetic Intake Kid', [], { birthDate: MINOR });
  parent = await h.person('Synthetic Intake Parent', [email('e4.parent')]);
  const proxy = await h.person('Synthetic Intake Proxy', [email('e4.proxy')]);
  stranger = await h.person('Synthetic Intake Stranger', [email('e4.stranger')]);
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${kid}/relationships`, {
      counterpartyRef: parent,
      kind: 'guardian',
      scopes: ['demographics', 'consent', 'scheduling'],
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${kid}/relationships`, {
      counterpartyRef: proxy,
      kind: 'proxy',
      scopes: ['demographics'],
      effectiveUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    }),
    201,
  );
  adultP = await h.enroll(adult, { channel: 'email', value: 'e4.adult@example.invalid' });
  parentP = await h.enroll(parent, { channel: 'email', value: 'e4.parent@example.invalid' });
  proxyP = await h.enroll(proxy, { channel: 'email', value: 'e4.proxy@example.invalid' });
  h.ok(await h.call('a1', 'POST', '/v1/intake/forms', FORM), 201);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const submit = async (who: string, patient: string, body: Record<string, unknown>, key?: string) =>
  h.portal(who, 'POST', SUBMIT(patient), { formRef: FORM.formRef, formVersion: 1, ...body }, key);
const rowCount = async (table: string, where = 'true', args: unknown[] = []) =>
  (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table} WHERE ${where}`, args)).rows[0]
    .n as number;

describe('E4 acceptance', () => {
  it('the portal reads the current form; a submission is one fact bound to its version, idempotent on its key', async () => {
    const form = h.ok<{ data: { formVersion: number; fields: { key: string }[] } }>(
      await h.portal(adultP, 'GET', `/portal/v1/forms/${FORM.formRef}`),
    ).data;
    expect(form.formVersion).toBe(1);
    expect(form.fields.map((f) => f.key)).toContain('visit_reason');
    // The portal description never exposes where an answer goes.
    expect(JSON.stringify(form)).not.toContain('target');
    const key = randomUUID();
    const first = h.ok<{ data: Sub; replayed: boolean }>(
      await submit(adultP, adult, { answers: answers() }, key),
      201,
    );
    const again = h.ok<{ data: Sub; replayed: boolean }>(
      await submit(adultP, adult, { answers: answers() }, key),
      201,
    );
    expect(again.data.submissionRef).toBe(first.data.submissionRef);
    expect(again.replayed).toBe(true);
    expect(await rowCount('intake_submissions', 'patient_id = $1', [adult])).toBe(1);
    const changed = await submit(adultP, adult, { answers: answers({ visit_reason: 'concern' }) }, key);
    expect([changed.statusCode, changed.json().code]).toStrictEqual([409, 'idempotency_conflict']);
  });

  it('a missing required answer, a wrong kind and an unexpected field are refused with field-level detail only', async () => {
    const before = await rowCount('intake_submissions');
    const missing = await submit(adultP, adult, { answers: { visit_reason: 'checkup' } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().detail.violations).toStrictEqual([
      { pointer: '/answers/agree_policy', rule: 'requiredAnswer' },
    ]);
    const wrong = await submit(adultP, adult, { answers: answers({ visit_reason: `other ${MARKER}` }) });
    expect(wrong.json().detail.violations).toStrictEqual([
      { pointer: '/answers/visit_reason', rule: 'answerKind' },
    ]);
    expect(wrong.body).not.toContain(MARKER);
    const extra = await submit(adultP, adult, { answers: answers({ shoe_size: `9 ${MARKER}` }) });
    expect([extra.statusCode, extra.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/answers/shoe_size', rule: 'unknownField' }],
    ]);
    const extraConsent = await submit(adultP, adult, {
      answers: answers(),
      consents: { sms_marketing: 'granted' },
    });
    expect(extraConsent.json().detail.violations).toStrictEqual([
      { pointer: '/consents/sms_marketing', rule: 'unknownField' },
    ]);
    expect(await rowCount('intake_submissions')).toBe(before);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('a guardian submits for the minor: the relationship used is recorded and the consent is one E6 fact', async () => {
    const res = h.ok<{ data: Sub }>(
      await submit(parentP, kid, { answers: answers(), consents: { email_reminders: 'granted' } }),
      201,
    ).data;
    const rel = (
      await db.admin.query(
        'SELECT id FROM cuspatlas.patient_relationships WHERE subject_patient_id = $1 AND counterparty_patient_id = $2',
        [kid, parent],
      )
    ).rows[0].id as string;
    expect(res.viaRelationshipRef).toBe(rel);
    expect(res.consentCount).toBe(1);
    const consents = h.ok<{
      data: {
        records: { source: string; viaRelationshipRef: string | null; version: string }[];
        effective: { channel: string; purpose: string; state: string }[];
      };
    }>(await h.call('a1', 'GET', `/v1/patients/${kid}/consents`)).data;
    expect(consents.records).toStrictEqual([
      expect.objectContaining({
        source: 'guardian_portal',
        viaRelationshipRef: rel,
        version: 'synthetic-intake-1',
      }),
    ]);
    expect(consents.effective).toContainEqual(
      expect.objectContaining({ channel: 'email', purpose: 'reminders', state: 'granted' }),
    );
    const list = h.ok<{ data: { submissionRef: string; consentRefs: string[]; submittedVia: string }[] }>(
      await h.call('a1', 'GET', `/v1/patients/${kid}/intake-submissions`),
    ).data;
    expect(list).toStrictEqual([
      expect.objectContaining({ submissionRef: res.submissionRef, submittedVia: 'portal' }),
    ]);
    expect(list[0]?.consentRefs).toHaveLength(1);
  });

  it('another patient is the same 404 as a random one; a proxy without consent is 403; nothing is stored', async () => {
    const before = await rowCount('intake_submissions');
    const other = await submit(adultP, stranger, { answers: answers() });
    const random = await submit(adultP, randomUUID(), { answers: answers() });
    const strip = (b: string) => JSON.parse(b, (k, v) => (k === 'correlationId' ? undefined : v));
    expect(other.statusCode).toBe(404);
    expect(strip(other.body)).toStrictEqual(strip(random.body));
    const proxy = await submit(proxyP, kid, { answers: answers() });
    expect([proxy.statusCode, proxy.json().code]).toStrictEqual([403, 'forbidden']);
    expect(await rowCount('intake_submissions')).toBe(before);
  });

  it('a revision binds new submissions; the earlier version refuses new ones and its submissions are unchanged', async () => {
    const v1 = h.ok<{ data: Sub }>(
      await submit(adultP, adult, { answers: answers({ visit_reason: 'concern' }) }),
      201,
    ).data;
    h.ok(
      await h.call('a1', 'POST', '/v1/intake/forms', {
        ...FORM,
        fields: [
          ...FORM.fields,
          { key: 'insurance_card', label: 'Card on file', kind: 'boolean', required: false },
        ],
      }),
      201,
    );
    const stale = await submit(adultP, adult, { answers: answers() });
    expect([stale.statusCode, stale.json().detail.reason]).toStrictEqual([409, 'form_version_expired']);
    const v2 = h.ok<{ data: Sub }>(
      await submit(adultP, adult, { formVersion: 2, answers: answers({ insurance_card: true }) }),
      201,
    ).data;
    expect(v2.formVersion).toBe(2);
    const read = h.ok<{ data: { formVersion: number; answers: { key: string; value: unknown }[] } }>(
      await h.call('a1', 'GET', `/v1/intake/submissions/${v1.submissionRef}`),
    ).data;
    expect(read.formVersion).toBe(1);
    expect(read.answers.map((a) => a.key)).toStrictEqual(['visit_reason', 'agree_policy']);
    // Retiring the current version refuses new submissions and keeps the stored ones.
    h.ok(await h.call('a1', 'POST', `/v1/intake/forms/${FORM.formRef}/retire`, { expectedVersion: 2 }));
    const retired = await submit(adultP, adult, { formVersion: 2, answers: answers() });
    expect([retired.statusCode, retired.json().detail.reason]).toStrictEqual([409, 'form_version_expired']);
    expect((await h.call('a1', 'GET', `/v1/intake/submissions/${v2.submissionRef}`)).statusCode).toBe(200);
    // The database keeps a published version immutable except for its retirement.
    await expect(
      db.admin.query(
        `UPDATE cuspatlas.intake_form_versions SET title = 'changed' WHERE form_ref = $1 AND version = 1`,
        [FORM.formRef],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    h.ok(await h.call('a1', 'POST', '/v1/intake/forms', FORM), 201);
  });

  it('differing demographics open a review with a diff applied through S4; equal answers open nothing; stale is refused', async () => {
    const current = h.ok<{ data: { formVersion: number }[] }>(await h.call('a1', 'GET', '/v1/intake/forms'))
      .data[0]?.formVersion as number;
    const same = await h.person('Synthetic Same Name', [email('e4.same')], {
      preferredName: { known: true, value: 'Sam' },
    });
    const sameP = await h.enroll(same, { channel: 'email', value: 'e4.same@example.invalid' });
    const unchanged = h.ok<{ data: Sub }>(
      await submit(sameP, same, { formVersion: current, answers: answers({ preferred_name: 'Sam' }) }),
      201,
    ).data;
    expect(unchanged.demographicsReview).toBe(false);
    const res = h.ok<{ data: Sub }>(
      await submit(adultP, adult, {
        formVersion: current,
        answers: answers({ preferred_name: `Ari ${MARKER}`, language: 'es' }),
      }),
      201,
    ).data;
    expect(res.demographicsReview).toBe(true);
    const work = h
      .ok<{
        data: {
          items: { workItemRef: string; kind: string; reasonCode: string; evidenceRefs: { ref: string }[] }[];
        };
      }>(await h.call('a1', 'GET', '/v1/intake/reviews/worklist'))
      .data.items.find((i) => i.evidenceRefs.some((e) => e.ref === res.submissionRef));
    expect(work).toMatchObject({ kind: 'intake_review', reasonCode: 'demographics_update' });
    const reviewRef = work?.workItemRef as string;
    const review = h.ok<{
      data: {
        patientVersion: number;
        version: number;
        diff: { group: string; current: unknown; proposed: unknown }[];
      };
    }>(await h.call('a1', 'GET', `/v1/intake/reviews/${reviewRef}`)).data;
    expect([...review.diff].sort((a, b) => b.group.localeCompare(a.group))).toStrictEqual([
      {
        group: 'preferredName',
        current: expect.anything(),
        proposed: { known: true, value: `Ari ${MARKER}` },
        unchanged: false,
      },
      {
        group: 'language',
        current: expect.anything(),
        proposed: { known: true, tag: 'es' },
        unchanged: false,
      },
    ]);
    // The record is untouched until a person applies the review.
    const before = h.ok<{ data: { preferredName: unknown; version: number } }>(
      await h.call('a1', 'GET', `/v1/patients/${adult}`),
    ).data;
    expect(before.version).toBe(review.patientVersion);
    const stale = await h.call('a1', 'POST', `/v1/intake/reviews/${reviewRef}/resolve`, {
      decision: 'apply',
      expectedVersion: review.version,
      patientVersion: review.patientVersion + 5,
    });
    expect(stale.statusCode).toBe(409);
    const applied = h.ok<{ data: { state: string; appliedPatientVersion: number } }>(
      await h.call('a1', 'POST', `/v1/intake/reviews/${reviewRef}/resolve`, {
        decision: 'apply',
        expectedVersion: review.version,
        patientVersion: review.patientVersion,
      }),
    ).data;
    expect(applied.state).toBe('applied');
    const after = h.ok<{ data: { preferredName: unknown; language: unknown; version: number } }>(
      await h.call('a1', 'GET', `/v1/patients/${adult}`),
    ).data;
    expect(after).toMatchObject({
      preferredName: { known: true, value: `Ari ${MARKER}` },
      language: { known: true, tag: 'es' },
      version: applied.appliedPatientVersion,
    });
    const audit = await db.admin.query(
      `SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at`,
      [adult],
    );
    expect(audit.rows.map((r) => r.operation)).toContain('patients.updateDemographics');
    const again = await h.call('a1', 'POST', `/v1/intake/reviews/${reviewRef}/resolve`, {
      decision: 'reject',
      expectedVersion: review.version + 1,
      reasonCode: 'duplicate',
    });
    expect([again.statusCode, again.json().detail.reason]).toStrictEqual([409, 'review_already_resolved']);
  });

  it('medical-history answers are a C8 hand-off by reference only: blocked, never applied, chart untouched', async () => {
    const current = h.ok<{ data: { formVersion: number }[] }>(await h.call('a1', 'GET', '/v1/intake/forms'))
      .data[0]?.formVersion as number;
    const res = h.ok<{ data: Sub }>(
      await submit(adultP, adult, {
        formVersion: current,
        answers: answers({ allergies: `synthetic pollen ${MARKER}` }),
      }),
      201,
    ).data;
    expect(res.historyHandoff).toBe(true);
    const item = h
      .ok<{
        data: {
          items: {
            workItemRef: string;
            reasonCode: string;
            blockingDependencies: string[];
            evidenceRefs: { ref: string }[];
          }[];
        };
      }>(await h.call('a1', 'GET', '/v1/intake/reviews/worklist'))
      .data.items.find(
        (i) =>
          i.reasonCode === 'medical_history_handoff' &&
          i.evidenceRefs.some((e) => e.ref === res.submissionRef),
      );
    expect(item?.blockingDependencies).toStrictEqual(['C8']);
    const review = h.ok<{ data: { payloadRef: string; blockedOn: string; version: number } }>(
      await h.call('a1', 'GET', `/v1/intake/reviews/${item?.workItemRef}`),
    ).data;
    expect(review.payloadRef).toBe(`intake-submission:${res.submissionRef}#allergies`);
    expect(review.blockedOn).toBe('C8');
    const apply = await h.call('a1', 'POST', `/v1/intake/reviews/${item?.workItemRef}/resolve`, {
      decision: 'apply',
      expectedVersion: review.version,
      patientVersion: 1,
    });
    expect([apply.statusCode, apply.json().detail.reason]).toStrictEqual([409, 'c8_not_deployed']);
    // C8 exists on the integration branch; the hand-off still writes nothing to the clinical record.
    const history = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.clinical_history_versions v
       JOIN cuspatlas.clinical_history_streams s ON s.id = v.stream_id WHERE s.subject_patient_id = $1`,
      [adult],
    );
    expect(history.rows[0].n).toBe(0);
    const proposed = await db.admin.query(
      'SELECT proposed::text AS p FROM cuspatlas.intake_review_items WHERE id = $1',
      [item?.workItemRef],
    );
    expect(proposed.rows[0].p).toBe('{}');
  });

  it('the portal forms view lists the submissions without answers; staff reads are sensitive-read logged; MCP agrees', async () => {
    const view = h.ok<{
      data: { coverage: { status: string }; fields: { submissions: Record<string, unknown>[] } };
    }>(await h.portal(adultP, 'GET', `/portal/v1/patients/${adult}/views/forms`)).data;
    expect(view.coverage.status).toBe('available');
    expect(view.fields.submissions.length).toBeGreaterThan(0);
    for (const s of view.fields.submissions)
      expect(Object.keys(s)).toStrictEqual([
        'submissionRef',
        'formRef',
        'formVersion',
        'submittedAt',
        'status',
      ]);
    const ref = view.fields.submissions[0]?.submissionRef as string;
    const read = await h.call('a1', 'GET', `/v1/intake/submissions/${ref}`);
    expect(read.statusCode).toBe(200);
    const logged = await db.admin.query(
      `SELECT operation FROM cuspatlas.sensitive_read_events WHERE $1::uuid = ANY (resource_refs) AND operation = 'intake.submissions.read'`,
      [ref],
    );
    expect(logged.rows.length).toBeGreaterThan(0);
    const mcp = await h.mcp('a1', 'intake_submissions_get', { submissionRef: ref });
    expect((mcp.body as { data: unknown }).data).toStrictEqual(read.json().data);
    const foreign = await h.call('b1', 'GET', `/v1/intake/submissions/${ref}`);
    expect(foreign.statusCode).toBe(404);
    const noScope = await h.call('a5', 'GET', `/v1/intake/submissions/${ref}`);
    expect(noScope.statusCode).toBe(403);
  });

  it('staff enter a paper form (written_form consent); a service principal may not; answers never reach audit, outbox, attempts or logs', async () => {
    const current = h.ok<{ data: { formVersion: number }[] }>(await h.call('a1', 'GET', '/v1/intake/forms'))
      .data[0]?.formVersion as number;
    const body = {
      formRef: FORM.formRef,
      formVersion: current,
      answers: answers({ allergies: `paper ${MARKER}` }),
      consents: { email_reminders: 'denied' },
    };
    const staff = h.ok<{ data: Sub }>(
      await h.call('a1', 'POST', `/v1/patients/${stranger}/intake-submissions`, body),
      201,
    ).data;
    expect(staff.consentCount).toBe(1);
    const consents = h.ok<{ data: { records: { source: string; state: string }[] } }>(
      await h.call('a1', 'GET', `/v1/patients/${stranger}/consents`),
    ).data.records;
    expect(consents).toStrictEqual([expect.objectContaining({ source: 'written_form', state: 'denied' })]);
    const svc = await h.call('svcA1', 'POST', `/v1/patients/${stranger}/intake-submissions`, body);
    expect(svc.statusCode).toBe(403);
    const leaks = await db.admin.query(
      `SELECT (SELECT count(*) FROM cuspatlas.audit_events a WHERE a::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.outbox_events o WHERE o::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.security_attempt_events s WHERE s::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.command_idempotency c WHERE c::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.sensitive_read_events r WHERE r::text LIKE $1) AS n`,
      [`%${MARKER}%`],
    );
    expect(Number(leaks.rows[0].n)).toBe(0);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
    // The runtime role cannot rewrite a submission.
    await expect(
      db.app.query(`UPDATE cuspatlas.intake_submissions SET answers = '{}'::jsonb WHERE id = $1`, [
        staff.submissionRef,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
