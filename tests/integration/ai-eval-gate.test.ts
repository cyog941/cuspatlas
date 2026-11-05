import { randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  AI_EVAL_CASE_SETS,
  AI_USE_CASE_REGISTRY,
  caseSetVersionOf,
  createAgentService,
  createAuthorize,
  createSyntheticModelAdapter,
  type ModelAdapter,
  runEvaluation,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentStack, startAgentStack } from './support/agent-stack';
import { ctxFor, T_ALPHA } from './support/fixtures';

/**
 * A12: versioned synthetic evaluation sets per AI use case, a red-team corpus (prompt injection, PHI
 * exfiltration attempts, out-of-scope tool requests), metrics with recorded thresholds (pending
 * approval) and a regression gate: a use case cannot be enabled, and stops running, while the
 * evaluation of its current model, prompt version and case set is failing, inconclusive or stale.
 * Synthetic model only; an evaluation result is never clinical validation.
 */
let s: AgentStack;
type Run = {
  runRef: string;
  verdict: string;
  modelRef: string;
  promptVersionRef: string;
  caseSetVersion: string;
  repetitions: number;
  metrics: Record<string, number>;
  failedCases: string[];
};
const run = (body: Record<string, unknown>) => s.call('humanAll', 'POST', '/v1/ai/evaluations', body);
const enable = (useCase: string, enabled = true) =>
  s.call('humanAll', 'POST', '/v1/ai/use-cases/configure', { useCase, enabled });

/** A domain service over a deliberately weakened model (fabricates a tooth and a date). */
function weakService(): ReturnType<typeof createAgentService> {
  const base = createSyntheticModelAdapter();
  const weak: ModelAdapter = {
    modelRef: base.modelRef,
    locality: 'synthetic-local',
    generate: (req) => base.generate({ ...req, promptVersionRef: `${req.promptVersionRef}.weak` }),
  };
  const memberships = createMembershipSource(s.db.app);
  return createAgentService({
    authorize: createAuthorize(memberships),
    withTenantTransaction: createTenantTransactionRunner(s.db.app),
    recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
    ai: { model: weak, readers: null, owners: {} },
  });
}

