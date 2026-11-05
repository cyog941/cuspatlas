import {
  type ActorContext,
  assertValid,
  ENGAGEMENT_PROPERTIES,
  RefusalError,
  type RelationshipScope,
  type TenantTransaction,
  validateEmptyQuery,
} from '@cuspatlas/contracts';
import {
  portalStatementRead,
  portalStatementsView,
  STATEMENT_RELEASE_RESOURCE,
} from '../../billing/portal-statements';
import { recordSensitiveRead } from '../../events/record-sensitive-read';
import { portalDocumentsView } from '../../imaging/portal-documents';
import type { EngagementBase } from '../common';
import { formsView } from '../intake/forms';
import { messagesView } from '../messaging/threads';
import { requirePortalAccess } from './access';

/**
 * E2 scoped portal views. Each view is an explicit allowlist projection (never a filtered row) with a
 * redaction report and a relationship-scope requirement (the view-to-scope mapping of the plan's
 * Shared interfaces). A view whose producer is not deployed returns an explicit `unavailable`
 * coverage with its owner and no fields, so it can never be read as "nothing there". Every view read
 * that returns data is sensitive-read logged inside the read's transaction (fail closed).
 */
export const PORTAL_VIEW_PROJECTION_VERSION = 'portal-views.pending-approval.1';

export type PortalViewName =
  | 'demographics'
  | 'appointments'
  | 'requests'
  | 'documents'
  | 'balances'
  | 'statements'
  | 'messages'
  | 'forms';

interface ViewDefinition {
  readonly requiredScope: readonly RelationshipScope[];
  readonly fields: readonly string[];
  /** Keys of each item of a list field (empty for record views). */
  readonly itemFields: readonly string[];
  readonly redactions: readonly string[];
  readonly unavailable?: { readonly owner: string; readonly reason: 'producer_not_deployed' };
  readonly project?: (tx: TenantTransaction, patientRef: string) => Promise<Record<string, unknown>>;
}

const REQUEST_STATE: Readonly<Record<string, 'pending' | 'scheduled' | 'closed'>> = {
  open: 'pending',
  in_review: 'pending',
  scheduled: 'scheduled',
  declined: 'closed',
  expired: 'closed',
  withdrawn: 'closed',
};

async function demographics(tx: TenantTransaction, patientRef: string) {
  const { rows } = await tx.query<{
    legal_name: unknown;
    preferred_name: unknown;
    pronouns: unknown;
    language: unknown;
    contact: unknown;
    address: unknown;
    birth: string | null;
    precision: string;
  }>(
    `SELECT legal_name, preferred_name, pronouns, language, contact, address,
       to_char(birth_date, 'YYYY-MM-DD') AS birth, birth_date_precision AS precision
     FROM cuspatlas.patients WHERE id = $1`,
    [patientRef],
  );
  const r = rows[0];
  if (!r) throw new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
  const value =
    r.birth === null
      ? null
      : r.precision === 'year'
        ? r.birth.slice(0, 4)
        : r.precision === 'month'
          ? r.birth.slice(0, 7)
          : r.birth;
  return {
    legalName: r.legal_name,
    preferredName: r.preferred_name,
    pronouns: r.pronouns,
    language: r.language,
    birthDate: value === null ? { known: false } : { known: true, value, precision: r.precision },
    contact: r.contact,
    address: r.address,
  };
}

async function appointments(tx: TenantTransaction, patientRef: string) {
  const { rows } = await tx.query<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    time_zone: string;
    display_label: string;
  }>(
    `SELECT a.id, a.starts_at, a.ends_at, a.time_zone, l.display_label FROM cuspatlas.appointments a
     JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
     WHERE a.subject_patient_id = $1 AND a.status = 'booked' AND a.ends_at > now()
     ORDER BY a.starts_at, a.id LIMIT 50`,
    [patientRef],
  );
  return {
    upcoming: rows.map((r) => ({
      appointmentRef: r.id,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      timeZone: r.time_zone,
      locationLabel: r.display_label,
      status: 'booked',
    })),
  };
}

