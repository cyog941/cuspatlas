-- B1: append-only double-entry journal (synthetic data only; ADR 0008, recommended-pending-billing-approval).
-- Money is an integer count of minor units (bigint) beside an explicit ISO 4217 currency. Posted
-- entries and lines are never updated or deleted: the runtime role may only read and append, and
-- every correction is a reversal entry that exactly negates its original. Balances are derived from
-- the lines; no balance column exists anywhere.

-- Per-tenant billing configuration. No write command exists until practice configuration
-- (admin.configure) does; a tenant without a row uses the defaults (USD, 7 days).
CREATE TABLE cuspatlas.billing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES cuspatlas.tenants (id),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  unapplied_escalation_days integer NOT NULL DEFAULT 7 CHECK (unapplied_escalation_days BETWEEN 1 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A charge aggregate. Its facts are immutable; only the version (the serialization point for
-- allocations, transfers and reversals) changes. Charges are posted from a synthetic procedure
-- reference until C14 drives this command with rendered-procedure facts.
CREATE TABLE cuspatlas.billing_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('synthetic_procedure_seam')),
  procedure_ref text NOT NULL CHECK (procedure_ref ~ '^syn-proc-[a-z0-9-]{1,60}$'),
  procedure_code text CHECK (procedure_code ~ '^SYN-[A-Z0-9]{1,12}$'),
  service_date date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- A replacement names the reversed charge it replaces. No self foreign key (row-by-row restore
  -- order); the domain checks it inside the posting transaction and the unique index below keeps
  -- each charge replaced at most once.
  replaces_charge_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (replaces_charge_id IS NULL OR replaces_charge_id <> id)
);
CREATE UNIQUE INDEX billing_charges_one_original
  ON cuspatlas.billing_charges (tenant_id, procedure_ref) WHERE replaces_charge_id IS NULL;
CREATE UNIQUE INDEX billing_charges_one_replacement
  ON cuspatlas.billing_charges (tenant_id, replaces_charge_id) WHERE replaces_charge_id IS NOT NULL;
CREATE INDEX billing_charges_patient ON cuspatlas.billing_charges (tenant_id, patient_id);

CREATE TABLE cuspatlas.billing_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  kind text NOT NULL CONSTRAINT billing_journal_entries_kind CHECK (kind IN ('charge', 'patientPayment',
    'insurerPayment', 'adjustment', 'refund', 'writeOff', 'transfer', 'openingBalance', 'allocation',
    'settlement', 'responsibilityTransfer')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Exactly this many lines belong to the entry (checked at commit), so no line can be added later.
  line_count smallint NOT NULL CHECK (line_count BETWEEN 2 AND 64),
  charge_id uuid,
  -- Owning payment (B2 adds the payments table and its foreign key).
  payment_id uuid,
  -- No self foreign key (restore order); existence, kind and exact negation are checked at commit.
  reverses_entry_id uuid,
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  service_date date,
  -- Synthetic opaque external reference (deposit, refund); never caller free text.
  external_ref text CHECK (external_ref ~ '^syn-[a-z0-9-]{1,60}$'),
  posted_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  correlation_id uuid NOT NULL,
  FOREIGN KEY (charge_id, tenant_id) REFERENCES cuspatlas.billing_charges (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, currency),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id),
  CHECK (reverses_entry_id IS NULL OR reason_code IS NOT NULL)
);
-- At most one reversal per entry: two concurrent reversals cannot both commit.
CREATE UNIQUE INDEX billing_journal_one_reversal
  ON cuspatlas.billing_journal_entries (tenant_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX billing_journal_entries_charge ON cuspatlas.billing_journal_entries (tenant_id, charge_id);
CREATE INDEX billing_journal_entries_posted ON cuspatlas.billing_journal_entries (tenant_id, posted_at, id);

CREATE TABLE cuspatlas.billing_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 64),
  account text NOT NULL CONSTRAINT billing_journal_lines_account CHECK (account IN ('patient_receivable',
    'insurer_receivable', 'production_revenue')),
  -- Signed: debit positive, credit negative. Never zero.
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND amount_minor BETWEEN -99999999999 AND 99999999999),
  currency text NOT NULL,
  patient_id uuid NOT NULL,
  charge_id uuid,
  -- Payment dimension (B2 adds its foreign key and the cash and unapplied accounts).
  payment_id uuid,
  payer_ref text CHECK (payer_ref ~ '^syn-payer-[a-z0-9-]{1,40}$'),
  FOREIGN KEY (entry_id, tenant_id, currency)
    REFERENCES cuspatlas.billing_journal_entries (id, tenant_id, currency),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (charge_id, tenant_id) REFERENCES cuspatlas.billing_charges (id, tenant_id),
  UNIQUE (tenant_id, entry_id, line_no),
  CONSTRAINT billing_journal_lines_dimensions CHECK (CASE account
    WHEN 'patient_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NULL
    WHEN 'insurer_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NOT NULL
    WHEN 'production_revenue' THEN charge_id IS NOT NULL AND payer_ref IS NULL
    ELSE false END)
);
CREATE INDEX billing_journal_lines_entry ON cuspatlas.billing_journal_lines (tenant_id, entry_id);
CREATE INDEX billing_journal_lines_patient ON cuspatlas.billing_journal_lines (tenant_id, patient_id);
CREATE INDEX billing_journal_lines_charge ON cuspatlas.billing_journal_lines (tenant_id, charge_id, account);

