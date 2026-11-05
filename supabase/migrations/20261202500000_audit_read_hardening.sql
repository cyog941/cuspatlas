-- A batch 3 hardening (synthetic only). Correction to 20261202010000_administration.sql: its header said
-- the runtime role could not read audit rows or sensitive reads, but the earlier tenant SELECT grants and
-- policies (20261104010000 audit_events_select, 20261105000000 sensitive_read_events_select) still let
-- cuspatlas_app read every audit and sensitive-read row of the current tenant. This migration removes
-- that: cuspatlas_app keeps INSERT only (append through record-command / record-sensitive-read, which use
-- no RETURNING), and every read goes through cuspatlas.admin_audit_search, the SECURITY DEFINER function
-- bound to the current tenant that rechecks a live human membership with audit.read. No application
-- reader of these tables exists outside that function.
REVOKE SELECT ON cuspatlas.audit_events FROM cuspatlas_app;
REVOKE SELECT ON cuspatlas.sensitive_read_events FROM cuspatlas_app;
DROP POLICY audit_events_select ON cuspatlas.audit_events;
DROP POLICY sensitive_read_events_select ON cuspatlas.sensitive_read_events;

COMMENT ON TABLE cuspatlas.audit_events IS
  'Append-only committed-change audit. cuspatlas_app may INSERT only; reads only via cuspatlas.admin_audit_search (definer, audit.read rechecked).';
COMMENT ON TABLE cuspatlas.sensitive_read_events IS
  'Append-only sensitive-read log. cuspatlas_app may INSERT only; reads only via cuspatlas.admin_audit_search (definer, audit.read rechecked).';
