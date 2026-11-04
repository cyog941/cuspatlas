import { randomUUID } from 'node:crypto';
import {
  validateNoteTemplateApplicable,
  validateNoteTemplateCommandResult,
  validateNoteTemplateRead,
  validateNoteTemplateVersionRead,
} from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  leakTables,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';
import { seedNoteScopes } from './support/note-fixtures';

/**
 * C9: progress-note templates with per-template enforcement and procedure-code association
 * (synthetic engineering implementation; C-D4 recommended-pending-clinical-approval; required
 * sections and codes are synthetic placeholders, SYN- codes only, no licensed terminology). Every
 * denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const TEMPLATES = '/v1/clinical/note-templates';
const LOC = 'loc-note-templates';

beforeAll(async () => {
  db = await openTestDatabase('clinical_note_templates');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedNoteScopes(db.admin);
  await seedLocation(h, LOC);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Section = { sectionKey: string; label: string; required: boolean };
type TemplateVersion = {
  templateVersionRef: string;
  templateRef: string;
  sequence: number;
  enforced: boolean;
  sections: Section[];
  procedureCodeRefs: string[];
  definedBy: { actorRef: string };
  definedAt: string;
};
type Template = {
  templateRef: string;
  noteType: string;
  label: string;
  state: 'active' | 'retired';
  retirement: { reasonCode: string; retiredBy: { actorRef: string }; retiredAt: string } | null;
  currentVersion: TemplateVersion;
  versions: TemplateVersion[];
  version: number;
};
type Applicable = {
  encounterRef: string;
  procedureCodeRefs: string[];
  procedureSource: string;
  associated: { templateRef: string; matchedCodeRefs: string[] }[];
  general: { templateRef: string; matchedCodeRefs: string[] }[];
};

const SECTIONS: Section[] = [
  { sectionKey: 'subjective', label: 'Synthetic subjective', required: true },
  { sectionKey: 'objective', label: 'Synthetic objective', required: true },
  { sectionKey: 'plan', label: 'Synthetic plan', required: false },
];

let seq = 0;
const label = (base: string) => `${base} ${++seq}`;
const defineBody = (overrides: Record<string, unknown> = {}) => ({
  noteType: 'progress',
  label: label('Synthetic restorative template'),
  enforced: true,
  sections: SECTIONS,
  procedureCodeRefs: ['SYN-PROC-001'],
  ...overrides,
});
const define = (body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', TEMPLATES, body, key);
async function defined(body: Record<string, unknown> = defineBody()): Promise<Template> {
  const res = h.ok<{ data: Template }>(await define(body), 201);
  return res.data;
}
const read = async (templateRef: string, who = 'a1') =>
  h.ok<{ data: Template }>(await h.call(who, 'GET', `${TEMPLATES}/${templateRef}`)).data;
async function encounter(): Promise<string> {
  const p = await createPatient(h, 'Synthetic Template Patient');
  const r = h.ok<{ data: { encounter: { encounterRef: string } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef: p, locationRef: LOC }),
    201,
  );
  return r.data.encounter.encounterRef;
}
const applicable = async (encounterRef: string, codes?: string) =>
  h.ok<{ data: Applicable }>(
    await h.call(
      'a1',
      'GET',
      `/v1/clinical/encounters/${encounterRef}/note-templates${codes ? `?procedureCodeRefs=${codes}` : ''}`,
    ),
  ).data;

describe('C9 acceptance cases', () => {
  it('defines a versioned template with enforcement, required sections and SYN- code associations', async () => {
    const res = await define(defineBody({ label: 'Synthetic defined template' }));
    const body = h.ok<{ data: Template; version: number; replayed: boolean }>(res, 201);
    expect(validateNoteTemplateCommandResult(body)).toBe(true);
    expect(body.data).toMatchObject({
      noteType: 'progress',
      label: 'Synthetic defined template',
      state: 'active',
      retirement: null,
      version: 1,
    });
    expect(body.data.currentVersion).toMatchObject({
      sequence: 1,
      enforced: true,
      sections: SECTIONS,
      procedureCodeRefs: ['SYN-PROC-001'],
    });
    expect(body.data.versions).toHaveLength(1);
    // Readable with clinical.read only (a4); the read validates against its contract.
    const ro = h.ok(await h.call('a4', 'GET', `${TEMPLATES}/${body.data.templateRef}`));
    expect(validateNoteTemplateRead(ro)).toBe(true);
  });

  it('3. a template associated with a code on the encounter is offered; an unassociated template only in the general group', async () => {
    const restorative = await defined(defineBody({ procedureCodeRefs: ['SYN-PROC-APPL-A'] }));
    const other = await defined(defineBody({ procedureCodeRefs: ['SYN-PROC-APPL-B'] }));
    const general = await defined(defineBody({ procedureCodeRefs: [], enforced: false }));
    const e = await encounter();
    const offered = await applicable(e, 'SYN-PROC-APPL-A');
    expect(validateNoteTemplateApplicable({ data: offered })).toBe(true);
    expect(offered.procedureSource).toBe('caller_supplied');
    const assoc = offered.associated.map((t) => t.templateRef);
    const gen = offered.general.map((t) => t.templateRef);
    expect(assoc).toContain(restorative.templateRef);
    expect(assoc).not.toContain(other.templateRef);
    expect(gen).toContain(general.templateRef);
    expect(gen).not.toContain(restorative.templateRef);
    expect(gen).not.toContain(other.templateRef);
    expect(
      offered.associated.find((t) => t.templateRef === restorative.templateRef)?.matchedCodeRefs,
    ).toStrictEqual(['SYN-PROC-APPL-A']);
    // Without procedure codes nothing is associated; nothing is applied silently.
    const none = await applicable(e);
    expect(none.associated).toStrictEqual([]);
    expect(none.general.map((t) => t.templateRef)).toContain(general.templateRef);
  });

  it('4. editing a template creates a new version and the earlier version stays resolvable unchanged', async () => {
    const t = await defined();
    const v1 = h.ok(
      await h.call('a1', 'GET', `/v1/clinical/note-template-versions/${t.currentVersion.templateVersionRef}`),
    );
    expect(validateNoteTemplateVersionRead(v1)).toBe(true);
    const revised = h.ok<{ data: Template; version: number }>(
      await h.call('a1', 'POST', `${TEMPLATES}/${t.templateRef}/versions`, {
        expectedVersion: 1,
        enforced: false,
        sections: [...SECTIONS, { sectionKey: 'followup', label: 'Synthetic follow-up', required: true }],
        procedureCodeRefs: ['SYN-PROC-002'],
      }),
      201,
    );
    expect(revised.version).toBe(2);
    expect(revised.data.currentVersion).toMatchObject({
      sequence: 2,
      enforced: false,
      procedureCodeRefs: ['SYN-PROC-002'],
    });
    expect(revised.data.versions.map((v) => v.sequence)).toStrictEqual([1, 2]);
    // Failure case 4: the code association removed in version 2 is not detached from version 1.
    const again = h.ok(
      await h.call('a1', 'GET', `/v1/clinical/note-template-versions/${t.currentVersion.templateVersionRef}`),
    );
    expect(again).toStrictEqual(v1);
    expect((again as { data: TemplateVersion }).data.procedureCodeRefs).toStrictEqual(['SYN-PROC-001']);
    const stale = await h.call('a1', 'POST', `${TEMPLATES}/${t.templateRef}/versions`, {
      expectedVersion: 1,
      enforced: true,
      sections: SECTIONS,
    });
    expect([stale.statusCode, stale.json().code, stale.json().detail.currentVersion]).toStrictEqual([
      409,
      'stale_version',
      2,
    ]);
  });

  it('5. cross-tenant template reads and writes are hidden; another tenant defines only its own', async () => {
    const t = await defined();
    const e = await encounter();
    for (const [method, url, body] of [
      ['GET', `${TEMPLATES}/${t.templateRef}`, undefined],
      ['GET', `/v1/clinical/note-template-versions/${t.currentVersion.templateVersionRef}`, undefined],
      ['GET', `/v1/clinical/encounters/${e}/note-templates`, undefined],
      [
        'POST',
        `${TEMPLATES}/${t.templateRef}/versions`,
        { expectedVersion: 1, enforced: true, sections: SECTIONS },
      ],
      ['POST', `${TEMPLATES}/${t.templateRef}/retire`, { expectedVersion: 1, reasonCode: 'superseded' }],
    ] as const) {
      const r = await h.call('b1', method, url, body);
      expect([url, r.statusCode, r.json().code]).toStrictEqual([url, 404, 'not_found']);
    }
    // The same type and label in another tenant is a separate template.
    const beta = h.ok<{ data: Template }>(await define({ ...defineBody(), label: t.label }, 'b1'), 201);
    expect(beta.data.templateRef).not.toBe(t.templateRef);
    expect((await read(t.templateRef)).version).toBe(1);
  });

  it('6. a retired template is absent from new drafts and still resolvable for existing references', async () => {
    const t = await defined(defineBody({ procedureCodeRefs: ['SYN-PROC-RET'] }));
    const e = await encounter();
    expect((await applicable(e, 'SYN-PROC-RET')).associated.map((x) => x.templateRef)).toContain(
      t.templateRef,
    );
    const retired = h.ok<{ data: Template }>(
      await h.call('a1', 'POST', `${TEMPLATES}/${t.templateRef}/retire`, {
        expectedVersion: 1,
        reasonCode: 'superseded',
      }),
    );
    expect(retired.data.state).toBe('retired');
    expect(retired.data.retirement).toMatchObject({ reasonCode: 'superseded' });
    expect((await applicable(e, 'SYN-PROC-RET')).associated.map((x) => x.templateRef)).not.toContain(
      t.templateRef,
    );
    expect((await read(t.templateRef)).state).toBe('retired');
    h.ok(
      await h.call('a1', 'GET', `/v1/clinical/note-template-versions/${t.currentVersion.templateVersionRef}`),
    );
    const revise = await h.call('a1', 'POST', `${TEMPLATES}/${t.templateRef}/versions`, {
      expectedVersion: 2,
      enforced: true,
      sections: SECTIONS,
    });
    expect([revise.statusCode, revise.json().detail.reason]).toStrictEqual([409, 'template_retired']);
    const twice = await h.call('a1', 'POST', `${TEMPLATES}/${t.templateRef}/retire`, {
      expectedVersion: 2,
      reasonCode: 'superseded',
    });
    expect([twice.statusCode, twice.json().detail.reason]).toStrictEqual([409, 'template_retired']);
    // A retired template frees its type and label for a new active template.
    h.ok(await define({ ...defineBody(), label: t.label }), 201);
  });
});

describe('C9 failure and recovery cases', () => {
  it('3. a duplicate active type and label is refused, never two ambiguous active templates', async () => {
    const t = await defined();
    const dup = await define({ ...defineBody(), label: t.label.toUpperCase() });
    expect([dup.statusCode, dup.json().detail]).toStrictEqual([
      409,
      { reason: 'template_exists', blockingRefs: [{ kind: 'clinicalNoteTemplate', ref: t.templateRef }] },
    ]);
    // A different note type with the same label is a different template.
    h.ok(await define({ ...defineBody(), noteType: 'hygiene', label: t.label }), 201);
  });

  it('a duplicate section key, an unknown property and a non-synthetic code are refused', async () => {
    const dupSections = await define(
      defineBody({ sections: [SECTIONS[0], { ...SECTIONS[0], label: 'Again' }] }),
    );
    expect([dupSections.statusCode, dupSections.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'duplicateSection',
    ]);
    const tenant = await define({ ...defineBody(), tenantId: T_ALPHA });
    expect(tenant.statusCode).toBe(400);
    const licensed = await define(defineBody({ procedureCodeRefs: ['D2391'] }));
    expect(licensed.statusCode).toBe(400);
    const dupCodes = await define(defineBody({ procedureCodeRefs: ['SYN-PROC-001', 'SYN-PROC-001'] }));
    expect(dupCodes.statusCode).toBe(400);
  });

  it('configuration is human admin only; reads need clinical.read', async () => {
    const svc = await define(defineBody(), 'svcA1');
    expect([svc.statusCode, svc.json().code]).toStrictEqual([403, 'forbidden']);
    const ro = await define(defineBody(), 'a4');
    expect([ro.statusCode, ro.json().code]).toStrictEqual([403, 'forbidden']);
    const before = await count(db, 'clinical_note_templates');
    expect(before).toBeGreaterThan(0);
    const { rows } = await db.admin.query(
      `SELECT reason_code FROM cuspatlas.security_attempt_events WHERE operation = 'clinical.noteTemplates.define'
       ORDER BY occurred_at`,
    );
    expect(rows.map((r) => r.reason_code)).toEqual(
      expect.arrayContaining(['principal_kind_denied', 'scope_missing']),
    );
  });

  it('the runtime role cannot rewrite, unretire or delete a template or any template version', async () => {
    const t = await defined();
    h.ok(
      await h.call('a1', 'POST', `${TEMPLATES}/${t.templateRef}/retire`, {
        expectedVersion: 1,
        reasonCode: 'superseded',
      }),
    );
    for (const sql of [
      `UPDATE cuspatlas.clinical_note_template_versions SET enforced = NOT enforced`,
      `UPDATE cuspatlas.clinical_note_template_versions SET procedure_code_refs = '{}'`,
      'DELETE FROM cuspatlas.clinical_note_template_versions',
      'DELETE FROM cuspatlas.clinical_note_templates',
      `UPDATE cuspatlas.clinical_note_templates SET label = 'rewritten', version = version + 1`,
      `UPDATE cuspatlas.clinical_note_templates SET state = 'active', retired_at = NULL, retired_by = NULL,
         retired_reason_code = NULL, version = version + 1 WHERE id = '${t.templateRef}'`,
    ]) {
      const client = await db.app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        expect([
          sql,
          await client.query(sql).then(
            () => 'ok',
            (e) => e.code,
          ),
        ]).toStrictEqual([sql, '42501']);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    // Even the owner path (superuser fixture pool) cannot rewrite a template version.
    const owner = await db.admin
      .query(`UPDATE cuspatlas.clinical_note_template_versions SET enforced = NOT enforced`)
      .then(
        () => 'ok',
        (e) => e.code,
      );
    expect(owner).toBe('42501');
  });

  it('every command is audited; the marker in template text never reaches logs, audit, outbox, attempts or idempotency', async () => {
    const t = await defined(
      defineBody({ sections: [{ sectionKey: 'subjective', label: `Synthetic ${MARKER}`, required: true }] }),
    );
    expect(t.currentVersion.sections[0]?.label).toBe(`Synthetic ${MARKER}`);
    await define({ ...defineBody(), label: `Synthetic ${MARKER}` }, 'b1');
    await define({ ...defineBody(), label: `Synthetic ${MARKER} again` }, 'a4');
    expect(`${await leakTables(db)}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const { rows } = await db.admin.query(
      `SELECT operation, resource_type FROM cuspatlas.audit_events WHERE resource_ref = $1`,
      [t.templateRef],
    );
    expect(rows).toStrictEqual([
      { operation: 'clinical.noteTemplates.define', resource_type: 'clinicalNoteTemplate' },
    ]);
  });

  it('MCP define replays a REST key; MCP reads equal REST reads; cross-tenant MCP reads are hidden', async () => {
    const key = randomUUID();
    const body = defineBody();
    const rest = h.ok<{ data: Template }>(await define(body, 'a1', key), 201);
    const viaMcp = await h.mcp('a1', 'clinical_note_templates_define', { ...body, idempotencyKey: key }, 201);
    expect(viaMcp.code).toBeNull();
    expect((viaMcp.body as { replayed: boolean }).replayed).toBe(true);
    expect((viaMcp.body as { data: Template }).data.templateRef).toBe(rest.data.templateRef);
    const mcpRead = await h.mcp('a1', 'clinical_note_templates_get', { templateRef: rest.data.templateRef });
    expect((mcpRead.body as { data: Template }).data).toStrictEqual(await read(rest.data.templateRef));
    const foreign = await h.mcp('b1', 'clinical_note_templates_get_version', {
      templateVersionRef: rest.data.currentVersion.templateVersionRef,
    });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
    const malformed = await h.call('a1', 'GET', `${TEMPLATES}/not-a-ref`);
    expect(malformed.statusCode).toBe(404);
  });
});
