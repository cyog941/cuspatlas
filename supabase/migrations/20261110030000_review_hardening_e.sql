-- Review hardening of E1-E7 (synthetic data only; every rule recommended-pending-approval).
--
-- 1. The single SuppressionReason vocabulary gains three values (added to the plan first):
--    offer_closed (a waitlist offer accepted, declined, expired or withdrawn before send),
--    subject_past (a reminder whose visit has started by send time) and no_verified_channel (the
--    channel's contact point on the record has no recorded verification).
-- 2. Contact verification facts: E-owned, append-only, keyed to a digest of the normalized contact
--    value (never the value). A changed contact value no longer matches its verification.
-- 3. Receipts that arrive while a message is still sending (no provider reference recorded yet) are
--    stored as pending against the message found by its delivery key, and applied when the send
--    finalizes with the same provider reference.

ALTER TABLE cuspatlas.suppression_decisions DROP CONSTRAINT suppression_decisions_reason_check;
ALTER TABLE cuspatlas.suppression_decisions ADD CONSTRAINT suppression_decisions_reason_check
  CHECK (reason IN ('no_consent', 'opt_out', 'quiet_hours', 'missing_contact', 'policy_off',
    'appointment_cancelled', 'appointment_missing', 'template_withdrawn', 'recall_not_due', 'grant_expired',
    'offer_closed', 'subject_past', 'no_verified_channel'));
ALTER TABLE cuspatlas.outbound_messages DROP CONSTRAINT outbound_messages_suppression_reason_check;
ALTER TABLE cuspatlas.outbound_messages ADD CONSTRAINT outbound_messages_suppression_reason_check
  CHECK (suppression_reason IN ('no_consent', 'opt_out', 'quiet_hours', 'missing_contact', 'policy_off',
    'appointment_cancelled', 'appointment_missing', 'template_withdrawn', 'recall_not_due', 'grant_expired',
    'offer_closed', 'subject_past', 'no_verified_channel'));

CREATE TABLE cuspatlas.contact_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'phone')),
  contact_digest text NOT NULL CHECK (contact_digest ~ '^[0-9a-f]{64}$'),
  method text NOT NULL CHECK (method IN ('synthetic_attested')),
  verified_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id)
);
CREATE INDEX contact_verifications_patient ON cuspatlas.contact_verifications (tenant_id, patient_id, channel);
CREATE TRIGGER contact_verifications_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.contact_verifications
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
ALTER TABLE cuspatlas.contact_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.contact_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_verifications_select ON cuspatlas.contact_verifications
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY contact_verifications_insert ON cuspatlas.contact_verifications
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND verified_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.contact_verifications TO cuspatlas_app;

ALTER TABLE cuspatlas.message_receipts
  ADD COLUMN provider_ref text CHECK (provider_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD COLUMN pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT message_receipts_pending_ref CHECK (NOT pending OR (provider_ref IS NOT NULL AND NOT applied));
