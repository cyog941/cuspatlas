import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  SCHEDULING_PROPERTIES,
  type TenantTransaction,
  type VisitContextData,
  type VisitContextEntry,
  type VisitContextItemRecord,
  type VisitContextSlot,
  type VisitFormAssign,
  type VisitFormUnassign,
  type VisitItemCommandData,
  type VisitItemKind,
  type VisitLabLink,
  type VisitLabRelink,
  type VisitProducerKey,
  type VisitProducerOwner,
  validateSchedulingEntityRef,
  validateVisitContextPin,
  validateVisitFormAssign,
  validateVisitFormUnassign,
  validateVisitLabLink,
  validateVisitLabRelink,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import type { AuthorizationDecision } from '../policy/authorize';
import type { AppointmentBase } from './appointment-base';
import { attendanceStateOf } from './attendance';
import { type AppointmentRow, loadAppointment } from './booking';
import { checkEnvelope, notFound } from './resources';

export const VISIT_ITEM_RESOURCE = 'visitContextItem';

/**
 * A record held by a clinical producer, as the producer reports it. Scheduling never stores or
 * returns its content: only the reference, version and provenance reference.
 */
export interface VisitProducerRecord {
  readonly ref: string;
  readonly version: number;
  readonly provenanceRef: string;
  readonly status: 'resolved' | 'voided';
  /** The record's current patient (required): a record of another patient is refused. */
  readonly patientRef: string;
}

/**
 * Port to a clinical producer (C8, C10, C11, C13, C16). Each call runs inside the visit-context
 * transaction under the caller's tenant context, so a producer can only answer for its own tenant;
 * another tenant's record is `null` (indistinguishable from missing).
 */
export interface VisitContextProducer {
  /**
   * The producer's own policy for this caller (for example clinical.read). False: the slot is reported
   * unavailable on read and a command is refused 403; the producer is not asked for any record.
   */
  available?(tx: TenantTransaction): Promise<boolean>;
  resolve(tx: TenantTransaction, ref: string): Promise<VisitProducerRecord | null>;
  /** The current record for a patient (medical history): what a pin captures. */
  current?(tx: TenantTransaction, patientRef: string): Promise<VisitProducerRecord | null>;
  /** Records the producer itself associates with the visit (note drafts, treatment-plan items). */
  listFor?(tx: TenantTransaction, appointmentRef: string, patientRef: string): Promise<VisitProducerRecord[]>;
}

/** Deployed producers by item. None exists in this foundation: every item is `unavailable`. */
export type VisitContextProducers = Partial<Record<VisitProducerKey, VisitContextProducer>>;

export const VISIT_PRODUCER_OWNERS: Readonly<Record<VisitProducerKey, VisitProducerOwner>> = {
  medicalHistory: 'C8',
  forms: 'C13',
  noteDrafts: 'C10',
  labCases: 'C16',
  treatmentPlanItems: 'C11',
};
const PRODUCER_KEYS: readonly VisitProducerKey[] = [
  'medicalHistory',
  'forms',
  'noteDrafts',
  'labCases',
  'treatmentPlanItems',
];
const KIND_OF: Readonly<Record<VisitItemKind, { key: VisitProducerKey; producer: 'C8' | 'C13' | 'C16' }>> = {
  medical_history_pin: { key: 'medicalHistory', producer: 'C8' },
  form_assignment: { key: 'forms', producer: 'C13' },
  lab_case_link: { key: 'labCases', producer: 'C16' },
};

const refused = (reason: string, blockingRefs?: { kind: string; ref: string }[]) =>
  new RefusalError({
    code: 'conflict',
    reasonCode: 'booking_refused',
    detail: { reason, ...(blockingRefs ? { blockingRefs } : {}) },
  });

interface ItemRow extends Record<string, unknown> {
  id: string;
  appointment_id: string;
  item_kind: VisitItemKind;
  producer: 'C8' | 'C13' | 'C16';
  item_ref: string;
  item_version: number | null;
  provenance_ref: string | null;
  state: 'active' | 'ended';
  end_kind: 'unassigned' | 'relinked' | null;
  end_reason: string | null;
  relinked_to_id: string | null;
  relinked_from_id: string | null;
  version: number;
  actor_id: string;
  created_at: Date;
  ended_at: Date | null;
}

