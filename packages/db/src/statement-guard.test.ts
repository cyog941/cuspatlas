import { describe, expect, it } from 'vitest';
import { assertDomainStatement } from './statement-guard';

describe('domain statement guard', () => {
  it('allows ordinary parameterized statements', () => {
    for (const ok of [
      'SELECT id FROM cuspatlas.synthetic_tasks WHERE id = $1',
      '  INSERT INTO cuspatlas.synthetic_tasks (label) VALUES ($1) RETURNING id',
      "SELECT current_setting('cuspatlas.tenant_id', true)",
      'UPDATE cuspatlas.synthetic_tasks SET label = $1 WHERE id = $2',
    ]) {
      expect(() => assertDomainStatement(ok)).not.toThrow();
    }
  });

  it('rejects transaction control, multiple statements, comments and context or pg_ function calls', () => {
    for (const bad of [
      'COMMIT',
      ' rollback',
      'SET ROLE postgres',
      'reset all',
      'DISCARD ALL',
      'SELECT 1; COMMIT',
      'SELECT 1;',
      '-- note\nCOMMIT',
      '/* x */ COMMIT',
      'SELECT 1 /* hidden */',
      "SELECT set_config('cuspatlas.tenant_id', $1, false)",
      "SELECT SET_CONFIG ('cuspatlas.tenant_id', $1, false)",
      'SELECT pg_sleep(1)',
      'SELECT pg_catalog.set_config($1, $2, false)',
      'SELECT PG_TERMINATE_BACKEND (1)',
    ]) {
      expect(() => assertDomainStatement(bad), bad).toThrow();
    }
  });
});