beforeAll(async () => {
  s = await startAgentStack('ai_eval_gate');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('A12 evaluation harness', () => {
  it('every registered runnable use case has a versioned synthetic case set with a red-team part', () => {
    for (const [useCase, entry] of Object.entries(AI_USE_CASE_REGISTRY)) {
      if (entry.approval === 'notApproved') continue;
      const set = AI_EVAL_CASE_SETS[useCase as keyof typeof AI_EVAL_CASE_SETS];
      expect(set?.version, useCase).toBe(entry.caseSetVersion);
      const classes = new Set(set?.cases.map((c) => c.class));
      for (const c of ['faithfulness', 'injection', 'minimization', 'refusal', 'availability']) {
        expect(classes.has(c as never), `${useCase} ${c}`).toBe(true);
      }
    }
  });

  it('the harness prepares input through the pipeline preparation; the case-set version digests the cases', async () => {
    const seen: string[] = [];
    const inner = createSyntheticModelAdapter();
    const model: ModelAdapter = {
      ...inner,
      generate(req) {
        seen.push(req.instructions);
        return inner.generate(req);
      },
    };
    await runEvaluation(model, 'clinicalNoteDraft', 'note-draft.1', 1);
    expect(seen.length).toBeGreaterThan(0);
    for (const i of seen) {
      expect(i).not.toMatch(/ref=/);
      expect(i).toMatch(/n=S1/);
    }
    expect(caseSetVersionOf('clinicalNoteDraft')).toMatch(/^note-draft-cases[.]1[.][0-9a-f]{12}$/);
  });

  it('a passing run names the model, prompt version and case set and the red-team corpus is caught', async () => {
    const r = await run({ useCase: 'clinicalNoteDraft', repetitions: 3 });
    expect(r.status).toBe(201);
    const d = r.body.data as Run;
    expect(d.verdict).toBe('pass');
    expect(d).toMatchObject({
      modelRef: 'synthetic-model.1',
      promptVersionRef: 'note-draft.1',
      caseSetVersion: caseSetVersionOf('clinicalNoteDraft'),
      repetitions: 3,
    });
    expect(d.metrics.faithfulness).toBe(1);
    expect(d.metrics.injectionDetection).toBe(1);
    expect(d.metrics.minimization).toBe(1);
    expect(d.metrics.refusal).toBe(1);
    // The outage case is availability, never folded into the quality verdict.
    expect(d.metrics.availability).toBeLessThan(1);
    expect((await enable('clinicalNoteDraft')).status).toBe(200);
  });

  it('a run for another model or prompt version is stale for the current identity', async () => {
    await s.db.admin.query(
      `INSERT INTO cuspatlas.ai_evaluation_runs (tenant_id, use_case, model_ref, prompt_version_ref, case_set_version,
         repetitions, verdict, metrics, failed_cases, case_results, ran_by)
       VALUES ($1, 'patientMessageDraft', 'synthetic-model.0', 'message-draft.0', 'message-draft-cases.1', 3, 'pass',
         '{}', '{}', '[]', (SELECT id FROM cuspatlas.principals WHERE kind = 'human' LIMIT 1))`,
      [T_ALPHA],
    );
    const list = await s.call('humanAll', 'GET', '/v1/ai/use-cases');
    const m = (list.body.items as { useCase: string; gate: string }[]).find(
      (x) => x.useCase === 'patientMessageDraft',
    );
    expect(m?.gate).toBe('stale');
    const e = await enable('patientMessageDraft');
    expect((e.body.detail as { reason: string }).reason).toBe('evaluation_stale');
  });

  it('fewer repetitions than the recorded minimum are inconclusive and block enabling', async () => {
    const r = await run({ useCase: 'patientMessageDraft', repetitions: 1 });
    expect((r.body.data as Run).verdict).toBe('inconclusive');
    const e = await enable('patientMessageDraft');
    expect(e.status).toBe(409);
    expect((e.body.detail as { reason: string }).reason).toBe('evaluation_inconclusive');
  });

  it('a candidate prompt that fabricates fails with the case named and leaves the current gate alone', async () => {
    const r = await run({
      useCase: 'clinicalNoteDraft',
      promptVersionRef: 'note-draft.1.weak',
      repetitions: 3,
    });
    const d = r.body.data as Run;
    expect(d.verdict).toBe('fail');
    expect(d.failedCases).toContain('nd-faith-1');
    const list = await s.call('humanAll', 'GET', '/v1/ai/use-cases');
    const note = (list.body.items as { useCase: string; gate: string }[]).find(
      (x) => x.useCase === 'clinicalNoteDraft',
    );
    expect(note?.gate).toBe('pass');
  });

  it('a regressed current model suspends the use case: drafts and enabling are refused', async () => {
    const svc = weakService();
    const ctx = ctxFor(
      T_ALPHA,
      (
        await s.db.admin.query<{ id: string }>(
          `SELECT principal_id AS id FROM cuspatlas.memberships WHERE tenant_id = $1 AND 'admin.configure' = ANY (scopes)
         AND principal_id IN (SELECT id FROM cuspatlas.principals WHERE kind = 'human') AND revoked_at IS NULL LIMIT 1`,
          [T_ALPHA],
        )
      ).rows[0]?.id as string,
      'human',
      ['admin.configure'],
    );
    const r = await svc.runAiEvaluation(ctx, {
      operation: 'ai.evaluations.run',
      idempotencyKey: randomUUID(),
      payload: { useCase: 'claimReadinessExplanation', repetitions: 3 },
    });
    expect(r.data.verdict).toBe('fail');
    const e = await enable('claimReadinessExplanation');
    expect(e.status).toBe(409);
    expect((e.body.detail as { reason: string }).reason).toBe('evaluation_fail');
  });

  it('runs are listed newest first in the list envelope and the run record cannot be changed', async () => {
    const l = await s.call('humanAll', 'GET', '/v1/ai/evaluations?useCase=clinicalNoteDraft');
    expect(l.status).toBe(200);
    expect((l.body.items as Run[]).length).toBeGreaterThanOrEqual(2);
    expect(l.body.count).toBeDefined();
    await expect(
      s.db.admin.query(`UPDATE cuspatlas.ai_evaluation_runs SET verdict = 'pass'`),
    ).rejects.toThrow();
  });

  it('agents cannot run evaluations or switch use cases', async () => {
    const a = await s.createAgent(['ai.read', 'ai.draft']);
    expect(
      (
        await s.agentTool(a, 'ai_evaluations_run', {
          useCase: 'clinicalNoteDraft',
          idempotencyKey: randomUUID(),
        })
      ).body.code,
    ).toBe('forbidden');
    expect((await s.agentTool(a, 'ai_evaluations_list', {})).isError).toBe(false);
  });
});
