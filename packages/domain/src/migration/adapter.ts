import type { ReviewCategory, ReviewDecision, SourceFormat } from '@cuspatlas/contracts';

/**
 * Versioned source adapters (MG-01). An adapter knows one source format: its entities, the source
 * identifier field of each, and a mapping per field with a confidence and a provenance label
 * (MG-02). `validated` mappings apply automatically; anything else (unknown fields and entities,
 * legacy terminology, ambiguous money, unusable identifiers) is queued for staff review and never
 * guessed. Only the fabricated `cuspatlas-synthetic-legacy/1` format exists until M-S1 qualifies a
 * real source; a real adapter is added here as a new format with its own version.
 */
export type Confidence = 'validated' | 'proposed';

export interface FieldMapping {
  /** Target concept in the owning workstream's contract (documentation and provenance only). */
  readonly target: string;
  readonly confidence: Confidence;
}

export interface EntitySpec {
  readonly idField: string;
  readonly fields: Readonly<Record<string, FieldMapping>>;
}

export interface ReviewProposal {
  readonly category: ReviewCategory;
  readonly field: string | null;
  /** Groups rows that one decision resolves (a field, a legacy code, a row). */
  readonly subjectKey: string;
  readonly proposal: Readonly<Record<string, unknown>>;
}

export interface StagedRow {
  readonly rowNo: number;
  readonly sourceId: string | null;
  readonly payload: Readonly<Record<string, string>>;
  readonly issueCode: string | null;
  readonly reviews: readonly ReviewProposal[];
}

export interface StageContext {
  readonly producedAt: Date;
  readonly currency: string;
}

export interface SourceAdapter {
  readonly format: SourceFormat;
  readonly adapterVersion: number;
  readonly entities: Readonly<Record<string, EntitySpec>>;
  /** Field-level review for one known row (terminology, money, future appointments). */
  reviewRow(entity: string, row: Readonly<Record<string, string>>, ctx: StageContext): ReviewProposal[];
}

export const ALLOWED_DECISIONS: Readonly<Record<ReviewCategory, readonly ReviewDecision[]>> = {
  unknown_field: ['exclude', 'archiveOnly'],
  unmapped_entity: ['exclude', 'archiveOnly'],
  terminology: ['archiveOnly', 'exclude'],
  monetary_semantics: ['exclude', 'acceptProposal'],
  missing_source_id: ['exclude'],
  duplicate_source_id: ['exclude'],
  identity: ['distinct', 'sameAsExisting', 'mergeAfterImport'],
  future_appointment: ['exclude', 'archiveOnly'],
};

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. Throws on a malformed table. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let i = 0;
  const push = () => {
    record.push(field);
    field = '';
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      push();
    } else if (c === '\n' || c === '\r') {
      push();
      records.push(record);
      record = [];
      if (c === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || record.length > 0) {
    push();
    records.push(record);
  }
  const header = records.shift();
  if (!header || header.length === 0 || header.some((h) => !/^[a-z][a-z0-9_]{0,40}$/.test(h)))
    throw new Error('malformed header');
  if (new Set(header).size !== header.length) throw new Error('duplicate column');
  for (const r of records) if (r.length !== header.length) throw new Error('ragged row');
  return { header, rows: records };
}

const V = (target: string): FieldMapping => ({ target, confidence: 'validated' });
const P = (target: string): FieldMapping => ({ target, confidence: 'proposed' });

/** Legacy appointment statuses with a validated meaning as historical references (never attendance). */
export const LEGACY_APPOINTMENT_STATUS: Readonly<Record<string, string>> = {
  completed: 'historicalCompleted',
  broken: 'historicalBroken',
  cancelled: 'historicalCancelled',
  scheduled: 'scheduled',
};

