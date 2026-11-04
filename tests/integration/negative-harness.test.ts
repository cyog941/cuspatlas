import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Workstream C (clinical record) rows are appended below with their own fixtures.
import { seedClinicalScopes, seedDispositions, seedPerioConfiguration } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A2, USER_A4, USER_B1 } from './support/fixtures';
import { fakeImageResolver } from './support/image-ref-resolver';
import { MARKER } from './support/marker';
import { seedNoteScopes } from './support/note-fixtures';
import { patientBody, seedPatientScopes, USER_A5 } from './support/patient-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './support/test-token-issuer';

/**
 * Shared negative harness for workstream S (Global Constraints of the scheduling and patients plan).
 * Every S command is attempted cross-tenant, with a revoked membership, with a downgraded role and
 * through MCP, under the runtime role. Append a row to COMMANDS for each new command; the
 * dimensions below run for every row unchanged.
 */

const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let mcp: McpServerHandle;
let mcpUrl: string;
let logLines: string[];
const rest: Record<string, string> = {};
const mcpTokens: Record<string, string> = {};

/** Fixture references created once per run (alpha tenant unless stated). */
export interface HarnessFixture {
  readonly alphaPatient: string;
  readonly [name: string]: string;
}
let fixture: HarnessFixture;
const harnessImages = fakeImageResolver();

type Method = 'GET' | 'POST';
interface RestCall {
  readonly method: Method;
  readonly url: string;
  readonly body?: unknown;
  /** Mutations carry an Idempotency-Key header; reads do not. */
  readonly keyed: boolean;
  readonly status: number;
}

export interface HarnessCommand {
  /** Operation id (also the security-attempt `operation`). */
  readonly operation: string;
  readonly tool: string;
  /**
   * What another tenant's member gets: hidden (404) for targeted commands, an empty page for searches,
   * a write into its own tenant for creates, or (tenant_own_data) a success computed over its own
   * tenant only, which must carry no alpha fixture reference.
   */
  readonly crossTenant:
    | 'not_found'
    | 'empty_page'
    | 'own_tenant_only'
    | 'confirmation_denied'
    | 'tenant_own_data';
  /** Who stands for "downgraded": a member lacking this command's scope. */
  readonly downgradedTo: 'readOnly' | 'noPatientScopes';
  rest(f: HarnessFixture): RestCall;
  mcpArgs(f: HarnessFixture): Record<string, unknown>;
}

