import { RefusalError } from '@cuspatlas/contracts';
import type { PatientService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  // Missing or repeated headers are refused; the domain validates the value itself.
  if (typeof raw !== 'string') throw new RefusalError({ code: 'invalid_request' });
  return raw;
}

type PatientParams = { Params: { patientRef: string } };
type RelationshipParams = { Params: { patientRef: string; relationshipRef: string } };

/**
 * Thin REST adapter for patient identity (S4). Authenticates in `onRequest` before any body is
 * parsed and calls the patient domain service. No tenant is read from the path, query, headers or
 * body; search terms travel in a POST body so identifying text never appears in a URL.
 */
export function registerPatientRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; patients: PatientService },
): void {
  const on = (operation: string) => ({ onRequest: authenticateOnRequest(deps.authenticator, operation) });
  const svc = deps.patients;

  app.post(routeFor('patients.create').fastifyPath, on('patients.create'), async (request, reply) => {
    const result = await svc.createPatient(requireActor(request), {
      operation: 'patients.create',
      idempotencyKey: idempotencyKey(request),
      payload: request.body,
    });
    return reply.code(201).send(result);
  });

  app.post(routeFor('patients.search').fastifyPath, on('patients.search'), async (request) =>
    svc.searchPatients(requireActor(request), request.body ?? {}),
  );

  app.get<PatientParams>(routeFor('patients.read').fastifyPath, on('patients.read'), async (request) => ({
    data: await svc.readPatient(requireActor(request), request.params.patientRef, {
      ...(request.query as object),
    }),
  }));

  app.post<PatientParams>(
    routeFor('patients.updateDemographics').fastifyPath,
    on('patients.updateDemographics'),
    async (request) =>
      svc.updatePatientDemographics(requireActor(request), request.params.patientRef, {
        operation: 'patients.updateDemographics',
        idempotencyKey: idempotencyKey(request),
        payload: request.body,
      }),
  );

  app.post<PatientParams>(
    routeFor('patients.setStatus').fastifyPath,
    on('patients.setStatus'),
    async (request) =>
      svc.setPatientStatus(requireActor(request), request.params.patientRef, {
        operation: 'patients.setStatus',
        idempotencyKey: idempotencyKey(request),
        payload: request.body,
      }),
  );

  // S5 relationships.
  app.post<PatientParams>(
    routeFor('patients.relationships.add').fastifyPath,
    on('patients.relationships.add'),
    async (request, reply) => {
      const result = await svc.addRelationship(requireActor(request), request.params.patientRef, {
        operation: 'patients.relationships.add',
        idempotencyKey: idempotencyKey(request),
        payload: request.body,
      });
      return reply.code(201).send(result);
    },
  );

  app.get<PatientParams>(
    routeFor('patients.relationships.list').fastifyPath,
    on('patients.relationships.list'),
    async (request) =>
      svc.listRelationships(requireActor(request), request.params.patientRef, {
        ...(request.query as object),
      }),
  );

  app.post<RelationshipParams>(
    routeFor('patients.relationships.revoke').fastifyPath,
    on('patients.relationships.revoke'),
    async (request) =>
      svc.revokeRelationship(
        requireActor(request),
        request.params.patientRef,
        request.params.relationshipRef,
        {
          operation: 'patients.relationships.revoke',
          idempotencyKey: idempotencyKey(request),
          payload: request.body,
        },
      ),
  );

  app.get<PatientParams>(
    routeFor('patients.access.resolve').fastifyPath,
    on('patients.access.resolve'),
    async (request) =>
      svc.resolvePatientAccess(requireActor(request), request.params.patientRef, {
        ...(request.query as object),
      }),
  );

  // S6 duplicate review, merge and unmerge.
  app.get<PatientParams>(
    routeFor('patients.duplicates.find').fastifyPath,
    on('patients.duplicates.find'),
    async (request) =>
      svc.findDuplicateCandidates(requireActor(request), request.params.patientRef, {
        ...(request.query as object),
      }),
  );

  app.post(routeFor('patients.merge').fastifyPath, on('patients.merge'), async (request, reply) => {
    const result = await svc.mergePatients(requireActor(request), {
      operation: 'patients.merge',
      idempotencyKey: idempotencyKey(request),
      payload: request.body,
    });
    return reply.code(201).send(result);
  });

  app.post<{ Params: { mergeRef: string } }>(
    routeFor('patients.unmerge').fastifyPath,
    on('patients.unmerge'),
    async (request) =>
      svc.unmergePatients(requireActor(request), request.params.mergeRef, {
        operation: 'patients.unmerge',
        idempotencyKey: idempotencyKey(request),
        payload: request.body,
      }),
  );

  app.get<PatientParams>(
    routeFor('patients.merges.list').fastifyPath,
    on('patients.merges.list'),
    async (request) =>
      svc.listMergeHistory(requireActor(request), request.params.patientRef, {
        ...(request.query as object),
      }),
  );
}
