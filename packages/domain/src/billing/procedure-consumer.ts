import {
  type ActorContext,
  type ProcedureConsumeData,
  RefusalError,
  type TenantTransaction,
} from '@cuspatlas/contracts';
import { loadEncounter } from '../clinical/encounters';
import { loadRenderedProcedureEvent } from '../clinical/procedures';
import { recordCommand } from '../events/record-command';
import { assertRef, type BillingBase, conflict, isPgError, loadSettings, mergeSet, notFound } from './base';
import { CHARGE_RESOURCE } from './charges';
import { bumpAggregates, lockAggregates } from './entries';
import { resolvePracticeFee } from './fees';
import { loadLines, negatedLines, postEntry, SignViolation } from './journal';

/** A refusal the worker retries later (an ordering or configuration gap, never a fault). */
const later = (reason: string) => new RefusalError({ code: 'conflict', retryable: true, detail: { reason } });

interface ChargeRow extends Record<string, unknown> {
  id: string;
  entry_id: string;
  reversal_id: string | null;
}

async function chargeOfProcedure(tx: TenantTransaction, procedureRef: string): Promise<ChargeRow | null> {
  const { rows } = await tx.query<ChargeRow>(
    `SELECT c.id, e.id AS entry_id,
       (SELECT r.id FROM cuspatlas.billing_journal_entries r WHERE r.reverses_entry_id = e.id) AS reversal_id
     FROM cuspatlas.billing_charges c
     JOIN cuspatlas.billing_journal_entries e ON e.charge_id = c.id AND e.tenant_id = c.tenant_id
       AND e.kind = 'charge' AND e.reverses_entry_id IS NULL
     WHERE c.procedure_ref = $1 AND c.source = 'clinical_procedure'`,
    [procedureRef],
  );
  return rows[0] ?? null;
}

/**
 * The C14 -> B consumer (docs/execution/foundation-contract-decisions.md, C14 -> B boundary). The
 * worker calls it for every `clinicalRenderedProcedure` outbox event with its own service principal;
 * the domain authorizes that principal freshly (`billing.write`). Idempotent per (procedureRef,
 * event version): the consumption row is inserted first, so a duplicate delivery or a concurrent
 * retry waits on its key and answers the committed charge; it never posts twice.
 *
 * - `procedure.rendered.v1`: one charge priced by the practice fee schedule effective on the date of
 *   service at the encounter's location; the charge records that schedule version. A replacement
 *   (`replacesProcedureRef`) needs the replaced procedure's charge reversed first and names it.
 * - `procedure.reversed.v1`: the exact reversal of the reversed procedure's charge entry.
 * No fee configured, or an event that arrives before the one it depends on: a retryable refusal
 * (the worker retries with backoff, then dead-letters for review). Never a guessed amount.
 */
