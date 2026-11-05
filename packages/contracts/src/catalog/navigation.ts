/**
 * A24 (OR-14): navigable capabilities of the operation catalog, grouped by domain area. Each capability
 * names its entry operation and every operation it needs; all of them must be catalog operations with
 * a REST route (tests/integration/navigation.test.ts), so an entry with no backing operation cannot
 * exist. Money concepts (ledger, claims, coverage, plans, statements, receivables) group under the one
 * `financial` area. Labels are plain English proposals; no layout or visual semantics.
 */
export type NavigationArea =
  | 'scheduling'
  | 'clinical'
  | 'financial'
  | 'communications'
  | 'imaging'
  | 'administration'
  | 'migration';

export interface NavigationCapability {
  readonly key: string;
  readonly label: string;
  /** The operation a client opens the capability with (visible only when the caller may call it). */
  readonly entry: string;
  /** Every operation the capability needs, entry first. */
  readonly operations: readonly string[];
}

export interface NavigationGroup {
  readonly area: NavigationArea;
  readonly label: string;
  readonly capabilities: readonly NavigationCapability[];
}

const cap = (
  key: string,
  label: string,
  operations: readonly [string, ...string[]],
): NavigationCapability => ({
  key,
  label,
  entry: operations[0],
  operations,
});

export const NAVIGATION_VERSION = 'navigation.1';

export const NAVIGATION: readonly NavigationGroup[] = [
  {
    area: 'scheduling',
    label: 'Scheduling',
    capabilities: [
      cap('schedule', 'Schedule', [
        'schedule.view',
        'appointments.detail',
        'scheduling.availability.search',
        'scheduling.appointments.read',
        'scheduling.appointments.book',
      ]),
      cap('patients', 'Patients', ['patients.search', 'patients.read', 'patients.create']),
      cap('requests', 'Appointment requests', ['scheduling.requests.list', 'scheduling.requests.read']),
      cap('floor', 'Floor', [
        'scheduling.floor.read',
        'scheduling.floor.providerRequests',
        'scheduling.presence.list',
      ]),
      cap('waitlist', 'Waitlist and staging', ['scheduling.waitlist.list', 'scheduling.staging.list']),
      cap('recall', 'Recall', ['scheduling.recall.due', 'scheduling.recall.policies']),
      cap('worklists', 'Daily worklists', ['scheduling.worklist.daily', 'scheduling.followUp.worklist']),
    ],
  },
  {
    area: 'clinical',
    label: 'Clinical',
    capabilities: [
      cap('chart', 'Chart', ['clinical.chart.read', 'clinical.history.read', 'clinical.history.alerts']),
      cap('notes', 'Progress notes', ['clinical.notes.list', 'clinical.notes.read']),
      cap('treatmentPlans', 'Treatment plans', [
        'clinical.treatmentPlans.list',
        'clinical.treatmentPlans.read',
        'clinical.estimates.list',
      ]),
      cap('labCases', 'Lab cases', ['clinical.labCases.worklist', 'clinical.labCases.list']),
      cap('referrals', 'Referrals', ['clinical.referrals.worklist', 'clinical.referrals.list']),
    ],
  },
  {
    area: 'financial',
    label: 'Financial',
    capabilities: [
      cap('ledger', 'Ledger and balances', [
        'billing.ledger.list',
        'billing.balances.read',
        'billing.charges.read',
        'billing.payments.read',
      ]),
      cap('claims', 'Claims', [
        'rcm.claims.queues',
        'rcm.claims.worklist',
        'rcm.claims.read',
        'rcm.claims.measures',
      ]),
      cap('coverage', 'Coverage and eligibility', ['rcm.coverages.resolve', 'rcm.coverages.read']),
      cap('plansAndStatements', 'Payment plans and statements', [
        'billing.plans.worklist',
        'billing.plans.read',
        'billing.statements.read',
      ]),
      cap('receivables', 'Receivables', ['billing.reports.receivables', 'billing.worklist.list']),
    ],
  },
  {
    area: 'communications',
    label: 'Communications',
    capabilities: [
      cap('messages', 'Messages', [
        'messaging.threads.worklist',
        'messaging.threads.list',
        'messaging.threads.read',
      ]),
      cap('deliveries', 'Deliveries', [
        'communications.deliveries.worklist',
        'communications.deliveries.read',
      ]),
      cap('consents', 'Contact consent', [
        'communications.consents.list',
        'communications.channelPolicies.list',
      ]),
      cap('intake', 'Intake forms', ['intake.reviews.worklist', 'intake.submissions.list']),
      cap('telephony', 'Calls', ['telephony.calls.list', 'telephony.calls.read']),
    ],
  },
  {
    area: 'imaging',
    label: 'Imaging',
    capabilities: [
      cap('objects', 'Images and documents', ['imaging.objects.list', 'imaging.objects.read']),
      cap('associations', 'Unmatched images', [
        'imaging.associations.unmatched',
        'imaging.associations.candidates',
      ]),
      cap('devices', 'Imaging devices', ['imaging.devices.list', 'imaging.devices.read']),
      cap('retention', 'Retention and legal holds', [
        'imaging.retention.policies',
        'imaging.legalHolds.list',
      ]),
    ],
  },
  {
    area: 'administration',
    label: 'Administration',
    capabilities: [
      cap('locations', 'Locations and resources', ['scheduling.locations.list', 'scheduling.resources.list']),
      cap('portalAccess', 'Portal access', ['portal.principals.read', 'portal.grants.list']),
      cap('vocabularies', 'State vocabularies', ['vocabularies.list', 'vocabularies.read']),
      cap('analytics', 'Measures', ['analytics.measures.list', 'analytics.measures.read']),
      cap('operations', 'Operational alerts', ['operations.alerts.list']),
    ],
  },
  {
    area: 'migration',
    label: 'Migration',
    capabilities: [
      cap('review', 'Migration review', ['migration.reviewItems.list', 'migration.reports.read']),
      cap('openingItems', 'Opening balances', ['migration.openingItems.list']),
      cap('archive', 'Source archive', ['migration.archive.read']),
    ],
  },
];
