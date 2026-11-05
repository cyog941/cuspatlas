-- Hardening of B6, B7 and B9 after independent review of 6ee7f65 (synthetic data only; fake
-- clearinghouse only; ADR 0008 pending billing approval).

-- 1. A procedure is on at most one open claim lineage per coverage rank. A hold is taken when a claim
--    (or its replacement) names the procedure and released only when a replacement of the same
--    lineage drops it; the partial unique index is the database backstop of the domain 409.
CREATE TABLE cuspatlas.rcm_claim_procedure_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  procedure_id uuid NOT NULL,
  benefit_rank smallint NOT NULL CHECK (benefit_rank BETWEEN 1 AND 3),
  claim_id uuid NOT NULL,
  version_id uuid NOT NULL,
  released_by_version_id uuid,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.rcm_claim_versions (id, tenant_id),
  FOREIGN KEY (released_by_version_id, tenant_id) REFERENCES cuspatlas.rcm_claim_versions (id, tenant_id),
  CHECK ((released_at IS NULL) = (released_by_version_id IS NULL))
);
CREATE UNIQUE INDEX rcm_claim_procedure_holds_open
  ON cuspatlas.rcm_claim_procedure_holds (tenant_id, procedure_id, benefit_rank) WHERE released_at IS NULL;
CREATE FUNCTION cuspatlas.rcm_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['released_at', 'released_by_version_id'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at', 'released_by_version_id'])
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_versions v
                      WHERE v.id = NEW.released_by_version_id AND v.tenant_id = NEW.tenant_id
                        AND v.claim_id = OLD.claim_id) THEN
      RAISE EXCEPTION 'a claim hold is released once, by a version of its own claim' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.rcm_hold_guard() FROM PUBLIC;
CREATE TRIGGER rcm_claim_procedure_holds_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_claim_procedure_holds
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.rcm_hold_guard();
-- Existing claims hold their head-version procedures (rank from the coverage's latest version).
INSERT INTO cuspatlas.rcm_claim_procedure_holds (tenant_id, procedure_id, benefit_rank, claim_id, version_id)
SELECT DISTINCT ON (l.tenant_id, l.procedure_id, cv.benefit_rank) l.tenant_id, l.procedure_id, cv.benefit_rank, c.id, v.id
FROM cuspatlas.rcm_claims c
JOIN LATERAL (SELECT * FROM cuspatlas.rcm_claim_versions x WHERE x.claim_id = c.id ORDER BY x.version_no DESC LIMIT 1) v ON true
JOIN cuspatlas.rcm_claim_lines l ON l.version_id = v.id
JOIN LATERAL (SELECT benefit_rank FROM cuspatlas.rcm_coverage_versions y WHERE y.coverage_id = c.coverage_id
              ORDER BY y.coverage_version DESC LIMIT 1) cv ON true
ORDER BY l.tenant_id, l.procedure_id, cv.benefit_rank, c.created_at;

-- 2. A manual contractual adjustment is a request tied to an adjudicated claim, approved by another
--    human (service principals post contractual amounts only through the remittance path).
ALTER TABLE cuspatlas.billing_adjustment_requests DROP CONSTRAINT billing_adjustment_requests_kind_check;
ALTER TABLE cuspatlas.billing_adjustment_requests
  ADD COLUMN claim_id uuid,
  ADD CONSTRAINT billing_adjustment_requests_kind_check CHECK (kind IN ('contractual', 'courtesy', 'writeOff')),
  ADD CONSTRAINT billing_adjustment_requests_claim FOREIGN KEY (claim_id, tenant_id)
    REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  ADD CONSTRAINT billing_adjustment_requests_contractual CHECK ((kind = 'contractual') = (claim_id IS NOT NULL)
    AND (kind <> 'contractual' OR responsibility = 'insurer'));

-- 3. A submission left `pending` by a crash carries a call deadline; after it, the outcome is resolved
--    once by lookup with the same key (never a new submission).
ALTER TABLE cuspatlas.rcm_claim_submissions ADD COLUMN call_deadline timestamptz;
CREATE OR REPLACE FUNCTION cuspatlas.rcm_submission_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    lifecycle text[] := ARRAY['outcome', 'transport_ref', 'rejection_code', 'resolved_by_lookup', 'version',
      'updated_at'];
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'claim submissions are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 OR (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle)
       OR NOT ((OLD.outcome = 'pending' AND NEW.outcome <> 'pending' AND NOT NEW.resolved_by_lookup)
            OR (OLD.outcome = 'pending' AND NEW.outcome IN ('transmitted', 'rejected') AND NEW.resolved_by_lookup
                AND OLD.call_deadline IS NOT NULL AND now() > OLD.call_deadline)
            OR (OLD.outcome = 'unknown' AND NEW.outcome IN ('transmitted', 'rejected') AND NEW.resolved_by_lookup)) THEN
      RAISE EXCEPTION 'a submission outcome is recorded once (and an unknown one resolved once)' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;

-- 4. An appeal approved while the send outcome was unknown is resolved by lookup (and a send with the
--    same key only when the partner confirms it never received it): one resolution row per appeal.
CREATE TABLE cuspatlas.rcm_appeal_send_resolutions (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  appeal_id uuid NOT NULL,
  sent_ref text NOT NULL CHECK (sent_ref ~ '^syn-appeal-[a-z0-9-]{1,64}$'),
  resolved_by text NOT NULL CHECK (resolved_by IN ('lookup', 'resend_same_key')),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appeal_id, tenant_id) REFERENCES cuspatlas.rcm_appeals (id, tenant_id),
  PRIMARY KEY (tenant_id, appeal_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rcm_claim_procedure_holds', 'rcm_appeal_send_resolutions'] LOOP
    EXECUTE format('ALTER TABLE cuspatlas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cuspatlas.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id())', t || '_insert', t);
    EXECUTE format('GRANT SELECT, INSERT ON cuspatlas.%I TO cuspatlas_app', t);
  END LOOP;
END
$$;
CREATE TRIGGER rcm_appeal_send_resolutions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_appeal_send_resolutions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE POLICY rcm_claim_procedure_holds_update ON cuspatlas.rcm_claim_procedure_holds FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT UPDATE (released_at, released_by_version_id) ON cuspatlas.rcm_claim_procedure_holds TO cuspatlas_app;

-- 5. Actor columns are bound to the transaction actor by RLS (a runtime-role insert cannot name another
--    principal as drafter, reviewer, requester or decider).
DROP POLICY rcm_appeals_insert ON cuspatlas.rcm_appeals;
CREATE POLICY rcm_appeals_insert ON cuspatlas.rcm_appeals FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND drafted_by = cuspatlas.current_actor_id());
DROP POLICY rcm_appeal_reviews_insert ON cuspatlas.rcm_appeal_reviews;
CREATE POLICY rcm_appeal_reviews_insert ON cuspatlas.rcm_appeal_reviews FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND reviewed_by = cuspatlas.current_actor_id());
DROP POLICY billing_adjustment_requests_insert ON cuspatlas.billing_adjustment_requests;
CREATE POLICY billing_adjustment_requests_insert ON cuspatlas.billing_adjustment_requests FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND requested_by = cuspatlas.current_actor_id());
DROP POLICY billing_adjustment_decisions_insert ON cuspatlas.billing_adjustment_decisions;
CREATE POLICY billing_adjustment_decisions_insert ON cuspatlas.billing_adjustment_decisions FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND decided_by = cuspatlas.current_actor_id());
