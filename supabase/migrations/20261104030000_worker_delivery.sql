-- F Task 6: durable outbox delivery (leases, receipts, dead-letter reasons). Synthetic, non-clinical.
-- The worker leases per tenant as the runtime role under the tenant context of its own service
-- principal (membership with scope outbox.deliver), so no cross-tenant role exists. Grant changes
-- for cuspatlas_app, all explicit: UPDATE on the new outbox column dead_letter_reason, and SELECT,
-- INSERT on delivery_receipts (own tenant only). No UPDATE or DELETE on receipts for any grant.

-- Correction to 20261104010000_audit_outbox.sql (applied migrations are immutable): that file says the
-- trigger refuses UPDATE and DELETE "for every role, owner included". It refuses them for every role
-- that cannot disable or drop the trigger. The table owner and superusers can still disable it.
COMMENT ON TRIGGER audit_events_append_only ON cuspatlas.audit_events IS
  'Refuses UPDATE and DELETE for every role that cannot disable or drop this trigger (the runtime role included). The table owner and superusers can still ALTER TABLE .. DISABLE TRIGGER or drop it; tamper evidence against privileged roles is a deployment gate, not provided here.';

-- Dead-letter review: why an event stopped. Present exactly when state = dead_letter.
ALTER TABLE cuspatlas.outbox_events
  ADD COLUMN dead_letter_reason text CHECK (dead_letter_reason IN (
    'membership_revoked', 'authorization_denied', 'max_attempts_exhausted', 'provider_rejected',
    'reconciliation_exhausted'));
ALTER TABLE cuspatlas.outbox_events
  ADD CONSTRAINT outbox_events_dead_letter_reason CHECK ((state = 'dead_letter') = (dead_letter_reason IS NOT NULL));
-- A lease always has an expiry, so an abandoned lease is always recoverable.
ALTER TABLE cuspatlas.outbox_events
  ADD CONSTRAINT outbox_events_lease_expiry CHECK (state <> 'leased' OR leased_until IS NOT NULL);
-- Target for the tenant-consistent receipt foreign key below.
ALTER TABLE cuspatlas.outbox_events ADD CONSTRAINT outbox_events_id_tenant UNIQUE (id, tenant_id);
CREATE INDEX outbox_events_lease_expiry_idx ON cuspatlas.outbox_events (state, leased_until);

GRANT UPDATE (dead_letter_reason) ON cuspatlas.outbox_events TO cuspatlas_app;

-- Provider receipts keyed by delivery key (= outbox event id). A provider that answers the same
-- delivery key twice (duplicate, reconciliation, late response) reports the same receipt id, which is
-- stored once. Receipts reference the event in the same tenant.
CREATE TABLE cuspatlas.delivery_receipts (
  event_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  provider_receipt_id text NOT NULL CHECK (provider_receipt_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  outcome text NOT NULL CHECK (outcome IN ('delivered', 'duplicate', 'reconciled')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, provider_receipt_id),
  FOREIGN KEY (event_id, tenant_id) REFERENCES cuspatlas.outbox_events (id, tenant_id)
);

ALTER TABLE cuspatlas.delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.delivery_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_receipts_select ON cuspatlas.delivery_receipts
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY delivery_receipts_insert ON cuspatlas.delivery_receipts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.delivery_receipts TO cuspatlas_app;
