import { createHash, createHmac } from 'node:crypto';
import {
  type Address,
  type BirthDate,
  type Contact,
  type Language,
  type LegalName,
  PATIENT_FIELD_GROUPS,
  type Patient,
  type PatientCreate,
  type PatientFieldGroup,
  type PatientIdentifier,
  type PatientStatus,
  type PatientSummary,
  type PreferredName,
  type Pronouns,
  type Provenance,
  type ProvenanceMap,
  RefusalError,
  type Unknown,
} from '@cuspatlas/contracts';

/** Domain-rule refusal (422). The reason is a fixed server enumeration, never caller text. */
export const invalid = (reason: string) =>
  new RefusalError({ code: 'validation_failed', detail: { reason } });
/** State conflict (409, terminal): the reason names the state that blocks the command. */
export const conflict = (reason: string, blockingRefs?: readonly { kind: string; ref: string }[]) =>
  new RefusalError({
    code: 'conflict',
    detail: blockingRefs === undefined ? { reason } : { reason, blockingRefs },
  });
export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });

export const NOT_PROVIDED: Unknown = Object.freeze({ known: false, reason: 'not_provided' });

/** Columns every patient read selects. Dates are formatted by the database, never parsed locally. */
export const PATIENT_COLUMNS = `id, legal_name, preferred_name, pronouns, language, contact, address,
  to_char(birth_date, 'YYYY-MM-DD') AS birth_date_text, birth_date_precision, birth_date_unknown_reason,
  time_zone, identifiers, provenance, home_location_ref, contactable, status, status_effective_at,
  merged_into, version`;

export interface PatientRow extends Record<string, unknown> {
  id: string;
  legal_name: LegalName;
  preferred_name: PreferredName;
  pronouns: Pronouns;
  language: Language;
  contact: Contact;
  address: Address;
  birth_date_text: string | null;
  birth_date_precision: 'day' | 'month' | 'year' | 'unknown';
  birth_date_unknown_reason: Unknown['reason'] | null;
  time_zone: string | null;
  identifiers: PatientIdentifier[];
  provenance: ProvenanceMap;
  home_location_ref: string | null;
  contactable: boolean;
  status: PatientStatus;
  status_effective_at: Date;
  merged_into: string | null;
  version: number;
}

function birthDateOf(r: PatientRow): BirthDate {
  if (r.birth_date_precision === 'unknown' || r.birth_date_text === null) {
    return { known: false, reason: r.birth_date_unknown_reason ?? 'not_provided' };
  }
  const len = r.birth_date_precision === 'day' ? 10 : r.birth_date_precision === 'month' ? 7 : 4;
  return { known: true, value: r.birth_date_text.slice(0, len), precision: r.birth_date_precision };
}

export function toSummary(r: PatientRow): PatientSummary {
  return {
    patientRef: r.id,
    legalName: r.legal_name,
    preferredName: r.preferred_name,
    birthDate: birthDateOf(r),
    status: r.status,
    statusEffectiveAt: r.status_effective_at.toISOString(),
    homeLocationRef: r.home_location_ref,
    contactable: r.contactable,
    mergedIntoRef: r.merged_into,
    version: r.version,
  };
}

export function toPatient(r: PatientRow): Patient {
  return {
    ...toSummary(r),
    pronouns: r.pronouns,
    language: r.language,
    timeZone: r.time_zone,
    contact: r.contact,
    address: r.address,
    identifiers: r.identifiers,
    provenance: r.provenance,
  };
}

/** The persisted identity of a patient: every field group present, unknown ones explicit. */
export interface IdentityRecord {
  readonly legalName: LegalName;
  readonly preferredName: PreferredName;
  readonly pronouns: Pronouns;
  readonly birthDate: BirthDate;
  readonly language: Language;
  readonly timeZone: string | null;
  readonly contact: Contact;
  readonly address: Address;
  readonly identifiers: readonly PatientIdentifier[];
  readonly homeLocationRef: string | null;
  readonly provenance: ProvenanceMap;
}

export function recordOf(r: PatientRow): IdentityRecord {
  return {
    legalName: r.legal_name,
    preferredName: r.preferred_name,
    pronouns: r.pronouns,
    birthDate: birthDateOf(r),
    language: r.language,
    timeZone: r.time_zone,
    contact: r.contact,
    address: r.address,
    identifiers: r.identifiers,
    homeLocationRef: r.home_location_ref,
    provenance: r.provenance,
  };
}

const DATE_SHAPE: Record<'day' | 'month' | 'year', RegExp> = {
  day: /^(\d{4})-(\d{2})-(\d{2})$/,
  month: /^(\d{4})-(\d{2})$/,
  year: /^(\d{4})$/,
};

