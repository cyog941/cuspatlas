import { RefusalError, type TenantTransaction } from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';

export const WAITLIST_ENTRY_RESOURCE = 'waitlistEntry';
export const WAITLIST_OFFER_RESOURCE = 'waitlistOffer';

/** Moves an offered entry back to active (after a decline, withdrawal or expiry). */
export async function reopenEntryIn(
  tx: TenantTransaction,
  operation: string,
  entryId: string,
): Promise<void> {
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.waitlist_entries SET state = 'active', version = version + 1, updated_at = now()
     WHERE id = $1 AND state = 'offered' RETURNING version`,
    [entryId],
  );
  const v = rows[0]?.version;
  if (v !== undefined) {
    await recordCommand(
      tx,
      { operation, resourceType: WAITLIST_ENTRY_RESOURCE, resourceRef: entryId, resourceVersion: v },
      { changedFields: ['state'] },
    );
  }
}

/**
 * S15 hook of the hold expiry path (S10 lazy release and holds reconcile): the live offer made on the
 * expired hold records the outcome `expired` and its entry is open again. No staff action, no booking.
 */
export async function expireOfferOfHold(tx: TenantTransaction, holdId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string; entry_id: string; version: number }>(
    `UPDATE cuspatlas.waitlist_offers SET outcome = 'expired', outcome_reason = 'hold_expired',
       decided_by = cuspatlas.current_actor_id(), decided_at = now(), version = version + 1, updated_at = now()
     WHERE hold_id = $1 AND outcome IS NULL RETURNING id, entry_id, version`,
    [holdId],
  );
  const o = rows[0];
  if (!o) return;
  await recordCommand(
    tx,
    {
      operation: 'scheduling.waitlist.expireOffer',
      resourceType: WAITLIST_OFFER_RESOURCE,
      resourceRef: o.id,
      resourceVersion: o.version,
    },
    { changedFields: ['outcome'] },
  );
  await reopenEntryIn(tx, 'scheduling.waitlist.expireOffer', o.entry_id);
}

/** A hold held by a live offer is converted or released only through the offer's response command. */
export async function assertHoldNotOffered(tx: TenantTransaction, holdId: string): Promise<void> {
  const { rows } = await tx.query(
    'SELECT 1 FROM cuspatlas.waitlist_offers WHERE hold_id = $1 AND outcome IS NULL',
    [holdId],
  );
  if (rows.length > 0) {
    throw new RefusalError({
      code: 'conflict',
      reasonCode: 'booking_refused',
      detail: { reason: 'hold_belongs_to_offer' },
    });
  }
}
