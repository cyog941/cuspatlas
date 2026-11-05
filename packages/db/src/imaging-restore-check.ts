/**
 * Restore drill check for bridge devices. A backup holds the device state of its own moment: a key
 * rotated after it comes back as the OLD active key (the rotated-away key is active again), and a
 * revocation made after it is lost. Given the live database (the reference) and the restored one, this
 * lists every device whose restored state is behind the reference. The runbook treats each listed
 * device as untrusted until revoked and paired again. With no reference available, treat every
 * restored device that way.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type StaleDeviceReason = 'rotated_after_backup' | 'revoked_after_backup' | 'key_mismatch';

export interface StaleRestoredDevice {
  readonly deviceRef: string;
  readonly reason: StaleDeviceReason;
  readonly restoredKeyVersion: number;
  readonly referenceKeyVersion: number;
}

interface DeviceState {
  state: string;
  keyVersion: number;
  activePublicKey: string | null;
}

async function devicesOf(db: Queryable): Promise<Map<string, DeviceState>> {
  const { rows } = await db.query(
    `SELECT d.id, d.state, d.key_version,
       (SELECT k.public_key FROM cuspatlas.imaging_device_keys k WHERE k.device_id = d.id AND k.state = 'active') AS pk
     FROM cuspatlas.imaging_devices d`,
  );
  return new Map(
    rows.map((r) => [
      String(r.id),
      {
        state: String(r.state),
        keyVersion: Number(r.key_version),
        activePublicKey: (r.pk as string) ?? null,
      },
    ]),
  );
}

export async function findStaleRestoredDevices(
  restored: Queryable,
  reference: Queryable,
): Promise<StaleRestoredDevice[]> {
  const [now, then] = [await devicesOf(reference), await devicesOf(restored)];
  const out: StaleRestoredDevice[] = [];
  for (const [deviceRef, ref] of now) {
    const got = then.get(deviceRef);
    if (!got) continue; // created after the backup: nothing was restored
    const base = { deviceRef, restoredKeyVersion: got.keyVersion, referenceKeyVersion: ref.keyVersion };
    if (got.state !== 'revoked' && ref.state === 'revoked')
      out.push({ ...base, reason: 'revoked_after_backup' });
    else if (got.keyVersion < ref.keyVersion) out.push({ ...base, reason: 'rotated_after_backup' });
    else if (got.state === 'active' && got.activePublicKey !== ref.activePublicKey)
      out.push({ ...base, reason: 'key_mismatch' });
  }
  return out.sort((a, b) => a.deviceRef.localeCompare(b.deviceRef));
}