/** Birth-date rules (422): the value matches its precision, is a real date, not in the future. */
export function checkBirthDate(b: BirthDate, today: Date = new Date()): void {
  if (!b.known) return;
  const m = DATE_SHAPE[b.precision].exec(b.value);
  if (!m) throw invalid('birth_date_precision_mismatch');
  const year = Number(m[1]);
  const month = m[2] === undefined ? 1 : Number(m[2]);
  const day = m[3] === undefined ? 1 : Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw invalid('birth_date_invalid');
  }
  if (year < 1880 || d.getTime() > today.getTime()) throw invalid('birth_date_out_of_range');
}

export function checkTimeZone(zone: string | null | undefined): void {
  if (zone === null || zone === undefined) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw invalid('time_zone_unknown');
  }
}

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,}$/;
export const phoneDigits = (value: string) => value.replace(/\D/g, '');

export function checkContact(c: Contact | undefined): void {
  if (!c?.known) return;
  for (const p of c.points) {
    if (p.channel === 'phone') {
      const n = phoneDigits(p.value).length;
      if (n < 7 || n > 15) throw invalid('phone_invalid');
    } else if (!EMAIL.test(p.value)) {
      throw invalid('email_invalid');
    }
  }
}

export function checkIdentifiers(ids: readonly PatientIdentifier[] | undefined): void {
  const seen = new Set<string>();
  for (const i of ids ?? []) {
    const k = `${i.type}|${i.issuer}`;
    if (seen.has(k)) throw invalid('identifier_duplicate');
    seen.add(k);
  }
}

/** Stateless domain rules for any (partial) identity input. */
export function checkIdentityInput(p: Partial<PatientCreate>): void {
  if (p.birthDate) checkBirthDate(p.birthDate);
  checkTimeZone(p.timeZone);
  checkContact(p.contact);
  checkIdentifiers(p.identifiers);
}

/** Groups present in an input, in contract order. */
export function groupsIn(p: Partial<PatientCreate>): PatientFieldGroup[] {
  return PATIENT_FIELD_GROUPS.filter((g) => p[g] !== undefined);
}

/** A complete record from a create body: absent groups become explicit unknowns. */
export function recordFromCreate(p: PatientCreate): IdentityRecord {
  const provenance: ProvenanceMap = {};
  for (const g of groupsIn(p)) provenance[g] = p.provenance?.[g] ?? 'staff_entry';
  return {
    legalName: p.legalName,
    preferredName: p.preferredName ?? NOT_PROVIDED,
    pronouns: p.pronouns ?? NOT_PROVIDED,
    birthDate: p.birthDate,
    language: p.language ?? NOT_PROVIDED,
    timeZone: p.timeZone ?? null,
    contact: p.contact ?? NOT_PROVIDED,
    address: p.address ?? NOT_PROVIDED,
    identifiers: p.identifiers ?? [],
    homeLocationRef: p.homeLocationRef ?? null,
    provenance,
  };
}

/** Applies an update: provided groups replace the stored ones; nothing else changes. */
export function applyUpdate(
  current: IdentityRecord,
  p: Partial<PatientCreate>,
  defaultProvenance: Provenance = 'staff_entry',
): IdentityRecord {
  const provenance: ProvenanceMap = { ...current.provenance };
  for (const g of groupsIn(p)) provenance[g] = p.provenance?.[g] ?? defaultProvenance;
  return {
    legalName: p.legalName ?? current.legalName,
    preferredName: p.preferredName ?? current.preferredName,
    pronouns: p.pronouns ?? current.pronouns,
    birthDate: p.birthDate ?? current.birthDate,
    language: p.language ?? current.language,
    timeZone: p.timeZone === undefined ? current.timeZone : p.timeZone,
    contact: p.contact ?? current.contact,
    address: p.address ?? current.address,
    identifiers: p.identifiers ?? current.identifiers,
    homeLocationRef: p.homeLocationRef === undefined ? current.homeLocationRef : p.homeLocationRef,
    provenance,
  };
}

/** Lower-case, accent-folded, single-spaced text for search and matching. */
export function normalizeText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Match-key prefixes; the duplicate scorer maps each to a reason. */
export const MATCH_KEY = {
  name: 'n',
  birthDate: 'd',
  phone: 'p',
  email: 'e',
  address: 'a',
  identifier: 'i',
} as const;

export const phoneKey = (value: string, keyer: MatchKeyer) => keyer.key(MATCH_KEY.phone, phoneDigits(value));