-- Commit-time invariants of one entry: declared line count, at least two lines, zero sum, exact
-- negation of the original for a reversal, and the per-dimension sign rules. Runs as the inserting
-- role (RLS applies; the tenant column is compared explicitly as well).
CREATE FUNCTION cuspatlas.billing_check_entry(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    e cuspatlas.billing_journal_entries%ROWTYPE;
    o cuspatlas.billing_journal_entries%ROWTYPE;
    n integer;
    s bigint;
    bad integer;
  BEGIN
    SELECT * INTO e FROM cuspatlas.billing_journal_entries WHERE id = p_entry AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'journal line without a visible entry' USING ERRCODE = '23503';
    END IF;
    SELECT count(*), coalesce(sum(amount_minor), 0) INTO n, s
      FROM cuspatlas.billing_journal_lines WHERE entry_id = p_entry AND tenant_id = p_tenant;
    IF n <> e.line_count OR n < 2 THEN
      RAISE EXCEPTION 'journal entry line count does not match its declaration' USING ERRCODE = '23514';
    END IF;
    IF s <> 0 THEN
      RAISE EXCEPTION 'journal entry is unbalanced' USING ERRCODE = '23514';
    END IF;
    IF e.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO o FROM cuspatlas.billing_journal_entries WHERE id = e.reverses_entry_id AND tenant_id = p_tenant;
      IF NOT FOUND OR o.reverses_entry_id IS NOT NULL OR o.kind <> e.kind OR o.currency <> e.currency
          OR o.line_count <> e.line_count OR o.charge_id IS DISTINCT FROM e.charge_id
          OR o.payment_id IS DISTINCT FROM e.payment_id THEN
        RAISE EXCEPTION 'reversal does not match a reversible original' USING ERRCODE = '23514';
      END IF;
      SELECT count(*) INTO bad FROM (
        (SELECT account, -amount_minor AS amount_minor, patient_id, charge_id, payment_id, payer_ref
           FROM cuspatlas.billing_journal_lines WHERE entry_id = o.id AND tenant_id = p_tenant
         EXCEPT ALL
         SELECT account, amount_minor, patient_id, charge_id, payment_id, payer_ref
           FROM cuspatlas.billing_journal_lines WHERE entry_id = e.id AND tenant_id = p_tenant)
        UNION ALL
        (SELECT account, amount_minor, patient_id, charge_id, payment_id, payer_ref
           FROM cuspatlas.billing_journal_lines WHERE entry_id = e.id AND tenant_id = p_tenant
         EXCEPT ALL
         SELECT account, -amount_minor, patient_id, charge_id, payment_id, payer_ref
           FROM cuspatlas.billing_journal_lines WHERE entry_id = o.id AND tenant_id = p_tenant)) d;
      IF bad <> 0 THEN
        RAISE EXCEPTION 'reversal does not exactly negate its original' USING ERRCODE = '23514';
      END IF;
    END IF;
    PERFORM cuspatlas.billing_check_signs(p_tenant, p_entry);
  END
  $$;

-- Sign rules per dimension touched by the entry. Receivables never fall below zero (no
-- over-allocation, no over-transfer); revenue never becomes a debit.
CREATE FUNCTION cuspatlas.billing_check_signs(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v integer;
  BEGIN
    SELECT count(*) INTO v FROM (
      SELECT t.account, t.charge_id, t.payer_ref
      FROM (SELECT DISTINCT account, charge_id, payer_ref FROM cuspatlas.billing_journal_lines
            WHERE entry_id = p_entry AND tenant_id = p_tenant) t
      JOIN cuspatlas.billing_journal_lines l ON l.tenant_id = p_tenant AND l.account = t.account
        AND l.charge_id IS NOT DISTINCT FROM t.charge_id AND l.payer_ref IS NOT DISTINCT FROM t.payer_ref
      GROUP BY t.account, t.charge_id, t.payer_ref
      HAVING (t.account IN ('patient_receivable', 'insurer_receivable') AND sum(l.amount_minor) < 0)
          OR (t.account = 'production_revenue' AND sum(l.amount_minor) > 0)) x;
    IF v <> 0 THEN
      RAISE EXCEPTION 'journal entry breaks an account sign rule' USING ERRCODE = '23514';
    END IF;
  END
  $$;

CREATE FUNCTION cuspatlas.billing_entry_committed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN PERFORM cuspatlas.billing_check_entry(NEW.tenant_id, NEW.id); RETURN NULL; END $$;
CREATE FUNCTION cuspatlas.billing_line_committed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN PERFORM cuspatlas.billing_check_entry(NEW.tenant_id, NEW.entry_id); RETURN NULL; END $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_check_entry(uuid, uuid), cuspatlas.billing_check_signs(uuid, uuid),
  cuspatlas.billing_entry_committed(), cuspatlas.billing_line_committed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.billing_check_entry(uuid, uuid), cuspatlas.billing_check_signs(uuid, uuid)
  TO cuspatlas_app;

CREATE CONSTRAINT TRIGGER billing_journal_entries_balanced
  AFTER INSERT ON cuspatlas.billing_journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_entry_committed();
CREATE CONSTRAINT TRIGGER billing_journal_lines_balanced
  AFTER INSERT ON cuspatlas.billing_journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_line_committed();

CREATE TRIGGER billing_journal_entries_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_journal_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER billing_journal_lines_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_journal_lines
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER billing_settings_append_only
  BEFORE DELETE ON cuspatlas.billing_settings
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Charge facts are immutable; only the version moves, by exactly one. Never deleted.
CREATE FUNCTION cuspatlas.billing_aggregate_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'billing aggregates are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - 'version' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'updated_at') THEN
      RAISE EXCEPTION 'posted billing facts are immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'billing aggregate version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_aggregate_guard() FROM PUBLIC;
CREATE TRIGGER billing_charges_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_charges
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_aggregate_guard();

ALTER TABLE cuspatlas.billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_charges FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_journal_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_settings_select ON cuspatlas.billing_settings
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY billing_charges_select ON cuspatlas.billing_charges
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_charges_insert ON cuspatlas.billing_charges
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY billing_charges_update ON cuspatlas.billing_charges
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY billing_journal_entries_select ON cuspatlas.billing_journal_entries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_journal_entries_insert ON cuspatlas.billing_journal_entries
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND posted_by = cuspatlas.current_actor_id());
CREATE POLICY billing_journal_lines_select ON cuspatlas.billing_journal_lines
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_journal_lines_insert ON cuspatlas.billing_journal_lines
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

-- Explicit grants: read and append only on the journal; only the version column of a charge moves.
GRANT SELECT ON cuspatlas.billing_settings TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.billing_charges TO cuspatlas_app;
GRANT UPDATE (version, updated_at) ON cuspatlas.billing_charges TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.billing_journal_entries TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.billing_journal_lines TO cuspatlas_app;
