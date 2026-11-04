import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * I9 restore drill: a storage-layer backup of the synthetic local object store (I-D1 picks the managed
 * backend; its own backup replaces this). It copies the content-addressed bytes (`t/`) and the
 * tombstone markers (`tombstones/`) with a manifest of every file's SHA-256, never staging or
 * quarantine. Restore verifies every file against the manifest (and every content file against the
 * digest its key names) before writing, refuses any key outside the two areas, and carries the live
 * store's tombstones forward (the runbook rule: tombstones outlive the oldest restorable backup), so a
 * deletion made after the backup can never resurrect an image as available.
 */
export const OBJECT_STORE_BACKUP_FORMAT = 'cuspatlas-object-store-backup/1';
const KEY =
  /^(t\/[0-9a-f-]{36}\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}|tombstones\/[0-9a-f-]{36}\/[0-9a-f-]{36})$/;

export interface ObjectStoreBackupManifest {
  readonly format: typeof OBJECT_STORE_BACKUP_FORMAT;
  readonly createdAt: string;
  readonly files: readonly { readonly key: string; readonly sha256: string; readonly byteLength: number }[];
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function walk(root: string, area: string): Promise<string[]> {
  const out: string[] = [];
  async function go(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await go(abs);
      else if (e.isFile() && !e.name.endsWith('.partial')) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  await go(join(root, area));
  return out.sort();
}

function inside(root: string, key: string): string {
  if (!KEY.test(key)) throw new Error('Object store backup key outside the backed-up areas');
  const abs = resolve(root, ...key.split('/'));
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Object store backup key escapes its root');
  return abs;
}

/** Copies content and tombstones of `storeRoot` into `outDir` with a verified manifest. */
export async function backupObjectStore(
  storeRoot: string,
  outDir: string,
): Promise<ObjectStoreBackupManifest> {
  const keys = [...(await walk(storeRoot, 't')), ...(await walk(storeRoot, 'tombstones'))];
  const files: { key: string; sha256: string; byteLength: number }[] = [];
  for (const key of keys) {
    const src = inside(storeRoot, key);
    const bytes = await readFile(src);
    const digest = sha256(bytes);
    // A content file whose bytes do not match its name is not backed up as good data.
    if (key.startsWith('t/') && !key.endsWith(digest))
      throw new Error('Object store content does not match its key');
    const dst = inside(join(outDir, 'objects'), key);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    files.push({ key, sha256: digest, byteLength: bytes.byteLength });
  }
  const manifest: ObjectStoreBackupManifest = {
    format: OBJECT_STORE_BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    files,
  };
  await writeFile(join(outDir, 'object-store-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Restores a verified object-store backup into an empty `targetRoot`, then carries forward the
 * tombstones of `tombstonesFrom` (the live store) that the backup lacks. Returns what was written.
 */
export async function restoreObjectStore(
  backupDir: string,
  targetRoot: string,
  opts: { tombstonesFrom?: string } = {},
): Promise<{ files: number; carriedTombstones: number }> {
  const manifest = JSON.parse(
    await readFile(join(backupDir, 'object-store-manifest.json'), 'utf8'),
  ) as ObjectStoreBackupManifest;
  if (manifest.format !== OBJECT_STORE_BACKUP_FORMAT)
    throw new Error('Unsupported object store backup format');
  // Verify everything before writing anything.
  const verified: { key: string; bytes: Buffer }[] = [];
  for (const f of manifest.files) {
    const bytes = await readFile(inside(join(backupDir, 'objects'), f.key));
    if (sha256(bytes) !== f.sha256 || bytes.byteLength !== f.byteLength)
      throw new Error('Object store backup file does not match its manifest');
    if (f.key.startsWith('t/') && !f.key.endsWith(f.sha256))
      throw new Error('Object store content does not match its key');
    verified.push({ key: f.key, bytes });
  }
  for (const v of verified) {
    const dst = inside(targetRoot, v.key);
    await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
    await writeFile(dst, v.bytes, { mode: 0o600, flag: 'wx' });
  }
  let carried = 0;
  if (opts.tombstonesFrom) {
    for (const key of await walk(opts.tombstonesFrom, 'tombstones')) {
      const dst = inside(targetRoot, key);
      try {
        await stat(dst);
        continue;
      } catch {}
      await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
      await copyFile(inside(opts.tombstonesFrom, key), dst);
      carried += 1;
    }
  }
  return { files: verified.length, carriedTombstones: carried };
}
