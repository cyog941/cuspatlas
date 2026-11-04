import { createHash } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  CLINICAL_PROPERTIES,
  type ClinicalAuthor,
  type CommandEnvelope,
  type CommandResult,
  type LabCase,
  type LabCaseAttach,
  type LabCaseCreate,
  type LabCaseRemake,
  type LabCaseReturn,
  type LabCaseSetState,
  type LabCaseState,
  type LabWorklistQuery,
  RefusalError,
  type TenantTransaction,
  validateLabCaseAttach,
  validateLabCaseCreate,
  validateLabCaseRemake,
  validateLabCaseReturn,
  validateLabCaseSetState,
  validateLabWorklistQuery,
  type WorkItem,
  type WorkItemListData,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { VisitContextProducer } from '../scheduling/visit-context';
import { AVAILABLE, workItem, workList } from '../work-items';
import { resolveClinicalAuthor } from './authorship';
import { type ClinicalBase, checkEnvelope, conflict, failedAt, notFound, UUID } from './base';
import { assertNotMerged, loadClinicalPatient } from './encounters';

export const LAB_CASE_RESOURCE = 'clinicalLabCase';
export const LAB_EXPORT_FORMAT = 'cuspatlas-lab-case-export/1';
const MAX_CASES = 200;
/** Provisional transition set (C-D9 pending); the database guard holds the same set. */
const ALLOWED: Readonly<Record<LabCaseState, readonly LabCaseState[]>> = {
  draft: ['sent', 'cancelled'],
  sent: ['in_progress', 'received', 'cancelled'],
  in_progress: ['received', 'cancelled'],
  received: ['seated', 'remake'],
  seated: ['remake'],
  remake: [],
  cancelled: [],
};
const AWAITING = new Set<LabCaseState>(['sent', 'in_progress']);
const TERMINAL = new Set<LabCaseState>(['seated', 'remake', 'cancelled']);

interface CaseRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  origin_patient_id: string;
  counterparty_ref: string;
  case_ref: string;
  plan_item_id: string | null;
  plan_detail_id: string | null;
  appointment_id: string | null;
  appointment_status: string | null;
  plan_superseded: boolean;
  requested_date: string | null;
  expected_return_date: string | null;
  received_date: string | null;
  no_attachment_reason: string | null;
  state: LabCaseState;
  remake_of_id: string | null;
  remade_as_id: string | null;
  created_by: string;
  created_at: Date;
  version: number;
}
const SELECT = `SELECT c.id, c.subject_patient_id, c.origin_patient_id, c.counterparty_ref, c.case_ref, c.plan_item_id,
    c.plan_detail_id, c.appointment_id, a.status AS appointment_status,
    EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions s
            WHERE s.tenant_id = c.tenant_id AND s.supersedes_version_id = coalesce(i.plan_version_id, d.plan_version_id))
      AS plan_superseded,
    to_char(c.requested_date, 'YYYY-MM-DD') AS requested_date,
    to_char(c.expected_return_date, 'YYYY-MM-DD') AS expected_return_date,
    to_char(c.received_date, 'YYYY-MM-DD') AS received_date, c.no_attachment_reason, c.state, c.remake_of_id,
    (SELECT r.id FROM cuspatlas.clinical_lab_cases r WHERE r.remake_of_id = c.id AND r.tenant_id = c.tenant_id) AS remade_as_id,
    c.created_by, c.created_at, c.version
  FROM cuspatlas.clinical_lab_cases c
  LEFT JOIN cuspatlas.appointments a ON a.id = c.appointment_id AND a.tenant_id = c.tenant_id
  LEFT JOIN cuspatlas.clinical_plan_items i ON i.id = c.plan_item_id AND i.tenant_id = c.tenant_id
  LEFT JOIN cuspatlas.clinical_plan_details d ON d.id = c.plan_detail_id AND d.tenant_id = c.tenant_id`;

