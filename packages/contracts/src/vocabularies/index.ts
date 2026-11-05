import { BILLING_VOCABULARIES } from './billing';
import { CLINICAL_VOCABULARIES } from './clinical';
import { ENGAGEMENT_VOCABULARIES } from './engagement';
import { IMAGING_VOCABULARIES } from './imaging';
import { MIGRATION_VOCABULARIES } from './migration';
import { PATIENTS_VOCABULARIES } from './patients';
import { PLATFORM_VOCABULARIES } from './platform';
import { SCHEDULING_VOCABULARIES } from './scheduling';
import type { ModuleVocabularies, VocabularyEntry } from './types';

export * from './types';
export {
  BILLING_VOCABULARIES,
  CLINICAL_VOCABULARIES,
  ENGAGEMENT_VOCABULARIES,
  IMAGING_VOCABULARIES,
  MIGRATION_VOCABULARIES,
  PATIENTS_VOCABULARIES,
  PLATFORM_VOCABULARIES,
  SCHEDULING_VOCABULARIES,
};

/** OR-02: every module's registered state set (one registry per owning module). */
export const VOCABULARY_MODULES: readonly ModuleVocabularies[] = [
  SCHEDULING_VOCABULARIES,
  PATIENTS_VOCABULARIES,
  CLINICAL_VOCABULARIES,
  BILLING_VOCABULARIES,
  ENGAGEMENT_VOCABULARIES,
  IMAGING_VOCABULARIES,
  MIGRATION_VOCABULARIES,
  PLATFORM_VOCABULARIES,
];

/** One served vocabulary resource. `version` is the owning module registry's version. */
export interface Vocabulary {
  readonly name: string;
  readonly module: string;
  readonly owner: ModuleVocabularies['owner'];
  readonly version: string;
  readonly entries: readonly VocabularyEntry[];
}

export const VOCABULARIES: ReadonlyMap<string, Vocabulary> = new Map(
  VOCABULARY_MODULES.flatMap((m) =>
    m.vocabularies.map(
      (v) =>
        [
          v.name,
          { name: v.name, module: m.module, owner: m.owner, version: m.version, entries: v.entries },
        ] as const,
    ),
  ),
);

/** The vocabulary version a response carrying a code of `name` states. */
export function vocabularyVersion(name: string): string {
  const v = VOCABULARIES.get(name);
  if (!v) throw new Error(`unknown vocabulary ${name}`);
  return v.version;
}

/** The plain label of a code (the code itself only for a value no registry knows, which CI forbids). */
export function vocabularyLabel(name: string, code: string): string {
  return VOCABULARIES.get(name)?.entries.find((e) => e.code === code)?.label ?? code;
}

/**
 * OR-02: responses that carry a state code also carry the version of its vocabulary, as a top-level
 * `vocabularies: { <name>: <registry version> }` attached by the REST and MCP transports from this
 * table (coverage recorded in docs/execution/api-progress.md "A20/B11").
 */
const WORK_ITEMS = ['work_item_kind'] as const;
export const VOCABULARY_BEARING: Readonly<Record<string, readonly string[]>> = {
  'scheduling.appointments.read': ['appointment_booking', 'attendance'],
  'scheduling.attendance.list': ['attendance'],
  'scheduling.attendance.visitStatus': ['attendance'],
  'scheduling.worklist.daily': ['appointment_booking', 'attendance'],
  'scheduling.followUp.worklist': WORK_ITEMS,
  'scheduling.notifications.worklist': WORK_ITEMS,
  'scheduling.recovery.list': WORK_ITEMS,
  'clinical.labCases.worklist': WORK_ITEMS,
  'clinical.referrals.worklist': WORK_ITEMS,
  'communications.deliveries.worklist': WORK_ITEMS,
  'intake.reviews.worklist': WORK_ITEMS,
  'messaging.threads.worklist': WORK_ITEMS,
  'rcm.claims.read': ['claim', 'appeal'],
  'rcm.claims.queues': ['claim'],
  'messaging.threads.read': ['message_thread'],
  'messaging.threads.list': ['message_thread'],
  'communications.deliveries.read': ['outbound_message'],
};

export function attachVocabularyVersions(operation: string, body: unknown): unknown {
  const names = VOCABULARY_BEARING[operation];
  if (!names || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...(body as Record<string, unknown>),
    vocabularies: Object.fromEntries(names.map((n) => [n, vocabularyVersion(n)])),
  };
}