async function requests(tx: TenantTransaction, patientRef: string) {
  const { rows } = await tx.query<{ id: string; state: string; origin: string; created_at: Date }>(
    `SELECT q.id, q.state, q.origin, q.created_at FROM cuspatlas.appointment_requests q
     WHERE q.subject_patient_id = $1 ORDER BY q.created_at DESC, q.id LIMIT 50`,
    [patientRef],
  );
  return {
    requests: rows.map((r) => ({
      requestRef: r.id,
      state: REQUEST_STATE[r.state] ?? 'closed',
      origin: r.origin,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

export const PORTAL_VIEWS: Readonly<Record<PortalViewName, ViewDefinition>> = {
  demographics: {
    requiredScope: ['demographics'],
    fields: ['legalName', 'preferredName', 'pronouns', 'language', 'birthDate', 'contact', 'address'],
    itemFields: [],
    redactions: [
      'identifiers',
      'provenance',
      'status',
      'homeLocationRef',
      'timeZone',
      'version',
      'relationships',
    ],
    project: demographics,
  },
  appointments: {
    requiredScope: ['scheduling'],
    fields: ['upcoming'],
    itemFields: ['appointmentRef', 'startsAt', 'endsAt', 'timeZone', 'locationLabel', 'status'],
    redactions: ['provider', 'operatory', 'appointmentType', 'request', 'createdBy', 'history', 'attendance'],
    project: appointments,
  },
  requests: {
    requiredScope: ['scheduling'],
    fields: ['requests'],
    itemFields: ['requestRef', 'state', 'origin', 'createdAt'],
    redactions: ['note', 'stateReason', 'transitions', 'providerPreference', 'location', 'contactConsent'],
    project: requests,
  },
  // Closeout B: images a clinician explicitly released to the portal (I3 association + release fact).
  documents: {
    requiredScope: ['clinical_read'],
    fields: ['documents'],
    itemFields: ['releaseRef', 'kind', 'contentType', 'byteLength', 'releasedAt'],
    redactions: ['objectRef', 'unreleasedObjects', 'provenance', 'digest', 'releasedBy', 'association'],
    project: portalDocumentsView,
  },
  balances: {
    requiredScope: ['financial'],
    fields: [],
    itemFields: [],
    redactions: [],
    unavailable: { owner: 'B4', reason: 'producer_not_deployed' },
  },
  // Closeout C: B4 statements a staff member explicitly released to the guarantor's portal.
  statements: {
    requiredScope: ['financial'],
    fields: ['statements'],
    itemFields: [
      'releaseRef',
      'statementVersion',
      'cutoffAt',
      'currency',
      'total',
      'amountDue',
      'creditBalance',
      'totalClass',
      'superseded',
      'releasedAt',
    ],
    redactions: [
      'statementRef',
      'unreleasedStatements',
      'entryRefs',
      'chargeRefs',
      'paymentRefs',
      'generatedBy',
      'releasedBy',
    ],
    project: portalStatementsView,
  },
  messages: {
    requiredScope: ['consent'],
    fields: ['threads'],
    itemFields: ['threadRef', 'topic', 'state', 'awaitingReplyFrom', 'lastMessageAt'],
    redactions: ['bodies', 'attachments', 'queue', 'assignee', 'legalHold', 'staffAuthors'],
    project: messagesView,
  },
  forms: {
    requiredScope: ['demographics', 'consent'],
    fields: ['submissions'],
    itemFields: ['submissionRef', 'formRef', 'formVersion', 'submittedAt', 'status'],
    redactions: ['answers', 'consentRefs', 'reviewItems', 'submittedBy', 'viaRelationship'],
    project: formsView,
  },
};

const viewOf = (name: string): ViewDefinition => {
  const v = (PORTAL_VIEWS as Record<string, ViewDefinition>)[name];
  if (!Object.hasOwn(PORTAL_VIEWS, name) || !v) {
    throw new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
  }
  return v;
};

export function createPortalViewOperations(base: EngagementBase) {
  const { deps } = base;
  const port = () => {
    if (!deps.portalDocuments) throw new RefusalError({ code: 'service_unavailable', retryable: true });
    return deps.portalDocuments;
  };
  return {
    /** E2 documents: a short-lived read grant of one released image (imaging side). */
    grantPortalDocument(ctx: ActorContext, patientRef: string, releaseRef: string, body: unknown) {
      return port().grant(ctx, patientRef, releaseRef, body);
    },
    /** E2 documents: the bytes of one released image with a live grant (REST only). */
    readPortalDocumentContent(ctx: ActorContext, patientRef: string, releaseRef: string, token: unknown) {
      return port().content(ctx, patientRef, releaseRef, token);
    },
    /**
     * Closeout C: one statement released to this patient's portal (the patient as guarantor, or a
     * relationship holding `financial`), from the stored, digest-verified snapshot. Sensitive-read logged.
     */
    readPortalStatement(ctx: ActorContext, patientRef: string, releaseRef: string, query: unknown) {
      return base.guarded(ctx, 'portal.statements.read', async () => {
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const access = await requirePortalAccess(tx, patientRef, ['financial']);
          const { statement, statementRef } = await portalStatementRead(tx, access.patientRef, releaseRef);
          // Names the release, the exact statement version read (its immutable statement ref) and the patient.
          await recordSensitiveRead(tx, {
            operation: 'portal.statements.read',
            resourceType: STATEMENT_RELEASE_RESOURCE,
            resourceRefs: [statement.releaseRef, statementRef, access.patientRef],
            queryFields: [],
          });
          return statement;
        });
      });
    },
    /** describePortalView: the declared allowlist, redactions and scope requirement (no data). */
    describePortalView(ctx: ActorContext, view: string, query: unknown) {
      return base.guarded(ctx, 'portal.views.describe', async () => {
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        const v = viewOf(view);
        return deps.withTenantTransaction(ctx, async () => ({
          view,
          fields: v.fields,
          itemFields: v.itemFields,
          redactions: v.redactions,
          requiredScope: v.requiredScope,
          availability: v.unavailable ? 'unavailable' : 'available',
          projectionVersion: PORTAL_VIEW_PROJECTION_VERSION,
        }));
      });
    },

    readPortalView(ctx: ActorContext, patientRef: string, view: string, query: unknown) {
      return base.guarded(ctx, 'portal.views.read', async () => {
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        const v = viewOf(view);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const access = await requirePortalAccess(tx, patientRef, v.requiredScope);
          const generatedAt = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          if (v.unavailable || !v.project) {
            return {
              view,
              patientRef: access.patientRef,
              coverage: {
                status: 'unavailable',
                ...(v.unavailable ?? { reason: 'producer_not_deployed', owner: 'E' }),
              },
              fields: null,
              redacted: v.redactions,
              projectionVersion: PORTAL_VIEW_PROJECTION_VERSION,
              generatedAt: generatedAt.toISOString(),
            };
          }
          const projected = await v.project(tx, access.patientRef);
          // Allowlist, not a filter: only declared keys leave, in declared order.
          const fields = Object.fromEntries(v.fields.map((f) => [f, projected[f]]));
          await recordSensitiveRead(tx, {
            operation: 'portal.views.read',
            resourceType: 'patient',
            resourceRefs: [access.patientRef],
            queryFields: ['view'],
          });
          return {
            view,
            patientRef: access.patientRef,
            coverage: { status: 'available' },
            fields,
            redacted: v.redactions,
            projectionVersion: PORTAL_VIEW_PROJECTION_VERSION,
            generatedAt: generatedAt.toISOString(),
          };
        });
      });
    },
  };
}
