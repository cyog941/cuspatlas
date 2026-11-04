import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  ENGAGEMENT_PROPERTIES,
  type TenantTransaction,
  validateRecallEnroll,
  validateRecallEnrollmentsQuery,
} from '@cuspatlas/contracts';
import { executeOnce } from '../../commands/execute-once';
import { recordCommand } from '../../events/record-command';
import { recallDueFor } from '../../scheduling/recall';
import { checkEnvelope, type EngagementBase } from '../common';

/**
 * E6 recall enrollment. The cohort is exactly S16's due list for the category's current policy (the
 * same computation `scheduling.recall.due` returns, consumed through `recallDueFor`); E never
 * re-derives recall policy. A patient S16 excludes is skipped with `recall_not_due` and S16's own
 * exclusion reason; a patient without a qualifying event is skipped with `no_baseline`. Enrollment is
 * one row per S16 due item (patient, policy, qualifying event), so a repeated run or a duplicate
 * completion never enrolls twice. Enrollment sends nothing: outreach is a later S16 recall task whose
 * S14 intent E6 decides and E7 delivers.
 */
export function createRecallEnrollmentOperations(base: EngagementBase) {
  const { deps } = base;
  const execute = deps.execute ?? executeOnce;
  return {
    enrollRecallCohort(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'communications.recall.enroll';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateRecallEnroll, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { category: string; asOf: string; patientRefs: string[] };
        // Patient status (deceased, inactive) is a patient-record fact: the S16 exclusion reason is
        // disclosed only to a caller holding patients.read; others see `not_disclosed`.
        const canReadPatients = await base.can(ctx, 'patients.read');
        // A completed-procedure policy (S16 basis over C14 facts) is a clinical read, as in S16.
        const clinical = {
          canReadClinical: await base.can(ctx, 'clinical.procedures.list'),
          ...(deps.completedProcedures ? { procedures: deps.completedProcedures } : {}),
        };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const due = await recallDueFor(
            tx,
            decision.locationRefs,
            p.category,
            Date.parse(p.asOf),
            true,
            clinical,
          );
          return execute(ctx, envelope, tx, async () => {
            const dueBy = new Map(due.due.map((d) => [d.patientRef, d]));
            const excluded = new Map(
              due.excluded.map((x) => [
                x.patientRef,
                canReadPatients || x.reason === 'already_booked' ? x.reason : 'not_disclosed',
              ]),
            );
            let enrolled = 0;
            const skipped: { ref: string; reason: 'recall_not_due'; exclusion: string }[] = [];
            const alreadyEnrolled: string[] = [];
            for (const ref of [...new Set(p.patientRefs)]) {
              const item = dueBy.get(ref);
              if (!item) {
                skipped.push({
                  ref,
                  reason: 'recall_not_due',
                  exclusion: excluded.get(ref) ?? (canReadPatients ? 'no_baseline' : 'not_disclosed'),
                });
                continue;
              }
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.recall_enrollments (tenant_id, patient_id, recall_policy_id, policy_version,
                   last_event_id, due_date, enrolled_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5::date, cuspatlas.current_actor_id())
                 ON CONFLICT (tenant_id, patient_id, recall_policy_id, last_event_id) DO NOTHING RETURNING id`,
                [ref, due.policy.policyRef, due.policy.version, item.lastEventRef, item.dueDate],
              );
              const id = rows[0]?.id;
              if (!id) {
                alreadyEnrolled.push(ref);
                continue;
              }
              enrolled += 1;
              await recordCommand(
                tx,
                { operation: op, resourceType: 'recallEnrollment', resourceRef: id, resourceVersion: 1 },
                { changedFields: ['patient', 'policy', 'dueDate'] },
              );
            }
            return {
              data: {
                category: due.policy.category,
                policyVersion: due.policy.version,
                enrolled,
                skipped,
                alreadyEnrolled,
              },
              version: 1,
            };
          });
        });
      });
    },

    listRecallEnrollments(ctx: ActorContext, query: unknown) {
      const op = 'communications.recall.enrollments';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid(validateRecallEnrollmentsQuery, query, ENGAGEMENT_PROPERTIES);
        const q = query as { category: string };
        const clinical = {
          canReadClinical: await base.can(ctx, 'clinical.procedures.list'),
          ...(deps.completedProcedures ? { procedures: deps.completedProcedures } : {}),
        };
        return deps.withTenantTransaction(ctx, async (tx: TenantTransaction) => {
          // The category must exist in this tenant (another tenant's category is indistinguishable).
          await recallDueFor(tx, decision.locationRefs, q.category, Date.now(), false, clinical);
          // The qualifying event is an attended appointment or (completed_procedure basis) a C14
          // rendered procedure, whose location is its encounter's.
          const { rows } = await tx.query<{
            id: string;
            patient_id: string;
            policy_version: number;
            due_date: string;
            last_event_id: string;
            created_at: Date;
          }>(
            `SELECT e.id, e.patient_id, e.policy_version, to_char(e.due_date, 'YYYY-MM-DD') AS due_date, e.last_event_id,
               e.created_at
             FROM cuspatlas.recall_enrollments e JOIN cuspatlas.recall_policies p ON p.id = e.recall_policy_id
             LEFT JOIN cuspatlas.appointments a ON a.id = e.last_event_id AND a.tenant_id = e.tenant_id
             LEFT JOIN cuspatlas.clinical_rendered_procedures rp ON rp.id = e.last_event_id AND rp.tenant_id = e.tenant_id
             LEFT JOIN cuspatlas.clinical_encounters ce ON ce.id = rp.encounter_id AND ce.tenant_id = rp.tenant_id
             JOIN cuspatlas.scheduling_locations l ON l.id = COALESCE(a.location_id, ce.location_id) AND l.tenant_id = e.tenant_id
             WHERE p.category = $1 AND ($2::text[] IS NULL OR l.location_ref = ANY ($2::text[]))
             ORDER BY e.created_at, e.id LIMIT 500`,
            [q.category, decision.locationRefs],
          );
          return rows.map((r) => ({
            enrollmentRef: r.id,
            patientRef: r.patient_id,
            policyVersion: r.policy_version,
            dueDate: r.due_date,
            lastEventRef: r.last_event_id,
            enrolledAt: r.created_at.toISOString(),
          }));
        });
      });
    },
  };
}
