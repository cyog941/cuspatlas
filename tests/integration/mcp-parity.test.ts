import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { buildApp } from '@cuspatlas/api';
import { REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY, SYNTHETIC_TEST_MATCH_KEY_PEPPER } from '@cuspatlas/domain';
import {
  buildMcpServer,
  ENGAGEMENT_OP_TOOLS,
  loadConfiguredMcpIdentity,
  type McpServerHandle,
} from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  SVC_B1,
  seedTenancy,
  T_ALPHA,
  T_BETA,
  TASK_A,
  TASK_A_NORTH,
  TASK_A_SOUTH,
  TASK_B,
  USER_A1,
  USER_A2,
  USER_A3,
  USER_A4,
} from './support/fixtures';
import { MARKER } from './support/marker';
import {
  createTestTokenIssuer,
  TEST_AUDIENCE,
  TEST_ISSUER,
  type TestTokenIssuer,
} from './support/test-token-issuer';

const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';
const TOOL_NAMES = [
  // S7/S9 scheduling resources and availability (resources track), sorted with the synthetic tools.
  'availability_search',
  'scheduling_locations_change_time_zone',
  'scheduling_locations_define',
  'scheduling_locations_list',
  'scheduling_resources_data_quality',
  'scheduling_resources_deactivate',
  'scheduling_resources_define',
  'scheduling_resources_get',
  'scheduling_resources_list',
  'scheduling_resources_set_availability',
  'scheduling_time_blocks_create',
  'synthetic_tasks_approve',
  'synthetic_tasks_commit',
  'synthetic_tasks_create',
  'synthetic_tasks_get',
  'synthetic_tasks_get_proposal',
  'synthetic_tasks_list',
  'vocabularies_list',
  'vocabularies_get',
  'synthetic_tasks_propose',
  'synthetic_tasks_relabel',
  // S4 patient tools (their parity is exercised in patient-identity and negative-harness tests).
  'patients_create',
  'patients_get',
  'patients_search',
  'patients_set_status',
  'patients_update_demographics',
  // S5 relationship tools.
  'patients_add_relationship',
  'patients_list_relationships',
  'patients_resolve_access',
  'patients_revoke_relationship',
  // S6 merge tools.
  'patients_find_duplicates',
  'patients_list_merge_history',
  'patients_merge',
  'patients_unmerge',
  // S8 appointment request tools (parity in appointment-requests and negative-harness tests).
  'scheduling_requests_close',
  'scheduling_requests_create',
  'scheduling_requests_get',
  'scheduling_requests_list',
  'scheduling_requests_reopen',
  'scheduling_requests_review',
  'scheduling_requests_unbooked_report',
  'scheduling_requests_update_preferences',
  // S10 booking and hold tools (parity in booking-conflicts and negative-harness tests).
  'scheduling_appointments_book',
  'scheduling_appointments_cancel',
  'scheduling_appointments_get',
  'scheduling_appointments_reschedule',
  'scheduling_holds_create',
  'scheduling_holds_reconcile',
  'scheduling_holds_release',
  // S11 attendance tools.
  'scheduling_attendance_list',
  'scheduling_attendance_record',
  'scheduling_attendance_visit_status',
  'scheduling_worklist_daily',
  // B1 billing journal tools (parity in billing-journal and negative-harness tests).
  'billing_balances_get',
  'billing_charges_get',
  'billing_charges_post',
  'billing_entries_get',
  'billing_entries_reverse',
  'billing_ledger_list',
  // B2 payment, allocation and worklist tools.
  'billing_funds_transfer',
  'billing_payments_allocate',
  'billing_payments_get',
  'billing_payments_reconcile',
  'billing_payments_record',
  'billing_payments_refund',
  'billing_payments_settle',
  'billing_responsibility_transfer',
  'billing_worklist_list',
  // B3 payment-plan tools.
  'billing_plans_amend',
  'billing_plans_authorize',
  'billing_plans_autopay',
  'billing_plans_close',
  'billing_plans_collect',
  'billing_plans_create',
  'billing_plans_get',
  'billing_plans_worklist',
  // B4 statement tools.
  'billing_statements_generate',
  'billing_statements_get',
  // B5 coverage and eligibility tools.
  'rcm_coverages_change',
  'rcm_coverages_get',
  'rcm_coverages_record',
  'rcm_coverages_resolve',
  'rcm_eligibility_record',
  // B9 fee schedules, adjustments and report scope; the C14 consumer twin (BILLING_OPS).
  'billing_fee_schedules_publish',
  'billing_fees_resolve',
  'billing_procedures_consume',
  'billing_adjustments_post',
  'billing_adjustments_decide',
  'billing_reports_receivables',
  'billing_export',
  // B6 claims (fake clearinghouse only).
  'rcm_appeals_draft',
  'rcm_appeals_review',
  'rcm_claims_attach',
  'rcm_claims_get',
  'rcm_claims_poll',
  'rcm_claims_prepare',
  'rcm_claims_prepare_secondary',
  'rcm_claims_replace',
  'rcm_claims_submit',
  'rcm_claims_validate',
  'rcm_claims_worklist',
  'rcm_claims_queues',
  'rcm_claims_measures',
  'rcm_submission_policies_create',
  'rcm_submission_policies_revoke',
  // B7 remittance.
  'rcm_remittances_get',
  'rcm_remittances_ingest',
  'rcm_remittances_reverse',
  'rcm_remittances_settle',
  // B7 review-line resolution and claims-workflow policy data.
  'rcm_remittances_resolve_line',
  'rcm_remittances_decide_resolution',
  'rcm_workflow_policies_publish',
  // Closed-loop claims workflow, attachment packages and visit preparation.
  'rcm_claims_package_attachments',
  'rcm_visits_prepare',
  'rcm_workflows_advance',
  'rcm_workflows_close',
  'rcm_workflows_fire_timer',
  'rcm_workflows_get',
  'rcm_workflows_start',
  // C5 encounter and authorship tools (parity in clinical-encounters and negative-harness tests).
  'clinical_author_context',
  'clinical_authors_define',
  'clinical_encounters_assign',
  'clinical_encounters_close',
  'clinical_encounters_get',
  'clinical_encounters_list',
  'clinical_encounters_open',
  // C8 history tools (parity in clinical-history and negative-harness tests).
  'clinical_history_alerts',
  'clinical_history_attest_review',
  'clinical_history_get_version',
  'clinical_history_read',
  'clinical_history_record_change',
  'clinical_history_verify_item',
  // C6 chart tools (parity in clinical-chart and negative-harness tests).
  'clinical_chart_correct_entry',
  'clinical_chart_read',
  'clinical_chart_record_entry',
  // C7 periodontal tools (parity in clinical-perio and negative-harness tests).
  'clinical_perio_compare',
  'clinical_perio_correct_exam',
  'clinical_perio_derive',
  'clinical_perio_get_exam',
  'clinical_perio_list_exams',
  'clinical_perio_record_exam',
  // C11 treatment plan tools (parity in clinical-treatment-plans and negative-harness tests).
  'clinical_treatment_plans_add_detail',
  'clinical_treatment_plans_add_item',
  'clinical_treatment_plans_create',
  'clinical_treatment_plans_get',
  'clinical_treatment_plans_list',
  'clinical_treatment_plans_set_detail_state',
  'clinical_treatment_plans_set_item_state',
  'clinical_treatment_plans_supersede',
  // C12 estimate, alternative and acceptance tools (parity in clinical-estimates and negative-harness tests).
  'clinical_estimates_accept',
  'clinical_estimates_generate',
  'clinical_estimates_get',
  'clinical_estimates_list',
  'clinical_estimates_present',
  'clinical_treatment_plans_create_alternative',
  'clinical_treatment_plans_list_alternatives',
  // C13 consent tools (parity in clinical-consents and negative-harness tests).
  'clinical_consent_templates_register',
  'clinical_consents_capture',
  'clinical_consents_get',
  'clinical_consents_list',
  'clinical_consents_withdraw',
  // C14 rendered procedure tools (parity in clinical-procedures and negative-harness tests).
  'clinical_procedures_correct',
  'clinical_procedures_get',
  'clinical_procedures_list',
  'clinical_procedures_render',
  // C15 encounter image links (parity in clinical-image-links and negative-harness tests).
  'clinical_image_links_get',
  'clinical_image_links_link',
  'clinical_image_links_list',
  'clinical_image_links_relink',
  'clinical_image_links_unlink',
  // C16 lab cases (parity in clinical-lab-cases and negative-harness tests).
  'clinical_lab_cases_attach',
  'clinical_lab_cases_create',
  'clinical_lab_cases_export',
  'clinical_lab_cases_get',
  'clinical_lab_cases_list',
  'clinical_lab_cases_record_return',
  'clinical_lab_cases_remake',
  'clinical_lab_cases_set_state',
  'clinical_lab_cases_worklist',
  // C17 referral records (parity in clinical-referrals and negative-harness tests).
  'clinical_referrals_close',
  'clinical_referrals_create',
  'clinical_referrals_export',
  'clinical_referrals_get',
  'clinical_referrals_list',
  'clinical_referrals_mark_sent',
  'clinical_referrals_prepare_package',
  'clinical_referrals_recall',
  'clinical_referrals_record_response',
  'clinical_referrals_record_share',
  'clinical_referrals_record_transmission_failure',
  'clinical_referrals_worklist',
  // C18 clinical export.
  'clinical_export',
  // C9 note template tools (parity in clinical-note-templates and negative-harness tests).
  'clinical_note_templates_applicable',
  'clinical_note_templates_define',
  'clinical_note_templates_get',
  'clinical_note_templates_get_version',
  'clinical_note_templates_retire',
  'clinical_note_templates_revise',
  // C10 note tools (parity in clinical-notes and negative-harness tests).
  'clinical_notes_add_addendum',
  'clinical_notes_amend',
  'clinical_notes_cosign',
  'clinical_notes_create_draft',
  'clinical_notes_get',
  'clinical_notes_list',
  'clinical_notes_sign',
  'clinical_notes_update_draft',
  // S12 visit context tools (derived from SCHEDULING_OPS; parity in scheduling-parity).
  'scheduling_visit_context_get',
  'scheduling_visit_context_items',
  'scheduling_visit_context_pin_medical_history',
  'scheduling_visit_context_assign_form',
  'scheduling_visit_context_unassign_form',
  'scheduling_visit_context_link_lab_case',
  'scheduling_visit_context_relink_lab_case',
  // S13 recurrence series tools.
  'scheduling_series_plan',
  'scheduling_series_create',
  'scheduling_series_get',
  'scheduling_series_extend',
  'scheduling_series_end',
  // S14 notification intents.
  'scheduling_notifications_worklist',
  'scheduling_notifications_get',
  // S15 waitlist and PT-02 cancellation recovery.
  'scheduling_waitlist_add',
  'scheduling_waitlist_list',
  'scheduling_waitlist_remove',
  'scheduling_waitlist_offer',
  'scheduling_waitlist_reconcile_offers',
  'scheduling_waitlist_offer_get',
  'scheduling_waitlist_respond',
  'scheduling_recovery_list',
  'scheduling_recovery_get',
  'scheduling_recovery_execute',
  'scheduling_standing_policies_grant',
  'scheduling_standing_policies_list',
  'scheduling_standing_policies_revoke',
  // S16 recall and the PT-03 follow-up worklist.
  'scheduling_recall_define_policy',
  'scheduling_recall_policies',
  'scheduling_recall_due',
  'scheduling_recall_create_task',
  'scheduling_recall_resolve_task',
  'scheduling_follow_up_worklist',
  // S17 export.
  'scheduling_export',
  // S20 staging list.
  'scheduling_staging_list',
  'scheduling_staging_configure',
  'scheduling_staging_add',
  'scheduling_staging_remove',
  'scheduling_staging_move',
  // S21 floor view, provider requests and presence.
  'scheduling_floor_read',
  'scheduling_floor_provider_requests',
  'scheduling_floor_request_provider',
  'scheduling_floor_acknowledge_provider_request',
  'scheduling_floor_clear_provider_request',
  'scheduling_presence_set',
  'scheduling_presence_list',
  // S22 patient reassignment.
  'scheduling_appointments_reassign_patient',
  // Workstream E staff operations, one tool per ENGAGEMENT_OPS row (portal routes are never tools).
  ...ENGAGEMENT_OP_TOOLS.map((t) => t.name),
  // I imaging tools (derived from IMAGING_OPS; parity in imaging-negative-harness). No byte tool.
  'imaging_objects_list',
  'imaging_objects_get',
  'imaging_objects_grant_read',
  'imaging_objects_revoke_grant',
  'imaging_storage_reconcile',
  'imaging_ingress_begin',
  'imaging_ingress_failures',
  'imaging_ingress_get',
  'imaging_ingress_complete',
  'imaging_associations_candidates',
  'imaging_associations_confirm',
  'imaging_associations_correct',
  'imaging_associations_history',
  'imaging_associations_unmatched',
  'imaging_image_refs_resolve',
  'imaging_mounts_create',
  'imaging_mounts_revise',
  'imaging_mounts_get',
  'imaging_annotations_create',
  'imaging_annotations_supersede',
  'imaging_annotations_list',
  'imaging_derived_create',
  'imaging_retention_set_policy',
  'imaging_retention_policies',
  'imaging_legal_holds_place',
  'imaging_legal_holds_release',
  'imaging_legal_holds_list',
  'imaging_deletions_request',
  'imaging_deletions_evaluate',
  'imaging_deletions_execute',
  'imaging_containers_inspect',
  'imaging_devices_register',
  'imaging_devices_list',
  'imaging_devices_get',
  'imaging_devices_issue_pairing_code',
  'imaging_devices_set_capabilities',
  'imaging_devices_revoke',
  'imaging_bridge_jobs_enqueue',
  'imaging_bridge_jobs_get',
  'imaging_acquisitions_request',
  'imaging_acquisitions_resolve',
  'imaging_bridge_jobs_reconcile',
  'imaging_bridge_worklist',
  'imaging_export',
  // Workstream M migration (M2-M6).
  'migration_source_profiles_register',
  'migration_packages_intake',
  'migration_packages_read',
  'migration_review_items_list',
  'migration_review_items_resolve',
  'migration_imports_plan',
  'migration_imports_apply',
  'migration_identity_merge',
  'migration_provenance_read',
  'migration_opening_items_list',
  'migration_reports_build',
  'migration_reports_read',
  'migration_signoffs_record',
  'migration_cutover_advance',
  'migration_archive_register',
  'migration_archive_verify',
  'migration_archive_references',
  'migration_archive_read',
  'migration_archive_holds_record',
  'migration_archive_retention_evaluate',
  'operations_operator_profiles_record',
  'operations_backup_verifications_record',
  'operations_readiness_assert',
  'operations_alerts_list',
  'migration_export',
  'practice_export_create',
  'practice_export_grant',
  'practice_export_download',
  'practice_export_verify',
  // A batch 3 read surfaces.
  'schedule_view',
  'appointments_detail',
  'navigation_get',
  'preferences_saved_views_list',
  'preferences_saved_views_save',
  'preferences_saved_views_delete',
  'preferences_favourites_list',
  'preferences_favourites_add',
  'preferences_favourites_remove',
  'preferences_recent_patients_list',
  'preferences_recent_patients_record',
  'preferences_recent_patients_clear',
].sort();

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let mcp: McpServerHandle;
let mcpUrl: string;
let logLines: string[];

