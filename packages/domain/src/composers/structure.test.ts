import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A21 (OR-09) structural rule: a composer imports only the owning domains' published read functions
 * (named here), never a command module's mutating export, and issues no write statement. The only row
 * a composer may add is the S4 sensitive-read access log (`recordSensitiveRead`).
 */
const DIR = import.meta.dirname;
const PUBLISHED_READS: Record<string, readonly string[]> = {
  '../billing/entries': ['patientBalanceIn'],
  '../clinical/read-surfaces': ['plannedProceduresFor', 'labCasesFor', 'unsignedNotesFor'],
  '../rcm/coverage': ['coverageSummariesFor'],
  '../patients/model': ['PATIENT_COLUMNS', 'toSummary'],
  '../policy/authorize': ['assertLocation', 'ActionName', 'Authorize', 'DISPLAY_SCOPE'],
  '../scheduling/schedule-view': [
    'appointmentFacts',
    'appointmentsInRange',
    'blocksInRange',
    'rangeOf',
    'SCHEDULE_VIEW_MAX_DAYS',
    'ScheduledAppointment',
    'ScheduleLocation',
    'scheduleCounters',
    'unavailableIntervals',
  ],
  '../scheduling/zoned-time': ['addDays', 'daysInclusive', 'isRealDate', 'localToInstant'],
  '../events/record-sensitive-read': ['recordSensitiveRead'],
  '../commands/boundary': ['AttemptRecordingDeps', 'withAttemptRecording'],
};
const WRITE = /\b(INSERT\s+INTO|UPDATE\s+cuspatlas|DELETE\s+FROM|TRUNCATE|recordCommand|executeOnce)\b/i;

/** The service and barrel assemble every read surface (A16, A17, A22 commands included); not composers. */
const ASSEMBLY = new Set(['index.ts', 'service.ts']);
const sources = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !ASSEMBLY.has(f))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

describe('A21 composer structure', () => {
  it('checks every composer file (only the assembly files are exempt)', () => {
    expect(
      sources(DIR)
        .map((s) => s.file)
        .sort(),
    ).toEqual(['framework.ts', 'huddle.ts', 'read-composers.ts']);
  });

  it('imports only published domain read functions', () => {
    for (const { file, text } of sources(DIR)) {
      for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
        const from = m[2] as string;
        if (from.startsWith('@cuspatlas/contracts') || from.startsWith('./')) continue;
        const allowed = PUBLISHED_READS[from];
        expect(allowed, `${file} imports ${from}`).toBeDefined();
        const names = (m[1] as string)
          .split(',')
          .map((n) => n.replace(/^\s*type\s+/, '').trim())
          .filter(Boolean);
        for (const n of names) expect(allowed, `${file} imports ${n} from ${from}`).toContain(n);
      }
      expect(text).not.toMatch(/import\s+\*\s+as/);
    }
  });

  it('issues no write statement, in the composers or the published reads they call', () => {
    const reads = [
      join(DIR, '../scheduling/schedule-view.ts'),
      join(DIR, '../clinical/read-surfaces.ts'),
    ].map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
    for (const { file, text } of [...sources(DIR), ...reads]) expect(text, file).not.toMatch(WRITE);
  });
});