async function loadCase(tx: TenantTransaction, ref: string, lock = ''): Promise<CaseRow | null> {
  if (!UUID.test(ref)) return null;
  if (lock) await tx.query(`SELECT id FROM cuspatlas.clinical_lab_cases WHERE id = $1 ${lock}`, [ref]);
  const { rows } = await tx.query<CaseRow>(`${SELECT} WHERE c.id = $1`, [ref]);
  return rows[0] ?? null;
}

const today = (asOf: number) => new Date(asOf).toISOString().slice(0, 10);

async function view(tx: TenantTransaction, r: CaseRow, asOf = Date.now()): Promise<LabCase> {
  const { rows: transitions } = await tx.query<{
    sequence: number;
    from_state: LabCaseState | null;
    to_state: LabCaseState;
    reason_code: string | null;
    actor_id: string;
    at: Date;
  }>(
    `SELECT sequence, from_state, to_state, reason_code, actor_id, at FROM cuspatlas.clinical_lab_case_transitions
     WHERE case_id = $1 ORDER BY sequence`,
    [r.id],
  );
  const { rows: attachments } = await tx.query<{ attachment_ref: string; added_by: string; added_at: Date }>(
    `SELECT attachment_ref, added_by, added_at FROM cuspatlas.clinical_lab_case_attachments WHERE case_id = $1
     ORDER BY added_at, attachment_ref`,
    [r.id],
  );
  return {
    labCaseRef: r.id,
    patientRef: r.subject_patient_id,
    sourcePatientRef: r.origin_patient_id,
    counterpartyRef: r.counterparty_ref,
    caseRef: r.case_ref,
    planItemRef: r.plan_item_id,
    planDetailRef: r.plan_detail_id,
    appointmentRef: r.appointment_id,
    appointmentStatus: r.appointment_status,
    requestedDate: r.requested_date,
    expectedReturnDate: r.expected_return_date,
    receivedDate: r.received_date,
    noAttachmentReason: r.no_attachment_reason,
    state: r.state,
    overdue: overdue(r, asOf),
    remakeOfRef: r.remake_of_id,
    remadeAsRef: r.remade_as_id,
    review: {
      planLinkSuperseded: r.plan_superseded,
      appointmentCancelled: r.appointment_status === 'cancelled',
    },
    transitions: transitions.map((t) => ({
      sequence: t.sequence,
      fromState: t.from_state,
      toState: t.to_state,
      reasonCode: t.reason_code,
      actorRef: t.actor_id,
      at: t.at.toISOString(),
    })),
    attachments: attachments.map((a) => ({
      attachmentRef: a.attachment_ref,
      addedBy: a.added_by,
      addedAt: a.added_at.toISOString(),
    })),
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    version: r.version,
  };
}

/** Derived, never stored: the expected return date passed (UTC date, pending C16-P3) while awaited. */
const overdue = (r: CaseRow, asOf: number) =>
  AWAITING.has(r.state) && r.expected_return_date !== null && r.expected_return_date < today(asOf);