export function createProcedureConsumer(base: BillingBase) {
  const { deps } = base;
  return {
    consumeRenderedProcedure(ctx: ActorContext, procedureRef: string): Promise<ProcedureConsumeData> {
      const op = 'billing.procedures.consume';
      return base.guarded(ctx, op, async () => {
        const decision = await deps.authorize(ctx, op, { tenantId: ctx.tenantId, id: 'billing' });
        assertRef(procedureRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const ev = await loadRenderedProcedureEvent(tx, procedureRef);
          if (ev === null) throw notFound();
          const existing = async (): Promise<ProcedureConsumeData | null> => {
            const { rows } = await tx.query<{ charge_id: string; entry_id: string }>(
              `SELECT p.charge_id,
                 (SELECT e.id FROM cuspatlas.billing_journal_entries e WHERE e.charge_id = p.charge_id
                    AND e.kind = 'charge' AND (CASE WHEN p.event_type = 'procedure.reversed.v1'
                      THEN e.reverses_entry_id IS NOT NULL ELSE e.reverses_entry_id IS NULL END)) AS entry_id
               FROM cuspatlas.billing_procedure_events p WHERE p.procedure_id = $1 AND p.event_version = $2`,
              [ev.procedureRef, ev.version],
            );
            const r = rows[0];
            return r
              ? {
                  procedureRef: ev.procedureRef,
                  eventType: ev.eventType,
                  chargeRef: r.charge_id,
                  entryRef: r.entry_id,
                  replayed: true,
                }
              : null;
          };
          const prior = await existing();
          if (prior) return prior;
          // The key: a concurrent consumer of the same event version waits here, then finds it done.
          const claim = async (chargeId: string) => {
            const { rows } = await tx.query<{ procedure_id: string }>(
              `INSERT INTO cuspatlas.billing_procedure_events (tenant_id, procedure_id, event_version, event_type,
                 charge_id, consumed_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id())
               ON CONFLICT DO NOTHING RETURNING procedure_id`,
              [ev.procedureRef, ev.version, ev.eventType, chargeId],
            );
            return rows.length > 0;
          };
          const root = (await mergeSet(tx, ev.patientRef)).root;
          if (ev.eventType === 'procedure.reversed.v1') {
            const found = await chargeOfProcedure(tx, ev.reversesProcedureRef as string);
            if (!found) throw later('original_charge_not_posted');
            if (!(await claim(found.id))) return (await existing()) as ProcedureConsumeData;
            await lockAggregates(tx, { payments: [], charges: [found.id] });
            // Re-read under the charge lock (review SHOULD): a concurrent reversal is seen here.
            const original = (await chargeOfProcedure(tx, ev.reversesProcedureRef as string)) ?? found;
            if (original.reversal_id !== null) throw conflict('already_reversed');
            const settings = await loadSettings(tx);
            try {
              const entryRef = await postEntry(tx, {
                kind: 'charge',
                currency: settings.currency,
                chargeId: original.id,
                reversesEntryId: original.entry_id,
                reasonCode: 'procedure_reversed',
                serviceDate: ev.dateOfService,
                lines: negatedLines(await loadLines(tx, [original.entry_id]), settings.currency),
              });
              const version =
                (await bumpAggregates(tx, { payments: [], charges: [original.id] })).get(original.id) ?? 1;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: CHARGE_RESOURCE,
                  resourceRef: original.id,
                  resourceVersion: version,
                },
                { changedFields: ['reversal'] },
              );
              return {
                procedureRef: ev.procedureRef,
                eventType: ev.eventType,
                chargeRef: original.id,
                entryRef,
                replayed: false,
              };
            } catch (err) {
              // Money already allocated to the charge must be moved by a human first.
              if (err instanceof SignViolation) throw conflict('allocation_reversal_required');
              if (isPgError(err, '23505')) throw conflict('already_reversed');
              throw err;
            }
          }
          let replaces: ChargeRow | null = null;
          if (ev.replacesProcedureRef !== null) {
            replaces = await chargeOfProcedure(tx, ev.replacesProcedureRef);
            if (!replaces || replaces.reversal_id === null) throw later('replaced_charge_not_reversed');
          }
          // The encounter's location, read through C's own loader (B names no clinical table).
          const locationId = (await loadEncounter(tx, decision, ev.encounterRef)).location_id;
          const fee = await resolvePracticeFee(tx, ev.codeRef, ev.dateOfService, locationId);
          if (fee === null) throw later('fee_not_configured');
          if (fee.fee.minor <= 0) throw later('fee_not_configured');
          const { rows: idr } = await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id');
          const chargeId = idr[0]?.id as string;
          if (!(await claim(chargeId))) return (await existing()) as ProcedureConsumeData;
          await tx.query(
            `INSERT INTO cuspatlas.billing_charges (id, tenant_id, patient_id, source, procedure_ref, procedure_code,
               service_date, amount_minor, currency, replaces_charge_id, fee_schedule_version_id, location_id, created_by)
             VALUES ($1, cuspatlas.current_tenant_id(), $2, 'clinical_procedure', $3, $4, $5::date, $6, $7, $8, $9, $10,
               cuspatlas.current_actor_id())`,
            [
              chargeId,
              root,
              ev.procedureRef,
              ev.codeRef,
              ev.dateOfService,
              String(fee.fee.minor),
              fee.fee.currency,
              replaces?.id ?? null,
              fee.versionRef,
              locationId,
            ],
          );
          const entryRef = await postEntry(tx, {
            kind: 'charge',
            currency: fee.fee.currency,
            chargeId,
            serviceDate: ev.dateOfService,
            lines: [
              { account: 'patient_receivable', amount: fee.fee, patientId: root, chargeId },
              {
                account: 'production_revenue',
                amount: { currency: fee.fee.currency, minor: -fee.fee.minor },
                patientId: root,
                chargeId,
              },
            ],
          });
          await recordCommand(
            tx,
            { operation: op, resourceType: CHARGE_RESOURCE, resourceRef: chargeId, resourceVersion: 1 },
            { changedFields: ['charge'] },
          );
          return {
            procedureRef: ev.procedureRef,
            eventType: ev.eventType,
            chargeRef: chargeId,
            entryRef,
            replayed: false,
          };
        });
      });
    },
  };
}
