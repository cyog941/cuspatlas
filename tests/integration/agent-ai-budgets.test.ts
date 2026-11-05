import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentStack, startAgentStack } from './support/agent-stack';
import { M_HUMAN_ALL, M_HUMAN_NONE } from './support/catalog-stack';
import { T_ALPHA } from './support/fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * H3 (A9 x A11): an agent's AI draft calls are charged for the PHI they move. Creating a draft is
 * charged, before generation, for every source record and its PHI fields (read through the owners);
 * reading a draft is charged by its PHI weight (free text counted per 500 characters) and as one
 * record. Synthetic data only.
 */
let s: AgentStack;
let encounterRef: string;
let noteRef: string;
const AI = ['ai.draft', 'ai.read', 'clinical.read'];
const OPS = ['ai.drafts.create', 'ai.drafts.read'];
const createDraft = (a: Parameters<AgentStack['agentTool']>[0], withNote = false) =>
  s.agentTool(a, 'ai_drafts_create', {
    useCase: 'clinicalNoteDraft',
    sourceRefs: [
      { kind: 'encounter', ref: encounterRef },
      ...(withNote ? [{ kind: 'note', ref: noteRef }] : []),
    ],
    idempotencyKey: randomUUID(),
  });
const drafts = async (agentRef: string) =>
  Number(
    (
      await s.db.admin.query<{ n: string }>(
        'SELECT count(*) AS n FROM cuspatlas.ai_drafts WHERE created_by = $1',
        [agentRef],
      )
    ).rows[0]?.n,
  );

beforeAll(async () => {
  s = await startAgentStack('agent_ai_budgets');
  await s.db.admin.query(
    `INSERT INTO cuspatlas.clinical_author_profiles (tenant_id, actor_id, role, credential_ref, defined_by, updated_by)
     VALUES ($1, $2, 'dentist', 'SYN-CRED-C1', $3, $3)`,
    [T_ALPHA, M_HUMAN_ALL, M_HUMAN_NONE],
  );
  const ok = (r: { status: number; body: Record<string, unknown> }, status = 201) => {
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    return r.body;
  };
  ok(
    await s.call('humanAll', 'POST', '/v1/scheduling/locations', {
      locationRef: 'loc-ai',
      displayLabel: 'Synthetic loc-ai',
      timeZone: 'America/New_York',
    }),
  );
  const p = ok(await s.call('humanAll', 'POST', '/v1/patients', patientBody('Budgetai')));
  const patientRef = (p.data as { patientRef: string }).patientRef;
  const e = ok(
    await s.call('humanAll', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: 'loc-ai' }),
  );
  encounterRef = (e.data as { encounter: { encounterRef: string } }).encounter.encounterRef;
  const n = ok(
    await s.call('humanAll', 'POST', `/v1/clinical/encounters/${encounterRef}/notes`, {
      noteType: 'progress',
      // One long free-text field: 1600 characters weigh four PHI fields.
      content: { sections: [{ sectionKey: 'subjective', text: 'Synthetic long note text. '.repeat(64) }] },
    }),
  );
  noteRef = (n.data as { noteRef: string }).noteRef;
  ok(await s.call('humanAll', 'POST', '/v1/ai/evaluations', { useCase: 'clinicalNoteDraft' }));
  ok(
    await s.call('humanAll', 'POST', '/v1/ai/use-cases/configure', {
      useCase: 'clinicalNoteDraft',
      enabled: true,
    }),
    200,
  );
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('H3 AI draft budgets', () => {
  it('creating a draft is charged for its source PHI before generation (phiFieldsPerCall=3)', async () => {
    const a = await s.createAgent(AI, 'ai phi per call', undefined, { consent: false });
    await s.consent(a, OPS, { phiFieldsPerCall: 3 });
    const r = await createDraft(a, true);
    expect(r.body.code).toBe('rate_limited');
    expect((r.body.detail as { limit: { name: string } }).limit.name).toBe('phiFieldsPerCall');
    expect(await drafts(a.agentRef)).toBe(0);
  });

  it('creating a draft is charged per source record against the period budget', async () => {
    const a = await s.createAgent(AI, 'ai records per period', undefined, { consent: false });
    await s.consent(a, OPS, { recordsPerPeriod: 1 });
    // The command took effect, so a budget exceeded by its result is a warning on the success.
    const first = await createDraft(a);
    expect(first.isError).toBe(false);
    expect(first.meta?.budgetWarning).toMatchObject({
      reason: 'budget_exceeded_after_effect',
      limit: { name: 'recordsPerPeriod' },
    });
    const second = await createDraft(a);
    expect(second.body.code).toBe('rate_limited');
    expect((second.body.detail as { limit: { name: string } }).limit.name).toBe('recordsPerPeriod');
    expect(await drafts(a.agentRef)).toBe(1);
  });

  it('reading a draft is one record charged by its PHI weight (phiFieldsPerCall=3)', async () => {
    const a = await s.createAgent(AI, 'ai read weight', undefined, { consent: false });
    await s.consent(a, OPS, {});
    const c = await createDraft(a);
    expect(c.isError).toBe(false);
    const draftRef = (c.body.data as { draftRef: string }).draftRef;
    const ok = await s.agentTool(a, 'ai_drafts_get', { draftRef });
    expect(ok.isError).toBe(false);
    const text = String((ok.body as { text?: string }).text ?? (ok.body.data as { text?: string })?.text);
    const log = await s.db.admin.query<{ records: number; phi_fields: number }>(
      `SELECT records, phi_fields FROM cuspatlas.agent_tool_calls
       WHERE agent_ref = $1 AND operation = 'ai.drafts.read' AND outcome = 'ok'`,
      [a.agentRef],
    );
    expect(log.rows[0]?.records).toBe(1);
    expect(log.rows[0]?.phi_fields).toBeGreaterThanOrEqual(Math.ceil(text.length / 500));
    await s.consent(a, OPS, { phiFieldsPerCall: 3 });
    const over = await s.agentTool(a, 'ai_drafts_get', { draftRef });
    expect(over.body.code).toBe('rate_limited');
    expect((over.body.detail as { limit: { name: string } }).limit.name).toBe('phiFieldsPerCall');
  });
});
