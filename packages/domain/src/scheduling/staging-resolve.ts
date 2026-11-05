import type { TenantTransaction } from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';

/** Same resource name as `STAGING_ENTRY_RESOURCE` in staging.ts (kept here to avoid an import cycle). */
const STAGING_ENTRY = 'schedulingStagingEntry';

/**
 * R4 (hardening H1): an S10 cancel or reschedule of a staged appointment resolves its staging entry in
 * the same transaction (`removed` with `appointment_cancelled`, or `moved`), so the entry never points
 * at a dead booking and its capacity is free at once. A staging move has already resolved its own
 * entry inside the reschedule guard, so it finds nothing left to resolve here.
 */
export async function resolveStagedAppointment(
  tx: TenantTransaction,
  operation: string,
  appointmentId: string,
  outcome: 'moved' | 'removed',
): Promise<void> {
  const { rows } = await tx.query<{ id: string; version: number }>(
    outcome === 'removed'
      ? `UPDATE cuspatlas.scheduling_staging_entries SET state = 'removed', removal_reason = 'appointment_cancelled',
           resolved_at = now(), version = version + 1, updated_at = now()
         WHERE appointment_id = $1 AND state = 'staged' RETURNING id, version`
      : `UPDATE cuspatlas.scheduling_staging_entries SET state = 'moved', resolved_at = now(),
           version = version + 1, updated_at = now()
         WHERE appointment_id = $1 AND state = 'staged' RETURNING id, version`,
    [appointmentId],
  );
  for (const r of rows) {
    await recordCommand(
      tx,
      { operation, resourceType: STAGING_ENTRY, resourceRef: r.id, resourceVersion: r.version },
      { changedFields: ['state'] },
    );
  }
}
