-- A14 (merged into backend integration) adds webhooks.read, which the read-only webhook lists admit
-- for a service principal. The database ceiling must equal the generated AGENT_SCOPE_CEILING
-- (asserted in api-agent-identity.test.ts). Every webhook mutation and every export stays human only.
CREATE OR REPLACE FUNCTION cuspatlas.agent_scope_ceiling() RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
  AS $$
    SELECT ARRAY[
      'actions.prepare',
      'actions.read',
      'admin.configure',
      'agentWorkspace.read',
      'agentWorkspace.write',
      'agents.read',
      'ai.draft',
      'ai.read',
      'analytics.read',
      'billing.write',
      'clinical.read',
      'communications.deliver',
      'communications.read',
      'communications.receipts',
      'communications.write',
      'coverage.read',
      'coverage.write',
      'imaging.read',
      'imaging.write',
      'ledger.read',
      'messaging.read',
      'migration.read',
      'migration.write',
      'openClaims.read',
      'outbox.deliver',
      'patients.read',
      'patients.write',
      'paymentDistribution.read',
      'portal.manage',
      'receivables.read',
      'scheduling.read',
      'scheduling.write',
      'syntheticTasks.read',
      'syntheticTasks.write',
      'telephony.events',
      'undistributedFunds.read',
      'webhooks.read'
    ]::text[]
  $$;