const SYNTHETIC_LEGACY_ENTITIES: Readonly<Record<string, EntitySpec>> = {
  patients: {
    idField: 'patient_id',
    fields: {
      patient_id: V('patient.identifiers[prior_system]'),
      last_name: V('patient.legalName.family'),
      first_name: V('patient.legalName.given'),
      birth_date: V('patient.birthDate'),
      phone: V('patient.contact.phone'),
      guarantor_id: V('reconciliation.guarantorSourceId'),
    },
  },
  appointments: {
    idField: 'appt_id',
    fields: {
      appt_id: V('migration.historicalAppointment.sourceId'),
      patient_id: V('migration.historicalAppointment.patient'),
      start_local: V('migration.historicalAppointment.start'),
      time_zone: V('migration.historicalAppointment.timeZone'),
      duration_min: V('migration.historicalAppointment.durationMinutes'),
      status: V('migration.historicalAppointment.legacyStatus'),
    },
  },
  procedures: {
    idField: 'proc_id',
    fields: {
      proc_id: V('migration.historicalProcedure.sourceId'),
      patient_id: V('migration.historicalProcedure.patient'),
      // Legacy procedure codes are terminology: never mapped to a clinical code automatically.
      legacy_code: P('clinical.procedureCode (reviewed reference only)'),
      service_date: V('migration.historicalProcedure.serviceDate'),
      fee_minor: V('migration.historicalProcedure.legacyFee (not posted; M-D2)'),
    },
  },
  ledger_balances: {
    idField: 'balance_id',
    fields: {
      balance_id: V('migration.openingBalance.sourceId'),
      account_id: V('reconciliation.guarantorSourceId'),
      patient_id: V('migration.openingBalance.patient'),
      balance_minor: V('billing.openingBalance.amount'),
      currency: V('billing.openingBalance.currency'),
      as_of: V('billing.openingBalance.asOf'),
    },
  },
  unapplied_credits: {
    idField: 'payment_id',
    fields: {
      payment_id: V('migration.unappliedCredit.sourcePaymentId'),
      account_id: V('reconciliation.guarantorSourceId'),
      patient_id: V('migration.unappliedCredit.patient'),
      amount_minor: V('billing.unappliedCredit.amount'),
      currency: V('billing.unappliedCredit.currency'),
      received_on: V('billing.unappliedCredit.ageBasis'),
    },
  },
  open_claims: {
    idField: 'claim_id',
    fields: {
      claim_id: V('migration.openClaim.sourceClaimId'),
      patient_id: V('migration.openClaim.patient'),
      payer_name: V('migration.openClaim.payerLabel'),
      state: V('migration.openClaim.stateAtCutover'),
      outstanding_minor: V('migration.openClaim.outstanding'),
      currency: V('migration.openClaim.currency'),
    },
  },
};

const INT = /^-?[0-9]{1,15}$/;

function moneyReview(
  row: Readonly<Record<string, string>>,
  amountField: string,
  ctx: StageContext,
  allowNegative: boolean,
): ReviewProposal[] {
  const amount = row[amountField] ?? '';
  const subject = `row:${row.__row}`;
  if (!INT.test(amount))
    return [
      {
        category: 'monetary_semantics',
        field: amountField,
        subjectKey: subject,
        proposal: { issue: 'not_integer_minor_units' },
      },
    ];
  if ((row.currency ?? '') !== ctx.currency)
    return [
      {
        category: 'monetary_semantics',
        field: 'currency',
        subjectKey: subject,
        proposal: { issue: 'currency_mismatch' },
      },
    ];
  if (!allowNegative && amount.startsWith('-')) {
    // A negative legacy balance may be a credit or a reversal: proposed as unapplied credit, never assumed.
    return [
      {
        category: 'monetary_semantics',
        field: amountField,
        subjectKey: subject,
        proposal: { issue: 'negative_balance', proposedTarget: 'unappliedCredit', confidence: 'proposed' },
      },
    ];
  }
  return [];
}

export const SYNTHETIC_LEGACY_ADAPTER: SourceAdapter = {
  format: 'cuspatlas-synthetic-legacy/1',
  adapterVersion: 1,
  entities: SYNTHETIC_LEGACY_ENTITIES,
  reviewRow(entity, row, ctx) {
    switch (entity) {
      case 'procedures':
        return [
          {
            category: 'terminology',
            field: 'legacy_code',
            subjectKey: `code:${(row.legacy_code ?? '').slice(0, 64)}`,
            proposal: {
              proposedTarget: 'archiveOnly',
              confidence: 'proposed',
              reason: 'legacy_terminology_unmapped',
            },
          },
        ];
      case 'appointments': {
        const status = row.status ?? '';
        if (!(status in LEGACY_APPOINTMENT_STATUS))
          return [
            {
              category: 'terminology',
              field: 'status',
              subjectKey: `status:${status.slice(0, 64)}`,
              proposal: {
                proposedTarget: 'archiveOnly',
                confidence: 'proposed',
                reason: 'legacy_status_unmapped',
              },
            },
          ];
        const start = Date.parse(`${(row.start_local ?? '').replace(' ', 'T')}:00Z`);
        if (status === 'scheduled' && (Number.isNaN(start) || start > ctx.producedAt.getTime()))
          return [
            {
              category: 'future_appointment',
              field: null,
              subjectKey: `row:${row.__row}`,
              proposal: { proposedTarget: 'rebookThroughScheduling', confidence: 'proposed' },
            },
          ];
        return [];
      }
      case 'ledger_balances':
        return moneyReview(row, 'balance_minor', ctx, false);
      case 'unapplied_credits':
        return moneyReview(row, 'amount_minor', ctx, false);
      case 'open_claims':
        return moneyReview(row, 'outstanding_minor', ctx, false);
      default:
        return [];
    }
  },
};

