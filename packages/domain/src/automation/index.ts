import { type AutomationBaseDeps, createAutomationBase } from './base';
import { createExportOperations, type ExportDeps } from './exports';
import { createWebhookOperations, type WebhookDeps } from './webhooks';

export {
  AUTOMATION_EXPORT_CODECS,
  buildScopedManifest,
  EXPORT_DOMAINS,
  EXPORT_FORMAT,
  type ExportBuildOutcome,
  type ExportDeps,
  type ExportPracticePort,
  type ExportRequestView,
  filterPatientDocuments,
  PATIENT_EXPORT_LINKAGE,
  type PatientLink,
  type ScopedExportValidation,
  type ScopedManifest,
  type ScopedPackage,
  validateScopedExport,
} from './exports';
export * from './webhook-catalog';
export * from './webhook-guard';
export * from './webhook-signing';
export {
  AUTOMATION_WEBHOOK_CODECS,
  resolveWebhookPort,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookDeliveryPort,
  type WebhookDeliveryView,
  type WebhookDeps,
  type WebhookSendRequest,
  type WebhookSendResult,
  type WebhookSubscriptionView,
} from './webhooks';

export interface AutomationDeps extends AutomationBaseDeps {
  readonly webhooks?: WebhookDeps;
  readonly exports?: ExportDeps;
}

/** Workstream A batch 4: A14 webhooks (and A15 exports), one service for REST, MCP and the worker. */
export function createAutomationService(deps: AutomationDeps) {
  const base = createAutomationBase(deps);
  return {
    ...createWebhookOperations(base, deps.webhooks ?? {}),
    ...createExportOperations(base, deps.exports),
  };
}
export type AutomationService = ReturnType<typeof createAutomationService>;