interface TokenPair {
  readonly rest: string | undefined;
  readonly mcp: string | undefined;
}
const tokens: Record<string, TokenPair> = {};

const mcpIssue = (o: Parameters<TestTokenIssuer['issue']>[0]) =>
  issuer.issue({ audience: MCP_AUDIENCE, ...o });

beforeAll(async () => {
  db = await openTestDatabase('mcp_parity');
  await seedTenancy(db.admin);
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

  const both = async (sub: string, tid: string): Promise<TokenPair> => ({
    rest: await issuer.issue({ sub, tid }),
    mcp: await mcpIssue({ sub, tid }),
  });
  tokens.a1 = await both(USER_A1, T_ALPHA);
  tokens.a2 = await both(USER_A2, T_ALPHA); // revoked
  tokens.a3 = await both(USER_A3, T_ALPHA); // loc-north only
  tokens.a4 = await both(USER_A4, T_ALPHA); // read only
  tokens.svcB1 = await both(SVC_B1, T_BETA);
  tokens.wrongTenant = await both(USER_A1, T_BETA); // a1 has no membership in beta
  tokens.none = { rest: undefined, mcp: undefined };
  tokens.garbage = { rest: MARKER, mcp: MARKER };
  const bad = async (o: Partial<Parameters<TestTokenIssuer['issue']>[0]>): Promise<TokenPair> => ({
    rest: await issuer.issue({ sub: USER_A1, tid: T_ALPHA, ...o }),
    mcp: await mcpIssue({ sub: USER_A1, tid: T_ALPHA, ...o }),
  });
  tokens.expired = await bad({ expiresInSec: -60 });
  tokens.notYetValid = await bad({ notBeforeSec: 600 });
  tokens.wrongIssuer = await bad({ issuer: 'urn:cuspatlas:synthetic-test-evil' });
  tokens.foreignKey = await bad({ foreignKey: true });
  // Audience confusion: each transport is offered the other transport's token.
  tokens.crossAudience = {
    rest: await mcpIssue({ sub: USER_A1, tid: T_ALPHA }),
    mcp: await issuer.issue({ sub: USER_A1, tid: T_ALPHA }),
  };
  tokens.malformedAudience = {
    rest: await issuer.issue({ sub: USER_A1, tid: T_ALPHA, audience: 'not-an-audience' }),
    mcp: await mcpIssue({ sub: USER_A1, tid: T_ALPHA, audience: 'not-an-audience' }),
  };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = {
    sub: USER_A1,
    tid: T_ALPHA,
    sid: 'sid-1',
    iss: TEST_ISSUER,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const algNone = (aud: string) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, aud })}.`;
  tokens.algNone = { rest: algNone(TEST_AUDIENCE), mcp: algNone(MCP_AUDIENCE) };
  const hs = (aud: string) =>
    new SignJWT({ tid: T_ALPHA, sid: 'sid-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_A1)
      .setIssuer(TEST_ISSUER)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('synthetic-shared-secret-synthetic-shared-secret'));
  tokens.hs256 = { rest: await hs(TEST_AUDIENCE), mcp: await hs(MCP_AUDIENCE) };
});

afterAll(async () => {
  await mcp?.close();
  await app?.close();
  await db?.close();
});

// ---------------------------------------------------------------------------------------------
// Transport drivers. Both reduce a call to the same Outcome so parity is asserted mechanically.

type Op = 'create' | 'list' | 'get' | 'relabel';
type Args = Record<string, unknown>;

interface Outcome {
  /** REST: the HTTP status. MCP: the HTTP status of a protocol-level refusal, else the REST-equivalent status of the tool result. */
  readonly status: number;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly retryable: boolean | null;
  /** Everything the caller received, for marker scans. */
  readonly raw: string;
  readonly body: Record<string, unknown> | null;
}

const SUCCESS_STATUS: Record<Op, number> = { create: 201, list: 200, get: 200, relabel: 200 };
const TOOL: Record<Op, string> = {
  create: 'synthetic_tasks_create',
  list: 'synthetic_tasks_list',
  get: 'synthetic_tasks_get',
  relabel: 'synthetic_tasks_relabel',
};

function outcomeOf(status: number, body: Record<string, unknown> | null, raw: string): Outcome {
  const refused = body !== null && typeof body.code === 'string' && typeof body.retryable === 'boolean';
  return {
    status,
    code: refused ? (body.code as string) : null,
    correlationId: body !== null && typeof body.correlationId === 'string' ? body.correlationId : null,
    retryable: refused ? (body.retryable as boolean) : null,
    raw,
    body,
  };
}

async function viaRest(op: Op, token: string | undefined, args: Args): Promise<Outcome> {
  const { idempotencyKey, taskRef, ...rest } = args;
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (op === 'create' || op === 'relabel') {
    headers['content-type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['idempotency-key'] = String(idempotencyKey);
  }
  const res = await app.inject({
    method: op === 'create' || op === 'relabel' ? 'POST' : 'GET',
    url:
      op === 'create'
        ? '/v1/synthetic-tasks'
        : op === 'relabel'
          ? `/v1/synthetic-tasks/${String(taskRef)}/relabel`
          : op === 'get'
            ? `/v1/synthetic-tasks/${encodeURIComponent(String(taskRef))}`
            : '/v1/synthetic-tasks',
    ...(op === 'list'
      ? { query: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) }
      : {}),
    headers,
    ...(op === 'create' || op === 'relabel' ? { payload: JSON.stringify(rest) } : {}),
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return outcomeOf(res.statusCode, body, `${res.body}${JSON.stringify(res.headers)}`);
}

async function withClient<T>(token: string | undefined, fn: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'synthetic-test-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A protocol-level refusal surfaces as a transport error carrying the HTTP status and body text. */
function fromTransportError(e: unknown): Outcome {
  const err = e as { code?: unknown; message?: string };
  if (typeof err.code !== 'number') throw e;
  const message = String(err.message);
  let body: Record<string, unknown> | null = null;
  const start = message.indexOf('{');
  if (start >= 0) {
    try {
      body = JSON.parse(message.slice(start));
    } catch {
      body = null;
    }
  }
  return outcomeOf(err.code, body, message);
}

async function viaMcp(op: Op, token: string | undefined, args: Args): Promise<Outcome> {
  try {
    return await withClient(token, async (client) => {
      const result = await client.callTool({ name: TOOL[op], arguments: args });
      const raw = JSON.stringify(result);
      if (result.isError === true) {
        const body = result.structuredContent as Record<string, unknown>;
        const status = REFUSAL_HTTP_STATUS[body.code as RefusalCode];
        return outcomeOf(status, body, raw);
      }
      return outcomeOf(SUCCESS_STATUS[op], result.structuredContent as Record<string, unknown>, raw);
    });
  } catch (e) {
    return fromTransportError(e);
  }
}

async function attempts(correlationId: string | null) {
  if (correlationId === null) return [];
  return (
    await db.admin.query(
      'SELECT tenant_id, actor_id, operation, reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [correlationId],
    )
  ).rows;
}

async function freshTask(location: string | null = null, tenant = T_ALPHA): Promise<string> {
  const { rows } = await db.admin.query(
    'INSERT INTO cuspatlas.synthetic_tasks (tenant_id, label, location_ref, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenant, 'fresh task', location, tenant === T_ALPHA ? USER_A1 : SVC_B1],
  );
  return rows[0].id;
}

async function taskCount(): Promise<number> {
  return (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.synthetic_tasks')).rows[0].n;
}

// ---------------------------------------------------------------------------------------------
// Table-driven parity harness: every case runs through REST and MCP and must agree.

interface ParityCase {
  readonly op: Op;
  readonly name: string;
  readonly who: string;
  /** Built per transport so state-changing cases get fresh keys and tasks. */
  readonly args: () => Promise<Args> | Args;
  readonly status: number;
  readonly code: string | null;
  /** Expected reason_code of the security attempt row when the case is a denial. */
  readonly reason?: string;
  /** The Idempotency-Key header (REST) and argument (MCP) are validated at different points, so their detail may differ. */
  readonly detailMayDiffer?: boolean;
}

const key = () => randomUUID();
const longLabel = 'x'.repeat(121);

const CASES: readonly ParityCase[] = [
  // allowed
  {
    op: 'create',
    name: 'allowed',
    who: 'a1',
    args: () => ({ label: 'water the plants', idempotencyKey: key() }),
    status: 201,
    code: null,
  },
  { op: 'list', name: 'allowed', who: 'a1', args: () => ({ limit: '5' }), status: 200, code: null },
  { op: 'get', name: 'allowed', who: 'a1', args: () => ({ taskRef: TASK_A }), status: 200, code: null },
  {
    op: 'relabel',
    name: 'allowed',
    who: 'a1',
    args: async () => ({
      taskRef: await freshTask(),
      label: 'renamed',
      expectedVersion: 1,
      idempotencyKey: key(),
    }),
    status: 200,
    code: null,
  },
  // unauthorized tenant: a verified principal naming a tenant it does not belong to
  {
    op: 'create',
    name: 'unauthorized tenant',
    who: 'wrongTenant',
    args: () => ({ label: 'x', idempotencyKey: key() }),
    status: 403,
    code: 'forbidden',
    reason: 'membership_inactive',
  },
  {
    op: 'list',
    name: 'unauthorized tenant',
    who: 'wrongTenant',
    args: () => ({}),
    status: 403,
    code: 'forbidden',
    reason: 'membership_inactive',
  },
  {
    op: 'get',
    name: 'unauthorized tenant',
    who: 'wrongTenant',
    args: () => ({ taskRef: TASK_A }),
    status: 403,
    code: 'forbidden',
    reason: 'membership_inactive',
  },
  {
    op: 'relabel',
    name: 'unauthorized tenant',
    who: 'wrongTenant',
    args: () => ({ taskRef: TASK_A, label: 'x', expectedVersion: 1, idempotencyKey: key() }),
    status: 403,
    code: 'forbidden',
    reason: 'membership_inactive',
  },
  // revoked membership
  {
    op: 'create',
    name: 'revoked member',
    who: 'a2',
    args: () => ({ label: 'x', idempotencyKey: key() }),
    status: 403,
    code: 'forbidden',
    reason: 'membership_inactive',
  },
  {
    op: 'get',
    name: 'revoked member',
    who: 'a2',
    args: () => ({ taskRef: TASK_A }),
    status: 403,
    code: 'forbidden',
    reason: 'membership_inactive',
  },
  // insufficient scope: a4 holds read only
  {
    op: 'create',
    name: 'insufficient scope',
    who: 'a4',
    args: () => ({ label: 'x', idempotencyKey: key() }),
    status: 403,
    code: 'forbidden',
    reason: 'scope_missing',
  },
  {
    op: 'relabel',
    name: 'insufficient scope',
    who: 'a4',
    args: () => ({ taskRef: TASK_A, label: 'x', expectedVersion: 1, idempotencyKey: key() }),
    status: 403,
    code: 'forbidden',
    reason: 'scope_missing',
  },
  { op: 'list', name: 'read scope allowed', who: 'a4', args: () => ({}), status: 200, code: null },
  {
    op: 'get',
    name: 'read scope allowed',
    who: 'a4',
    args: () => ({ taskRef: TASK_A }),
    status: 200,
    code: null,
  },
  // insufficient scope is decided before schema: an invalid payload from a read-only caller is still a denial
  {
    op: 'create',
    name: 'insufficient scope before schema',
    who: 'a4',
    args: () => ({ label: longLabel, idempotencyKey: key() }),
    status: 403,
    code: 'forbidden',
    reason: 'scope_missing',
  },
  // location denial: a3 may only act in loc-north
  {
    op: 'create',
    name: 'location denied',
    who: 'a3',
    args: () => ({ label: 'x', locationRef: 'loc-south', idempotencyKey: key() }),
    status: 403,
    code: 'forbidden',
    reason: 'location_denied',
  },
  {
    op: 'create',
    name: 'location allowed',
    who: 'a3',
    args: () => ({ label: 'x', locationRef: 'loc-north', idempotencyKey: key() }),
    status: 201,
    code: null,
  },
  {
    op: 'get',
    name: 'location denied',
    who: 'a3',
    args: () => ({ taskRef: TASK_A_SOUTH }),
    status: 403,
    code: 'forbidden',
    reason: 'location_denied',
  },
  {
    op: 'get',
    name: 'location allowed',
    who: 'a3',
    args: () => ({ taskRef: TASK_A_NORTH }),
    status: 200,
    code: null,
  },
  {
    op: 'relabel',
    name: 'location denied',
    who: 'a3',
    args: async () => ({
      taskRef: await freshTask('loc-south'),
      label: 'x',
      expectedVersion: 1,
      idempotencyKey: key(),
    }),
    status: 403,
    code: 'forbidden',
    reason: 'location_denied',
  },
  // hidden cross-tenant resources are indistinguishable from missing ones
  {
    op: 'get',
    name: 'cross-tenant hidden',
    who: 'a1',
    args: () => ({ taskRef: TASK_B }),
    status: 404,
    code: 'not_found',
    reason: 'resource_hidden_or_missing',
  },
  {
    op: 'get',
    name: 'missing',
    who: 'a1',
    args: () => ({ taskRef: '40000000-0000-4000-8000-0000000000ee' }),
    status: 404,
    code: 'not_found',
    reason: 'resource_hidden_or_missing',
  },
  {
    op: 'get',
    name: 'malformed taskRef',
    who: 'a1',
    args: () => ({ taskRef: 'not-a-uuid' }),
    status: 404,
    code: 'not_found',
    reason: 'resource_hidden_or_missing',
  },
  {
    op: 'relabel',
    name: 'cross-tenant hidden',
    who: 'a1',
    args: () => ({ taskRef: TASK_B, label: 'x', expectedVersion: 1, idempotencyKey: key() }),
    status: 404,
    code: 'not_found',
    reason: 'resource_hidden_or_missing',
  },
  // schema violations
  {
    op: 'create',
    name: 'label too long',
    who: 'a1',
    args: () => ({ label: longLabel, idempotencyKey: key() }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'create',
    name: 'unknown property',
    who: 'a1',
    args: () => ({ label: 'x', tenantId: T_BETA, idempotencyKey: key() }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'create',
    name: 'missing idempotency key',
    who: 'a1',
    args: () => ({ label: 'x' }),
    status: 400,
    code: 'invalid_request',
    detailMayDiffer: true,
  },
  {
    op: 'create',
    name: 'bad idempotency key',
    who: 'a1',
    args: () => ({ label: 'x', idempotencyKey: 'has space' }),
    status: 400,
    code: 'invalid_request',
    detailMayDiffer: true,
  },
  {
    op: 'create',
    name: 'missing label',
    who: 'a1',
    args: () => ({ idempotencyKey: key() }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'create',
    name: 'wrong type',
    who: 'a1',
    args: () => ({ label: 42, idempotencyKey: key() }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'create',
    name: 'bad location',
    who: 'a1',
    args: () => ({ label: 'x', locationRef: 'Bad Loc', idempotencyKey: key() }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'list',
    name: 'limit zero',
    who: 'a1',
    args: () => ({ limit: '0' }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'list',
    name: 'unknown property',
    who: 'a1',
    args: () => ({ tenantId: T_BETA }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'list',
    name: 'cursor malformed',
    who: 'a1',
    args: () => ({ cursor: '!!' }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'list',
    name: 'cursor forged',
    who: 'a1',
    args: () => ({ cursor: 'e30.AAAAAAAAAAAAAAAAAAAAAA' }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'relabel',
    name: 'version zero',
    who: 'a1',
    args: () => ({ taskRef: TASK_A, label: 'x', expectedVersion: 0, idempotencyKey: key() }),
    status: 400,
    code: 'invalid_request',
  },
  {
    op: 'relabel',
    name: 'missing expectedVersion',
    who: 'a1',
    args: () => ({ taskRef: TASK_A, label: 'x', idempotencyKey: key() }),
    status: 400,
    code: 'invalid_request',
  },
  // optimistic concurrency
  {
    op: 'relabel',
    name: 'stale version',
    who: 'a1',
    args: async () => ({ taskRef: await freshTask(), label: 'x', expectedVersion: 7, idempotencyKey: key() }),
    status: 409,
    code: 'stale_version',
  },
  // authentication failures
  ...(
    [
      'none',
      'garbage',
      'expired',
      'notYetValid',
      'wrongIssuer',
      'foreignKey',
      'algNone',
      'hs256',
      'crossAudience',
      'malformedAudience',
    ] as const
  ).flatMap((who): ParityCase[] =>
    (['create', 'list', 'get', 'relabel'] as const).map((op) => ({
      op,
      name: `token ${who}`,
      who,
      args: () =>
        op === 'create'
          ? { label: 'x', idempotencyKey: key() }
          : op === 'get'
            ? { taskRef: TASK_A }
            : op === 'relabel'
              ? { taskRef: TASK_A, label: 'x', expectedVersion: 1, idempotencyKey: key() }
              : {},
      status: 401,
      code: 'unauthenticated',
      reason: who === 'none' ? 'token_missing' : 'token_invalid',
    })),
  ),
];

const DENIAL_STATUSES = new Set([401, 403, 404]);

interface Row {
  readonly op: Op;
  readonly name: string;
  readonly rest: string;
  readonly mcp: string;
}
const table: Row[] = [];

describe('REST and MCP parity (table-driven)', () => {
  it.each(CASES)('$op / $name ($who)', async (c) => {
    const t = tokens[c.who] as TokenPair;
    const restArgs = await c.args();
    const mcpArgs = await c.args();
    const before = await taskCount();
    const rest = await viaRest(c.op, t.rest, restArgs);
    const viaTool = await viaMcp(c.op, t.mcp, mcpArgs);

    const fmt = (o: Outcome) => `${o.status}${o.code ? ` ${o.code}` : ''}`;
    table.push({ op: c.op, name: `${c.name} (${c.who})`, rest: fmt(rest), mcp: fmt(viaTool) });

    expect([rest.status, rest.code]).toStrictEqual([c.status, c.code]);
    expect([viaTool.status, viaTool.code]).toStrictEqual([rest.status, rest.code]);
    expect(viaTool.retryable).toBe(rest.retryable);
    if (c.code !== null) {
      // Same shape: code, retryable, correlationId (and detail when present), nothing else.
      if (c.detailMayDiffer !== true) {
        expect(Object.keys(viaTool.body ?? {}).sort()).toStrictEqual(Object.keys(rest.body ?? {}).sort());
        expect(viaTool.body?.detail).toStrictEqual(rest.body?.detail);
      }
      expect(viaTool.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    }

    if (c.status >= 400 && c.status < 500 && !DENIAL_STATUSES.has(c.status)) {
      // Validation refusals are not denials, create nothing and write no attempt row.
      expect(await taskCount()).toBe(before);
    }

    if (DENIAL_STATUSES.has(c.status)) {
      for (const o of [rest, viaTool]) {
        const rows = await attempts(o.correlationId);
        expect(rows).toHaveLength(1);
        expect(rows[0].reason_code).toBe(c.reason);
        if (c.status === 401) expect([rows[0].tenant_id, rows[0].actor_id]).toStrictEqual([null, null]);
      }
      expect((await attempts(viaTool.correlationId))[0].operation).toMatch(
        c.status === 401 ? /^mcp\.request$/ : /^(mcp\.request|syntheticTasks\.\w+)$/,
      );
    } else if (c.status === 400 || c.status === 409) {
      expect(await attempts(viaTool.correlationId)).toHaveLength(0);
    }
  });

  afterAll(() => {
    const w = Math.max(...table.map((r) => r.name.length));
    const lines = table.map(
      (r) => `${r.op.padEnd(8)} ${r.name.padEnd(w)}  REST ${r.rest.padEnd(24)} MCP ${r.mcp}`,
    );
    process.stdout.write(`\nPARITY TABLE (${table.length} rows)\n${lines.join('\n')}\n`);
  });
});

describe('protocol surface', () => {
  it('lists exactly the registered tools and advertises nothing else', async () => {
    await withClient(tokens.a1?.mcp, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toStrictEqual(TOOL_NAMES);
      for (const t of tools) {
        expect(t.inputSchema.additionalProperties).toBe(false);
        expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('tenantId');
      }
      expect(Object.keys(client.getServerCapabilities() ?? {})).toStrictEqual(['tools']);
      // No tool-name probing: an unknown tool is a protocol error that does not echo the name.
      await expect(client.callTool({ name: `${MARKER}_sql`, arguments: {} })).rejects.toSatisfy(
        (e: Error) => !e.message.includes(MARKER),
      );
    });
  });

  it('a token for the REST audience is refused by MCP and an MCP token is refused by REST', async () => {
    const a = tokens.a1 as TokenPair;
    const toMcp = await viaMcp('list', a.rest, {});
    const toRest = await viaRest('list', a.mcp, {});
    expect([toMcp.status, toMcp.code]).toStrictEqual([401, 'unauthenticated']);
    expect([toRest.status, toRest.code]).toStrictEqual([401, 'unauthenticated']);
    expect((await viaMcp('list', a.mcp, {})).status).toBe(200);
    expect((await viaRest('list', a.rest, {})).status).toBe(200);
  });

  it('answers a bad token at the HTTP layer with 401, a Bearer challenge and protected-resource metadata', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.expired?.mcp}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    const meta = await fetch(new URL('/.well-known/oauth-protected-resource', mcpUrl));
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ resource: MCP_AUDIENCE, bearer_methods_supported: ['header'] });
  });

  it('refuses browser origins, non-POST methods, wrong paths and oversized bodies', async () => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens.a1?.mcp}`,
    };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(
      (await fetch(mcpUrl, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body }))
        .status,
    ).toBe(403);
    expect((await fetch(mcpUrl, { method: 'GET', headers })).status).toBe(405);
    expect((await fetch(mcpUrl, { method: 'DELETE', headers })).status).toBe(405);
    expect((await fetch(new URL('/other', mcpUrl), { method: 'POST', headers, body })).status).toBe(404);
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { pad: 'x'.repeat(40_000) },
    });
    expect((await fetch(mcpUrl, { method: 'POST', headers, body: big })).status).toBe(413);
  });

  it('refuses to start with a shared audience or a test issuer outside synthetic-test', () => {
    const base = {
      membership: createMembershipSource(db.app),
      attempts: createSecurityAttemptSink(db.sink),
      tenantTransactions: createTenantTransactionRunner(db.app),
    };
    expect(() =>
      buildMcpServer({
        env: 'synthetic-test',
        identity: issuer.verifierConfig,
        restAudience: TEST_AUDIENCE,
        ...base,
      }),
    ).toThrow(/audience/i);
    expect(() =>
      buildMcpServer({
        env: 'production',
        identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
        ...base,
      }),
    ).toThrow(/synthetic-test/);
  });
});

