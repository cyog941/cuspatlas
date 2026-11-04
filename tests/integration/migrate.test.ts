import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSyntheticDatabaseName, migrate } from '@cuspatlas/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';

const MIGRATIONS = resolve(import.meta.dirname, '../../supabase/migrations');
let db: TestDatabase;

beforeAll(async () => {
  db = await openTestDatabase('migrate');
});
afterAll(async () => {
  await db?.close();
});

describe('in-repo migrator', () => {
  it('re-running against an up-to-date database applies nothing', async () => {
    const client = await db.admin.connect();
    try {
      expect(await migrate(client, { dir: MIGRATIONS })).toStrictEqual({ applied: [] });
    } finally {
      client.release();
    }
  });

  it('refuses when an applied migration file has changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cuspatlas-mig-'));
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      writeFileSync(join(dir, '20261103230000_tenancy_foundation.sql'), '-- tampered\n');
      const client = await db.admin.connect();
      try {
        await expect(migrate(client, { dir })).rejects.toThrow(/changed on disk/);
      } finally {
        client.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses any database whose name lacks the synthetic marker', async () => {
    expect(() => assertSyntheticDatabaseName('postgres')).toThrow(/cuspatlas_synthetic/);
    expect(() => assertSyntheticDatabaseName('cuspatlas_prod')).toThrow(/cuspatlas_synthetic/);
    const client = new pg.Client({
      host: '127.0.0.1',
      port: Number(process.env.CUSPATLAS_TEST_PG_PORT),
      user: 'postgres',
      password: process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD,
      database: 'postgres',
    });
    await client.connect();
    try {
      await expect(migrate(client, { dir: MIGRATIONS })).rejects.toThrow(/cuspatlas_synthetic/);
      const { rows } = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
      expect(rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });
});
