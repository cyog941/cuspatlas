-- Integration of A batch 3 with H3 (synthetic implementation, pending approval): A16 adds
-- `analytics.read`, a scope service principals may hold, so it becomes grantable to an agent. The
-- database ceiling must equal the generated AGENT_SCOPE_CEILING (asserted in
-- api-agent-identity.test.ts); 20261203000000 is applied and stays unchanged.
CREATE OR REPLACE FUNCTION cuspatlas.agent_scope_ceiling() RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
  AS $$
    SELECT ARRAY[
      'actions.prepare',
      'actions.read',
      'admin.configure',
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
      'undistributedFunds.read'
    ]::text[]
  $$;
