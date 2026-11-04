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
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A2, USER_A4, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
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
  // S12 visit context (every command; producers are absent, but every dimension is refused first).
  ...visitRows(),
  // S13 recurrence series.
  ...seriesRows(),
];

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
  });
  mcp = buildMcpServer({
    env: 'synthetic-test',
    identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
    restAudience: TEST_AUDIENCE,
    membership,
    attempts,
    tenantTransactions,
    logger: { stream },
  });
  mcpUrl = (await mcp.listen({ host: '127.0.0.1', port: 0 })).url;
  for (const [who, sub, tid] of [
    ['owner', USER_A1, T_ALPHA],
    ['crossTenant', USER_B1, T_BETA],
    ['revoked', USER_A2, T_ALPHA],
    ['readOnly', USER_A4, T_ALPHA],
    ['noPatientScopes', USER_A5, T_ALPHA],
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
  fixture = {
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
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.visit_context_items'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.appointment_series'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_series_occurrences'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.appointment_series_exceptions'),
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
});
