import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './automation.schema.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/**
 * Workstream A batch 4 contracts: A14 webhook subscriptions and deliveries, A15 the export surface.
 * Synthetic only; the registration model (A-D7) and what "complete" means (A-D8) are
 * recommended-pending-approval (docs/execution/api-progress.md "A batch 4").
 */
export const automationSchema = schema;
export const AUTOMATION_SCHEMA_ID = schema.$id;
export const AUTOMATION_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: string): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateAutomationIdempotencyKey = def('IdempotencyKey');
export const validateAutomationRef = def('Uuid');
export const validateWebhookSubscriptionCreate = def('WebhookSubscriptionCreate');
export const validateWebhookSubscriptionRotate = def('WebhookSubscriptionRotate');
export const validateWebhookSubscriptionRevoke = def('WebhookSubscriptionRevoke');
export const validateWebhookSubscriptionListQuery = def('WebhookSubscriptionListQuery');
export const validateWebhookEventTypeListQuery = def('WebhookEventTypeListQuery');
export const validateWebhookDeliveryListQuery = def('WebhookDeliveryListQuery');
export const validateWebhookFailureListQuery = def('WebhookFailureListQuery');
export const validateWebhookReplay = def('WebhookReplay');

export const validateExportCreate = def('ExportCreate');
export const validateExportListQuery = def('ExportListQuery');
export const validateExportQuery = def('ExportQuery');
export const validateExportGrant = def('ExportGrant');
export const validateExportGrantRevoke = def('ExportGrantRevoke');
export const validateExportDownload = def('ExportDownload');