export const SOURCE_ADAPTERS: Readonly<Record<SourceFormat, SourceAdapter>> = {
  'cuspatlas-synthetic-legacy/1': SYNTHETIC_LEGACY_ADAPTER,
};

const SOURCE_ID = /^[A-Za-z0-9._:/-]{1,64}$/;
const ENTITY = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * Stages one table: every row is kept (an unknown entity is staged unmapped, never dropped); an
 * empty or malformed identifier and a repeated identifier are issues on that row, never a collapse.
 */
export function stageTable(
  adapter: SourceAdapter,
  entity: string,
  header: readonly string[],
  rows: readonly string[][],
  ctx: StageContext,
): { mapped: boolean; staged: StagedRow[]; tableReviews: ReviewProposal[] } {
  const spec = adapter.entities[entity];
  const tableReviews: ReviewProposal[] = [];
  if (!spec) {
    tableReviews.push({
      category: 'unmapped_entity',
      field: null,
      subjectKey: `entity:${entity}`,
      proposal: { reason: 'entity_not_in_source_profile', rows: rows.length },
    });
  } else {
    for (const h of header) {
      if (!(h in spec.fields) && ENTITY.test(h))
        tableReviews.push({
          category: 'unknown_field',
          field: h,
          subjectKey: `field:${h}`,
          proposal: { reason: 'field_not_in_adapter' },
        });
    }
  }
  const seen = new Map<string, number>();
  const staged: StagedRow[] = rows.map((cells, i) => {
    const rowNo = i + 1;
    const payload: Record<string, string> = {};
    header.forEach((h, k) => {
      payload[h] = cells[k] ?? '';
    });
    if (!spec) return { rowNo, sourceId: null, payload, issueCode: 'unmapped_entity', reviews: [] };
    const raw = payload[spec.idField] ?? '';
    const reviews: ReviewProposal[] = [];
    let issueCode: string | null = null;
    let sourceId: string | null = null;
    if (!SOURCE_ID.test(raw)) {
      issueCode = 'missing_source_id';
      reviews.push({
        category: 'missing_source_id',
        field: spec.idField,
        subjectKey: `row:${rowNo}`,
        proposal: {},
      });
    } else {
      sourceId = raw;
      const n = (seen.get(raw) ?? 0) + 1;
      seen.set(raw, n);
      if (n > 1) {
        issueCode = 'duplicate_source_id';
        reviews.push({
          category: 'duplicate_source_id',
          field: spec.idField,
          subjectKey: `row:${rowNo}`,
          proposal: {},
        });
      }
    }
    if (issueCode === null)
      reviews.push(...adapter.reviewRow(entity, { ...payload, __row: String(rowNo) }, ctx));
    return { rowNo, sourceId, payload, issueCode, reviews };
  });
  return { mapped: spec !== undefined, staged, tableReviews };
}

/**
 * H2 M-8: one CSV cell for any downstream export of staged source values. Values are stored raw; on
 * export a value a spreadsheet would read as a formula (leading `=`, `+`, `-`, `@`, tab or carriage
 * return) is neutralised with a leading apostrophe, and a cell with a comma, quote or line break is
 * quoted. Recommended-pending-approval (the export consumers are not yet defined).
 */
export function csvExportCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One exported CSV row (see `csvExportCell`). */
export function csvExportRow(values: readonly string[]): string {
  return values.map(csvExportCell).join(',');
}