const ITEM_COLUMNS = `id, appointment_id, item_kind, producer, item_ref, item_version, provenance_ref, state, end_kind,
  end_reason, relinked_to_id, relinked_from_id, version, actor_id, created_at, ended_at`;

const commandData = (r: ItemRow, created: boolean): VisitItemCommandData => ({
  itemRef: r.id,
  appointmentRef: r.appointment_id,
  itemKind: r.item_kind,
  producerRef: r.item_ref,
  itemVersion: r.item_version,
  state: r.state,
  endKind: r.end_kind,
  created,
});

const toRecord = (r: ItemRow): VisitContextItemRecord => ({
  itemRef: r.id,
  itemKind: r.item_kind,
  producer: r.producer,
  producerRef: r.item_ref,
  itemVersion: r.item_version,
  provenanceRef: r.provenance_ref,
  state: r.state,
  endKind: r.end_kind,
  endReason: r.end_reason,
  relinkedFrom: r.relinked_from_id,
  relinkedTo: r.relinked_to_id,
  actorRef: r.actor_id,
  createdAt: r.created_at.toISOString(),
  endedAt: r.ended_at === null ? null : r.ended_at.toISOString(),
  version: r.version,
});

async function items(tx: TenantTransaction, appointmentId: string): Promise<ItemRow[]> {
  const { rows } = await tx.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM cuspatlas.visit_context_items WHERE appointment_id = $1
     ORDER BY created_at, id LIMIT 200`,
    [appointmentId],
  );
  return rows;
}

async function insertItem(
  tx: TenantTransaction,
  operation: string,
  o: {
    id?: string;
    appointmentId: string;
    kind: VisitItemKind;
    rec: VisitProducerRecord;
    pinVersion: boolean;
    relinkedFrom: string | null;
  },
): Promise<ItemRow> {
  const { rows } = await tx.query<ItemRow>(
    `INSERT INTO cuspatlas.visit_context_items (id, tenant_id, appointment_id, item_kind, producer, item_ref,
       item_version, provenance_ref, relinked_from_id, actor_id)
     VALUES (coalesce($1::uuid, gen_random_uuid()), cuspatlas.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8,
       cuspatlas.current_actor_id())
     RETURNING ${ITEM_COLUMNS}`,
    [
      o.id ?? null,
      o.appointmentId,
      o.kind,
      KIND_OF[o.kind].producer,
      o.rec.ref,
      o.pinVersion ? o.rec.version : null,
      o.rec.provenanceRef,
      o.relinkedFrom,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('insert returned no row');
  await recordCommand(
    tx,
    { operation, resourceType: VISIT_ITEM_RESOURCE, resourceRef: row.id, resourceVersion: 1 },
    { changedFields: ['itemKind', 'producerRef', ...(o.relinkedFrom ? ['relinkedFrom'] : [])] },
  );
  return row;
}

async function endItem(
  tx: TenantTransaction,
  operation: string,
  row: ItemRow,
  endKind: 'unassigned' | 'relinked',
  reason: string,
  relinkedTo: string | null,
): Promise<ItemRow> {
  const { rows } = await tx.query<ItemRow>(
    `UPDATE cuspatlas.visit_context_items SET state = 'ended', end_kind = $1, end_reason = $2, relinked_to_id = $3,
       ended_by = cuspatlas.current_actor_id(), ended_at = now(), version = version + 1, updated_at = now()
     WHERE id = $4 AND version = $5 RETURNING ${ITEM_COLUMNS}`,
    [endKind, reason, relinkedTo, row.id, row.version],
  );
  const ended = rows[0];
  if (!ended) throw new RefusalError({ code: 'stale_version' });
  await recordCommand(
    tx,
    { operation, resourceType: VISIT_ITEM_RESOURCE, resourceRef: ended.id, resourceVersion: ended.version },
    { changedFields: ['state', ...(relinkedTo ? ['relinkedTo'] : [])] },
  );
  return ended;
}

/** S12: the visit context container and its reference commands. */
export function createVisitContextOperations(base: AppointmentBase) {
  const { deps, execute } = base;
  const producers: VisitContextProducers = deps.visitContextProducers ?? {};

  /** The producer of an item, or the typed refusal that names its absence (no write is attempted). */
  const producerFor = (key: VisitProducerKey): VisitContextProducer => {
    const p = producers[key];
    if (!p) throw refused('producer_unavailable');
    return p;
  };
  const resolveOrHide = async (
    tx: TenantTransaction,
    p: VisitContextProducer,
    ref: string,
    appt: AppointmentRow,
  ) => {
    if (!validateSchedulingEntityRef(ref)) throw notFound();
    const rec = await p.resolve(tx, ref);
    if (rec === null) throw notFound();
    if (rec.patientRef !== appt.subject_patient_id) throw refused('producer_record_other_patient');
    if (rec.status === 'voided') throw refused('producer_record_voided');
    return rec;
  };
  const assertOpen = (appt: AppointmentRow) => {
    if (appt.status !== 'booked') throw refused('appointment_not_open');
  };

  /**
   * Shared command shape: authorize, envelope, schema, producer present (configuration, checked
   * before the executor so a later deployment is not answered from a stored refusal), then the
   * appointment row lock and the idempotent handler.
   */
  function command<P>(
    ctx: ActorContext,
    op: Parameters<AppointmentBase['authorize']>[1],
    appointmentRef: string,
    envelope: CommandEnvelope<unknown>,
    validate: Parameters<typeof assertValid>[0],
    key: VisitProducerKey,
    work: (
      tx: TenantTransaction,
      appt: AppointmentRow,
      p: P,
      producer: VisitContextProducer,
      decision: AuthorizationDecision,
    ) => Promise<{
      data: VisitItemCommandData;
      version: number;
    }>,
    payloadExtra: Record<string, unknown> = {},
  ): Promise<CommandResult<VisitItemCommandData>> {
    return base.recorded(ctx, op, async () => {
      const decision = await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload as P;
      assertValid<P>(validate, p, SCHEDULING_PROPERTIES);
      return deps.withTenantTransaction(ctx, async (tx) => {
        const appt = await loadAppointment(tx, decision, appointmentRef, 'FOR UPDATE OF a');
        const producer = producerFor(key);
        if (producer.available && !(await producer.available(tx))) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'scope_missing' });
        }
        return execute<VisitItemCommandData>(
          ctx,
          { ...envelope, payload: { appointmentRef, ...payloadExtra, ...(p as object) } },
          tx,
          () => work(tx, appt, p, producer, decision),
        );
      });
    });
  }

  async function slot(
    tx: TenantTransaction,
    key: VisitProducerKey,
    rows: readonly ItemRow[],
    appt: AppointmentRow,
  ): Promise<VisitContextSlot> {
    const owner = VISIT_PRODUCER_OWNERS[key];
    const p = producers[key];
    if (!p) return { status: 'unavailable', owner, reason: 'producer_not_deployed' };
    if (p.available && !(await p.available(tx)))
      return { status: 'unavailable', owner, reason: 'producer_access_denied' };
    const entries: VisitContextEntry[] = [];
    for (const r of rows) {
      if (KIND_OF[r.item_kind].key !== key) continue;
      // Ended assignments stay in the item history, not in the current context.
      if (r.state !== 'active') continue;
      const rec = await p.resolve(tx, r.item_ref);
      entries.push({
        itemRef: r.id,
        producerRef: r.item_ref,
        version: r.item_version,
        currentVersion: rec?.version ?? null,
        provenanceRef: r.provenance_ref,
        resolution: rec === null ? 'not_found' : rec.status,
        state: r.state,
      });
    }
    if (p.listFor) {
      for (const rec of await p.listFor(tx, appt.id, appt.subject_patient_id)) {
        entries.push({
          itemRef: null,
          producerRef: rec.ref,
          version: rec.version,
          currentVersion: rec.version,
          provenanceRef: rec.provenanceRef,
          resolution: rec.status,
          state: 'active',
        });
      }
    }
    return { status: 'available', owner, entries };
  }

  return {
    getVisitContext(ctx: ActorContext, appointmentRef: string): Promise<VisitContextData> {
      const op = 'scheduling.visitContext.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const appt = await loadAppointment(tx, decision, appointmentRef);
          const rows = await items(tx, appt.id);
          const state = await attendanceStateOf(tx, appt.id);
          const now = await tx.query<{ at: Date }>('SELECT now() AS at');
          const slots = {} as Record<VisitProducerKey, VisitContextSlot>;
          for (const key of PRODUCER_KEYS) slots[key] = await slot(tx, key, rows, appt);
          const unavailable = PRODUCER_KEYS.filter((k) => slots[k].status === 'unavailable');
          let resolved = 0;
          let unresolved = 0;
          for (const k of PRODUCER_KEYS) {
            const s = slots[k];
            if (s.status !== 'available') continue;
            for (const e of s.entries) {
              if (e.resolution === 'resolved') resolved += 1;
              else unresolved += 1;
            }
          }
          return {
            appointmentRef: appt.id,
            asOf: (now.rows[0]?.at ?? new Date()).toISOString(),
            appointment: {
              status: appt.status,
              version: appt.version,
              startsAt: appt.starts_at.toISOString(),
              locationRef: appt.location_ref,
              acceptsChanges: appt.status === 'booked',
            },
            patient: { status: 'resolved', patientRef: appt.subject_patient_id },
            attendance: { status: 'resolved', state },
            items: slots,
            readiness: { resolved, unavailable, complete: unavailable.length === 0 && unresolved === 0 },
          };
        });
      });
    },

    listVisitContextItems(ctx: ActorContext, appointmentRef: string): Promise<VisitContextItemRecord[]> {
      const op = 'scheduling.visitContext.items';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const appt = await loadAppointment(tx, decision, appointmentRef);
          return (await items(tx, appt.id)).map(toRecord);
        });
      });
    },

    pinMedicalHistorySnapshot(ctx: ActorContext, appointmentRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.visitContext.pinMedicalHistory';
      return command<Record<string, never>>(
        ctx,
        op,
        appointmentRef,
        envelope,
        validateVisitContextPin,
        'medicalHistory',
        async (tx, appt, _p, producer) => {
          assertOpen(appt);
          const existing = (await items(tx, appt.id)).find((r) => r.item_kind === 'medical_history_pin');
          if (existing) throw refused('already_pinned', [{ kind: 'visitContextItem', ref: existing.id }]);
          const rec = producer.current ? await producer.current(tx, appt.subject_patient_id) : null;
          if (rec === null) throw refused('producer_record_missing');
          if (rec.status === 'voided') throw refused('producer_record_voided');
          const row = await insertItem(tx, op, {
            appointmentId: appt.id,
            kind: 'medical_history_pin',
            rec,
            pinVersion: true,
            relinkedFrom: null,
          });
          return { data: commandData(row, true), version: 1 };
        },
      );
    },

    assignForm(ctx: ActorContext, appointmentRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.visitContext.assignForm';
      return command<VisitFormAssign>(
        ctx,
        op,
        appointmentRef,
        envelope,
        validateVisitFormAssign,
        'forms',
        async (tx, appt, p, producer) => {
          assertOpen(appt);
          // Idempotent per form and appointment: the recorded assignment is returned once.
          const existing = (await items(tx, appt.id)).find(
            (r) => r.item_kind === 'form_assignment' && r.item_ref === p.formRef && r.state === 'active',
          );
          if (existing) return { data: commandData(existing, false), version: existing.version };
          const rec = await resolveOrHide(tx, producer, p.formRef, appt);
          const row = await insertItem(tx, op, {
            appointmentId: appt.id,
            kind: 'form_assignment',
            rec,
            pinVersion: false,
            relinkedFrom: null,
          });
          return { data: commandData(row, true), version: 1 };
        },
      );
    },

    unassignForm(
      ctx: ActorContext,
      appointmentRef: string,
      itemRef: string,
      envelope: CommandEnvelope<unknown>,
    ) {
      const op = 'scheduling.visitContext.unassignForm';
      return command<VisitFormUnassign>(
        ctx,
        op,
        appointmentRef,
        envelope,
        validateVisitFormUnassign,
        'forms',
        async (tx, appt, p) => {
          if (!validateSchedulingEntityRef(itemRef)) throw notFound();
          const row = (await items(tx, appt.id)).find(
            (r) => r.id === itemRef && r.item_kind === 'form_assignment',
          );
          if (!row) throw notFound();
          if (row.version !== p.expectedVersion) {
            throw new RefusalError({ code: 'stale_version', detail: { currentVersion: row.version } });
          }
          if (row.state !== 'active') throw refused('item_not_active');
          const ended = await endItem(tx, op, row, 'unassigned', p.reasonCode, null);
          return { data: commandData(ended, false), version: ended.version };
        },
        { itemRef },
      );
    },

    linkLabCase(ctx: ActorContext, appointmentRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.visitContext.linkLabCase';
      return command<VisitLabLink>(
        ctx,
        op,
        appointmentRef,
        envelope,
        validateVisitLabLink,
        'labCases',
        async (tx, appt, p, producer, decision) => {
          assertOpen(appt);
          const rec = await resolveOrHide(tx, producer, p.labCaseRef, appt);
          const bound = await boundLab(tx, p.labCaseRef);
          if (bound) {
            if (bound.appointment_id === appt.id)
              return { data: commandData(bound, false), version: bound.version };
            // The other appointment is named only when the caller's location policy may see it.
            const visible = await visibleAppointment(tx, decision, bound.appointment_id);
            throw refused(
              'lab_case_bound_elsewhere',
              visible ? [{ kind: 'appointment', ref: bound.appointment_id }] : undefined,
            );
          }
          const row = await insertItem(tx, op, {
            appointmentId: appt.id,
            kind: 'lab_case_link',
            rec,
            pinVersion: false,
            relinkedFrom: null,
          });
          return { data: commandData(row, true), version: 1 };
        },
      );
    },

    relinkLabCase(ctx: ActorContext, appointmentRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.visitContext.relinkLabCase';
      return command<VisitLabRelink>(
        ctx,
        op,
        appointmentRef,
        envelope,
        validateVisitLabRelink,
        'labCases',
        async (tx, appt, p, producer) => {
          assertOpen(appt);
          const rec = await resolveOrHide(tx, producer, p.labCaseRef, appt);
          const bound = await boundLab(tx, p.labCaseRef);
          if (!bound) throw refused('lab_case_not_bound');
          if (bound.appointment_id === appt.id) throw refused('lab_case_already_here');
          // Both references stay in history: the old binding ends naming the new one, which names it back.
          const newId = (await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]?.id;
          if (!newId) throw new Error('no id');
          await endItem(tx, op, bound, 'relinked', p.reasonCode, newId);
          const row = await insertItem(tx, op, {
            id: newId,
            appointmentId: appt.id,
            kind: 'lab_case_link',
            rec,
            pinVersion: false,
            relinkedFrom: bound.id,
          });
          return { data: commandData(row, true), version: 1 };
        },
      );
    },
  };
}

async function visibleAppointment(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  appointmentId: string,
): Promise<boolean> {
  try {
    await loadAppointment(tx, decision, appointmentId);
    return true;
  } catch (err) {
    if (err instanceof RefusalError && err.code === 'not_found') return false;
    throw err;
  }
}

/** The active binding of a lab case anywhere in the tenant, locked for the relink. */
async function boundLab(tx: TenantTransaction, labCaseRef: string): Promise<ItemRow | null> {
  const { rows } = await tx.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM cuspatlas.visit_context_items
     WHERE item_kind = 'lab_case_link' AND item_ref = $1 AND state = 'active' FOR UPDATE`,
    [labCaseRef],
  );
  return rows[0] ?? null;
}

export type VisitContextOperations = ReturnType<typeof createVisitContextOperations>;