describe('idempotency shared with REST', () => {
  it('an MCP replay returns the same task with replayed: true', async () => {
    const k = key();
    const first = await viaMcp('create', tokens.a1?.mcp, { label: 'once', idempotencyKey: k });
    const second = await viaMcp('create', tokens.a1?.mcp, { label: 'once', idempotencyKey: k });
    const d1 = first.body as { data: { taskRef: string }; replayed: boolean; version: number };
    const d2 = second.body as typeof d1;
    expect([d1.replayed, d2.replayed]).toStrictEqual([false, true]);
    expect(d2.data.taskRef).toBe(d1.data.taskRef);
    expect(d2.version).toBe(d1.version);
    const rows = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.synthetic_tasks WHERE id = $1',
      [d1.data.taskRef],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('a REST replay of an MCP-created key replays, and the reverse holds', async () => {
    const k = key();
    const viaTool = await viaMcp('create', tokens.a1?.mcp, { label: 'shared', idempotencyKey: k });
    const viaHttp = await viaRest('create', tokens.a1?.rest, { label: 'shared', idempotencyKey: k });
    expect(viaHttp.status).toBe(201);
    expect(viaHttp.body).toMatchObject({ replayed: true });
    expect((viaHttp.body as { data: { taskRef: string } }).data.taskRef).toBe(
      (viaTool.body as { data: { taskRef: string } }).data.taskRef,
    );

    const k2 = key();
    const restFirst = await viaRest('create', tokens.a1?.rest, { label: 'shared2', idempotencyKey: k2 });
    const mcpReplay = await viaMcp('create', tokens.a1?.mcp, { label: 'shared2', idempotencyKey: k2 });
    expect(mcpReplay.body).toMatchObject({ replayed: true });
    expect((mcpReplay.body as { data: { taskRef: string } }).data.taskRef).toBe(
      (restFirst.body as { data: { taskRef: string } }).data.taskRef,
    );
  });

  it('the same key with a different payload is idempotency_conflict on both transports', async () => {
    const k = key();
    await viaMcp('create', tokens.a1?.mcp, { label: 'first', idempotencyKey: k });
    const mcpConflict = await viaMcp('create', tokens.a1?.mcp, { label: 'second', idempotencyKey: k });
    const restConflict = await viaRest('create', tokens.a1?.rest, { label: 'second', idempotencyKey: k });
    for (const o of [mcpConflict, restConflict])
      expect([o.status, o.code]).toStrictEqual([409, 'idempotency_conflict']);
    expect(mcpConflict.retryable).toBe(restConflict.retryable);
  });

  it('does not share keys across principals or tenants', async () => {
    const k = key();
    const a = await viaMcp('create', tokens.a1?.mcp, { label: 'alpha', idempotencyKey: k });
    const b = await viaMcp('create', tokens.svcB1?.mcp, { label: 'alpha', idempotencyKey: k });
    expect((b.body as { replayed: boolean }).replayed).toBe(false);
    expect((b.body as { data: { taskRef: string } }).data.taskRef).not.toBe(
      (a.body as { data: { taskRef: string } }).data.taskRef,
    );
  });

  it('a relabel retry through MCP does not bump the version twice', async () => {
    const ref = await freshTask();
    const k = key();
    const args = { taskRef: ref, label: 'again', expectedVersion: 1, idempotencyKey: k };
    const one = await viaMcp('relabel', tokens.a1?.mcp, args);
    const two = await viaMcp('relabel', tokens.a1?.mcp, args);
    expect([one.body?.version, two.body?.version]).toStrictEqual([2, 2]);
    expect(two.body?.replayed).toBe(true);
  });

  it('a member revoked after the first call is denied on replay', async () => {
    const t = await mcpIssue({ sub: USER_A3, tid: T_ALPHA });
    const k = key();
    const args = { label: 'then revoked', locationRef: 'loc-north', idempotencyKey: k };
    expect((await viaMcp('create', t, args)).status).toBe(201);
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      USER_A3,
    ]);
    try {
      const replay = await viaMcp('create', t, args);
      expect([replay.status, replay.code]).toStrictEqual([403, 'forbidden']);
      expect(replay.raw).not.toContain('then revoked');
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
        USER_A3,
      ]);
    }
  });
});

