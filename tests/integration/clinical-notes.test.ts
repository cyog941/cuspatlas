import { randomUUID } from 'node:crypto';
import { validateNoteCommandResult, validateNoteList, validateNoteRead } from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { seedClinicalScopes, seedDispositions } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';
import { seedNoteScopes, USER_A8, USER_A9 } from './support/note-fixtures';

/**
 * C10: note drafting, signing, amendment, addendum and co-signature (synthetic engineering
 * implementation; C-D4 and C-D5 recommended-pending-clinical-approval; co-signature C-S2-Q5 is
 * blocking and implemented as a recorded pending state). No AI drafting is built: `ai_draft` is a
 * provenance label only. Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let a8: string;
let a9: string;
let provider: string;
const LOC = 'loc-north';
let enforcedTemplate: { templateRef: string; versionRef: string };
let plainTemplate: { templateRef: string; versionRef: string };

const SECTIONS = [
  { sectionKey: 'subjective', label: 'Synthetic subjective', required: true },
  { sectionKey: 'objective', label: 'Synthetic objective', required: true },
  { sectionKey: 'plan', label: 'Synthetic plan', required: false },
];

async function template(enforced: boolean, label: string) {
  const r = h.ok<{ data: { templateRef: string; currentVersion: { templateVersionRef: string } } }>(
    await h.call('a1', 'POST', '/v1/clinical/note-templates', {
      noteType: 'progress',
      label,
      enforced,
      sections: SECTIONS,
      procedureCodeRefs: ['SYN-PROC-001'],
    }),
    201,
  );
  return { templateRef: r.data.templateRef, versionRef: r.data.currentVersion.templateVersionRef };
}

beforeAll(async () => {
  db = await openTestDatabase('clinical_notes');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedNoteScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  provider = (await seedLocation(h, LOC)).provider;
  a8 = await h.issuer.issue({ sub: USER_A8, tid: T_ALPHA });
  a9 = await h.issuer.issue({ sub: USER_A9, tid: T_ALPHA });
  enforcedTemplate = await template(true, 'Synthetic enforced progress');
  plainTemplate = await template(false, 'Synthetic advisory progress');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Author = { actorRef: string; role: string; credentialRef: string | null };
type Check = {
  enforced: boolean;
  satisfied: boolean;
  blocksSigning: boolean;
  missingSections: string[];
  missingCodeRefs: string[];
  unresolvedSections: string[];
};
type Content = { sections: { sectionKey: string; text: string }[]; procedureCodeRefs: string[] };
type Version = {
  noteVersionRef: string;
  sequence: number;
  kind: 'original' | 'amendment' | 'addendum';
  referencesSequence: number | null;
  supersededBySequence: number | null;
  reasonCode: string | null;
  content: Content | null;
  addendumText: string | null;
  templateVersionRef: string | null;
  templateCheck: Check | null;
  historyAtSigning: {
    recorded: boolean;
    versions: { streamRef: string; version: number; historyVersionRef: string | null }[];
  };
  authoredBy: Author;
  authoredAt: string;
  contentDigest: string;
  digestVerified: boolean;
  cosignature: {
    required: boolean;
    supervisingResourceRef: string | null;
    status: 'not_required' | 'pending' | 'cosigned';
    cosignedBy: Author | null;
    cosignedAt: string | null;
  };
};
type Note = {
  noteRef: string;
  encounterRef: string;
  patientRef: string;
  noteType: string;
  status: 'draft' | 'signed' | 'amended';
  source: { kind: 'human' | 'ai_draft'; aiModelRef: string | null; aiPromptVersionRef: string | null };
  templateVersionRef: string | null;
  draft: { content: Content; templateCheck: Check | null; updatedBy: Author; updatedAt: string } | null;
  versions: Version[];
  createdBy: Author;
  version: number;
};

const complete: Content = {
  sections: [
    { sectionKey: 'subjective', text: 'Synthetic chief complaint' },
    { sectionKey: 'objective', text: 'Synthetic finding' },
  ],
  procedureCodeRefs: ['SYN-PROC-001'],
};
const partial: Content = {
  sections: [{ sectionKey: 'subjective', text: 'Synthetic complaint mentioning SYN-PROC-001 in text only' }],
  procedureCodeRefs: [],
};

async function encounter(
  patientRef?: string,
): Promise<{ encounterRef: string; patientRef: string; version: number }> {
  const p = patientRef ?? (await createPatient(h, 'Synthetic Note Patient'));
  const r = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef: p, locationRef: LOC }),
    201,
  );
  return { ...r.data.encounter, patientRef: p };
}
const createDraft = (encounterRef: string, body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', `/v1/clinical/encounters/${encounterRef}/notes`, body, key);
async function draft(encounterRef: string, body: Record<string, unknown> = {}, who = 'a1'): Promise<Note> {
  return h.ok<{ data: Note }>(
    await createDraft(encounterRef, { noteType: 'progress', content: complete, ...body }, who),
    201,
  ).data;
}
const post = (noteRef: string, action: string, body: unknown, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', `/v1/clinical/notes/${noteRef}/${action}`, body, key);
const read = async (noteRef: string, who = 'a1') =>
  h.ok<{ data: Note }>(await h.call(who, 'GET', `/v1/clinical/notes/${noteRef}`)).data;
async function signed(n: Note, who = 'a1'): Promise<Note> {
  return h.ok<{ data: Note }>(await post(n.noteRef, 'sign', { expectedVersion: n.version }, who)).data;
}
async function runtimeSql(sql: string): Promise<string> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
    return await client.query(sql).then(
      () => 'ok',
      (e) => e.code as string,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
const versionRows = async (noteRef: string) =>
  (
    await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.clinical_note_versions WHERE note_id = $1',
      [noteRef],
    )
  ).rows[0].n as number;

describe('C10 acceptance cases', () => {
  it('1. a draft is editable repeatedly; after signing, the command and every direct write path refuse an overwrite', async () => {
    const e = await encounter();
    const d = await draft(e.encounterRef, { content: partial });
    expect([d.status, d.version, d.versions]).toStrictEqual(['draft', 1, []]);
    const v2 = h.ok<{ data: Note; version: number }>(
      await post(d.noteRef, 'draft', {
        expectedVersion: 1,
        content: { ...partial, procedureCodeRefs: ['SYN-PROC-001'] },
      }),
    );
    expect(v2.version).toBe(2);
    const v3 = h.ok<{ data: Note }>(
      await post(d.noteRef, 'draft', { expectedVersion: 2, content: complete }),
    );
    expect(validateNoteCommandResult(v3)).toBe(true);
    expect(v3.data.draft?.content).toStrictEqual(complete);
    const stale = await post(d.noteRef, 'draft', { expectedVersion: 2, content: partial });
    expect([stale.statusCode, stale.json().code, stale.json().detail.currentVersion]).toStrictEqual([
      409,
      'stale_version',
      3,
    ]);
    const s = await signed(v3.data);
    expect(s.status).toBe('signed');
    expect(s.draft).toBeNull();
    const [orig] = s.versions;
    expect(orig).toMatchObject({
      sequence: 1,
      kind: 'original',
      referencesSequence: null,
      supersededBySequence: null,
      content: complete,
      authoredBy: { actorRef: '20000000-0000-4000-8000-0000000000a1', role: 'dentist' },
      digestVerified: true,
    });
    expect(orig?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const after = await post(d.noteRef, 'draft', { expectedVersion: s.version, content: partial });
    expect([after.statusCode, after.json().detail]).toStrictEqual([
      409,
      {
        reason: 'note_signed',
        blockingRefs: [{ kind: 'clinicalNote', ref: d.noteRef }],
        alternative: 'clinical.notes.amend',
      },
    ]);
    for (const sql of [
      `UPDATE cuspatlas.clinical_note_versions SET sections = '[]'::jsonb`,
      `UPDATE cuspatlas.clinical_note_versions SET content_digest = 'sha256:${'0'.repeat(64)}'`,
      'DELETE FROM cuspatlas.clinical_note_versions',
      `UPDATE cuspatlas.clinical_notes SET draft_sections = '[]'::jsonb, version = version + 1 WHERE id = '${d.noteRef}'`,
      `UPDATE cuspatlas.clinical_notes SET state = 'draft', head_sequence = 0, version = version + 1 WHERE id = '${d.noteRef}'`,
      `UPDATE cuspatlas.clinical_notes SET encounter_id = encounter_id WHERE id = '${d.noteRef}'`,
      'DELETE FROM cuspatlas.clinical_notes',
    ]) {
      expect([sql, await runtimeSql(sql)]).toStrictEqual([sql, '42501']);
    }
    // The owner path (superuser fixture pool) is refused by the triggers too.
    for (const sql of [
      `UPDATE cuspatlas.clinical_note_versions SET sections = '[]'::jsonb WHERE note_id = '${d.noteRef}'`,
      `UPDATE cuspatlas.clinical_notes SET draft_sections = '[]'::jsonb, version = version + 1 WHERE id = '${d.noteRef}'`,
    ]) {
      const code = await db.admin.query(sql).then(
        () => 'ok',
        (err) => err.code,
      );
      expect([sql, code]).toStrictEqual([sql, '42501']);
    }
    expect((await read(d.noteRef)).versions).toStrictEqual(s.versions);
  });

  it('2. amendment and addendum append versions with author, instant and reason; the signed version stays byte-identical', async () => {
    const e = await encounter();
    const s = await signed(await draft(e.encounterRef));
    const original = s.versions[0];
    const amended = h.ok<{ data: Note; version: number }>(
      await post(s.noteRef, 'amendments', {
        expectedVersion: s.version,
        reasonCode: 'documentation_correction',
        content: {
          ...complete,
          sections: [...complete.sections, { sectionKey: 'plan', text: 'Synthetic plan' }],
        },
      }),
      201,
    );
    expect(amended.data.status).toBe('amended');
    expect(amended.data.versions[1]).toMatchObject({
      sequence: 2,
      kind: 'amendment',
      referencesSequence: 1,
      reasonCode: 'documentation_correction',
      authoredBy: { role: 'dentist' },
      digestVerified: true,
    });
    expect(amended.data.versions[0]).toStrictEqual({ ...original, supersededBySequence: 2 });
    const addendum = h.ok<{ data: Note }>(
      await post(
        s.noteRef,
        'addenda',
        {
          expectedVersion: amended.version,
          reasonCode: 'clarification',
          text: 'Synthetic clarifying addendum',
        },
        'a3',
      ),
      201,
    );
    const chain = addendum.data.versions;
    expect(chain.map((v) => [v.sequence, v.kind, v.referencesSequence, v.digestVerified])).toStrictEqual([
      [1, 'original', null, true],
      [2, 'amendment', 1, true],
      [3, 'addendum', 2, true],
    ]);
    expect(chain[2]).toMatchObject({
      addendumText: 'Synthetic clarifying addendum',
      content: null,
      authoredBy: { role: 'hygienist' },
    });
    expect(new Set(chain.map((v) => v.contentDigest)).size).toBe(3);
    expect(validateNoteRead({ data: addendum.data })).toBe(true);
    const missingReason = await post(s.noteRef, 'amendments', {
      expectedVersion: addendum.data.version,
      content: complete,
    });
    expect(missingReason.statusCode).toBe(400);
    const { rows } = await db.admin.query(
      'SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at',
      [s.noteRef],
    );
    expect(rows.map((r) => r.operation)).toStrictEqual([
      'clinical.notes.createDraft',
      'clinical.notes.sign',
      'clinical.notes.amend',
      'clinical.notes.addendum',
    ]);
  });

  it('3. signing a draft that fails an enforced template is refused with the deficit list and writes no signature; a non-enforced template signs with a warning', async () => {
    const e = await encounter();
    const enforced = await draft(e.encounterRef, {
      content: partial,
      templateVersionRef: enforcedTemplate.versionRef,
    });
    const deficits = {
      missingSections: ['objective'],
      missingCodeRefs: ['SYN-PROC-001'],
      unresolvedSections: [],
    };
    expect(enforced.draft?.templateCheck).toStrictEqual({
      enforced: true,
      satisfied: false,
      blocksSigning: true,
      ...deficits,
    });
    const refused = await post(enforced.noteRef, 'sign', { expectedVersion: enforced.version });
    expect([refused.statusCode, refused.json().detail]).toStrictEqual([
      409,
      { reason: 'template_deficit', deficits },
    ]);
    expect(await versionRows(enforced.noteRef)).toBe(0);
    expect((await read(enforced.noteRef)).status).toBe('draft');
    // The same draft under a non-enforced template signs, recording the warning on the signed version.
    const advisory = await draft(e.encounterRef, {
      content: partial,
      templateVersionRef: plainTemplate.versionRef,
    });
    const s = await signed(advisory);
    expect(s.versions[0]?.templateCheck).toStrictEqual({
      enforced: false,
      satisfied: false,
      blocksSigning: false,
      ...deficits,
    });
    expect(s.versions[0]?.templateVersionRef).toBe(plainTemplate.versionRef);
    // Addressing the deficits lets the enforced draft sign.
    const fixed = h.ok<{ data: Note }>(
      await post(enforced.noteRef, 'draft', { expectedVersion: enforced.version, content: complete }),
    );
    expect(fixed.data.draft?.templateCheck?.satisfied).toBe(true);
    expect((await signed(fixed.data)).versions[0]?.templateCheck).toMatchObject({
      enforced: true,
      satisfied: true,
    });
    // An amendment under an enforced template is checked at the same point.
    const after = await read(enforced.noteRef);
    const bad = await post(after.noteRef, 'amendments', {
      expectedVersion: after.version,
      reasonCode: 'correction',
      content: partial,
    });
    expect([bad.statusCode, bad.json().detail.reason]).toStrictEqual([409, 'template_deficit']);
  });

  it('4. two concurrent signatures produce exactly one signed version and one typed conflict with guidance', async () => {
    const e = await encounter();
    const d = await draft(e.encounterRef);
    const [x, y] = await Promise.all([
      post(d.noteRef, 'sign', { expectedVersion: d.version }, 'a1'),
      post(d.noteRef, 'sign', { expectedVersion: d.version }, a8),
    ]);
    const codes = [x.statusCode, y.statusCode].sort();
    expect(codes).toStrictEqual([200, 409]);
    const loser = x.statusCode === 409 ? x : y;
    expect(loser.json().detail).toStrictEqual({
      reason: 'note_signed',
      blockingRefs: [{ kind: 'clinicalNote', ref: d.noteRef }],
      alternative: 'clinical.notes.addendum',
    });
    expect(await versionRows(d.noteRef)).toBe(1);
  });

  it('5. an ai_draft carries its model and prompt references; only a named human signs; an unattributed AI draft is refused', async () => {
    const e = await encounter();
    const ai = await draft(e.encounterRef, {
      source: 'ai_draft',
      aiModelRef: 'SYN-MODEL-1',
      aiPromptVersionRef: 'SYN-PROMPT-1',
    });
    expect(ai.source).toStrictEqual({
      kind: 'ai_draft',
      aiModelRef: 'SYN-MODEL-1',
      aiPromptVersionRef: 'SYN-PROMPT-1',
    });
    const s = await signed(ai);
    expect(s.source.kind).toBe('ai_draft');
    expect(s.versions[0]?.authoredBy).toMatchObject({
      actorRef: '20000000-0000-4000-8000-0000000000a1',
      role: 'dentist',
    });
    const unattributed = await createDraft(e.encounterRef, {
      noteType: 'progress',
      source: 'ai_draft',
      aiModelRef: 'SYN-MODEL-1',
    });
    expect([unattributed.statusCode, unattributed.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'aiDraftUnattributed',
    ]);
    const human = await createDraft(e.encounterRef, { noteType: 'progress', aiModelRef: 'SYN-MODEL-1' });
    expect([human.statusCode, human.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'aiRefsOnlyForAiDraft',
    ]);
    // A service principal never drafts or signs, even with the scopes.
    const svcDraft = await createDraft(e.encounterRef, { noteType: 'progress', content: complete }, 'svcA1');
    expect(svcDraft.statusCode).toBe(403);
    const other = await draft(e.encounterRef);
    const svcSign = await post(other.noteRef, 'sign', { expectedVersion: other.version }, 'svcA1');
    expect(svcSign.statusCode).toBe(403);
    expect(await versionRows(other.noteRef)).toBe(0);
  });

  it('6. a member without the signing scope is refused even with read access; cross-tenant read, sign and amend are hidden', async () => {
    const e = await encounter();
    const d = await draft(e.encounterRef);
    expect((await read(d.noteRef, 'a4')).status).toBe('draft');
    const ro = await post(d.noteRef, 'sign', { expectedVersion: d.version }, 'a4');
    expect([ro.statusCode, ro.json().code]).toStrictEqual([403, 'forbidden']);
    const s = await signed(d);
    for (const [method, url, body] of [
      ['GET', `/v1/clinical/notes/${d.noteRef}`, undefined],
      ['GET', `/v1/clinical/encounters/${e.encounterRef}/notes`, undefined],
      ['POST', `/v1/clinical/notes/${d.noteRef}/sign`, { expectedVersion: s.version }],
      [
        'POST',
        `/v1/clinical/notes/${d.noteRef}/amendments`,
        { expectedVersion: s.version, reasonCode: 'x', content: complete },
      ],
      [
        'POST',
        `/v1/clinical/notes/${d.noteRef}/addenda`,
        { expectedVersion: s.version, reasonCode: 'x', text: 'Synthetic' },
      ],
    ] as const) {
      const r = await h.call('b1', method, url, body);
      expect([url, r.statusCode, r.json().code]).toStrictEqual([url, 404, 'not_found']);
    }
    expect(await versionRows(d.noteRef)).toBe(1);
  });

  it('7. amending another clinician’s note needs the oversight scope; an addendum does not', async () => {
    const e = await encounter();
    const s = await signed(await draft(e.encounterRef));
    const denied = await post(
      s.noteRef,
      'amendments',
      { expectedVersion: s.version, reasonCode: 'correction', content: complete },
      a8,
    );
    expect([denied.statusCode, denied.json().code, denied.json().detail]).toStrictEqual([
      403,
      'forbidden',
      { reason: 'clinical_oversight_required', alternative: 'clinical.notes.addendum' },
    ]);
    const { rows } = await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [denied.headers['x-correlation-id']],
    );
    expect(rows.map((r) => r.reason_code)).toStrictEqual(['clinical_oversight_required']);
    const add = h.ok<{ data: Note; version: number }>(
      await post(
        s.noteRef,
        'addenda',
        { expectedVersion: s.version, reasonCode: 'clarification', text: 'Synthetic' },
        a8,
      ),
      201,
    );
    const ok = h.ok<{ data: Note }>(
      await post(
        s.noteRef,
        'amendments',
        { expectedVersion: add.version, reasonCode: 'oversight_correction', content: complete },
        a9,
      ),
      201,
    );
    expect(ok.data.versions.map((v) => [v.kind, v.authoredBy.actorRef])).toStrictEqual([
      ['original', '20000000-0000-4000-8000-0000000000a1'],
      ['addendum', USER_A8],
      ['amendment', USER_A9],
    ]);
  });
});

describe('C10 failure and recovery cases', () => {
  it('1. a retry after the signature was written returns the recorded signature; no second signature', async () => {
    const e = await encounter();
    const d = await draft(e.encounterRef);
    const key = randomUUID();
    const first = h.ok<{ data: Note; replayed: boolean }>(
      await post(d.noteRef, 'sign', { expectedVersion: d.version }, 'a1', key),
    );
    const retry = h.ok<{ data: Note; replayed: boolean }>(
      await post(d.noteRef, 'sign', { expectedVersion: d.version }, 'a1', key),
    );
    expect([first.replayed, retry.replayed]).toStrictEqual([false, true]);
    expect(retry.data.versions).toStrictEqual(first.data.versions);
    expect(await versionRows(d.noteRef)).toBe(1);
    const viaMcp = await h.mcp('a1', 'clinical_notes_sign', {
      noteRef: d.noteRef,
      expectedVersion: d.version,
      idempotencyKey: key,
    });
    expect((viaMcp.body as { replayed: boolean }).replayed).toBe(true);
  });

  it('2. a signature against a template version retired (and revised) later still succeeds against the retained version', async () => {
    const t = await template(true, 'Synthetic retiring progress');
    const e = await encounter();
    const d = await draft(e.encounterRef, { templateVersionRef: t.versionRef });
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/note-templates/${t.templateRef}/versions`, {
        expectedVersion: 1,
        enforced: true,
        sections: [...SECTIONS, { sectionKey: 'followup', label: 'Synthetic follow-up', required: true }],
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/note-templates/${t.templateRef}/retire`, {
        expectedVersion: 2,
        reasonCode: 'superseded',
      }),
    );
    const s = await signed(d);
    expect(s.versions[0]).toMatchObject({
      templateVersionRef: t.versionRef,
      templateCheck: { satisfied: true },
    });
    // C9 case 4: the signed note still resolves the version it was validated against.
    const v = h.ok<{ data: { sequence: number; sections: unknown[] } }>(
      await h.call('a1', 'GET', `/v1/clinical/note-template-versions/${t.versionRef}`),
    );
    expect([v.data.sequence, v.data.sections]).toStrictEqual([1, SECTIONS]);
    // A retired template cannot be pinned on a new draft; a superseded version cannot either.
    const retired = await createDraft(e.encounterRef, {
      noteType: 'progress',
      templateVersionRef: t.versionRef,
    });
    expect([retired.statusCode, retired.json().detail.reason]).toStrictEqual([409, 'template_retired']);
    const live = await template(false, 'Synthetic live progress');
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/note-templates/${live.templateRef}/versions`, {
        expectedVersion: 1,
        enforced: false,
        sections: SECTIONS,
      }),
      201,
    );
    const superseded = await createDraft(e.encounterRef, {
      noteType: 'progress',
      templateVersionRef: live.versionRef,
    });
    expect([superseded.statusCode, superseded.json().detail.reason]).toStrictEqual([
      409,
      'template_version_superseded',
    ]);
    const mismatch = await createDraft(e.encounterRef, {
      noteType: 'hygiene',
      templateVersionRef: enforcedTemplate.versionRef,
    });
    expect([mismatch.statusCode, mismatch.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'templateNoteTypeMismatch',
    ]);
  });

  it('3. an amendment racing another amendment yields one next version and one conflict; the chain stays linear', async () => {
    const e = await encounter();
    const s = await signed(await draft(e.encounterRef));
    const body = { expectedVersion: s.version, reasonCode: 'correction', content: complete };
    const [x, y] = await Promise.all([
      post(s.noteRef, 'amendments', body),
      post(s.noteRef, 'amendments', body),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toStrictEqual([201, 409]);
    const loser = x.statusCode === 409 ? x : y;
    expect(loser.json().code).toBe('stale_version');
    expect((await read(s.noteRef)).versions.map((v) => [v.sequence, v.referencesSequence])).toStrictEqual([
      [1, null],
      [2, 1],
    ]);
  });

  it('4. a note keeps the history version it was signed against after the history moves on', async () => {
    const e = await encounter();
    const hv = h.ok<{ data: { header: { historyVersionRef: string; streamRef: string } } }>(
      await h.call('a1', 'POST', '/v1/clinical/history/changes', {
        patientRef: e.patientRef,
        provenance: 'staff',
        reportedBy: 'clinician',
        changes: [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen N' }],
      }),
      201,
    );
    const s = await signed(await draft(e.encounterRef));
    const at = s.versions[0]?.historyAtSigning;
    expect(at).toStrictEqual({
      recorded: true,
      versions: [
        {
          streamRef: hv.data.header.streamRef,
          version: 1,
          historyVersionRef: hv.data.header.historyVersionRef,
        },
      ],
    });
    h.ok(
      await h.call('a1', 'POST', '/v1/clinical/history/changes', {
        patientRef: e.patientRef,
        provenance: 'staff',
        reportedBy: 'clinician',
        changes: [{ kind: 'medication', state: 'active', displayText: 'Synthetic medication N' }],
      }),
      201,
    );
    expect((await read(s.noteRef)).versions[0]?.historyAtSigning).toStrictEqual(at);
    // No history recorded is stated explicitly, never as an empty reference.
    const bare = await encounter();
    const none = await signed(await draft(bare.encounterRef));
    expect(none.versions[0]?.historyAtSigning).toMatchObject({ recorded: false });
  });
});

describe('C10 co-signature, encounters, merge, digest, privacy and parity', () => {
  it('a note signed at an encounter with a supervising assignment records a pending co-signature; a distinct signer completes it', async () => {
    const e = await encounter();
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/assignments`, {
        expectedVersion: e.version,
        role: 'supervising_provider',
        assignee: { kind: 'provider', resourceRef: provider },
      }),
      201,
    );
    const s = await signed(await draft(e.encounterRef, {}, 'a3'), 'a3');
    const v = s.versions[0] as Version;
    expect(v.cosignature).toStrictEqual({
      required: true,
      supervisingResourceRef: provider,
      status: 'pending',
      cosignedBy: null,
      cosignedAt: null,
    });
    const self = await post(s.noteRef, 'cosignatures', { sequence: 1, contentDigest: v.contentDigest }, 'a3');
    expect([self.statusCode, self.json().detail.reason]).toStrictEqual([409, 'cosigner_is_author']);
    const wrong = await post(s.noteRef, 'cosignatures', {
      sequence: 1,
      contentDigest: `sha256:${'a'.repeat(64)}`,
    });
    expect([wrong.statusCode, wrong.json().detail.reason]).toStrictEqual([409, 'content_digest_mismatch']);
    const done = h.ok<{ data: Note }>(
      await post(s.noteRef, 'cosignatures', { sequence: 1, contentDigest: v.contentDigest }),
      201,
    );
    expect(done.data.versions[0]?.cosignature).toMatchObject({
      required: true,
      status: 'cosigned',
      cosignedBy: { role: 'dentist' },
    });
    expect(done.data.versions[0]?.contentDigest).toBe(v.contentDigest);
    const twice = await post(s.noteRef, 'cosignatures', { sequence: 1, contentDigest: v.contentDigest }, a8);
    expect([twice.statusCode, twice.json().detail.reason]).toStrictEqual([409, 'already_cosigned']);
    const plain = await signed(await draft((await encounter()).encounterRef));
    expect(plain.versions[0]?.cosignature.status).toBe('not_required');
    const notNeeded = await post(plain.noteRef, 'cosignatures', {
      sequence: 1,
      contentDigest: plain.versions[0]?.contentDigest,
    });
    expect([notNeeded.statusCode, notNeeded.json().detail.reason]).toStrictEqual([
      409,
      'cosignature_not_required',
    ]);
  });

  it('a closed encounter refuses a new draft with the alternative; a draft begun earlier still signs after close', async () => {
    const e = await encounter();
    const d = await draft(e.encounterRef);
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    const late = await createDraft(e.encounterRef, { noteType: 'progress', content: complete });
    expect([late.statusCode, late.json().detail]).toStrictEqual([
      409,
      {
        reason: 'encounter_closed',
        blockingRefs: [{ kind: 'clinicalEncounter', ref: e.encounterRef }],
        alternative: 'clinical.notes.addendum',
      },
    ]);
    expect((await signed(d)).status).toBe('signed');
    const list = h.ok<{ data: Note[] }>(
      await h.call('a1', 'GET', `/v1/clinical/encounters/${e.encounterRef}/notes`),
    );
    expect(validateNoteList(list)).toBe(true);
    expect(list.data.map((n) => n.noteRef)).toStrictEqual([d.noteRef]);
    const nothingYet = await draft((await encounter()).encounterRef, {
      content: { sections: [], procedureCodeRefs: [] },
    });
    const empty = await post(nothingYet.noteRef, 'sign', { expectedVersion: nothingYet.version });
    expect([empty.statusCode, empty.json().detail.reason]).toStrictEqual([409, 'note_empty']);
  });

  it('a merge never changes a signed note: no note table references a patient, rows are byte-identical and the digest verifies', async () => {
    const { rows: refs } = await db.admin.query(
      `SELECT c.conrelid::regclass::text AS t FROM pg_constraint c
       WHERE c.contype = 'f' AND c.confrelid = 'cuspatlas.patients'::regclass
         AND c.conrelid::regclass::text LIKE 'cuspatlas.clinical_note%'`,
    );
    expect(refs).toStrictEqual([]);
    const { rows: cols } = await db.admin.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'cuspatlas' AND table_name LIKE 'clinical_note%' AND column_name LIKE '%patient%'`,
    );
    expect(cols).toStrictEqual([]);
    const survivor = await createPatient(h, 'Synthetic Merge Note');
    const merged = await createPatient(h, 'Synthetic Merge Note');
    const e = await encounter(merged);
    const s = await signed(await draft(e.encounterRef));
    const snapshot = async () =>
      (
        await db.admin.query(
          `SELECT (SELECT json_agg(n ORDER BY n.id) FROM cuspatlas.clinical_notes n) AS n,
             (SELECT json_agg(v ORDER BY v.id) FROM cuspatlas.clinical_note_versions v) AS v`,
        )
      ).rows[0];
    const before = await snapshot();
    await mergePatients(h, survivor, merged);
    expect(await snapshot()).toStrictEqual(before);
    const after = await read(s.noteRef);
    expect(after.patientRef).toBe(survivor);
    expect(after.versions).toStrictEqual(s.versions);
    expect(after.versions[0]?.digestVerified).toBe(true);
  });

  it('the stored digest detects content altered behind every guard (trigger disabled by a superuser)', async () => {
    const s = await signed(await draft((await encounter()).encounterRef));
    await db.admin.query(
      'ALTER TABLE cuspatlas.clinical_note_versions DISABLE TRIGGER clinical_note_versions_append_only',
    );
    try {
      await db.admin.query(
        `UPDATE cuspatlas.clinical_note_versions SET sections = '[{"sectionKey":"subjective","text":"tampered"}]'::jsonb
         WHERE note_id = $1`,
        [s.noteRef],
      );
    } finally {
      await db.admin.query(
        'ALTER TABLE cuspatlas.clinical_note_versions ENABLE TRIGGER clinical_note_versions_append_only',
      );
    }
    const v = (await read(s.noteRef)).versions[0];
    expect([v?.digestVerified, v?.contentDigest]).toStrictEqual([false, s.versions[0]?.contentDigest]);
  });

  it('the marker in note text never reaches logs, audit, outbox, attempts, idempotency or sensitive-read rows', async () => {
    const e = await encounter();
    const marked = {
      sections: [{ sectionKey: 'subjective', text: `Synthetic ${MARKER}` }],
      procedureCodeRefs: [],
    };
    const d = await draft(e.encounterRef, { content: marked });
    const s = await signed(d);
    expect(s.versions[0]?.content?.sections[0]?.text).toBe(`Synthetic ${MARKER}`);
    await post(s.noteRef, 'addenda', {
      expectedVersion: s.version,
      reasonCode: 'clarification',
      text: `Addendum ${MARKER}`,
    });
    await post(
      s.noteRef,
      'amendments',
      { expectedVersion: s.version, reasonCode: 'x', content: marked },
      'b1',
    );
    await post(
      s.noteRef,
      'amendments',
      { expectedVersion: s.version + 1, reasonCode: 'x', content: marked },
      a8,
    );
    await createDraft(e.encounterRef, { noteType: 'progress', content: marked }, 'a4');
    await read(s.noteRef);
    h.ok(await h.call('a1', 'GET', `/v1/clinical/encounters/${e.encounterRef}/notes`));
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${await leakTables(db)}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const logged = await db.admin.query(
      `SELECT DISTINCT operation, resource_type FROM cuspatlas.sensitive_read_events WHERE operation LIKE 'clinical.notes.%'
       ORDER BY 1`,
    );
    expect(logged.rows).toStrictEqual([
      { operation: 'clinical.notes.list', resource_type: 'clinicalNote' },
      { operation: 'clinical.notes.read', resource_type: 'clinicalNote' },
    ]);
  });

  it('MCP drafts replay a REST key; MCP reads equal REST reads; refusals match across surfaces', async () => {
    const e = await encounter();
    const key = randomUUID();
    const body = { noteType: 'progress', content: complete };
    const rest = h.ok<{ data: Note }>(await createDraft(e.encounterRef, body, 'a1', key), 201);
    const viaMcp = await h.mcp(
      'a1',
      'clinical_notes_create_draft',
      { encounterRef: e.encounterRef, ...body, idempotencyKey: key },
      201,
    );
    expect(viaMcp.code).toBeNull();
    expect((viaMcp.body as { replayed: boolean; data: Note }).replayed).toBe(true);
    expect((viaMcp.body as { data: Note }).data.noteRef).toBe(rest.data.noteRef);
    const mcpRead = await h.mcp('a1', 'clinical_notes_get', { noteRef: rest.data.noteRef });
    expect((mcpRead.body as { data: Note }).data).toStrictEqual(await read(rest.data.noteRef));
    const foreign = await h.mcp('b1', 'clinical_notes_sign', {
      noteRef: rest.data.noteRef,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
    const deficit = await draft(e.encounterRef, {
      content: partial,
      templateVersionRef: enforcedTemplate.versionRef,
    });
    const mcpSign = await h.mcp('a1', 'clinical_notes_sign', {
      noteRef: deficit.noteRef,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    const restSign = await post(deficit.noteRef, 'sign', { expectedVersion: 1 });
    expect([mcpSign.status, (mcpSign.body as { detail: unknown }).detail]).toStrictEqual([
      409,
      restSign.json().detail,
    ]);
    expect((await h.call('a1', 'GET', '/v1/clinical/notes/not-a-ref')).statusCode).toBe(404);
  });
});
