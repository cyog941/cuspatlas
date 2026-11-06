/**
 * Audited application-clock reads (clock audit, scripts/clock-guard.test.ts). Each entry is one read
 * that scripts/clock-scan.ts finds in the TypeScript AST (`now` of the global `Date` in any spelling,
 * or a bare `new Date()`), keyed by its file, its enclosing named function chain (`<module>` at the
 * top level), its kind and its 0-based occurrence index of that kind within the function, with why
 * the host clock is safe there. Class (a) only: every mixed-clock (b) and precision (c) use was moved
 * to the database clock (packages/domain/src/clock.ts). Adding an entry is a review decision, not a way
 * to pass the guard.
 */
export interface ClockAllowlistEntry {
  readonly file: string;
  readonly fn: string;
  readonly kind: 'Date.now' | 'new Date()';
  readonly index: number;
  readonly reason: string;
}

export const CLOCK_ALLOWLIST: readonly ClockAllowlistEntry[] = [
  {
    file: 'apps/api/src/device-auth.ts',
    fn: 'createDeviceAuthenticator.authenticate',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'apps/api/src/list-envelope-hook.ts',
    fn: 'registerListEnvelope.readHandler',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'apps/api/src/pair-throttle.ts',
    fn: 'PairThrottle.check',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'apps/api/src/pair-throttle.ts',
    fn: 'PairThrottle.recordFailure',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'apps/mcp/src/server.ts',
    fn: 'buildMcpServer.callTool',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'apps/worker/src/compose.ts',
    fn: 'composeWorker.tick.verify',
    kind: 'Date.now',
    index: 0,
    reason: '(a) synthetic fake adapter event time or a unique name suffix; not compared with stored facts',
  },
  {
    file: 'packages/db/src/backup-verify.ts',
    fn: 'verifyBackup',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/backup-verify.ts',
    fn: 'verifyBackup',
    kind: 'Date.now',
    index: 1,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/backup.ts',
    fn: 'createBackup',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/db/src/object-store-backup.ts',
    fn: 'backupObjectStore',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    fn: 'createLocalObjectStore.verifyOpen',
    kind: 'Date.now',
    index: 0,
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    fn: 'createLocalObjectStore.verifyOpen',
    kind: 'Date.now',
    index: 1,
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    fn: 'createLocalObjectStore.writeTombstone',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    fn: 'createLocalStagingMaintenance.listStagedOlderThan',
    kind: 'Date.now',
    index: 0,
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    fn: 'createLocalStagingMaintenance.removeContentIfOlderThan',
    kind: 'Date.now',
    index: 0,
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    fn: 'touch',
    kind: 'new Date()',
    index: 0,
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    fn: 'runRestoreDrill',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    fn: 'runRestoreDrill',
    kind: 'Date.now',
    index: 1,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    fn: 'runRestoreDrill',
    kind: 'Date.now',
    index: 2,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    fn: 'runRestoreDrill',
    kind: 'Date.now',
    index: 3,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/security-attempts.ts',
    fn: 'createSecurityAttemptSink.record',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) schema-validation placeholder only; the stored instant is the database now() (clock audit fix)',
  },
  {
    file: 'packages/domain/src/administration/administration.ts',
    fn: 'createAdministrationOperations.reviewAccess',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/administration/administration.ts',
    fn: 'createAdministrationOperations.searchAudit',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/agents/ai.ts',
    fn: 'createAiPipeline.readAiDraft',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/agents/ai.ts',
    fn: 'createAiPipeline.readAiDraft',
    kind: 'new Date()',
    index: 1,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/agents/governance.ts',
    fn: 'createAgentGovernance.recordConsent',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/principals.ts',
    fn: 'createAgentPrincipals.createAgentPrincipal',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/principals.ts',
    fn: 'createAgentPrincipals.createAgentPrincipal',
    kind: 'Date.now',
    index: 1,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/workspace.ts',
    fn: 'createAgentWorkspace.recordAgentTaskPolicy',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/workspace.ts',
    fn: 'createAgentWorkspace.recordAgentTaskPolicy',
    kind: 'Date.now',
    index: 1,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/workspace.ts',
    fn: 'createAgentWorkspace.scheduleAgentTask',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/automation/exports.ts',
    fn: 'createExportOperations.build',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/automation/exports.ts',
    fn: 'createExportOperations.revokeExportGrant',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/automation/webhooks.ts',
    fn: 'createWebhookOperations.dispatchWebhookDeliveries',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/automation/webhooks.ts',
    fn: 'createWebhookOperations.listWebhookEventTypes',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/billing/adjustments.ts',
    fn: 'createAdjustmentOperations.receivablesReport',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/billing/entries.ts',
    fn: 'patientBalanceIn',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/billing/plans.ts',
    fn: 'createPlanOperations.listPlanWorklist',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/billing/worklist.ts',
    fn: 'createWorklistOperations.listWorklist',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/clinical/estimates.ts',
    fn: 'createEstimateOperations.acceptEstimate',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) ages a caller-entered coverage sourceAsOf against a 30-day window; no database-stamped fact (the B5 fresh_until check moved to transactionNow)',
  },
  {
    file: 'packages/domain/src/clinical/estimates.ts',
    fn: 'createEstimateOperations.generateEstimate',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) ages a caller-entered coverage sourceAsOf against a 30-day window; no database-stamped fact (the B5 fresh_until check moved to transactionNow)',
  },
  {
    file: 'packages/domain/src/clinical/estimates.ts',
    fn: 'createEstimateOperations.generateEstimate',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/clinical/estimates.ts',
    fn: 'createEstimateOperations.presentEstimate',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) ages a caller-entered coverage sourceAsOf against a 30-day window; no database-stamped fact (the B5 fresh_until check moved to transactionNow)',
  },
  {
    file: 'packages/domain/src/clinical/estimates.ts',
    fn: 'project',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) ages a caller-entered coverage sourceAsOf against a 30-day window; no database-stamped fact (the B5 fresh_until check moved to transactionNow)',
  },
  {
    file: 'packages/domain/src/clinical/history.ts',
    fn: 'createHistoryOperations.getActiveAlerts',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/history.ts',
    fn: 'resolveHistoryReference',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/insurer-estimate.ts',
    fn: 'computeInsurerEstimate',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/lab-cases.ts',
    fn: 'createLabCaseOperations.exportLabCase',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/lab-cases.ts',
    fn: 'createLabCaseOperations.labWorklist',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/clinical/lab-cases.ts',
    fn: 'view',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    fn: 'createReferralOperations.exportReferral',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    fn: 'createReferralOperations.recordReferralShare',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    fn: 'createReferralOperations.recordReferralShare',
    kind: 'Date.now',
    index: 1,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    fn: 'createReferralOperations.referralWorklist',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    fn: 'view',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/engagement/communications/consent.ts',
    fn: 'createConsentOperations.previewSuppression',
    kind: 'new Date()',
    index: 0,
    reason: '(a) quiet-hours preview instant against a wall-clock policy window; no stored fact compared',
  },
  {
    file: 'packages/domain/src/engagement/communications/recall-enrollment.ts',
    fn: 'createRecallEnrollmentOperations.listRecallEnrollments',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/engagement/portal/session.ts',
    fn: 'createPortalSessionOperations.readPortalSession',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/events/record-command.ts',
    fn: 'recordCommand',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) schema-validation placeholder only; the stored instant is the database now() (clock audit fix)',
  },
  {
    file: 'packages/domain/src/imaging/bridge-update.ts',
    fn: 'verifyUpdateManifest',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/imaging/bridge.ts',
    fn: 'createBridgeOperations.reportJobResult',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/imaging/orphan-bytes.ts',
    fn: 'createOrphanBytesOperations.finishOne',
    kind: 'Date.now',
    index: 0,
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/domain/src/imaging/orphan-bytes.ts',
    fn: 'createOrphanBytesOperations.run',
    kind: 'Date.now',
    index: 0,
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/domain/src/migration/operations.ts',
    fn: 'createOperationsReadiness.lastBackupVerification',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/patients/identity.ts',
    fn: 'createIdentityCommands.setPatientStatus',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/patients/merge-confirmation.ts',
    fn: 'createMergeConfirmationCodec',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/patients/model.ts',
    fn: 'checkBirthDate',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/policy/patient-access.ts',
    fn: 'evaluatePatientAccess',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/preferences/preferences.ts',
    fn: 'ENVELOPE',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/rcm/clearinghouse.ts',
    fn: 'createFakeClearinghouse.poll',
    kind: 'new Date()',
    index: 0,
    reason: '(a) synthetic fake adapter event time or a unique name suffix; not compared with stored facts',
  },
  {
    file: 'packages/domain/src/rcm/coverage.ts',
    fn: 'createCoverageOperations.resolveCoverage',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/rcm/workflow.ts',
    fn: 'createWorkflowOperations.advance',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/domain/src/rcm/workflow.ts',
    fn: 'createWorkflowOperations.advance',
    kind: 'Date.now',
    index: 1,
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/domain/src/reporting/measures.ts',
    fn: 'createMeasureReads.listMeasures',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/availability.ts',
    fn: 'searchAvailabilityIn',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/availability.ts',
    fn: 'searchAvailabilityIn',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/booking.ts',
    fn: 'checkWindow',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/floor.ts',
    fn: 'envelopeOf',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/recall.ts',
    fn: 'createRecallOperations.createRecallTask',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/recall.ts',
    fn: 'createRecallOperations.recallDue',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/recurrence.ts',
    fn: 'createRecurrenceOperations.endSeries',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/requests.ts',
    fn: 'createRequestOperations.unbookedRequests',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/scheduling/resources.ts',
    fn: 'createSchedulingResourceService.stateLabelledResources',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/scheduling/staging.ts',
    fn: 'createStagingOperations.listStaging',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/visit-context.ts',
    fn: 'createVisitContextOperations.getVisitContext',
    kind: 'new Date()',
    index: 0,
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/scheduling/waitlist.ts',
    fn: 'createWaitlistOperations.executeRecovery',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/waitlist.ts',
    fn: 'createWaitlistOperations.grantStandingPolicy',
    kind: 'Date.now',
    index: 0,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/scheduling/waitlist.ts',
    fn: 'createWaitlistOperations.grantStandingPolicy',
    kind: 'Date.now',
    index: 1,
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
];