describe('tool results', () => {
  it('returns the CommandResult as structured content and never reports a refusal as success', async () => {
    await withClient(tokens.a1?.mcp, async (client) => {
      const ok = await client.callTool({
        name: 'synthetic_tasks_create',
        arguments: { label: 'structured', idempotencyKey: key() },
      });
      expect(ok.isError).not.toBe(true);
      const s = ok.structuredContent as Record<string, unknown>;
      expect(Object.keys(s).sort()).toStrictEqual(['correlationId', 'data', 'replayed', 'version']);
      expect(Object.keys(s.data as object).sort()).toStrictEqual(['label', 'taskRef']);

      const list = await client.callTool({ name: 'synthetic_tasks_list', arguments: { limit: '1' } });
      const page = list.structuredContent as { data: unknown[]; nextCursor: string | null };
      expect(page.data).toHaveLength(1);
      expect(typeof page.nextCursor).toBe('string');
      const next = await client.callTool({
        name: 'synthetic_tasks_list',
        arguments: { limit: '1', cursor: page.nextCursor },
      });
      expect(next.isError).not.toBe(true);

      const denied = await client.callTool({ name: 'synthetic_tasks_get', arguments: { taskRef: TASK_B } });
      expect(denied.isError).toBe(true);
      expect(Object.keys(denied.structuredContent as object).sort()).toStrictEqual([
        'code',
        'correlationId',
        'retryable',
      ]);
    });
  });

  it('cross-tenant and missing tasks produce byte-identical refusals apart from the correlation id', async () => {
    const strip = (o: Outcome) => JSON.stringify({ ...o.body, correlationId: undefined });
    const hidden = await viaMcp('get', tokens.a1?.mcp, { taskRef: TASK_B });
    const missing = await viaMcp('get', tokens.a1?.mcp, { taskRef: '40000000-0000-4000-8000-0000000000ee' });
    expect(strip(hidden)).toBe(strip(missing));
  });

  it('never takes a tenant from the client', async () => {
    const before = await taskCount();
    const o = await viaMcp('create', tokens.a1?.mcp, { label: 'x', tenantId: T_BETA, idempotencyKey: key() });
    expect(o.status).toBe(400);
    expect(await taskCount()).toBe(before);
    const created = await viaMcp('create', tokens.a1?.mcp, { label: 'mine', idempotencyKey: key() });
    const ref = (created.body as { data: { taskRef: string } }).data.taskRef;
    const row = (
      await db.admin.query('SELECT tenant_id, created_by FROM cuspatlas.synthetic_tasks WHERE id = $1', [ref])
    ).rows[0];
    expect(row).toStrictEqual({ tenant_id: T_ALPHA, created_by: USER_A1 });
  });
});

