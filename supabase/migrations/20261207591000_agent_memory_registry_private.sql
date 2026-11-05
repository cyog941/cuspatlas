-- Closeout D review fixes (synthetic engineering implementation, recommended-pending-approval): the agent
-- memory registry is not readable by the runtime role. Every cuspatlas table stays invisible to the runtime
-- role without tenant context (the restore verification and the default-deny isolation rule); the registry
-- is read only by the SECURITY DEFINER guard agent_memory_registry_guard, like the PHI policy guard, and is
-- written only by the migrator (syncAgentMemoryRegistry).
DROP POLICY agent_memory_registry_read ON cuspatlas.agent_memory_registry;
REVOKE ALL ON cuspatlas.agent_memory_registry FROM cuspatlas_app;