const P = (f: HarnessFixture) => f.alphaPatient;
const SOON = new Date(Date.now() + 7 * 86_400_000).toISOString();
/** Well-formed but never issued: every merge attempt in the harness must be refused before using it. */
const FAKE_TOKEN = 'v1.9999999999.1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** S4 rows. S5, S6 and the scheduling tasks append their commands here. */
export const COMMANDS: HarnessCommand[] = [
  {
    operation: 'patients.create',
    tool: 'patients_create',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/patients',
      body: patientBody(`Synthetic ${MARKER}`),
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({ ...patientBody(`Synthetic ${MARKER}`), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'patients.read',
    tool: 'patients_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/patients/${P(f)}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'patients.search',
    tool: 'patients_search',
    crossTenant: 'empty_page',
    downgradedTo: 'noPatientScopes',
    rest: () => ({
      method: 'POST',
      url: '/v1/patients/search',
      body: { name: 'Synthetic Harness' },
      keyed: false,
      status: 200,
    }),
    mcpArgs: () => ({ name: 'Synthetic Harness' }),
  },
  {
    operation: 'patients.updateDemographics',
    tool: 'patients_update_demographics',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/demographics`,
      body: { expectedVersion: 1, preferredName: { known: true, value: MARKER } },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      expectedVersion: 1,
      preferredName: { known: true, value: MARKER },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'patients.setStatus',
    tool: 'patients_set_status',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/status`,
      body: {
        expectedVersion: 1,
        status: 'inactive',
        effectiveAt: '2026-10-01T00:00:00Z',
        reasonCode: 'moved_away',
      },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      expectedVersion: 1,
      status: 'inactive',
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: 'moved_away',
      idempotencyKey: randomUUID(),
    }),
  },
  // S5 relationship commands.
  {
    operation: 'patients.relationships.add',
    tool: 'patients_add_relationship',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/relationships`,
      body: {
        counterpartyRef: f.alphaCounterparty,
        kind: 'proxy',
        scopes: ['demographics'],
        effectiveUntil: SOON,
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      counterpartyRef: f.alphaCounterparty,
      kind: 'proxy',
      scopes: ['demographics'],
      effectiveUntil: SOON,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'patients.relationships.list',
    tool: 'patients_list_relationships',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/patients/${P(f)}/relationships`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'patients.relationships.revoke',
    tool: 'patients_revoke_relationship',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/relationships/${f.alphaRelationship}/revoke`,
      body: { expectedVersion: 1, reasonCode: 'patient_request' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      relationshipRef: f.alphaRelationship,
      expectedVersion: 1,
      reasonCode: 'patient_request',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'patients.access.resolve',
    tool: 'patients_resolve_access',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/patients/${P(f)}/access?counterpartyRef=${f.alphaCounterparty}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: P(f), counterpartyRef: f.alphaCounterparty }),
  },
  // S6 duplicate review and merge commands.
  {
    operation: 'patients.duplicates.find',
    tool: 'patients_find_duplicates',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/patients/${P(f)}/duplicate-candidates`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'patients.merge',
    tool: 'patients_merge',
    crossTenant: 'confirmation_denied',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/patients/merges',
      body: {
        survivorRef: P(f),
        mergedRef: f.alphaCounterparty,
        confirmationToken: FAKE_TOKEN,
        reasonCode: 'other',
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      survivorRef: P(f),
      mergedRef: f.alphaCounterparty,
      confirmationToken: FAKE_TOKEN,
      reasonCode: 'other',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'patients.unmerge',
    tool: 'patients_unmerge',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/merges/${f.alphaMerge}/unmerge`,
      body: { reasonCode: 'merged_in_error' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({ mergeRef: f.alphaMerge, reasonCode: 'merged_in_error', idempotencyKey: randomUUID() }),
  },
  {
    operation: 'patients.merges.list',
    tool: 'patients_list_merge_history',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/patients/${f.alphaMergedPatient}/merge-history`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: f.alphaMergedPatient }),
  },
  // S7 and S9 (resources track, folded in from resources-negative.test.ts). Writes are downgraded
  // to a scheduling-read-only member; reads to a member holding no scheduling scope.
  {
    operation: 'scheduling.locations.define',
    tool: 'scheduling_locations_define',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/scheduling/locations',
      body: {
        locationRef: uniqueLocation(),
        displayLabel: 'Synthetic Location',
        timeZone: 'America/New_York',
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({
      locationRef: uniqueLocation(),
      displayLabel: 'Synthetic Location',
      timeZone: 'America/New_York',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.locations.list',
    tool: 'scheduling_locations_list',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({ method: 'GET', url: '/v1/scheduling/locations', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'scheduling.locations.changeTimeZone',
    tool: 'scheduling_locations_change_time_zone',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/scheduling/locations/${f.alphaLocation}/time-zone`,
      body: { timeZone: 'America/Chicago', expectedVersion: 1 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      locationRef: f.alphaLocation,
      timeZone: 'America/Chicago',
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.resources.define',
    tool: 'scheduling_resources_define',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/scheduling/resources',
      body: { kind: 'operatory', locationRef: f.alphaLocation, displayLabel: 'Operatory 7' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      kind: 'operatory',
      locationRef: f.alphaLocation,
      displayLabel: 'Operatory 7',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.resources.list',
    tool: 'scheduling_resources_list',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({ method: 'GET', url: '/v1/scheduling/resources', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'scheduling.resources.read',
    tool: 'scheduling_resources_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/scheduling/resources/${f.alphaResource}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ resourceRef: f.alphaResource }),
  },
  {
    operation: 'scheduling.resources.setAvailability',
    tool: 'scheduling_resources_set_availability',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/scheduling/resources/${f.alphaResource}/availability`,
      body: { effectiveFrom: '2030-06-03', weekly: [] },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      resourceRef: f.alphaResource,
      effectiveFrom: '2030-06-03',
      weekly: [],
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.resources.deactivate',
    tool: 'scheduling_resources_deactivate',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/scheduling/resources/${f.alphaOtherResource}/deactivate`,
      body: { expectedVersion: 1 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({ resourceRef: f.alphaOtherResource, expectedVersion: 1, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'scheduling.timeBlocks.create',
    tool: 'scheduling_time_blocks_create',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/scheduling/time-blocks',
      body: blockBody(f),
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ ...blockBody(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'scheduling.resources.dataQuality',
    tool: 'scheduling_resources_data_quality',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({
      method: 'GET',
      url: '/v1/scheduling/data-quality/state-labelled-resources',
      keyed: false,
      status: 200,
    }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'scheduling.availability.search',
    tool: 'availability_search',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/availability/search',
      body: searchBody(f),
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => searchBody(f),
  },
  // S8 appointment requests. Writes downgrade to a scheduling-read-only member; reads to a member
  // holding no scheduling scope.
  {
    operation: 'scheduling.requests.create',
    tool: 'scheduling_requests_create',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({ method: 'POST', url: REQ, body: requestBody(f), keyed: true, status: 201 }),
    mcpArgs: (f) => ({ ...requestBody(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'scheduling.requests.list',
    tool: 'scheduling_requests_list',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({ method: 'GET', url: REQ, keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'scheduling.requests.read',
    tool: 'scheduling_requests_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `${REQ}/${f.alphaRequest}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ requestRef: f.alphaRequest }),
  },
  {
    operation: 'scheduling.requests.updatePreferences',
    tool: 'scheduling_requests_update_preferences',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${REQ}/${f.alphaRequest}/preferences`,
      body: { expectedVersion: 1, note: `Synthetic ${MARKER}` },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      requestRef: f.alphaRequest,
      expectedVersion: 1,
      note: `Synthetic ${MARKER}`,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.requests.review',
    tool: 'scheduling_requests_review',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${REQ}/${f.alphaRequest}/review`,
      body: { expectedVersion: 1 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({ requestRef: f.alphaRequest, expectedVersion: 1, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'scheduling.requests.close',
    tool: 'scheduling_requests_close',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${REQ}/${f.alphaRequest}/close`,
      body: { expectedVersion: 1, state: 'withdrawn', reasonCode: 'patient_request' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      requestRef: f.alphaRequest,
      expectedVersion: 1,
      state: 'withdrawn',
      reasonCode: 'patient_request',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.requests.reopen',
    tool: 'scheduling_requests_reopen',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${REQ}/${f.alphaClosedRequest}/reopen`,
      body: { expectedVersion: 2, reasonCode: 'patient_called_back' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      requestRef: f.alphaClosedRequest,
      expectedVersion: 2,
      reasonCode: 'patient_called_back',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.requests.unbookedReport',
    tool: 'scheduling_requests_unbooked_report',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({
      method: 'GET',
      url: '/v1/scheduling/reports/unbooked-requests',
      keyed: false,
      status: 200,
    }),
    mcpArgs: () => ({}),
  },
  // S10 booking and holds.
  {
    operation: 'scheduling.appointments.book',
    tool: 'scheduling_appointments_book',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({ method: 'POST', url: APPT, body: bookingBody(f), keyed: true, status: 201 }),
    mcpArgs: (f) => ({ ...bookingBody(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'scheduling.appointments.read',
    tool: 'scheduling_appointments_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `${APPT}/${f.alphaAppointment}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ appointmentRef: f.alphaAppointment }),
  },
  {
    operation: 'scheduling.appointments.reschedule',
    tool: 'scheduling_appointments_reschedule',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${APPT}/${f.alphaAppointment}/reschedule`,
      body: rescheduleBody(f),
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      ...rescheduleBody(f),
      appointmentRef: f.alphaAppointment,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.appointments.cancel',
    tool: 'scheduling_appointments_cancel',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${APPT}/${f.alphaAppointment}/cancel`,
      body: { expectedVersion: 1, reasonCode: 'patient_request' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      appointmentRef: f.alphaAppointment,
      expectedVersion: 1,
      reasonCode: 'patient_request',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.holds.create',
    tool: 'scheduling_holds_create',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({ method: 'POST', url: HOLDS, body: holdBody(f), keyed: true, status: 201 }),
    mcpArgs: (f) => ({ ...holdBody(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'scheduling.holds.release',
    tool: 'scheduling_holds_release',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${HOLDS}/${f.alphaHold}/release`,
      body: { reasonCode: 'offer_declined' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({ holdRef: f.alphaHold, reasonCode: 'offer_declined', idempotencyKey: randomUUID() }),
  },
  {
    operation: 'scheduling.holds.reconcile',
    tool: 'scheduling_holds_reconcile',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'readOnly',
    rest: () => ({ method: 'POST', url: `${HOLDS}/reconcile`, body: {}, keyed: true, status: 200 }),
    mcpArgs: () => ({ idempotencyKey: randomUUID() }),
  },
  // S11 attendance and the daily worklist.
  {
    operation: 'scheduling.attendance.record',
    tool: 'scheduling_attendance_record',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `${APPT}/${f.alphaAppointment}/attendance`,
      body: { kind: 'arrived', note: `Synthetic ${MARKER}` },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      appointmentRef: f.alphaAppointment,
      kind: 'arrived',
      note: `Synthetic ${MARKER}`,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'scheduling.attendance.list',
    tool: 'scheduling_attendance_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `${APPT}/${f.alphaAppointment}/attendance`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ appointmentRef: f.alphaAppointment }),
  },
  {
    operation: 'scheduling.attendance.visitStatus',
    tool: 'scheduling_attendance_visit_status',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `${APPT}/${f.alphaAppointment}/visit-status`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ appointmentRef: f.alphaAppointment }),
  },
  {
    operation: 'scheduling.worklist.daily',
    tool: 'scheduling_worklist_daily',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/scheduling/worklist?locationRef=${f.alphaLocation}&date=2030-01-07`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ locationRef: f.alphaLocation, date: '2030-01-07' }),
  },
  // C5 encounters and clinical authorship (workstream C).
  {
    operation: 'clinical.authors.define',
    tool: 'clinical_authors_define',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/clinical/authors',
      body: { actorRef: USER_A4, role: 'assistant', credentialRef: MARKER },
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({
      actorRef: USER_A4,
      role: 'assistant',
      credentialRef: MARKER,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.authors.context',
    tool: 'clinical_author_context',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({ method: 'GET', url: '/v1/clinical/author-context', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  {
    operation: 'clinical.encounters.open',
    tool: 'clinical_encounters_open',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/clinical/encounters',
      body: { patientRef: P(f), locationRef: f.alphaLocation },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ patientRef: P(f), locationRef: f.alphaLocation, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.encounters.read',
    tool: 'clinical_encounters_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/encounters/${f.alphaEncounter}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ encounterRef: f.alphaEncounter }),
  },
  {
    operation: 'clinical.encounters.assign',
    tool: 'clinical_encounters_assign',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/assignments`,
      body: {
        expectedVersion: 1,
        role: 'treating_provider',
        assignee: { kind: 'provider', resourceRef: f.alphaProvider },
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      encounterRef: f.alphaEncounter,
      expectedVersion: 1,
      role: 'treating_provider',
      assignee: { kind: 'provider', resourceRef: f.alphaProvider },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.encounters.close',
    tool: 'clinical_encounters_close',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/close`,
      body: { expectedVersion: 1, dispositionCode: 'completed_as_planned' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      encounterRef: f.alphaEncounter,
      expectedVersion: 1,
      dispositionCode: 'completed_as_planned',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.encounters.list',
    tool: 'clinical_encounters_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/patients/${P(f)}/encounters`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  // C8 medical history, allergies and medications (workstream C).
  {
    operation: 'clinical.history.recordChange',
    tool: 'clinical_history_record_change',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/clinical/history/changes',
      body: historyBody(f),
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ ...historyBody(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.history.read',
    tool: 'clinical_history_read',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/clinical/patients/${P(f)}/history`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'clinical.history.readVersion',
    tool: 'clinical_history_get_version',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/history/versions/${f.alphaHistoryVersion}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ historyVersionRef: f.alphaHistoryVersion }),
  },
  {
    operation: 'clinical.history.alerts',
    tool: 'clinical_history_alerts',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/clinical/patients/${P(f)}/alerts`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'clinical.history.verifyItem',
    tool: 'clinical_history_verify_item',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/history/items/${f.alphaHistoryItem}/verifications`,
      body: { expectedChangeRef: f.alphaHistoryChange },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      itemRef: f.alphaHistoryItem,
      expectedChangeRef: f.alphaHistoryChange,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.history.attestReview',
    tool: 'clinical_history_attest_review',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/history-reviews`,
      body: { medication: 'confirmed' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      encounterRef: f.alphaEncounter,
      medication: 'confirmed',
      idempotencyKey: randomUUID(),
    }),
  },
  // C6 chart (workstream C batch 2a).
  {
    operation: 'clinical.chart.recordEntry',
    tool: 'clinical_chart_record_entry',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/clinical/chart/entries',
      body: chartBody(f),
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ ...chartBody(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.chart.correctEntry',
    tool: 'clinical_chart_correct_entry',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/chart/entries/${f.alphaChartEntry}/corrections`,
      body: { reasonCode: 'wrong_surface', state: 'active', detailText: `Synthetic ${MARKER}` },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      chartEntryRef: f.alphaChartEntry,
      reasonCode: 'wrong_surface',
      state: 'active',
      detailText: `Synthetic ${MARKER}`,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.chart.read',
    tool: 'clinical_chart_read',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/clinical/patients/${P(f)}/chart`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  // C7 periodontal exams (workstream C batch 2a).
  {
    operation: 'clinical.perio.recordExam',
    tool: 'clinical_perio_record_exam',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/clinical/perio/exams',
      body: perioBody(f),
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ ...perioBody(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.perio.correctExam',
    tool: 'clinical_perio_correct_exam',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/perio/exams/${f.alphaPerioExam}/corrections`,
      body: perioCorrection(f),
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ perioExamRef: f.alphaPerioExam, ...perioCorrection(f), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.perio.derive',
    tool: 'clinical_perio_derive',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/perio/exams/${f.alphaPerioExam}/derivations`,
      body: { formulaRef: 'SYN-PERIO-SUM', formulaVersion: 1 },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      perioExamRef: f.alphaPerioExam,
      formulaRef: 'SYN-PERIO-SUM',
      formulaVersion: 1,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.perio.readExam',
    tool: 'clinical_perio_get_exam',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/perio/exams/${f.alphaPerioExam}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ perioExamRef: f.alphaPerioExam }),
  },
  {
    operation: 'clinical.perio.listExams',
    tool: 'clinical_perio_list_exams',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/patients/${P(f)}/perio-exams`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'clinical.perio.compare',
    tool: 'clinical_perio_compare',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/perio/comparisons?baseExamRef=${f.alphaPerioExam}&targetExamRef=${f.alphaPerioExam}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ baseExamRef: f.alphaPerioExam, targetExamRef: f.alphaPerioExam }),
  },
  // C11 treatment plans (workstream C batch 2a).
  {
    operation: 'clinical.treatmentPlans.create',
    tool: 'clinical_treatment_plans_create',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/clinical/treatment-plans',
      body: { patientRef: f.alphaPatient, displayText: `Synthetic ${MARKER}` },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      patientRef: f.alphaPatient,
      displayText: `Synthetic ${MARKER}`,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.treatmentPlans.read',
    tool: 'clinical_treatment_plans_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/treatment-plans/${f.alphaPlan}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ planRef: f.alphaPlan }),
  },
  {
    operation: 'clinical.treatmentPlans.list',
    tool: 'clinical_treatment_plans_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/patients/${P(f)}/treatment-plans`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'clinical.treatmentPlans.addDetail',
    tool: 'clinical_treatment_plans_add_detail',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/treatment-plans/versions/${f.alphaPlanVersion}/details`,
      body: { expectedRevision: 3, scope: 'whole_mouth', displayText: `Synthetic ${MARKER}` },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      planVersionRef: f.alphaPlanVersion,
      expectedRevision: 3,
      scope: 'whole_mouth',
      displayText: `Synthetic ${MARKER}`,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.treatmentPlans.addItem',
    tool: 'clinical_treatment_plans_add_item',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/treatment-plans/details/${f.alphaPlanDetail}/items`,
      body: { expectedRevision: 3, procedureCodeRef: 'SYN-HARNESS-PROC', sequence: 2 },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      planDetailRef: f.alphaPlanDetail,
      expectedRevision: 3,
      procedureCodeRef: 'SYN-HARNESS-PROC',
      sequence: 2,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.treatmentPlans.setItemState',
    tool: 'clinical_treatment_plans_set_item_state',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/treatment-plans/items/${f.alphaPlanItem}/state`,
      body: { expectedRevision: 3, state: 'accepted' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      planItemRef: f.alphaPlanItem,
      expectedRevision: 3,
      state: 'accepted',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.treatmentPlans.setDetailState',
    tool: 'clinical_treatment_plans_set_detail_state',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/treatment-plans/details/${f.alphaPlanDetail}/state`,
      body: { expectedRevision: 3, state: 'declined', reasonCode: 'patient_declined' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      planDetailRef: f.alphaPlanDetail,
      expectedRevision: 3,
      state: 'declined',
      reasonCode: 'patient_declined',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.treatmentPlans.supersede',
    tool: 'clinical_treatment_plans_supersede',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/treatment-plans/versions/${f.alphaPlanVersion}/supersede`,
      body: { expectedRevision: 3, reasonCode: 'treatment_changed' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      planVersionRef: f.alphaPlanVersion,
      expectedRevision: 3,
      reasonCode: 'treatment_changed',
      idempotencyKey: randomUUID(),
    }),
  },
  // C9 progress-note templates (workstream C).
  {
    operation: 'clinical.noteTemplates.define',
    tool: 'clinical_note_templates_define',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/clinical/note-templates',
      body: templateBody(),
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({ ...templateBody(), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.noteTemplates.revise',
    tool: 'clinical_note_templates_revise',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/note-templates/${f.alphaTemplate}/versions`,
      body: { expectedVersion: 1, enforced: false, sections: TEMPLATE_SECTIONS },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      templateRef: f.alphaTemplate,
      expectedVersion: 1,
      enforced: false,
      sections: TEMPLATE_SECTIONS,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.noteTemplates.retire',
    tool: 'clinical_note_templates_retire',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/note-templates/${f.alphaTemplate}/retire`,
      body: { expectedVersion: 1, reasonCode: 'superseded' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      templateRef: f.alphaTemplate,
      expectedVersion: 1,
      reasonCode: 'superseded',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.noteTemplates.read',
    tool: 'clinical_note_templates_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/note-templates/${f.alphaTemplate}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ templateRef: f.alphaTemplate }),
  },
  {
    operation: 'clinical.noteTemplates.readVersion',
    tool: 'clinical_note_templates_get_version',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/note-template-versions/${f.alphaTemplateVersion}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ templateVersionRef: f.alphaTemplateVersion }),
  },
  {
    operation: 'clinical.noteTemplates.applicable',
    tool: 'clinical_note_templates_applicable',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/note-templates?procedureCodeRefs=SYN-PROC-001`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ encounterRef: f.alphaEncounter, procedureCodeRefs: 'SYN-PROC-001' }),
  },
  // C10 notes: drafting, signing, amendment, addendum and co-signature (workstream C).
  {
    operation: 'clinical.notes.createDraft',
    tool: 'clinical_notes_create_draft',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/notes`,
      body: noteBody(),
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({ encounterRef: f.alphaEncounter, ...noteBody(), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.notes.list',
    tool: 'clinical_notes_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/notes`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ encounterRef: f.alphaEncounter }),
  },
  {
    operation: 'clinical.notes.read',
    tool: 'clinical_notes_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/notes/${f.alphaSignedNote}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ noteRef: f.alphaSignedNote }),
  },
  {
    operation: 'clinical.notes.updateDraft',
    tool: 'clinical_notes_update_draft',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/notes/${f.alphaNote}/draft`,
      body: { expectedVersion: 1, content: NOTE_CONTENT },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      noteRef: f.alphaNote,
      ...{ expectedVersion: 1, content: NOTE_CONTENT },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.notes.sign',
    tool: 'clinical_notes_sign',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/notes/${f.alphaNote}/sign`,
      body: { expectedVersion: 1 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({ noteRef: f.alphaNote, ...{ expectedVersion: 1 }, idempotencyKey: randomUUID() }),
  },
  {
    operation: 'clinical.notes.amend',
    tool: 'clinical_notes_amend',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/notes/${f.alphaSignedNote}/amendments`,
      body: { expectedVersion: 2, reasonCode: 'correction', content: NOTE_CONTENT },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      noteRef: f.alphaSignedNote,
      ...{ expectedVersion: 2, reasonCode: 'correction', content: NOTE_CONTENT },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.notes.addendum',
    tool: 'clinical_notes_add_addendum',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/notes/${f.alphaSignedNote}/addenda`,
      body: { expectedVersion: 2, reasonCode: 'clarification', text: `Synthetic ${MARKER}` },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      noteRef: f.alphaSignedNote,
      ...{ expectedVersion: 2, reasonCode: 'clarification', text: `Synthetic ${MARKER}` },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.notes.cosign',
    tool: 'clinical_notes_cosign',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/notes/${f.alphaSignedNote}/cosignatures`,
      body: { sequence: 1, contentDigest: f.alphaSignedDigest },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      noteRef: f.alphaSignedNote,
      ...{ sequence: 1, contentDigest: f.alphaSignedDigest },
      idempotencyKey: randomUUID(),
    }),
  },
  // C12 estimates, alternatives and acceptance (workstream C batch 3).
  {
    operation: 'clinical.estimates.generate',
    tool: 'clinical_estimates_generate',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/treatment-plans/versions/${f.alphaPlanVersion}/estimates`,
      body: { lines: [], feeScheduleVersionRef: 'synthetic-harness-fees' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      planVersionRef: f.alphaPlanVersion,
      lines: [],
      feeScheduleVersionRef: 'synthetic-harness-fees',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.estimates.list',
    tool: 'clinical_estimates_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/treatment-plans/versions/${f.alphaPlanVersion}/estimates`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ planVersionRef: f.alphaPlanVersion }),
  },
  {
    operation: 'clinical.estimates.read',
    tool: 'clinical_estimates_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/estimates/${f.alphaEstimate}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ estimateRef: f.alphaEstimate }),
  },
  {
    operation: 'clinical.estimates.present',
    tool: 'clinical_estimates_present',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/estimates/${f.alphaEstimate}/presentation`,
      body: { expectedEstimateNumber: 1 },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      estimateRef: f.alphaEstimate,
      expectedEstimateNumber: 1,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.estimates.accept',
    tool: 'clinical_estimates_accept',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/estimates/${f.alphaEstimate}/acceptance`,
      body: { expectedRevision: 3, scope: 'full' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      estimateRef: f.alphaEstimate,
      expectedRevision: 3,
      scope: 'full',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.treatmentPlans.createAlternative',
    tool: 'clinical_treatment_plans_create_alternative',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/treatment-plans/${f.alphaPlan}/alternatives`,
      body: { displayText: `Synthetic ${MARKER}` },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      planRef: f.alphaPlan,
      displayText: `Synthetic ${MARKER}`,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.treatmentPlans.alternatives',
    tool: 'clinical_treatment_plans_list_alternatives',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/treatment-plans/${f.alphaPlan}/alternatives`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ planRef: f.alphaPlan }),
  },
  // C13 consent capture (workstream C batch 3).
  {
    operation: 'clinical.consents.capture',
    tool: 'clinical_consents_capture',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/clinical/consents',
      body: {
        patientRef: f.alphaPatient,
        scope: 'general_treatment',
        method: 'in_person',
        templateRef: 'synthetic-harness-consent',
        templateDigest: DIGEST_A,
        attestationCode: 'signed_in_person',
        signer: { kind: 'patient' },
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      ...{
        patientRef: f.alphaPatient,
        scope: 'general_treatment',
        method: 'in_person',
        templateRef: 'synthetic-harness-consent',
        templateDigest: DIGEST_A,
        attestationCode: 'signed_in_person',
        signer: { kind: 'patient' },
      },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.consents.read',
    tool: 'clinical_consents_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/consents/${f.alphaConsent}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ consentRef: f.alphaConsent }),
  },
  {
    operation: 'clinical.consents.list',
    tool: 'clinical_consents_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/patients/${P(f)}/consents`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'clinical.consents.withdraw',
    tool: 'clinical_consents_withdraw',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/consents/${f.alphaConsent}/withdrawal`,
      body: { expectedVersion: 1, reasonCode: 'patient_request', signer: { kind: 'patient' } },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      consentRef: f.alphaConsent,
      expectedVersion: 1,
      reasonCode: 'patient_request',
      signer: { kind: 'patient' },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.consentTemplates.register',
    tool: 'clinical_consent_templates_register',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/clinical/consent-templates',
      body: { templateRef: 'synthetic-harness-consent', digest: randomDigest() },
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({
      templateRef: 'synthetic-harness-consent',
      digest: randomDigest(),
      idempotencyKey: randomUUID(),
    }),
  },
  // C14 rendered procedures (workstream C batch 3).
  {
    operation: 'clinical.procedures.render',
    tool: 'clinical_procedures_render',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/procedures`,
      body: {
        sequence: 7,
        dateOfService: '2026-11-01',
        renderingProviderRef: f.alphaProvider,
        codeRef: 'SYN-HARNESS-PROC',
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      encounterRef: f.alphaEncounter,
      sequence: 7,
      dateOfService: '2026-11-01',
      renderingProviderRef: f.alphaProvider,
      codeRef: 'SYN-HARNESS-PROC',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.procedures.correct',
    tool: 'clinical_procedures_correct',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/procedures/${f.alphaProcedure}/corrections`,
      body: { reasonCode: 'recorded_in_error' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      procedureRef: f.alphaProcedure,
      reasonCode: 'recorded_in_error',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.procedures.read',
    tool: 'clinical_procedures_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/procedures/${f.alphaProcedure}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ procedureRef: f.alphaProcedure }),
  },
  {
    operation: 'clinical.procedures.list',
    tool: 'clinical_procedures_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/procedures`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ encounterRef: f.alphaEncounter }),
  },
  // C15 encounter image links (workstream C batch 4; I3 resolved through the test double).
  {
    operation: 'clinical.imageLinks.link',
    tool: 'clinical_image_links_link',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/image-links`,
      body: { imageRef: f.alphaImageRef },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      encounterRef: f.alphaEncounter,
      imageRef: f.alphaImageRef,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.imageLinks.relink',
    tool: 'clinical_image_links_relink',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/image-links/${f.alphaImageLink}/relink`,
      body: { encounterRef: f.alphaEncounter, reasonCode: 'wrong_visit' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      imageLinkRef: f.alphaImageLink,
      encounterRef: f.alphaEncounter,
      reasonCode: 'wrong_visit',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.imageLinks.unlink',
    tool: 'clinical_image_links_unlink',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/image-links/${f.alphaImageLink}/unlink`,
      body: { reasonCode: 'wrong_visit' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      imageLinkRef: f.alphaImageLink,
      reasonCode: 'wrong_visit',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.imageLinks.read',
    tool: 'clinical_image_links_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/image-links/${f.alphaImageLink}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ imageLinkRef: f.alphaImageLink }),
  },
  {
    operation: 'clinical.imageLinks.list',
    tool: 'clinical_image_links_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/encounters/${f.alphaEncounter}/image-links`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ encounterRef: f.alphaEncounter }),
  },
  // C16 lab cases (workstream C batch 4).
  {
    operation: 'clinical.labCases.create',
    tool: 'clinical_lab_cases_create',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: '/v1/clinical/lab-cases',
      body: { patientRef: f.alphaPatient, counterpartyRef: 'syn-lab-harness', caseRef: 'SYN-HARNESS-2' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      patientRef: f.alphaPatient,
      counterpartyRef: 'syn-lab-harness',
      caseRef: 'SYN-HARNESS-2',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.labCases.setState',
    tool: 'clinical_lab_cases_set_state',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/lab-cases/${f.alphaLabCase}/state`,
      body: { expectedVersion: 1, state: 'sent' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      labCaseRef: f.alphaLabCase,
      expectedVersion: 1,
      state: 'sent',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.labCases.recordReturn',
    tool: 'clinical_lab_cases_record_return',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/lab-cases/${f.alphaLabCase}/return`,
      body: { expectedVersion: 1, receivedDate: '2030-01-07', noAttachmentReason: 'none' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      labCaseRef: f.alphaLabCase,
      expectedVersion: 1,
      receivedDate: '2030-01-07',
      noAttachmentReason: 'none',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.labCases.attach',
    tool: 'clinical_lab_cases_attach',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/lab-cases/${f.alphaLabCase}/attachments`,
      body: { attachmentRef: 'syn-obj-harness' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      labCaseRef: f.alphaLabCase,
      attachmentRef: 'syn-obj-harness',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.labCases.remake',
    tool: 'clinical_lab_cases_remake',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/lab-cases/${f.alphaLabCase}/remake`,
      body: { expectedVersion: 1, reasonCode: 'shade_mismatch', caseRef: 'SYN-HARNESS-R' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      labCaseRef: f.alphaLabCase,
      expectedVersion: 1,
      reasonCode: 'shade_mismatch',
      caseRef: 'SYN-HARNESS-R',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.labCases.read',
    tool: 'clinical_lab_cases_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/lab-cases/${f.alphaLabCase}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ labCaseRef: f.alphaLabCase }),
  },
  {
    operation: 'clinical.labCases.list',
    tool: 'clinical_lab_cases_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/patients/${f.alphaPatient}/lab-cases`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: f.alphaPatient }),
  },
  {
    operation: 'clinical.labCases.export',
    tool: 'clinical_lab_cases_export',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/lab-cases/${f.alphaLabCase}/export`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ labCaseRef: f.alphaLabCase }),
  },
  {
    operation: 'clinical.labCases.worklist',
    tool: 'clinical_lab_cases_worklist',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({ method: 'GET', url: '/v1/clinical/lab-cases/worklist', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  // C17 referral records (workstream C batch 4).
  {
    operation: 'clinical.referrals.create',
    tool: 'clinical_referrals_create',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals`,
      body: {
        patientRef: f.alphaPatient,
        direction: 'incoming',
        counterpartyRef: 'syn-practice-h2',
        reasonCode: 'consult',
        requestedScope: 'consult',
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      patientRef: f.alphaPatient,
      direction: 'incoming',
      counterpartyRef: 'syn-practice-h2',
      reasonCode: 'consult',
      requestedScope: 'consult',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.preparePackage',
    tool: 'clinical_referrals_prepare_package',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals/${f.alphaReferral}/package`,
      body: { expectedVersion: 1, selections: [{ kind: 'renderedProcedure', ref: f.alphaProcedure }] },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      referralRef: f.alphaReferral,
      expectedVersion: 1,
      selections: [{ kind: 'renderedProcedure', ref: f.alphaProcedure }],
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.recordShare',
    tool: 'clinical_referrals_record_share',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals/${f.alphaReferral}/shares`,
      body: {
        purposeCode: 'continuity_of_care',
        scope: ['renderedProcedure'],
        expiresAt: '2099-01-01T00:00:00Z',
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      referralRef: f.alphaReferral,
      purposeCode: 'continuity_of_care',
      scope: ['renderedProcedure'],
      expiresAt: '2099-01-01T00:00:00Z',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.markSent',
    tool: 'clinical_referrals_mark_sent',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals/${f.alphaReferral}/sent`,
      body: { expectedVersion: 1, channel: 'print' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      referralRef: f.alphaReferral,
      expectedVersion: 1,
      channel: 'print',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.recordTransmissionFailure',
    tool: 'clinical_referrals_record_transmission_failure',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals/${f.alphaReferral}/transmission-failures`,
      body: { errorCode: 'printer_unavailable' },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      referralRef: f.alphaReferral,
      errorCode: 'printer_unavailable',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.recordResponse',
    tool: 'clinical_referrals_record_response',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals/${f.alphaReferral}/responses`,
      body: { expectedVersion: 1, sourceRef: 'syn-practice-h', receivedDate: '2030-01-07' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      referralRef: f.alphaReferral,
      expectedVersion: 1,
      sourceRef: 'syn-practice-h',
      receivedDate: '2030-01-07',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.close',
    tool: 'clinical_referrals_close',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals/${f.alphaReferral}/close`,
      body: { expectedVersion: 1, reasonCode: 'care_completed' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      referralRef: f.alphaReferral,
      expectedVersion: 1,
      reasonCode: 'care_completed',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.recall',
    tool: 'clinical_referrals_recall',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/clinical/referrals/${f.alphaReferral}/recall`,
      body: { expectedVersion: 1, reasonCode: 'wrong_counterparty' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      referralRef: f.alphaReferral,
      expectedVersion: 1,
      reasonCode: 'wrong_counterparty',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'clinical.referrals.read',
    tool: 'clinical_referrals_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/referrals/${f.alphaReferral}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ referralRef: f.alphaReferral }),
  },
  {
    operation: 'clinical.referrals.list',
    tool: 'clinical_referrals_list',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/patients/${f.alphaPatient}/referrals`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: f.alphaPatient }),
  },
  {
    operation: 'clinical.referrals.export',
    tool: 'clinical_referrals_export',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/referrals/${f.alphaReferral}/export`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ referralRef: f.alphaReferral }),
  },
  {
    operation: 'clinical.referrals.worklist',
    tool: 'clinical_referrals_worklist',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/clinical/referrals/worklist`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({}),
  },
  // C18 clinical export: another tenant exports only its own records.
  {
    operation: 'clinical.export',
    tool: 'clinical_export',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({ method: 'GET', url: '/v1/clinical/export', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  // S12 visit context (every command; producers are absent, but every dimension is refused first).
  ...visitRows(),
  // S13 recurrence series.
  ...seriesRows(),
  // S14 notification intents (reads only; intents are recorded by the commands that cause them).
  {
    operation: 'scheduling.notifications.read',
    tool: 'scheduling_notifications_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/scheduling/notifications/${f.alphaIntent}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ intentRef: f.alphaIntent }),
  },
  {
    operation: 'scheduling.notifications.worklist',
    tool: 'scheduling_notifications_worklist',
    crossTenant: 'tenant_own_data',
    downgradedTo: 'noPatientScopes',
    rest: () => ({ method: 'GET', url: '/v1/scheduling/notifications/worklist', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
  // S15 waitlist and PT-02 cancellation recovery with its standing policies.
  ...waitlistRows(),
  // S16 recall and the PT-03 follow-up worklist.
  ...recallRows(),
  // S17 minimal export: another tenant exports only its own records (which legitimately include the
  // marker its own harness create wrote; that alpha records never appear in a beta export is asserted
  // in scheduling-export.test.ts).
  {
    operation: 'scheduling.export',
    tool: 'scheduling_export',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({ method: 'GET', url: '/v1/scheduling/export', keyed: false, status: 200 }),
    mcpArgs: () => ({}),
  },
];

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const randomDigest = () => `sha256:${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;

function perioBody(f: HarnessFixture) {
  return {
    patientRef: f.alphaPatient,
    siteScheme: 'six_site_provisional',
    teeth: [perioTooth('14')],
  };
}
function perioTooth(code: string) {
  return {
    tooth: { system: 'universal', code },
    mobility: 'not_measured',
    furcation: 'not_measured',
    probingDepth: [3, 3, 3, 3, 3, 3],
    recession: [1, 1, 1, 1, 1, 1],
    bleeding: ['not_measured', false, false, false, false, false],
  };
}
function perioCorrection(f: HarnessFixture) {
  return {
    reasonCode: 'transcription_error',
    corrections: [{ measurementRef: f.alphaPerioMeasurement, value: { status: 'measured', mm: 4 } }],
  };
}

function chartBody(f: HarnessFixture) {
  return {
    patientRef: f.alphaPatient,
    provenance: 'recorded',
    tooth: { system: 'universal', code: '19' },
    surfaces: ['O'],
    kind: 'condition',
    findingRef: 'SYN-HARNESS-002',
    detailText: `Synthetic ${MARKER}`,
  };
}

const NOTE_CONTENT = {
  sections: [{ sectionKey: 'subjective', text: `Synthetic ${MARKER}` }],
  procedureCodeRefs: [],
};
function noteBody() {
  return { noteType: 'progress', content: NOTE_CONTENT };
}

const TEMPLATE_SECTIONS = [{ sectionKey: 'subjective', label: 'Synthetic subjective', required: true }];
/** A fresh label per call: a second active template with the same type and label is refused. */
function templateBody() {
  return {
    noteType: 'progress',
    label: `Synthetic harness template ${randomUUID()}`,
    enforced: true,
    sections: TEMPLATE_SECTIONS,
    procedureCodeRefs: ['SYN-PROC-001'],
  };
}

function historyBody(f: HarnessFixture) {
  return {
    patientRef: f.alphaPatient,
    provenance: 'patient_reported',
    reportedBy: 'patient',
    changes: [{ kind: 'allergy', state: 'active', displayText: `Synthetic ${MARKER}` }],
  };
}

const APPT = '/v1/scheduling/appointments';
const HOLDS = '/v1/scheduling/holds';
/** S12 rows: reads need scheduling.read, reference commands scheduling.write. */
function visitRows(): HarnessCommand[] {
  const ctx = (f: HarnessFixture) => `${APPT}/${f.alphaAppointment}/visit-context`;
  const read = (operation: string, tool: string, suffix: string): HarnessCommand => ({
    operation,
    tool,
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `${ctx(f)}${suffix}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ appointmentRef: f.alphaAppointment }),
  });
  const write = (
    operation: string,
    tool: string,
    suffix: (f: HarnessFixture) => string,
    body: Record<string, unknown>,
    extra: (f: HarnessFixture) => Record<string, unknown> = () => ({}),
  ): HarnessCommand => ({
    operation,
    tool,
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({ method: 'POST', url: `${ctx(f)}${suffix(f)}`, body, keyed: true, status: 201 }),
    mcpArgs: (f) => ({
      appointmentRef: f.alphaAppointment,
      ...extra(f),
      ...body,
      idempotencyKey: randomUUID(),
    }),
  });
  const item = '0b0b0b0b-0000-4000-8000-000000000001';
  return [
    read('scheduling.visitContext.read', 'scheduling_visit_context_get', ''),
    read('scheduling.visitContext.items', 'scheduling_visit_context_items', '/items'),
    write(
      'scheduling.visitContext.pinMedicalHistory',
      'scheduling_visit_context_pin_medical_history',
      () => '/medical-history-pin',
      {},
    ),
    write('scheduling.visitContext.assignForm', 'scheduling_visit_context_assign_form', () => '/forms', {
      formRef: item,
    }),
    write(
      'scheduling.visitContext.unassignForm',
      'scheduling_visit_context_unassign_form',
      () => `/forms/${item}/unassign`,
      { expectedVersion: 1, reasonCode: 'assigned_in_error' },
      () => ({ itemRef: item }),
    ),
    write(
      'scheduling.visitContext.linkLabCase',
      'scheduling_visit_context_link_lab_case',
      () => '/lab-cases',
      {
        labCaseRef: item,
      },
    ),
    write(
      'scheduling.visitContext.relinkLabCase',
      'scheduling_visit_context_relink_lab_case',
      () => '/lab-cases/relink',
      {
        labCaseRef: item,
        reasonCode: 'wrong_visit',
      },
    ),
  ];
}

/** S13 rows. */
function seriesRows(): HarnessCommand[] {
  const SERIES = '/v1/scheduling/series';
  const seriesBody = (f: HarnessFixture) => ({
    patientRef: f.alphaPatient,
    locationRef: f.alphaLocation,
    provider: { kind: 'provider', resourceRef: f.alphaProvider },
    operatory: { kind: 'operatory', resourceRef: f.alphaResource },
    pattern: { frequency: 'weekly', interval: 1 },
    firstDate: '2030-02-04',
    startTime: '10:00',
    durationMinutes: 30,
    count: 2,
  });
  return [
    {
      operation: 'scheduling.series.plan',
      tool: 'scheduling_series_plan',
      crossTenant: 'not_found',
      downgradedTo: 'noPatientScopes',
      rest: (f) => ({
        method: 'POST',
        url: `${SERIES}/plan`,
        body: seriesBody(f),
        keyed: false,
        status: 200,
      }),
      mcpArgs: (f) => seriesBody(f),
    },
    {
      operation: 'scheduling.series.create',
      tool: 'scheduling_series_create',
      crossTenant: 'not_found',
      downgradedTo: 'readOnly',
      rest: (f) => ({ method: 'POST', url: SERIES, body: seriesBody(f), keyed: true, status: 201 }),
      mcpArgs: (f) => ({ ...seriesBody(f), idempotencyKey: randomUUID() }),
    },
    {
      operation: 'scheduling.series.read',
      tool: 'scheduling_series_get',
      crossTenant: 'not_found',
      downgradedTo: 'noPatientScopes',
      rest: (f) => ({ method: 'GET', url: `${SERIES}/${f.alphaSeries}`, keyed: false, status: 200 }),
      mcpArgs: (f) => ({ seriesRef: f.alphaSeries }),
    },
    {
      operation: 'scheduling.series.extend',
      tool: 'scheduling_series_extend',
      crossTenant: 'not_found',
      downgradedTo: 'readOnly',
      rest: (f) => ({
        method: 'POST',
        url: `${SERIES}/${f.alphaSeries}/extend`,
        body: { expectedVersion: 1, count: 1 },
        keyed: true,
        status: 201,
      }),
      mcpArgs: (f) => ({
        seriesRef: f.alphaSeries,
        expectedVersion: 1,
        count: 1,
        idempotencyKey: randomUUID(),
      }),
    },
    {
      operation: 'scheduling.series.end',
      tool: 'scheduling_series_end',
      crossTenant: 'not_found',
      downgradedTo: 'readOnly',
      rest: (f) => ({
        method: 'POST',
        url: `${SERIES}/${f.alphaSeries}/end`,
        body: { expectedVersion: 1, reasonCode: 'provider_unavailable' },
        keyed: true,
        status: 200,
      }),
      mcpArgs: (f) => ({
        seriesRef: f.alphaSeries,
        expectedVersion: 1,
        reasonCode: 'provider_unavailable',
        idempotencyKey: randomUUID(),
      }),
    },
  ];
}

/** S15 and PT-02 rows. */
function offerCall(): HarnessCommand {
  const command = waitlistRows().find((c) => c.operation === 'scheduling.waitlist.offer');
  if (!command) throw new Error('missing offer row');
  return command;
}

function waitlistRows(): HarnessCommand[] {
  const W = '/v1/scheduling/waitlist';
  const O = '/v1/scheduling/waitlist-offers';
  const R = '/v1/scheduling/recoveries';
  const P = '/v1/scheduling/standing-policies';
  const write = (
    operation: string,
    tool: string,
    url: (f: HarnessFixture) => string,
    body: (f: HarnessFixture) => Record<string, unknown>,
    params: (f: HarnessFixture) => Record<string, unknown>,
    status: number,
    crossTenant: HarnessCommand['crossTenant'] = 'not_found',
  ): HarnessCommand => ({
    operation,
    tool,
    crossTenant,
    downgradedTo: 'readOnly',
    rest: (f) => ({ method: 'POST', url: url(f), body: body(f), keyed: true, status }),
    mcpArgs: (f) => ({ ...params(f), ...body(f), idempotencyKey: randomUUID() }),
  });
  const read = (
    operation: string,
    tool: string,
    url: (f: HarnessFixture) => string,
    params: (f: HarnessFixture) => Record<string, unknown>,
    crossTenant: HarnessCommand['crossTenant'] = 'not_found',
  ): HarnessCommand => ({
    operation,
    tool,
    crossTenant,
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: url(f), keyed: false, status: 200 }),
    mcpArgs: (f) => params(f),
  });
  const none = () => ({});
  const offerBody = (f: HarnessFixture) => ({
    startsAt: '2030-02-11T15:00:00Z',
    endsAt: '2030-02-11T16:00:00Z',
    provider: { kind: 'provider', resourceRef: f.alphaProvider },
    operatory: { kind: 'operatory', resourceRef: f.alphaResource },
  });
  return [
    write(
      'scheduling.waitlist.add',
      'scheduling_waitlist_add',
      () => W,
      (f) => ({
        patientRef: f.alphaPatient,
        locationRef: f.alphaLocation,
        durationMinutes: 60,
        desiredFrom: '2030-01-01T00:00:00Z',
        desiredUntil: '2030-12-31T00:00:00Z',
      }),
      none,
      201,
    ),
    read('scheduling.waitlist.list', 'scheduling_waitlist_list', () => W, none, 'tenant_own_data'),
    write(
      'scheduling.waitlist.remove',
      'scheduling_waitlist_remove',
      (f) => `${W}/${f.alphaEntry}/remove`,
      () => ({ expectedVersion: 1, reasonCode: 'patient_request' }),
      (f) => ({ entryRef: f.alphaEntry }),
      200,
    ),
    write(
      'scheduling.waitlist.offer',
      'scheduling_waitlist_offer',
      (f) => `${W}/${f.alphaEntry}/offer`,
      offerBody,
      (f) => ({ entryRef: f.alphaEntry }),
      201,
    ),
    write(
      'scheduling.waitlist.reconcileOffers',
      'scheduling_waitlist_reconcile_offers',
      () => `${W}/offers/reconcile`,
      none,
      none,
      200,
      'tenant_own_data',
    ),
    read(
      'scheduling.waitlist.offers.read',
      'scheduling_waitlist_offer_get',
      (f) => `${O}/${f.alphaOffer}`,
      (f) => ({
        offerRef: f.alphaOffer,
      }),
    ),
    write(
      'scheduling.waitlist.respond',
      'scheduling_waitlist_respond',
      (f) => `${O}/${f.alphaOffer}/respond`,
      () => ({ expectedVersion: 1, outcome: 'declined', reasonCode: 'patient_declined' }),
      (f) => ({ offerRef: f.alphaOffer }),
      200,
    ),
    read('scheduling.recovery.list', 'scheduling_recovery_list', () => R, none, 'tenant_own_data'),
    read(
      'scheduling.recovery.read',
      'scheduling_recovery_get',
      (f) => `${R}/${f.alphaRecovery}`,
      (f) => ({
        recoveryRef: f.alphaRecovery,
      }),
    ),
    write(
      'scheduling.recovery.execute',
      'scheduling_recovery_execute',
      (f) => `${R}/${f.alphaRecovery}/execute`,
      () => ({ expectedVersion: 1 }),
      (f) => ({ recoveryRef: f.alphaRecovery }),
      201,
    ),
    write(
      'scheduling.standingPolicies.grant',
      'scheduling_standing_policies_grant',
      () => P,
      (f) => ({
        operation: 'scheduling.recovery.execute',
        granteeRef: '30000000-0000-4000-8000-0000000000a1',
        locationRefs: [f.alphaLocation],
        maxOffersPerRecovery: 1,
        expiresAt: SOON,
      }),
      none,
      201,
    ),
    read(
      'scheduling.standingPolicies.list',
      'scheduling_standing_policies_list',
      () => P,
      none,
      'tenant_own_data',
    ),
    write(
      'scheduling.standingPolicies.revoke',
      'scheduling_standing_policies_revoke',
      (f) => `${P}/${f.alphaPolicy}/revoke`,
      () => ({ expectedVersion: 1, reasonCode: 'practice_request' }),
      (f) => ({ policyRef: f.alphaPolicy }),
      200,
    ),
  ];
}

/** S16 rows. The due row names a category only alpha defines, so another tenant gets 404. */
function recallRows(): HarnessCommand[] {
  const R = '/v1/scheduling/recall';
  const taskBody = (f: HarnessFixture) => ({
    patientRef: f.alphaCounterparty,
    category: 'harness-recall',
    locationRef: f.alphaLocation,
    expectedPolicyVersion: 1,
    asOf: '2031-01-01T12:00:00Z',
  });
  const define = { category: 'harness-define', intervalMonths: 6, basis: 'attended_visit' };
  return [
    {
      operation: 'scheduling.recall.definePolicy',
      tool: 'scheduling_recall_define_policy',
      crossTenant: 'own_tenant_only',
      downgradedTo: 'readOnly',
      rest: () => ({ method: 'POST', url: `${R}/policies`, body: define, keyed: true, status: 201 }),
      mcpArgs: () => ({ ...define, idempotencyKey: randomUUID() }),
    },
    {
      operation: 'scheduling.recall.policies',
      tool: 'scheduling_recall_policies',
      crossTenant: 'tenant_own_data',
      downgradedTo: 'noPatientScopes',
      rest: () => ({ method: 'GET', url: `${R}/policies`, keyed: false, status: 200 }),
      mcpArgs: () => ({}),
    },
    {
      operation: 'scheduling.recall.due',
      tool: 'scheduling_recall_due',
      crossTenant: 'not_found',
      downgradedTo: 'noPatientScopes',
      rest: () => ({
        method: 'GET',
        url: `${R}/due?category=harness-recall&asOf=2031-01-01T12%3A00%3A00Z`,
        keyed: false,
        status: 200,
      }),
      mcpArgs: () => ({ category: 'harness-recall', asOf: '2031-01-01T12:00:00Z' }),
    },
    {
      operation: 'scheduling.recall.createTask',
      tool: 'scheduling_recall_create_task',
      crossTenant: 'not_found',
      downgradedTo: 'readOnly',
      rest: (f) => ({ method: 'POST', url: `${R}/tasks`, body: taskBody(f), keyed: true, status: 201 }),
      mcpArgs: (f) => ({ ...taskBody(f), idempotencyKey: randomUUID() }),
    },
    {
      operation: 'scheduling.recall.resolveTask',
      tool: 'scheduling_recall_resolve_task',
      crossTenant: 'not_found',
      downgradedTo: 'readOnly',
      rest: (f) => ({
        method: 'POST',
        url: `${R}/tasks/${f.alphaRecallTask}/resolve`,
        body: { expectedVersion: 1, reasonCode: 'patient_booked' },
        keyed: true,
        status: 200,
      }),
      mcpArgs: (f) => ({
        recallTaskRef: f.alphaRecallTask,
        expectedVersion: 1,
        reasonCode: 'patient_booked',
        idempotencyKey: randomUUID(),
      }),
    },
    {
      operation: 'scheduling.followUp.worklist',
      tool: 'scheduling_follow_up_worklist',
      crossTenant: 'tenant_own_data',
      downgradedTo: 'noPatientScopes',
      rest: () => ({ method: 'GET', url: '/v1/scheduling/follow-up/worklist', keyed: false, status: 200 }),
      mcpArgs: () => ({}),
    },
  ];
}

function windowOf(f: HarnessFixture, startsAt: string, endsAt: string) {
  return {
    startsAt,
    endsAt,
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: f.alphaProvider },
    operatory: { kind: 'operatory', resourceRef: f.alphaResource },
  };
}
function bookingBody(f: HarnessFixture) {
  return {
    patientRef: f.alphaPatient,
    locationRef: f.alphaLocation,
    ...windowOf(f, '2030-01-07T16:00:00Z', '2030-01-07T17:00:00Z'),
  };
}
function rescheduleBody(f: HarnessFixture) {
  return {
    expectedVersion: 1,
    reasonCode: 'patient_request',
    ...windowOf(f, '2030-01-07T18:00:00Z', '2030-01-07T19:00:00Z'),
  };
}
function holdBody(f: HarnessFixture) {
  return {
    locationRef: f.alphaLocation,
    startsAt: '2030-01-07T20:00:00Z',
    endsAt: '2030-01-07T21:00:00Z',
    resources: [{ kind: 'operatory', resourceRef: f.alphaResource }],
  };
}
const REQ = '/v1/scheduling/appointment-requests';
function requestBody(f: HarnessFixture) {
  return {
    patientRef: f.alphaPatient,
    locationRef: f.alphaLocation,
    sourceChannel: 'phone',
    contactConsent: 'granted',
    flexibility: 'mornings',
  };
}
function uniqueLocation(): string {
  return `loc-${randomUUID().slice(0, 8)}`;
}
function blockBody(f: HarnessFixture) {
  return {
    locationRef: f.alphaLocation,
    startsAt: '2030-03-05T15:00:00Z',
    endsAt: '2030-03-05T16:00:00Z',
    reasonCode: 'meeting',
    resources: [{ kind: 'operatory', resourceRef: f.alphaResource }],
  };
}
function searchBody(f: HarnessFixture) {
  return {
    locationRef: f.alphaLocation,
    from: '2030-01-07',
    to: '2030-01-07',
    durationMinutes: 30,
    displayTimeZone: 'America/New_York',
    requirements: [{ kind: 'operatory', resourceRef: f.alphaResource }],
  };
}

beforeAll(async () => {
  db = await openTestDatabase('negative_harness');
  await seedTenancy(db.admin);
  await seedPatientScopes(db.admin);
  await seedSchedulingScopes(db.admin);
  await seedClinicalScopes(db.admin);
  await seedNoteScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  await seedPerioConfiguration(db.admin, T_ALPHA);
  await seedPerioConfiguration(db.admin, T_BETA);
  issuer = await createTestTokenIssuer();
  logLines = [];
  const stream = { write: (l: string) => logLines.push(l) };
  const membership = createMembershipSource(db.app);
  const attempts = createSecurityAttemptSink(db.sink);
  const tenantTransactions = createTenantTransactionRunner(db.app);
  app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'info', stream },
    identity: issuer.verifierConfig,
    membership,
    attempts,
    tenantTransactions,
    imageRefResolver: harnessImages,
  });
  mcp = buildMcpServer({
    env: 'synthetic-test',
    identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
    restAudience: TEST_AUDIENCE,
    membership,
    attempts,
    tenantTransactions,
    imageRefResolver: harnessImages,
    logger: { stream },
  });
  mcpUrl = (await mcp.listen({ host: '127.0.0.1', port: 0 })).url;
  for (const [who, sub, tid] of [
    ['owner', USER_A1, T_ALPHA],
    ['crossTenant', USER_B1, T_BETA],
    ['revoked', USER_A2, T_ALPHA],
    ['readOnly', USER_A4, T_ALPHA],
    ['noPatientScopes', USER_A5, T_ALPHA],
    ['service', SVC_A1, T_ALPHA],
  ] as const) {
    rest[who] = await issuer.issue({ sub, tid });
    mcpTokens[who] = await issuer.issue({ sub, tid, audience: MCP_AUDIENCE });
  }
  const created = await app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: {
      authorization: `Bearer ${rest.owner}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    payload: JSON.stringify(patientBody('Synthetic Harness Patient')),
  });
  expect(created.statusCode).toBe(201);
  const owner = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${rest.owner}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: JSON.stringify(body),
    });
  const alphaPatient = created.json().data.patientRef;
  const counterparty = await owner('/v1/patients', patientBody('Synthetic Harness Counterparty'));
  const alphaCounterparty = counterparty.json().data.patientRef;
  const rel = await owner(`/v1/patients/${alphaPatient}/relationships`, {
    counterpartyRef: alphaCounterparty,
    kind: 'guarantor',
    scopes: ['financial'],
  });
  expect(rel.statusCode).toBe(201);
  // S6: a merged pair, so unmerge and merge history have a real alpha target.
  const dupA = (await owner('/v1/patients', patientBody('Synthetic Harness Duplicate'))).json().data
    .patientRef;
  const dupB = (await owner('/v1/patients', patientBody('Synthetic Harness Duplicate'))).json().data
    .patientRef;
  const review = await app.inject({
    method: 'GET',
    url: `/v1/patients/${dupA}/duplicate-candidates`,
    headers: { authorization: `Bearer ${rest.owner}` },
  });
  const token = review
    .json()
    .data.find((c: { candidateRef: string }) => c.candidateRef === dupB).confirmationToken;
  const merged = await owner('/v1/patients/merges', {
    survivorRef: dupA,
    mergedRef: dupB,
    confirmationToken: token,
    reasonCode: 'duplicate_registration',
  });
  expect(merged.statusCode).toBe(201);
  // S7/S9: an alpha location with two operatories, one of which has weekly hours.
  const alphaLocation = 'loc-harness';
  expect(
    (
      await owner('/v1/scheduling/locations', {
        locationRef: alphaLocation,
        displayLabel: 'Synthetic Location',
        timeZone: 'America/New_York',
      })
    ).statusCode,
  ).toBe(201);
  const operatory = async (label: string) => {
    const r = await owner('/v1/scheduling/resources', {
      kind: 'operatory',
      locationRef: alphaLocation,
      displayLabel: label,
    });
    expect(r.statusCode).toBe(201);
    return r.json().data.resourceRef as string;
  };
  const alphaResource = await operatory('Operatory 1');
  const alphaOtherResource = await operatory('Operatory 2');
  expect(
    (
      await owner(`/v1/scheduling/resources/${alphaResource}/availability`, {
        effectiveFrom: '2030-01-07',
        weekly: [{ weekday: 1, start: '08:00', end: '17:00' }],
      })
    ).statusCode,
  ).toBe(201);
  // S8: one open request and one withdrawn request (version 2) at the alpha location.
  const reqBody = {
    patientRef: alphaPatient,
    locationRef: alphaLocation,
    sourceChannel: 'phone',
    contactConsent: 'granted',
    flexibility: 'mornings',
  };
  const openRequest = await owner(REQ, reqBody);
  expect(openRequest.statusCode).toBe(201);
  const closedRequest = (await owner(REQ, reqBody)).json().data.requestRef as string;
  expect(
    (
      await owner(`${REQ}/${closedRequest}/close`, {
        expectedVersion: 1,
        state: 'withdrawn',
        reasonCode: 'patient_request',
      })
    ).statusCode,
  ).toBe(200);
  // S10: a provider with Monday hours, one booking and one active hold at the alpha location.
  const providerRes = await owner('/v1/scheduling/resources', {
    kind: 'provider',
    locationRef: alphaLocation,
    displayLabel: 'Synthetic Provider',
  });
  expect(providerRes.statusCode).toBe(201);
  const alphaProvider = providerRes.json().data.resourceRef as string;
  expect(
    (
      await owner(`/v1/scheduling/resources/${alphaProvider}/availability`, {
        effectiveFrom: '2030-01-07',
        weekly: [{ weekday: 1, start: '08:00', end: '17:00' }],
      })
    ).statusCode,
  ).toBe(201);
  const slot = (startsAt: string, endsAt: string) => ({
    startsAt,
    endsAt,
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: alphaProvider },
    operatory: { kind: 'operatory', resourceRef: alphaResource },
  });
  const appointment = await owner('/v1/scheduling/appointments', {
    patientRef: alphaPatient,
    locationRef: alphaLocation,
    ...slot('2030-01-07T14:00:00Z', '2030-01-07T15:00:00Z'),
  });
  expect(appointment.statusCode).toBe(201);
  const hold = await owner('/v1/scheduling/holds', {
    locationRef: alphaLocation,
    startsAt: '2030-01-07T15:00:00Z',
    endsAt: '2030-01-07T16:00:00Z',
    resources: [{ kind: 'operatory', resourceRef: alphaResource }],
    ttlMinutes: 1440,
  });
  expect(hold.statusCode).toBe(201);
  // C5: an open alpha encounter for the alpha appointment (version 1).
  const encounter = await owner('/v1/clinical/encounters', {
    patientRef: alphaPatient,
    appointmentRef: appointment.json().data.appointmentRef,
  });
  expect(encounter.statusCode).toBe(201);
  // C8: one recorded history version for the alpha patient (one allergy item).
  const history = await owner('/v1/clinical/history/changes', {
    patientRef: alphaPatient,
    provenance: 'staff',
    reportedBy: 'clinician',
    changes: [{ kind: 'allergy', state: 'active', displayText: 'Synthetic harness allergen' }],
  });
  expect(history.statusCode).toBe(201);
  const recorded = history.json().data;
  // C6: one active chart entry for the alpha patient.
  const chartEntry = await owner('/v1/clinical/chart/entries', {
    patientRef: alphaPatient,
    provenance: 'recorded',
    tooth: { system: 'universal', code: '3' },
    kind: 'condition',
    findingRef: 'SYN-HARNESS-001',
  });
  expect(chartEntry.statusCode).toBe(201);
  // C7: one alpha periodontal exam (tooth 14).
  const perio = await owner('/v1/clinical/perio/exams', {
    patientRef: alphaPatient,
    siteScheme: 'six_site_provisional',
    teeth: [perioTooth('14')],
  });
  expect(perio.statusCode).toBe(201);
  const perioExam = perio.json().data;
  // C11: one alpha plan (revision 3): a whole-mouth detail with one proposed item.
  const plan = await owner('/v1/clinical/treatment-plans', { patientRef: alphaPatient });
  expect(plan.statusCode).toBe(201);
  const planVersion = plan.json().data.plan.headVersionRef;
  const planDetail = await owner(`/v1/clinical/treatment-plans/versions/${planVersion}/details`, {
    expectedRevision: 1,
    scope: 'whole_mouth',
  });
  expect(planDetail.statusCode).toBe(201);
  const planItem = await owner(
    `/v1/clinical/treatment-plans/details/${planDetail.json().data.targetRef}/items`,
    {
      expectedRevision: 2,
      procedureCodeRef: 'SYN-HARNESS-PROC',
      sequence: 1,
    },
  );
  expect(planItem.statusCode).toBe(201);
  // C12: one incomplete estimate (version 1) on the alpha plan version (its item names no fee).
  const estimate = await owner(`/v1/clinical/treatment-plans/versions/${planVersion}/estimates`, {
    lines: [],
  });
  expect(estimate.statusCode).toBe(201);
  // C13: one active alpha consent (general treatment, signed by the adult alpha patient).
  const consent = await owner('/v1/clinical/consents', {
    patientRef: alphaPatient,
    scope: 'general_treatment',
    method: 'in_person',
    templateRef: 'synthetic-harness-consent',
    templateDigest: DIGEST_A,
    attestationCode: 'signed_in_person',
    signer: { kind: 'patient' },
  });
  expect(consent.statusCode).toBe(201);
  // C9: one active alpha note template (version 1).
  const template = await owner('/v1/clinical/note-templates', templateBody());
  expect(template.statusCode).toBe(201);
  // C10: one alpha draft (version 1) and one signed alpha note (version 2) at the alpha encounter.
  const encounterRef = encounter.json().data.encounter.encounterRef;
  const noteDraft = await owner(`/v1/clinical/encounters/${encounterRef}/notes`, {
    noteType: 'progress',
    content: {
      sections: [{ sectionKey: 'subjective', text: 'Synthetic harness note' }],
      procedureCodeRefs: [],
    },
  });
  expect(noteDraft.statusCode).toBe(201);
  const toSign = await owner(`/v1/clinical/encounters/${encounterRef}/notes`, {
    noteType: 'progress',
    content: {
      sections: [{ sectionKey: 'subjective', text: 'Synthetic harness signed note' }],
      procedureCodeRefs: [],
    },
  });
  const signedNote = await owner(`/v1/clinical/notes/${toSign.json().data.noteRef}/sign`, {
    expectedVersion: 1,
  });
  expect(signedNote.statusCode).toBe(200);
  // C14: one rendered alpha procedure (unscheduled; provider not assigned, so with an override reason).
  const procedure = await owner(`/v1/clinical/encounters/${encounterRef}/procedures`, {
    sequence: 1,
    dateOfService: '2026-11-01',
    renderingProviderRef: alphaProvider,
    codeRef: 'SYN-HARNESS-PROC',
    providerOverrideReason: 'harness_fixture',
  });
  expect(procedure.statusCode).toBe(201);
  // C15: one active alpha image link (the imageRef resolves through the I3 test double).
  const alphaImageRef = `syn-img-${randomUUID()}`;
  harnessImages.put(T_ALPHA, alphaImageRef, {
    status: 'current',
    patientRef: alphaPatient,
    associationRef: 'syn-assoc-h',
  });
  const imageLink = await owner(`/v1/clinical/encounters/${encounterRef}/image-links`, {
    imageRef: alphaImageRef,
  });
  expect(imageLink.statusCode).toBe(201);
  // C16: one draft alpha lab case (version 1) for the alpha patient.
  const labCase = await owner('/v1/clinical/lab-cases', {
    patientRef: alphaPatient,
    counterpartyRef: 'syn-lab-harness',
    caseRef: 'SYN-HARNESS-1',
  });
  expect(labCase.statusCode).toBe(201);
  // C17: one incoming alpha referral (version 1, received) for the alpha patient.
  const referral = await owner('/v1/clinical/referrals', {
    patientRef: alphaPatient,
    direction: 'incoming',
    counterpartyRef: 'syn-practice-h',
    reasonCode: 'consult',
    requestedScope: 'consult',
  });
  expect(referral.statusCode).toBe(201);
  // S13: one alpha series (one Monday occurrence) for the series rows.
  const series = await owner('/v1/scheduling/series', {
    patientRef: alphaPatient,
    locationRef: alphaLocation,
    provider: { kind: 'provider', resourceRef: alphaProvider },
    operatory: { kind: 'operatory', resourceRef: alphaResource },
    pattern: { frequency: 'weekly', interval: 1 },
    firstDate: '2030-01-14',
    startTime: '10:00',
    durationMinutes: 30,
    count: 1,
  });
  expect(series.statusCode).toBe(201);
  const intents = await app.inject({
    method: 'GET',
    url: '/v1/scheduling/notifications/worklist',
    headers: { authorization: `Bearer ${rest.owner}` },
  });
  const alphaIntent = intents
    .json()
    .data.items.find((i: { evidenceRefs: { ref: string }[] }) =>
      i.evidenceRefs.some((e) => e.ref === appointment.json().data.appointmentRef),
    ).workItemRef as string;
  // S15/PT-02: an offer policy, one entry with a live offer, a second entry, a cancelled booking's
  // recovery and a standing policy, all at the alpha location.
  await db.admin.query(
    `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
     SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 1440 FROM cuspatlas.scheduling_locations
     WHERE location_ref = $1`,
    [alphaLocation],
  );
  const entryBody = {
    patientRef: alphaPatient,
    locationRef: alphaLocation,
    durationMinutes: 60,
    desiredFrom: '2030-01-01T00:00:00Z',
    desiredUntil: '2030-12-31T00:00:00Z',
  };
  const offeredEntry = await owner('/v1/scheduling/waitlist', entryBody);
  expect(offeredEntry.statusCode).toBe(201);
  const liveOffer = await owner(`/v1/scheduling/waitlist/${offeredEntry.json().data.entryRef}/offer`, {
    startsAt: '2030-01-21T15:00:00Z',
    endsAt: '2030-01-21T16:00:00Z',
    provider: { kind: 'provider', resourceRef: alphaProvider },
    operatory: { kind: 'operatory', resourceRef: alphaResource },
  });
  expect(liveOffer.statusCode).toBe(201);
  const idleEntry = await owner('/v1/scheduling/waitlist', { ...entryBody, patientRef: alphaCounterparty });
  expect(idleEntry.statusCode).toBe(201);
  const toCancel = await owner('/v1/scheduling/appointments', {
    patientRef: alphaCounterparty,
    locationRef: alphaLocation,
    ...slot('2030-01-28T14:00:00Z', '2030-01-28T15:00:00Z'),
  });
  expect(toCancel.statusCode).toBe(201);
  const cancelledRef = toCancel.json().data.appointmentRef as string;
  expect(
    (
      await owner(`/v1/scheduling/appointments/${cancelledRef}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      })
    ).statusCode,
  ).toBe(200);
  const recoveries = await app.inject({
    method: 'GET',
    url: '/v1/scheduling/recoveries',
    headers: { authorization: `Bearer ${rest.owner}` },
  });
  const alphaRecovery = recoveries
    .json()
    .data.items.find((i: { evidenceRefs: { ref: string }[] }) =>
      i.evidenceRefs.some((e) => e.ref === cancelledRef),
    ).workItemRef as string;
  const policy = await owner('/v1/scheduling/standing-policies', {
    operation: 'scheduling.recovery.execute',
    granteeRef: '30000000-0000-4000-8000-0000000000a1',
    locationRefs: [alphaLocation],
    maxOffersPerRecovery: 1,
    expiresAt: SOON,
  });
  expect(policy.statusCode).toBe(201);
  // S16: a recall policy, an attended visit of the counterparty and one open recall task.
  expect(
    (
      await owner('/v1/scheduling/recall/policies', {
        category: 'harness-recall',
        intervalMonths: 6,
        basis: 'attended_visit',
      })
    ).statusCode,
  ).toBe(201);
  const recallVisit = await owner('/v1/scheduling/appointments', {
    patientRef: alphaCounterparty,
    locationRef: alphaLocation,
    ...slot('2030-02-04T14:00:00Z', '2030-02-04T15:00:00Z'),
  });
  expect(recallVisit.statusCode).toBe(201);
  expect(
    (
      await owner(`/v1/scheduling/appointments/${recallVisit.json().data.appointmentRef}/attendance`, {
        kind: 'arrived',
      })
    ).statusCode,
  ).toBe(201);
  const recallTask = await owner('/v1/scheduling/recall/tasks', {
    patientRef: alphaCounterparty,
    category: 'harness-recall',
    locationRef: alphaLocation,
    expectedPolicyVersion: 1,
    asOf: '2031-01-01T12:00:00Z',
  });
  expect(recallTask.statusCode).toBe(201);
  fixture = {
    alphaPlan: plan.json().data.plan.planRef,
    alphaPlanVersion: planVersion,
    alphaPlanDetail: planDetail.json().data.targetRef,
    alphaPlanItem: planItem.json().data.targetRef,
    alphaEstimate: estimate.json().data.estimateRef,
    alphaConsent: consent.json().data.consentRef,
    alphaProcedure: procedure.json().data.procedureRef,
    alphaImageRef,
    alphaImageLink: imageLink.json().data.imageLinkRef,
    alphaLabCase: labCase.json().data.labCaseRef,
    alphaReferral: referral.json().data.referralRef,
    alphaPerioExam: perioExam.examRef,
    alphaPerioMeasurement: perioExam.measurements.find(
      (m: { measure: string; site: string | null }) => m.measure === 'probing_depth' && m.site === 'b',
    ).measurementRef,
    alphaChartEntry: chartEntry.json().data.entry.entryRef,
    alphaNote: noteDraft.json().data.noteRef,
    alphaSignedNote: signedNote.json().data.noteRef,
    alphaSignedDigest: signedNote.json().data.versions[0].contentDigest,
    alphaTemplate: template.json().data.templateRef,
    alphaTemplateVersion: template.json().data.currentVersion.templateVersionRef,
    alphaHistoryVersion: recorded.header.historyVersionRef,
    alphaHistoryItem: recorded.changes[0].itemRef,
    alphaHistoryChange: recorded.changes[0].change.changeRef,
    alphaEncounter: encounter.json().data.encounter.encounterRef,
    alphaRecallTask: recallTask.json().data.recallTaskRef,
    alphaEntry: idleEntry.json().data.entryRef,
    alphaOffer: liveOffer.json().data.offerRef,
    alphaRecovery,
    alphaPolicy: policy.json().data.policyRef,
    alphaIntent,
    alphaSeries: series.json().data.seriesRef,
    alphaProvider,
    alphaAppointment: appointment.json().data.appointmentRef,
    alphaHold: hold.json().data.holdRef,
    alphaRequest: openRequest.json().data.requestRef,
    alphaClosedRequest: closedRequest,
    alphaLocation,
    alphaResource,
    alphaOtherResource,
    alphaPatient,
    alphaCounterparty,
    alphaRelationship: rel.json().data.relationshipRef,
    alphaMerge: merged.json().data.mergeRef,
    alphaMergedPatient: dupB,
  };
});

afterAll(async () => {
  await mcp?.close();
  await app?.close();
  await db?.close();
});

interface Outcome {
  readonly status: number;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly body: Record<string, unknown> | null;
  readonly raw: string;
}

async function viaRest(who: string, call: RestCall): Promise<Outcome> {
  const res = await app.inject({
    method: call.method,
    url: call.url,
    headers: {
      authorization: `Bearer ${rest[who]}`,
      ...(call.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(call.keyed ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(call.body === undefined ? {} : { payload: JSON.stringify(call.body) }),
  });
  const body = res.json() as Record<string, unknown>;
  return {
    status: res.statusCode,
    code: typeof body.code === 'string' ? body.code : null,
    correlationId: res.headers['x-correlation-id'] as string,
    body,
    raw: `${res.body}${JSON.stringify(res.headers)}`,
  };
}

async function viaMcp(
  who: string,
  tool: string,
  args: Record<string, unknown>,
  okStatus: number,
): Promise<Outcome> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${mcpTokens[who]}` } },
  });
  const client = new Client({ name: 'synthetic-harness', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    const body = result.structuredContent as Record<string, unknown>;
    const refused = result.isError === true;
    return {
      status: refused ? REFUSAL_HTTP_STATUS[body.code as RefusalCode] : okStatus,
      code: refused ? (body.code as string) : null,
      correlationId: typeof body.correlationId === 'string' ? body.correlationId : null,
      body,
      raw: JSON.stringify(result),
    };
  } catch (e) {
    // Protocol-level refusal (authentication or membership) carries the HTTP status.
    const err = e as { code?: unknown; message?: string };
    if (typeof err.code !== 'number') throw e;
    const message = String(err.message);
    const start = message.indexOf('{');
    const body = start >= 0 ? (JSON.parse(message.slice(start)) as Record<string, unknown>) : null;
    return {
      status: err.code,
      code: body && typeof body.code === 'string' ? body.code : null,
      correlationId: body && typeof body.correlationId === 'string' ? body.correlationId : null,
      body,
      raw: message,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function attemptReasons(correlationId: string | null): Promise<string[]> {
  if (correlationId === null) return [];
  const { rows } = await db.admin.query(
    'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
    [correlationId],
  );
  return rows.map((r) => r.reason_code);
}

/** Snapshot of the alpha fixture and every write surface, to prove a denial changed nothing. */
async function state(): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await db.admin.query(sql)).rows);
  return [
    await q(`SELECT version FROM cuspatlas.patients WHERE id = '${fixture.alphaPatient}'`),
    await q('SELECT count(*)::int AS n FROM cuspatlas.patients'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.patient_relationships'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.patient_merges'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.patient_merge_reversals'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.scheduling_locations'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.scheduling_resources'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.scheduling_availability_versions'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.scheduling_time_blocks'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.scheduling_occupancy'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.appointment_requests'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_request_transitions'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.appointments'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.scheduling_holds'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.scheduling_occupancy WHERE released_at IS NULL'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_overrides'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_lifecycle_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_attendance_transitions'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_author_profiles'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_encounters'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_encounter_assignments'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_history_streams'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_history_versions'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_history_items'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_history_changes'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_history_verifications'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_history_reviews'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_charts'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_chart_entries'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_perio_streams'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_perio_exams'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_perio_measurements'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_perio_derivations'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_perio_derived_values'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_treatment_plans'),
    await q('SELECT count(*)::int AS n, sum(revision)::int AS v FROM cuspatlas.clinical_plan_versions'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_details'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_items'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_item_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_detail_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_alternatives'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_estimates'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_estimate_lines'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_estimate_assumptions'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_estimate_presentations'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_acceptances'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_consent_templates'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_consents'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_consent_withdrawals'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_rendered_procedures'),
    await q(
      'SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_encounter_image_links',
    ),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_lab_cases'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_lab_case_transitions'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_lab_case_attachments'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_referrals'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_referral_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_referral_selections'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_referral_shares'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_referral_responses'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_note_templates'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_note_template_versions'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.clinical_notes'),
    await q('SELECT json_agg(n.draft_sections ORDER BY n.id)::text AS d FROM cuspatlas.clinical_notes n'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_note_versions'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.clinical_note_cosignatures'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.visit_context_items'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.appointment_series'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_series_occurrences'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_series_exceptions'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.notification_intents'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.waitlist_entries'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.waitlist_offers'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.cancellation_recoveries'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.scheduling_standing_policies'),
    await q(`SELECT count(*)::int AS n FROM cuspatlas.recall_policies WHERE tenant_id = '${T_ALPHA}'`),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.recall_tasks'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.audit_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.outbox_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.command_idempotency'),
  ].join('|');
}

type Dimension = 'crossTenant' | 'revoked' | 'downgraded';
const DIMENSIONS: Dimension[] = ['crossTenant', 'revoked', 'downgraded'];

function expected(
  cmd: HarnessCommand,
  d: Dimension,
): { status: number; code: string | null; reason: string | null } {
  if (d === 'revoked') return { status: 403, code: 'forbidden', reason: 'membership_inactive' };
  if (d === 'downgraded') return { status: 403, code: 'forbidden', reason: 'scope_missing' };
  if (cmd.crossTenant === 'not_found')
    return { status: 404, code: 'not_found', reason: 'resource_hidden_or_missing' };
  // A merge names two patients; another tenant cannot hold a confirmation for them, so it is denied
  // before any lookup and learns nothing about either record.
  if (cmd.crossTenant === 'confirmation_denied')
    return { status: 403, code: 'forbidden', reason: 'merge_confirmation_invalid' };
  return { status: cmd.rest(fixture).status, code: null, reason: null };
}

const whoFor = (cmd: HarnessCommand, d: Dimension) => (d === 'downgraded' ? cmd.downgradedTo : d);

describe('negative harness: every S command, every dimension, REST and MCP', () => {
  const cases = COMMANDS.flatMap((cmd) => DIMENSIONS.map((d) => [cmd.operation, d, cmd] as const));

  it.each(cases)('%s %s', async (_op, d, cmd) => {
    const want = expected(cmd, d);
    const who = whoFor(cmd, d);
    const before = await state();
    const r = await viaRest(who, cmd.rest(fixture));
    const m = await viaMcp(who, cmd.tool, cmd.mcpArgs(fixture), cmd.rest(fixture).status);
    for (const [surface, o] of [
      ['REST', r],
      ['MCP', m],
    ] as const) {
      expect([surface, o.status, o.code]).toStrictEqual([surface, want.status, want.code]);
      // A refusal never echoes caller text (successes legitimately return the caller's own data).
      if (want.code !== null) expect(o.raw).not.toContain(MARKER);
      if (want.reason !== null) {
        expect([surface, await attemptReasons(o.correlationId)]).toStrictEqual([surface, [want.reason]]);
      }
    }
    if (want.code === null && cmd.crossTenant === 'empty_page') {
      // Another tenant searching sees only its own (empty) tenant, never alpha's patients.
      for (const o of [r, m]) expect(o.body?.data).toStrictEqual([]);
    }
    if (want.code === null && cmd.crossTenant === 'tenant_own_data') {
      // Computed over the caller's own tenant: no alpha fixture reference crosses the boundary.
      for (const o of [r, m]) {
        expect(o.raw).not.toContain(MARKER);
        for (const ref of Object.values(fixture)) expect(o.raw).not.toContain(ref);
      }
      const { rows } = await db.admin.query(
        'SELECT count(*)::int AS n FROM cuspatlas.scheduling_locations WHERE tenant_id = $1',
        [T_ALPHA],
      );
      expect(rows[0].n).toBe(1);
    }
    if (want.code !== null) expect(await state()).toBe(before);
    if (cmd.crossTenant === 'own_tenant_only' && d === 'crossTenant') {
      // A create by another tenant's member lands in its own tenant only.
      const { rows } = await db.admin.query(
        'SELECT DISTINCT tenant_id FROM cuspatlas.patients WHERE created_by = $1',
        [USER_B1],
      );
      expect(rows).toStrictEqual([{ tenant_id: T_BETA }]);
    }
  });

  it('the owner succeeds with the same calls (the harness is not vacuous)', async () => {
    for (const cmd of COMMANDS.filter(
      (c) => c.operation === 'patients.read' || c.operation === 'patients.search',
    )) {
      const r = await viaRest('owner', cmd.rest(fixture));
      expect([cmd.operation, r.status]).toStrictEqual([cmd.operation, cmd.rest(fixture).status]);
    }
  });

  it('a role downgraded after the token was issued is refused on the next command', async () => {
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'admin.configure') WHERE principal_id = $1`,
      [USER_A1],
    );
    try {
      const cmd = COMMANDS.find((c) => c.operation === 'scheduling.resources.define');
      if (!cmd) throw new Error('missing row');
      const before = await state();
      const r = await viaRest('owner', cmd.rest(fixture));
      const m = await viaMcp('owner', cmd.tool, cmd.mcpArgs(fixture), 201);
      for (const o of [r, m]) {
        expect([o.status, o.code]).toStrictEqual([403, 'forbidden']);
        expect(await attemptReasons(o.correlationId)).toStrictEqual(['scope_missing']);
      }
      expect(await state()).toBe(before);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['admin.configure'] WHERE principal_id = $1`,
        [USER_A1],
      );
    }
  });

  it('no caller-supplied tenant is accepted by any S body or tool', async () => {
    for (const cmd of COMMANDS) {
      const call = cmd.rest(fixture);
      if (call.body === undefined) continue;
      const r = await viaRest('owner', { ...call, body: { ...(call.body as object), tenantId: T_BETA } });
      expect([cmd.operation, r.status]).toStrictEqual([cmd.operation, 400]);
      const m = await viaMcp('owner', cmd.tool, { ...cmd.mcpArgs(fixture), tenantId: T_BETA }, 200);
      expect([cmd.operation, m.code]).toStrictEqual([cmd.operation, 'invalid_request']);
    }
    expect(logLines.join('\n')).not.toContain(MARKER);
  });

  it('S-D6: a service principal cannot accept an offer, and cannot offer without a live standing policy', async () => {
    const respond = {
      method: 'POST' as const,
      url: `/v1/scheduling/waitlist-offers/${fixture.alphaOffer}/respond`,
      body: { expectedVersion: 1, outcome: 'accepted' },
      keyed: true,
      status: 200,
    };
    const before = await state();
    const r = await viaRest('service', respond);
    const m = await viaMcp(
      'service',
      'scheduling_waitlist_respond',
      { offerRef: fixture.alphaOffer, expectedVersion: 1, outcome: 'accepted', idempotencyKey: randomUUID() },
      200,
    );
    for (const o of [r, m]) expect([o.status, o.code]).toStrictEqual([403, 'forbidden']);
    expect(await state()).toBe(before);
    // Revoke the harness policy (a person's command), then the same service principal has none.
    const revoke = await viaRest('owner', {
      method: 'POST',
      url: `/v1/scheduling/standing-policies/${fixture.alphaPolicy}/revoke`,
      body: { expectedVersion: 1, reasonCode: 'practice_request' },
      keyed: true,
      status: 200,
    });
    expect(revoke.status).toBe(200);
    const offer = offerCall();
    const afterRevoke = await state();
    const ro = await viaRest('service', offer.rest(fixture));
    const mo = await viaMcp('service', offer.tool, offer.mcpArgs(fixture), 201);
    for (const o of [ro, mo]) {
      expect([o.status, o.code]).toStrictEqual([403, 'forbidden']);
      expect(JSON.stringify(o.body)).toContain('standing_policy_required');
    }
    expect(await state()).toBe(afterRevoke);
  });
});