describe('privacy: the marker never appears in errors, logs or attempt rows', () => {
  it('keeps SYNTHETIC_SECRET_42 out of every refusal and log line', async () => {
    const a = tokens.a1 as TokenPair;
    const seed = key();
    await viaMcp('create', a.mcp, { label: 'plain', idempotencyKey: MARKER });
    const outcomes: Outcome[] = [
      // label (too long, carrying the marker), idempotency key (conflict), cursor, unknown property, task reference, token
      await viaMcp('create', a.mcp, { label: MARKER.repeat(7), idempotencyKey: seed }),
      await viaMcp('create', a.mcp, { label: 'different', idempotencyKey: MARKER }),
      await viaMcp('create', a.mcp, { label: 'x', idempotencyKey: `${MARKER} nope` }),
      await viaMcp('create', a.mcp, { label: 'x', [MARKER]: 1, idempotencyKey: seed }),
      await viaMcp('list', a.mcp, { cursor: `${MARKER}.${MARKER}` }),
      await viaMcp('list', a.mcp, { cursor: MARKER }),
      await viaMcp('get', a.mcp, { taskRef: MARKER }),
      await viaMcp('relabel', a.mcp, {
        taskRef: MARKER,
        label: MARKER.repeat(7),
        expectedVersion: 1,
        idempotencyKey: MARKER,
      }),
      await viaMcp('create', tokens.a4?.mcp, { label: MARKER.repeat(7), idempotencyKey: MARKER }),
      await viaMcp('get', tokens.garbage?.mcp, { taskRef: MARKER }),
      await viaMcp('create', `${MARKER}.${MARKER}.${MARKER}`, { label: MARKER, idempotencyKey: MARKER }),
    ];
    for (const o of outcomes) {
      expect(o.status).toBeGreaterThanOrEqual(400);
      expect(o.raw).not.toContain(MARKER);
    }
    const attemptRows = JSON.stringify(
      (await db.admin.query('SELECT * FROM cuspatlas.security_attempt_events')).rows,
    );
    expect(attemptRows).not.toContain(MARKER);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).not.toContain(MARKER);
    // The log carries actor, tool and correlation id only.
    const toolLines = logLines.map((l) => JSON.parse(l)).filter((l) => l.tool !== undefined);
    expect(toolLines.length).toBeGreaterThan(0);
    for (const l of toolLines) {
      expect(Object.keys(l).sort()).toStrictEqual([
        'actorId',
        'code',
        'correlationId',
        'level',
        'msg',
        'tool',
      ]);
      expect(TOOL_NAMES).toContain(l.tool);
    }
  });
});