/** A deterministic work-item reference per case and kind (a projection, not a stored row). */
const workRef = (kind: string, id: string) => {
  const h = createHash('sha256').update(`${kind}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** The C16 producer behind S12's lab-case slot (references, versions and state labels only). */
export const LAB_CASE_VISIT_PRODUCER: Omit<VisitContextProducer, 'available'> = {
  async resolve(tx, ref) {
    const r = await loadCase(tx, ref);
    if (!r) return null;
    return {
      ref: r.id,
      version: r.version,
      provenanceRef: `C16:${r.state}`,
      status: r.state === 'cancelled' ? 'voided' : 'resolved',
      patientRef: r.subject_patient_id,
    };
  },
};

type Ack = { readonly ref: string };

/** C16 commands and reads. No command orders from a lab or transmits anything (C-D9). */
export function createLabCaseOperations(base: ClinicalBase) {
  const { deps, execute } = base;

  const located = async (tx: TenantTransaction, ref: string, lock = '') => {
    const r = await loadCase(tx, ref, lock);
    if (!r) throw notFound();
    return r;
  };
  const answer = async (tx: TenantTransaction, ref: string) => view(tx, await located(tx, ref));
  const audit = (tx: TenantTransaction, op: string, ref: string, version: number, fields: string[]) =>
    recordCommand(
      tx,
      { operation: op, resourceType: LAB_CASE_RESOURCE, resourceRef: ref, resourceVersion: version },
      { changedFields: fields },
    );
  const transition = async (
    tx: TenantTransaction,
    caseId: string,
    from: LabCaseState | null,
    to: LabCaseState,
    reason: string | null,
    who: ClinicalAuthor,
  ) => {
    const { rows } = await tx.query<{ n: number }>(
      'SELECT coalesce(max(sequence), 0)::int AS n FROM cuspatlas.clinical_lab_case_transitions WHERE case_id = $1',
      [caseId],
    );
    await tx.query(
      `INSERT INTO cuspatlas.clinical_lab_case_transitions (tenant_id, case_id, sequence, from_state, to_state, reason_code,
         actor_id, actor_role, actor_credential_ref)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id(), $6, $7)`,
      [caseId, (rows[0]?.n ?? 0) + 1, from, to, reason, who.role, who.credentialRef],
    );
  };
  const attach = async (tx: TenantTransaction, caseId: string, refs: readonly string[]) => {
    for (const ref of refs) {
      await tx.query(
        `INSERT INTO cuspatlas.clinical_lab_case_attachments (tenant_id, case_id, attachment_ref, added_by)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id()) ON CONFLICT DO NOTHING`,
        [caseId, ref],
      );
    }
  };
  /** The next step must be in the proposed set and enabled by the practice's configuration. */
  const checkStep = async (tx: TenantTransaction, r: CaseRow, to: LabCaseState) => {
    if (!ALLOWED[r.state].includes(to)) {
      throw conflict('lab_transition_not_allowed', { blockingRefs: [{ kind: 'labCase', ref: r.id }] });
    }
    const { rows } = await tx.query<{ enabled: boolean }>(
      'SELECT enabled FROM cuspatlas.clinical_lab_case_state_config WHERE state = $1',
      [to],
    );
    if (rows[0]?.enabled === false) throw conflict('lab_state_disabled');
  };
  const checkVersion = (r: CaseRow, expected: number) => {
    if (r.version !== expected)
      throw new RefusalError({ code: 'stale_version', detail: { currentVersion: r.version } });
  };
  const caseRefFree = async (tx: TenantTransaction, counterparty: string, caseRef: string) => {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM cuspatlas.clinical_lab_cases WHERE counterparty_ref = $1 AND case_ref = $2',
      [counterparty, caseRef],
    );
    if (rows[0])
      throw conflict('lab_case_ref_in_use', { blockingRefs: [{ kind: 'labCase', ref: rows[0].id }] });
  };
  /** A plan link and the appointment must exist in this tenant (404) and belong to the patient (422). */
  const checkLinks = async (tx: TenantTransaction, patientId: string, p: LabCaseCreate) => {
    const owner = async (sql: string, ref: string | undefined, pointer: string, rule: string) => {
      if (ref === undefined) return;
      if (!UUID.test(ref)) throw notFound();
      const { rows } = await tx.query<{ subject: string }>(sql, [ref]);
      if (!rows[0]) throw notFound();
      if (rows[0].subject !== patientId) throw failedAt(pointer, rule);
    };
    const planOf = (table: string) =>
      `SELECT p.subject_patient_id AS subject FROM cuspatlas.${table} x
       JOIN cuspatlas.clinical_plan_versions v ON v.id = x.plan_version_id AND v.tenant_id = x.tenant_id
       JOIN cuspatlas.clinical_treatment_plans p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id WHERE x.id = $1`;
    await owner(planOf('clinical_plan_items'), p.planItemRef, '/planItemRef', 'planItemPatientMismatch');
    await owner(
      planOf('clinical_plan_details'),
      p.planDetailRef,
      '/planDetailRef',
      'planDetailPatientMismatch',
    );
    await owner(
      'SELECT subject_patient_id AS subject FROM cuspatlas.appointments WHERE id = $1',
      p.appointmentRef,
      '/appointmentRef',
      'appointmentPatientMismatch',
    );
  };
  /** Versioned lifecycle command on one case: authorize, envelope, schema, then the locked case. */
  function command<P>(
    ctx: ActorContext,
    op: Parameters<ClinicalBase['authorize']>[1],
    labCaseRef: string,
    envelope: CommandEnvelope<unknown>,
    validate: Parameters<typeof assertValid>[0],
    work: (
      tx: TenantTransaction,
      r: CaseRow,
      p: P,
      who: ClinicalAuthor,
    ) => Promise<{ ref: string; version: number }>,
  ): Promise<CommandResult<LabCase>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload as P;
      assertValid<P>(validate, p, CLINICAL_PROPERTIES);
      return deps.withTenantTransaction(ctx, async (tx) => {
        const found = await located(tx, labCaseRef);
        await loadClinicalPatient(tx, found.subject_patient_id);
        const who = await resolveClinicalAuthor(tx);
        const r = await execute<Ack>(
          ctx,
          { ...envelope, payload: { labCaseRef, ...(p as object) } },
          tx,
          async () => {
            const current = await located(tx, labCaseRef, 'FOR UPDATE');
            const done = await work(tx, current, p, who);
            return { data: { ref: done.ref }, version: done.version };
          },
        );
        return { ...r, data: await answer(tx, r.data.ref) };
      });
    });
  }

  return {
    createLabCase(ctx: ActorContext, envelope: CommandEnvelope<unknown>): Promise<CommandResult<LabCase>> {
      const op = 'clinical.labCases.create';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<LabCaseCreate>(validateLabCaseCreate, p, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, p.patientRef);
          const who = await resolveClinicalAuthor(tx);
          const r = await execute<Ack>(ctx, envelope, tx, async () => {
            assertNotMerged(patient);
            await checkLinks(tx, patient.id, p);
            if (
              p.expectedReturnDate !== undefined &&
              p.requestedDate !== undefined &&
              p.expectedReturnDate < p.requestedDate
            )
              throw failedAt('/expectedReturnDate', 'beforeRequestedDate');
            await caseRefFree(tx, p.counterpartyRef, p.caseRef);
            const { rows: n } = await tx.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM cuspatlas.clinical_lab_cases WHERE subject_patient_id = $1',
              [patient.id],
            );
            if ((n[0]?.n ?? 0) >= MAX_CASES) throw failedAt('/', 'tooManyLabCases');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.clinical_lab_cases (tenant_id, subject_patient_id, origin_patient_id, counterparty_ref,
                 case_ref, plan_item_id, plan_detail_id, appointment_id, requested_date, expected_return_date, created_by,
                 created_by_role, created_by_credential_ref)
               VALUES (cuspatlas.current_tenant_id(), $1, $1, $2, $3, $4, $5, $6, $7, $8, cuspatlas.current_actor_id(), $9, $10)
               RETURNING id`,
              [
                patient.id,
                p.counterpartyRef,
                p.caseRef,
                p.planItemRef ?? null,
                p.planDetailRef ?? null,
                p.appointmentRef ?? null,
                p.requestedDate ?? null,
                p.expectedReturnDate ?? null,
                who.role,
                who.credentialRef,
              ],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await transition(tx, id, null, 'draft', null, who);
            await attach(tx, id, p.attachmentRefs ?? []);
            await audit(tx, op, id, 1, ['patientRef', 'counterpartyRef', 'caseRef', 'links', 'dates']);
            return { data: { ref: id }, version: 1 };
          });
          return { ...r, data: await answer(tx, r.data.ref) };
        });
      });
    },

    setLabCaseState(ctx: ActorContext, labCaseRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.labCases.setState';
      return command<LabCaseSetState>(
        ctx,
        op,
        labCaseRef,
        envelope,
        validateLabCaseSetState,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          await checkStep(tx, r, p.state);
          await tx.query(
            `UPDATE cuspatlas.clinical_lab_cases SET state = $2, version = version + 1, updated_at = now() WHERE id = $1`,
            [r.id, p.state],
          );
          await transition(tx, r.id, r.state, p.state, p.reasonCode ?? null, who);
          await audit(tx, op, r.id, r.version + 1, ['state']);
          return { ref: r.id, version: r.version + 1 };
        },
      );
    },

    recordLabReturn(ctx: ActorContext, labCaseRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.labCases.recordReturn';
      return command<LabCaseReturn>(
        ctx,
        op,
        labCaseRef,
        envelope,
        validateLabCaseReturn,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          const refs = p.attachmentRefs ?? [];
          if (refs.length === 0 && p.noAttachmentReason === undefined)
            throw failedAt('/attachmentRefs', 'attachmentOrReasonRequired');
          await checkStep(tx, r, 'received');
          await tx.query(
            `UPDATE cuspatlas.clinical_lab_cases SET state = 'received', received_date = $2, no_attachment_reason = $3,
             version = version + 1, updated_at = now() WHERE id = $1`,
            [r.id, p.receivedDate, p.noAttachmentReason ?? null],
          );
          await transition(tx, r.id, r.state, 'received', null, who);
          await attach(tx, r.id, refs);
          await audit(tx, op, r.id, r.version + 1, ['state', 'receivedDate', 'attachments']);
          return { ref: r.id, version: r.version + 1 };
        },
      );
    },

    attachLabDocument(
      ctx: ActorContext,
      labCaseRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<LabCase>> {
      const op = 'clinical.labCases.attach';
      return command<LabCaseAttach>(
        ctx,
        op,
        labCaseRef,
        envelope,
        validateLabCaseAttach,
        async (tx, r, p) => {
          await attach(tx, r.id, [p.attachmentRef]);
          await tx.query(
            `UPDATE cuspatlas.clinical_lab_cases SET version = version + 1, updated_at = now() WHERE id = $1`,
            [r.id],
          );
          await audit(tx, op, r.id, r.version + 1, ['attachments']);
          return { ref: r.id, version: r.version + 1 };
        },
      );
    },

    /** A remake is a new case linked to this one; this case ends as remake with its history unchanged. */
    remakeLabCase(ctx: ActorContext, labCaseRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'clinical.labCases.remake';
      return command<LabCaseRemake>(
        ctx,
        op,
        labCaseRef,
        envelope,
        validateLabCaseRemake,
        async (tx, r, p, who) => {
          checkVersion(r, p.expectedVersion);
          await checkStep(tx, r, 'remake');
          await caseRefFree(tx, r.counterparty_ref, p.caseRef);
          await tx.query(
            `UPDATE cuspatlas.clinical_lab_cases SET state = 'remake', version = version + 1, updated_at = now() WHERE id = $1`,
            [r.id],
          );
          await transition(tx, r.id, r.state, 'remake', p.reasonCode, who);
          await audit(tx, op, r.id, r.version + 1, ['state']);
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO cuspatlas.clinical_lab_cases (tenant_id, subject_patient_id, origin_patient_id, counterparty_ref,
             case_ref, plan_item_id, plan_detail_id, expected_return_date, remake_of_id, created_by, created_by_role,
             created_by_credential_ref)
           VALUES (cuspatlas.current_tenant_id(), $1, $1, $2, $3, $4, $5, $6, $7, cuspatlas.current_actor_id(), $8, $9)
           RETURNING id`,
            [
              r.subject_patient_id,
              r.counterparty_ref,
              p.caseRef,
              r.plan_item_id,
              r.plan_detail_id,
              p.expectedReturnDate ?? null,
              r.id,
              who.role,
              who.credentialRef,
            ],
          );
          const id = rows[0]?.id;
          if (!id) throw new Error('insert returned no row');
          await transition(tx, id, null, 'draft', p.reasonCode, who);
          await audit(tx, op, id, 1, ['remakeOf', 'caseRef']);
          return { ref: id, version: 1 };
        },
      );
    },

    readLabCase(ctx: ActorContext, labCaseRef: string): Promise<LabCase> {
      const op = 'clinical.labCases.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await located(tx, labCaseRef);
          const out = await view(tx, r);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: LAB_CASE_RESOURCE,
            resourceRefs: [r.id],
            queryFields: [],
          });
          return out;
        });
      });
    },

    listLabCases(ctx: ActorContext, patientRef: string): Promise<LabCase[]> {
      const op = 'clinical.labCases.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadClinicalPatient(tx, patientRef, '');
          const { rows } = await tx.query<CaseRow>(
            `${SELECT} WHERE c.subject_patient_id = $1 ORDER BY c.created_at, c.id LIMIT ${MAX_CASES}`,
            [patient.id],
          );
          const out: LabCase[] = [];
          for (const r of rows) out.push(await view(tx, r));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: LAB_CASE_RESOURCE,
            resourceRefs: [patient.id, ...rows.map((r) => r.id)].slice(0, 100),
            queryFields: [],
          });
          return out;
        });
      });
    },

    /** C-D9: the printable package is the only channel; nothing is transmitted. A sensitive read. */
    exportLabCase(
      ctx: ActorContext,
      labCaseRef: string,
    ): Promise<{ format: typeof LAB_EXPORT_FORMAT; generatedAt: string; labCase: LabCase }> {
      const op = 'clinical.labCases.export';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await located(tx, labCaseRef);
          const labCase = await view(tx, r);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: LAB_CASE_RESOURCE,
            resourceRefs: [r.id],
            queryFields: [],
          });
          return { format: LAB_EXPORT_FORMAT, generatedAt: new Date().toISOString(), labCase };
        });
      });
    },

    /**
     * PT-03 (lab returns), exception first: awaited cases past their expected return date, and open
     * cases whose plan link was superseded or whose appointment was cancelled. A projection of stored
     * facts; producing it changes nothing.
     */
    labWorklist(ctx: ActorContext, query: unknown): Promise<WorkItemListData> {
      const op = 'clinical.labCases.worklist';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        const q = query as LabWorklistQuery;
        assertValid<LabWorklistQuery>(validateLabWorklistQuery, q, CLINICAL_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const asOf = q.asOf === undefined ? Date.now() : Date.parse(q.asOf);
          const { rows } = await tx.query<CaseRow>(
            `${SELECT} WHERE c.state NOT IN ('seated', 'remake', 'cancelled') ORDER BY c.created_at, c.id LIMIT 1000`,
          );
          const items: WorkItem[] = [];
          for (const r of rows) {
            if (TERMINAL.has(r.state)) continue;
            const evidence = [{ kind: 'labCase', ref: r.id }];
            if (overdue(r, asOf)) {
              items.push(
                workItem({
                  workItemRef: workRef('lab_return_overdue', r.id),
                  kind: 'lab_return_overdue',
                  reasonCode: 'expected_return_passed',
                  explanation: 'The lab case was expected back and no return is recorded.',
                  evidenceRefs: evidence,
                  owner: { queue: 'clinical', principalRef: null },
                  nextActionOwedBy: 'vendor',
                  dueAt: `${r.expected_return_date}T00:00:00.000Z`,
                  priority: 'soon',
                  priorityRationale: 'return_overdue',
                  suggestedNextAction: 'contact_lab',
                  blockingDependencies: [],
                }),
              );
            }
            if (r.plan_superseded || r.appointment_status === 'cancelled') {
              items.push(
                workItem({
                  workItemRef: workRef('lab_case_review', r.id),
                  kind: 'lab_case_review',
                  reasonCode: r.plan_superseded ? 'plan_link_superseded' : 'appointment_cancelled',
                  explanation: r.plan_superseded
                    ? 'The plan version this lab case serves was superseded; the link was kept for review.'
                    : 'The appointment this lab case serves was cancelled; the link was kept for review.',
                  evidenceRefs: [
                    ...evidence,
                    ...(r.appointment_id ? [{ kind: 'appointment', ref: r.appointment_id }] : []),
                  ],
                  owner: { queue: 'clinical', principalRef: null },
                  dueAt: null,
                  suggestedNextAction: 'review_lab_case',
                  blockingDependencies: [],
                }),
              );
            }
          }
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: LAB_CASE_RESOURCE,
            resourceRefs: items.flatMap((i) => i.evidenceRefs.map((e) => e.ref)).slice(0, 100),
            queryFields: q.asOf === undefined ? [] : ['asOf'],
          });
          return workList(new Date(asOf), AVAILABLE, items);
        });
      });
    },
  };
}
