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
 * Thin REST adapter for the clinical service (C5). Authentication runs in `onRequest`; no tenant is
 * read from the path, query, headers or body. Refusals are thrown and mapped centrally, never 2xx.
 */
export function registerClinicalRoutes(
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

  mount('clinical.authors.define', (r) =>
    c.defineClinicalAuthor(requireActor(r), env('clinical.authors.define', r)),
  );
  mount('clinical.authors.context', async (r) => ({ data: await c.getAuthorContext(requireActor(r)) }));
  mount('clinical.encounters.open', (r) =>
    c.openEncounter(requireActor(r), env('clinical.encounters.open', r)),
  );
  mount('clinical.encounters.read', async (r) => ({
    data: await c.readEncounter(requireActor(r), param(r, 'encounterRef')),
  }));
  mount('clinical.encounters.assign', (r) =>
    c.assignEncounterRole(requireActor(r), param(r, 'encounterRef'), env('clinical.encounters.assign', r)),
  );
  mount('clinical.encounters.close', (r) =>
    c.closeEncounter(requireActor(r), param(r, 'encounterRef'), env('clinical.encounters.close', r)),
  );
  mount('clinical.encounters.list', (r) =>
    c.listEncounters(requireActor(r), param(r, 'patientRef'), { ...(r.query as object) }),
  );
  mount('clinical.history.recordChange', (r) =>
    c.recordHistoryChange(requireActor(r), env('clinical.history.recordChange', r)),
  );
  mount('clinical.history.read', async (r) => ({
    data: await c.readHistory(requireActor(r), param(r, 'patientRef'), { ...(r.query as object) }),
  }));
  mount('clinical.history.readVersion', async (r) => ({
    data: await c.getHistoryVersion(requireActor(r), param(r, 'historyVersionRef')),
  }));
  mount('clinical.history.alerts', async (r) => ({
    data: await c.getActiveAlerts(requireActor(r), param(r, 'patientRef')),
  }));
  mount('clinical.history.verifyItem', (r) =>
    c.verifyHistoryItem(requireActor(r), param(r, 'itemRef'), env('clinical.history.verifyItem', r)),
  );
  mount('clinical.history.attestReview', (r) =>
    c.attestHistoryReview(requireActor(r), param(r, 'encounterRef'), env('clinical.history.attestReview', r)),
  );
  mount('clinical.noteTemplates.define', (r) =>
    c.defineNoteTemplate(requireActor(r), env('clinical.noteTemplates.define', r)),
  );
  mount('clinical.noteTemplates.read', async (r) => ({
    data: await c.readNoteTemplate(requireActor(r), param(r, 'templateRef')),
  }));
  mount('clinical.noteTemplates.revise', (r) =>
    c.reviseNoteTemplate(requireActor(r), param(r, 'templateRef'), env('clinical.noteTemplates.revise', r)),
  );
  mount('clinical.noteTemplates.retire', (r) =>
    c.retireNoteTemplate(requireActor(r), param(r, 'templateRef'), env('clinical.noteTemplates.retire', r)),
  );
  mount('clinical.noteTemplates.readVersion', async (r) => ({
    data: await c.readNoteTemplateVersion(requireActor(r), param(r, 'templateVersionRef')),
  }));
  mount('clinical.noteTemplates.applicable', async (r) => ({
    data: await c.listApplicableTemplates(requireActor(r), param(r, 'encounterRef'), {
      ...(r.query as object),
    }),
  }));
  mount('clinical.notes.createDraft', (r) =>
    c.createNoteDraft(requireActor(r), param(r, 'encounterRef'), env('clinical.notes.createDraft', r)),
  );
  mount('clinical.notes.list', async (r) => ({
    data: await c.listNotes(requireActor(r), param(r, 'encounterRef')),
  }));
  mount('clinical.notes.read', async (r) => ({
    data: await c.readNote(requireActor(r), param(r, 'noteRef')),
  }));
  mount('clinical.notes.updateDraft', (r) =>
    c.updateNoteDraft(requireActor(r), param(r, 'noteRef'), env('clinical.notes.updateDraft', r)),
  );
  mount('clinical.notes.sign', (r) =>
    c.signNote(requireActor(r), param(r, 'noteRef'), env('clinical.notes.sign', r)),
  );
  mount('clinical.notes.amend', (r) =>
    c.amendNote(requireActor(r), param(r, 'noteRef'), env('clinical.notes.amend', r)),
  );
  mount('clinical.notes.addendum', (r) =>
    c.addNoteAddendum(requireActor(r), param(r, 'noteRef'), env('clinical.notes.addendum', r)),
  );
  mount('clinical.notes.cosign', (r) =>
    c.cosignNote(requireActor(r), param(r, 'noteRef'), env('clinical.notes.cosign', r)),
  );
}