/** Tenant-bound HMAC match keys of normalized values. Plaintext is never copied into the key column. */
export function matchKeys(r: IdentityRecord, keyer: MatchKeyer): string[] {
  const keys = new Set<string>();
  if (r.legalName.known) {
    keys.add(
      keyer.key(MATCH_KEY.name, `${normalizeText(r.legalName.family)}|${normalizeText(r.legalName.given)}`),
    );
  }
  if (r.birthDate.known && r.birthDate.precision === 'day')
    keys.add(keyer.key(MATCH_KEY.birthDate, r.birthDate.value));
  if (r.contact.known) {
    for (const p of r.contact.points) {
      keys.add(
        p.channel === 'phone'
          ? phoneKey(p.value, keyer)
          : keyer.key(MATCH_KEY.email, p.value.trim().toLowerCase()),
      );
    }
  }
  if (r.address.known) {
    const a = r.address;
    keys.add(
      keyer.key(
        MATCH_KEY.address,
        [...a.lines, a.postalCode, a.country]
          .map((x) => normalizeText(x).replace(/[^a-z0-9]/g, ''))
          .join('|'),
      ),
    );
  }
  for (const i of r.identifiers) {
    keys.add(keyer.key(MATCH_KEY.identifier, `${i.type}|${i.issuer.toLowerCase()}|${i.value.toLowerCase()}`));
  }
  return [...keys].slice(0, 32);
}

export function contactable(c: Contact): boolean {
  return c.known && c.points.some((p) => p.preference !== 'avoid');
}

/** SQL parameters for the identity columns, in PATIENT_WRITE_COLUMNS order. */
export function identityParams(r: IdentityRecord, keyer: MatchKeyer): unknown[] {
  const b = r.birthDate;
  const birth = b.known
    ? b.precision === 'day'
      ? b.value
      : b.precision === 'month'
        ? `${b.value}-01`
        : `${b.value}-01-01`
    : null;
  return [
    JSON.stringify(r.legalName),
    JSON.stringify(r.preferredName),
    JSON.stringify(r.pronouns),
    JSON.stringify(r.language),
    JSON.stringify(r.contact),
    JSON.stringify(r.address),
    birth,
    b.known ? b.precision : 'unknown',
    b.known ? null : b.reason,
    r.timeZone,
    JSON.stringify(r.identifiers),
    JSON.stringify(r.provenance),
    r.homeLocationRef,
    r.legalName.known ? normalizeText(r.legalName.family) : null,
    r.legalName.known ? normalizeText(r.legalName.given) : null,
    matchKeys(r, keyer),
    contactable(r.contact),
  ];
}

export const PATIENT_WRITE_COLUMNS = [
  'legal_name',
  'preferred_name',
  'pronouns',
  'language',
  'contact',
  'address',
  'birth_date',
  'birth_date_precision',
  'birth_date_unknown_reason',
  'time_zone',
  'identifiers',
  'provenance',
  'home_location_ref',
  'search_family',
  'search_given',
  'match_keys',
  'contactable',
] as const;

/** Escapes LIKE wildcards in caller text (used with ESCAPE '!'). */
export const likePrefix = (s: string) => `${s.replace(/[!%_]/g, (c) => `!${c}`)}%`;

/**
 * Tenant-bound match keys (review hardening, SHOULD 3): HMAC-SHA-256 under a server pepper of the
 * tenant id, the key prefix and the normalized value, truncated to 128 bits. Equal inputs in two
 * tenants never share a key, and a key cannot be recomputed from low-entropy inputs without the
 * pepper. Plaintext is never copied into the key column.
 */
export interface MatchKeyer {
  key(prefix: string, value: string): string;
}

export function createMatchKeyer(pepper: Uint8Array, tenantId: string): MatchKeyer {
  if (pepper.byteLength < 32) throw new Error('match-key pepper must be at least 32 bytes');
  return {
    key: (prefix, value) =>
      `${prefix}:${createHmac('sha256', pepper).update(`${tenantId}\u0000${prefix}\u0000${value}`).digest('hex').slice(0, 32)}`,
  };
}

/**
 * Test-only pepper, accepted solely when the runtime environment is synthetic-test (the same rule
 * as the test token issuer). Any other environment must configure CUSPATLAS_MATCH_KEY_PEPPER.
 */
export const SYNTHETIC_TEST_MATCH_KEY_PEPPER: Uint8Array = new Uint8Array(
  createHash('sha256').update('cuspatlas synthetic-test match-key pepper (never for real data)').digest(),
);

/**
 * The pepper a transport must use: the configured secret, or the test-only pepper under
 * synthetic-test. Refuses a missing pepper, and the test-only pepper, in any other environment.
 */
export function resolveMatchKeyPepper(env: string, configured: Uint8Array | undefined): Uint8Array {
  const isTest = (p: Uint8Array) =>
    p.byteLength === SYNTHETIC_TEST_MATCH_KEY_PEPPER.byteLength &&
    p.every((b, i) => b === SYNTHETIC_TEST_MATCH_KEY_PEPPER[i]);
  if (configured !== undefined) {
    if (env !== 'synthetic-test' && isTest(configured)) {
      throw new Error(
        'Refusing to start: the test-only match-key pepper is permitted only in synthetic-test',
      );
    }
    createMatchKeyer(configured, '00000000-0000-4000-8000-000000000000');
    return configured;
  }
  if (env === 'synthetic-test') return SYNTHETIC_TEST_MATCH_KEY_PEPPER;
  throw new Error('Refusing to start: CUSPATLAS_MATCH_KEY_PEPPER must be configured outside synthetic-test');
}
