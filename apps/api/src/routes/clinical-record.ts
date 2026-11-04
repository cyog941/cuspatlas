import type { ClinicalService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/** The Idempotency-Key, validated by the domain after authorization (the scheduling-route pattern). */
function key(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  return typeof raw === 'string' ? raw : '';
}

type Handler = (request: FastifyRequest) => Promise<unknown>;

/**
 * Thin REST adapter for the structured clinical record (C6 chart, C7 periodontal charting, C11
 * treatment plans). Authentication runs in `onRequest`; no tenant is read from the path, query,
 * headers or body. Refusals are thrown and mapped centrally, never 2xx.
 */
export function registerClinicalRecordRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; clinical: ClinicalService },
): void {
  const c = deps.clinical;
  const mount = (operationId: string, handler: Handler) => {
    const r = routeFor(operationId);
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, r.operationId) };
    if (r.method === 'get') {
      app.get(r.fastifyPath, opts, async (request) => handler(request));
    } else {
      app.post(r.fastifyPath, opts, async (request, reply) =>
        reply.code(Number(r.success.status)).send(await handler(request)),
      );
    }
  };
  const env = (operation: string, request: FastifyRequest) => ({
    operation,
    idempotencyKey: key(request),
    payload: request.body,
  });
  const param = (request: FastifyRequest, name: string) =>
    (request.params as Record<string, string>)[name] ?? '';
  const query = (request: FastifyRequest) => ({ ...(request.query as object) });

  // C6 chart.
  mount('clinical.chart.recordEntry', (r) =>
    c.recordChartEntry(requireActor(r), env('clinical.chart.recordEntry', r)),
  );
  mount('clinical.chart.correctEntry', (r) =>
    c.correctChartEntry(requireActor(r), param(r, 'chartEntryRef'), env('clinical.chart.correctEntry', r)),
  );
  mount('clinical.chart.read', async (r) => ({
    data: await c.readChart(requireActor(r), param(r, 'patientRef'), query(r)),
  }));
  // C7 periodontal exams.
  mount('clinical.perio.recordExam', (r) =>
    c.recordPerioExam(requireActor(r), env('clinical.perio.recordExam', r)),
  );
  mount('clinical.perio.correctExam', (r) =>
    c.correctPerioExam(requireActor(r), param(r, 'perioExamRef'), env('clinical.perio.correctExam', r)),
  );
  mount('clinical.perio.derive', (r) =>
    c.derivePerioValues(requireActor(r), param(r, 'perioExamRef'), env('clinical.perio.derive', r)),
  );
  mount('clinical.perio.readExam', async (r) => ({
    data: await c.readPerioExam(requireActor(r), param(r, 'perioExamRef')),
  }));
  mount('clinical.perio.listExams', async (r) => ({
    data: await c.listPerioExams(requireActor(r), param(r, 'patientRef')),
  }));
  mount('clinical.perio.compare', async (r) => ({
    data: await c.comparePerioExams(requireActor(r), query(r)),
  }));
  // C16 lab cases.
  mount('clinical.labCases.create', (r) =>
    c.createLabCase(requireActor(r), env('clinical.labCases.create', r)),
  );
  mount('clinical.labCases.worklist', async (r) => ({
    data: await c.labWorklist(requireActor(r), query(r)),
  }));
  mount('clinical.labCases.read', async (r) => ({
    data: await c.readLabCase(requireActor(r), param(r, 'labCaseRef')),
  }));
  mount('clinical.labCases.export', async (r) => ({
    data: await c.exportLabCase(requireActor(r), param(r, 'labCaseRef')),
  }));
  mount('clinical.labCases.setState', (r) =>
    c.setLabCaseState(requireActor(r), param(r, 'labCaseRef'), env('clinical.labCases.setState', r)),
  );
  mount('clinical.labCases.recordReturn', (r) =>
    c.recordLabReturn(requireActor(r), param(r, 'labCaseRef'), env('clinical.labCases.recordReturn', r)),
  );
  mount('clinical.labCases.attach', (r) =>
    c.attachLabDocument(requireActor(r), param(r, 'labCaseRef'), env('clinical.labCases.attach', r)),
  );
  mount('clinical.labCases.remake', (r) =>
    c.remakeLabCase(requireActor(r), param(r, 'labCaseRef'), env('clinical.labCases.remake', r)),
  );
  mount('clinical.labCases.list', async (r) => ({
    data: await c.listLabCases(requireActor(r), param(r, 'patientRef')),
  }));
  // C15 encounter image links.
  mount('clinical.imageLinks.link', (r) =>
    c.linkImageToEncounter(requireActor(r), param(r, 'encounterRef'), env('clinical.imageLinks.link', r)),
  );
  mount('clinical.imageLinks.list', async (r) => ({
    data: await c.listEncounterImages(requireActor(r), param(r, 'encounterRef')),
  }));
  mount('clinical.imageLinks.read', async (r) => ({
    data: await c.readImageLink(requireActor(r), param(r, 'imageLinkRef')),
  }));
  mount('clinical.imageLinks.relink', (r) =>
    c.relinkImage(requireActor(r), param(r, 'imageLinkRef'), env('clinical.imageLinks.relink', r)),
  );
  mount('clinical.imageLinks.unlink', (r) =>
    c.unlinkImage(requireActor(r), param(r, 'imageLinkRef'), env('clinical.imageLinks.unlink', r)),
  );
  // C14 rendered procedures.
  mount('clinical.procedures.render', (r) =>
    c.renderProcedure(requireActor(r), param(r, 'encounterRef'), env('clinical.procedures.render', r)),
  );
  mount('clinical.procedures.list', async (r) => ({
    data: await c.listProcedures(requireActor(r), param(r, 'encounterRef')),
  }));
  mount('clinical.procedures.read', async (r) => ({
    data: await c.readProcedure(requireActor(r), param(r, 'procedureRef')),
  }));
  mount('clinical.procedures.correct', (r) =>
    c.correctProcedure(requireActor(r), param(r, 'procedureRef'), env('clinical.procedures.correct', r)),
  );
  // C13 consent capture.
  mount('clinical.consents.capture', (r) =>
    c.captureConsent(requireActor(r), env('clinical.consents.capture', r)),
  );
  mount('clinical.consents.read', async (r) => ({
    data: await c.readConsent(requireActor(r), param(r, 'consentRef')),
  }));
  mount('clinical.consents.withdraw', (r) =>
    c.withdrawConsent(requireActor(r), param(r, 'consentRef'), env('clinical.consents.withdraw', r)),
  );
  mount('clinical.consents.list', (r) => c.listConsents(requireActor(r), param(r, 'patientRef'), query(r)));
  mount('clinical.consentTemplates.register', (r) =>
    c.registerConsentTemplate(requireActor(r), env('clinical.consentTemplates.register', r)),
  );
  // C12 estimates, alternatives and acceptance.
  mount('clinical.estimates.generate', (r) =>
    c.generateEstimate(requireActor(r), param(r, 'planVersionRef'), env('clinical.estimates.generate', r)),
  );
  mount('clinical.estimates.list', async (r) => ({
    data: await c.listEstimates(requireActor(r), param(r, 'planVersionRef')),
  }));
  mount('clinical.estimates.read', async (r) => ({
    data: await c.readEstimate(requireActor(r), param(r, 'estimateRef')),
  }));
  mount('clinical.estimates.present', (r) =>
    c.presentEstimate(requireActor(r), param(r, 'estimateRef'), env('clinical.estimates.present', r)),
  );
  mount('clinical.estimates.accept', (r) =>
    c.acceptEstimate(requireActor(r), param(r, 'estimateRef'), env('clinical.estimates.accept', r)),
  );
  mount('clinical.treatmentPlans.createAlternative', (r) =>
    c.createPlanAlternative(
      requireActor(r),
      param(r, 'planRef'),
      env('clinical.treatmentPlans.createAlternative', r),
    ),
  );
  mount('clinical.treatmentPlans.alternatives', async (r) => ({
    data: await c.listPlanAlternatives(requireActor(r), param(r, 'planRef')),
  }));
  // C11 treatment plans.
  mount('clinical.treatmentPlans.create', (r) =>
    c.createTreatmentPlan(requireActor(r), env('clinical.treatmentPlans.create', r)),
  );
  mount('clinical.treatmentPlans.read', async (r) => ({
    data: await c.readTreatmentPlan(requireActor(r), param(r, 'planRef')),
  }));
  mount('clinical.treatmentPlans.list', async (r) => ({
    data: await c.listTreatmentPlans(requireActor(r), param(r, 'patientRef')),
  }));
  mount('clinical.treatmentPlans.addDetail', (r) =>
    c.addPlanDetail(requireActor(r), param(r, 'planVersionRef'), env('clinical.treatmentPlans.addDetail', r)),
  );
  mount('clinical.treatmentPlans.addItem', (r) =>
    c.addPlanItem(requireActor(r), param(r, 'planDetailRef'), env('clinical.treatmentPlans.addItem', r)),
  );
  mount('clinical.treatmentPlans.setItemState', (r) =>
    c.setPlanItemState(
      requireActor(r),
      param(r, 'planItemRef'),
      env('clinical.treatmentPlans.setItemState', r),
    ),
  );
  mount('clinical.treatmentPlans.setDetailState', (r) =>
    c.setPlanDetailState(
      requireActor(r),
      param(r, 'planDetailRef'),
      env('clinical.treatmentPlans.setDetailState', r),
    ),
  );
  mount('clinical.treatmentPlans.supersede', (r) =>
    c.supersedePlanVersion(
      requireActor(r),
      param(r, 'planVersionRef'),
      env('clinical.treatmentPlans.supersede', r),
    ),
  );
}