describe('E4/E5 hardening: transport and validation', () => {
  /** A dedicated server whose tenant transactions are counted: no count means no domain statement. */
  async function countingServer(extra: Partial<Parameters<typeof buildMcpServer>[0]> = {}) {
    const base = createTenantTransactionRunner(db.app);
    const counter = { calls: 0 };
    const server = buildMcpServer({
      env: 'synthetic-test',
      identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
      restAudience: TEST_AUDIENCE,
      membership: createMembershipSource(db.app),
      attempts: createSecurityAttemptSink(db.sink),
      tenantTransactions: (ctx, work) => {
        counter.calls += 1;
        return base(ctx, work);
      },
      ...extra,
    });
    const { url } = await server.listen({ host: '127.0.0.1', port: 0 });
    return { server, url, counter };
  }

  async function call(url: string, token: string | undefined, name: string, args: Record<string, unknown>) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
    });
    const client = new Client({ name: 'synthetic-test-client', version: '0.0.0' });
    await client.connect(transport);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  it('an extra property on a read tool is refused before any handler or domain statement runs', async () => {
    const { server, url, counter } = await countingServer();
    try {
      for (const [name, args] of [
        ['synthetic_tasks_get', { taskRef: TASK_A, extra: MARKER }],
        ['synthetic_tasks_list', { limit: '5', extra: 1 }],
        ['synthetic_tasks_get_proposal', { proposalRef: randomUUID(), extra: 1 }],
      ] as const) {
        counter.calls = 0;
        const result = await call(url, tokens.a1?.mcp, name, args);
        const body = result.structuredContent as { code: string; correlationId: string };
        expect([name, result.isError, body.code]).toStrictEqual([name, true, 'invalid_request']);
        expect([name, counter.calls]).toStrictEqual([name, 0]);
        // No authorization denial was recorded for the authorized caller; proposal tools record
        // every refusal, so they hold exactly the invalid_request row.
        const rows = await attempts(body.correlationId);
        expect(rows.map((r) => r.reason_code)).toStrictEqual(
          name === 'synthetic_tasks_get_proposal' ? ['request_invalid'] : [],
        );
        expect(JSON.stringify(result)).not.toContain(MARKER);
      }
      // Authorization still precedes schema: a caller without write gets the denial, not the schema error.
      counter.calls = 0;
      const denied = await call(url, tokens.a4?.mcp, 'synthetic_tasks_relabel', {
        taskRef: TASK_A,
        label: '',
        expectedVersion: 1,
        idempotencyKey: key(),
        extra: 1,
      });
      const deniedBody = denied.structuredContent as { code: string; correlationId: string };
      expect(deniedBody.code).toBe('forbidden');
      expect((await attempts(deniedBody.correlationId)).map((r) => r.reason_code)).toStrictEqual([
        'scope_missing',
      ]);
      expect(counter.calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('refuses Host headers outside the allowlist with 421 (DNS rebinding)', async () => {
    const { server, url } = await countingServer({
      resourceMetadataUrl: 'https://mcp.synthetic.invalid/.well-known/oauth-protected-resource',
    });
    const port = new URL(url).port;
    const post = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              host,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      });
    try {
      expect(await post('evil.example')).toBe(421);
      expect(await post(`evil.example:${port}`)).toBe(421);
      expect(await post('127.0.0.1.evil.example')).toBe(421);
      // Allowed hosts pass the host check (and then need a token: 401).
      expect(await post(`127.0.0.1:${port}`)).toBe(401);
      expect(await post(`localhost:${port}`)).toBe(401);
      expect(await post('mcp.synthetic.invalid')).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('requires resourceMetadataUrl outside synthetic-test and refuses a default derived from 0.0.0.0', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const identity = await loadConfiguredMcpIdentity({
      CUSPATLAS_JWT_ISSUER: 'urn:cuspatlas:issuer:synthetic-config',
      CUSPATLAS_MCP_AUDIENCE: 'urn:cuspatlas:mcp:synthetic-config',
      CUSPATLAS_JWT_AUDIENCE: 'urn:cuspatlas:api:synthetic-config',
      CUSPATLAS_JWT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const base = {
      identity,
      membership: createMembershipSource(db.app),
      attempts: createSecurityAttemptSink(db.sink),
      tenantTransactions: createTenantTransactionRunner(db.app),
      // Outside synthetic-test the match-key pepper is a configured secret (review hardening).
      matchKeyPepper: new Uint8Array(randomBytes(32)),
      // Integration hardening: the idempotency digest key is a configured secret there as well.
      idempotencyDigestKey: new Uint8Array(randomBytes(32)),
    };
    expect(() => buildMcpServer({ env: 'development', ...base })).toThrow(/resourceMetadataUrl/);
    const { idempotencyDigestKey: _digestKey, ...withoutDigestKey } = base;
    expect(() =>
      buildMcpServer({
        env: 'development',
        ...withoutDigestKey,
        resourceMetadataUrl: 'https://mcp.synthetic.invalid/.well-known/oauth-protected-resource',
      }),
    ).toThrow(/CUSPATLAS_IDEMPOTENCY_DIGEST_KEY/);
    expect(() =>
      buildMcpServer({
        env: 'development',
        ...base,
        idempotencyDigestKey: SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY,
        resourceMetadataUrl: 'https://mcp.synthetic.invalid/.well-known/oauth-protected-resource',
      }),
    ).toThrow(/test-only idempotency digest key/);
    const { matchKeyPepper: _pepper, ...withoutPepper } = base;
    expect(() =>
      buildMcpServer({
        env: 'development',
        ...withoutPepper,
        resourceMetadataUrl: 'https://mcp.synthetic.invalid/.well-known/oauth-protected-resource',
      }),
    ).toThrow(/CUSPATLAS_MATCH_KEY_PEPPER/);
    expect(() =>
      buildMcpServer({
        env: 'development',
        ...base,
        matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
        resourceMetadataUrl: 'https://mcp.synthetic.invalid/.well-known/oauth-protected-resource',
      }),
    ).toThrow(/test-only match-key pepper/);
    const configured = buildMcpServer({
      env: 'development',
      ...base,
      resourceMetadataUrl: 'https://mcp.synthetic.invalid/.well-known/oauth-protected-resource',
    });
    await configured.close();
    const unspecified = buildMcpServer({
      env: 'synthetic-test',
      identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
      restAudience: TEST_AUDIENCE,
      membership: base.membership,
      attempts: base.attempts,
      tenantTransactions: base.tenantTransactions,
    });
    await expect(unspecified.listen({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/resourceMetadataUrl/);
    await unspecified.close();
  });
});
