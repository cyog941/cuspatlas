-- C6: structured chart entries per canonical tooth identity (synthetic data only). Semantics are
-- recommended-pending-clinical-approval (ADR 0005: C-D1 canonical identity independent of numbering;
-- C-D2 provisional SYN- vocabulary, no licensed code set; C-S1-Q2 surface values provisional).
-- No diagnosis and no decision support: entries are stored as recorded. Nothing is deleted or
-- rewritten; a correction is a superseding entry with a reason.

-- Independent enforcement shared by clinical tables (C6 onward). Both run as the invoker, so they
-- see only the current tenant's rows through RLS.
-- 1. The authorship snapshot (actor, role, credential) must equal the author's active profile at
--    write time: no application path can claim a role the actor does not hold.
CREATE FUNCTION cuspatlas.clinical_author_snapshot_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    row jsonb := to_jsonb(NEW);
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM cuspatlas.clinical_author_profiles p
      WHERE p.tenant_id = NEW.tenant_id AND p.actor_id = (row ->> TG_ARGV[0])::uuid AND p.active
        AND p.role = row ->> TG_ARGV[1] AND p.credential_ref IS NOT DISTINCT FROM row ->> TG_ARGV[2]
    ) THEN
      RAISE EXCEPTION 'clinical author snapshot does not match an active profile' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_author_snapshot_guard() FROM PUBLIC;

-- 2. A clinical fact that names an encounter needs that encounter to be open.
CREATE FUNCTION cuspatlas.clinical_open_encounter_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    ref uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  BEGIN
    IF ref IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cuspatlas.clinical_encounters e
      WHERE e.id = ref AND e.tenant_id = NEW.tenant_id AND e.state = 'open'
    ) THEN
      RAISE EXCEPTION 'clinical facts cannot name a closed encounter' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_open_encounter_guard() FROM PUBLIC;

-- One chart per source patient. A merge relinks only subject_patient_id (S6); entries reference the
-- chart, never the patient, so a merge cannot touch them, and the chart keeps its source patient.
CREATE TABLE cuspatlas.clinical_charts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  origin_patient_id uuid NOT NULL,
  head_sequence integer NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (tenant_id, origin_patient_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX clinical_charts_subject ON cuspatlas.clinical_charts (tenant_id, subject_patient_id);

CREATE FUNCTION cuspatlas.clinical_charts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'charts are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.origin_patient_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.origin_patient_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'chart identity is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.head_sequence NOT IN (OLD.head_sequence, OLD.head_sequence + 1) THEN
      RAISE EXCEPTION 'chart entries are appended one at a time' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'chart version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_charts_guard() FROM PUBLIC;
CREATE TRIGGER clinical_charts_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_charts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_charts_guard();

-- One entry: a canonical tooth (vocabulary-versioned; a vocabulary change is a new version with a
-- recorded mapping in a later migration, never a rewrite), a surface set, a kind, a provisional
-- SYN- finding code, the stated state, provenance and the authorship snapshot. A correction names
-- the entry it supersedes inside the same chart; one successor per entry (unique), so duplicated
-- corrections of one base keep exactly one. recorded_at is the insert-time clock (after the chart
-- lock), truncated to milliseconds so an as-of read at a returned instant includes it.
CREATE TABLE cuspatlas.clinical_chart_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  chart_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  tooth_canonical_ref text CHECK (tooth_canonical_ref ~ '^(perm-(ur|ul|ll|lr)-[1-8]|prim-(ur|ul|ll|lr)-[1-5]|sn-(ur|ul|ll|lr)-[1-4])$'),
  tooth_vocabulary text CHECK (tooth_vocabulary IN ('cuspatlas-tooth.v1')),
  surfaces text[] CHECK (cardinality(surfaces) BETWEEN 1 AND 7
    AND surfaces <@ ARRAY['M', 'D', 'O', 'I', 'B', 'F', 'L']::text[]),
  kind text NOT NULL CHECK (kind IN ('condition', 'existing_restoration', 'missing', 'supernumerary', 'implant', 'prosthodontic')),
  finding_ref text NOT NULL CHECK (finding_ref ~ '^SYN-[A-Z0-9-]{1,40}$'),
  recorded_state text NOT NULL CHECK (recorded_state IN ('active', 'resolved', 'entered_in_error')),
  detail_text text CHECK (char_length(detail_text) BETWEEN 1 AND 500),
  provenance text NOT NULL CHECK (provenance IN ('recorded', 'imported', 'patient_reported')),
  source_ref text CHECK (source_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  encounter_id uuid,
  supersedes_entry_id uuid,
  correction_reason_code text CHECK (correction_reason_code ~ '^[a-z_]{1,64}$'),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  recorded_by_credential_ref text CHECK (recorded_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (chart_id, tenant_id) REFERENCES cuspatlas.clinical_charts (id, tenant_id),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  FOREIGN KEY (supersedes_entry_id, chart_id, tenant_id)
    REFERENCES cuspatlas.clinical_chart_entries (id, chart_id, tenant_id),
  UNIQUE (chart_id, sequence),
  UNIQUE (id, tenant_id),
  UNIQUE (id, chart_id, tenant_id),
  UNIQUE (tenant_id, supersedes_entry_id),
  CHECK ((tooth_canonical_ref IS NULL) = (tooth_vocabulary IS NULL)),
  CHECK (surfaces IS NULL OR tooth_canonical_ref IS NOT NULL),
  CHECK (provenance <> 'imported' OR source_ref IS NOT NULL),
  CHECK ((supersedes_entry_id IS NULL) = (correction_reason_code IS NULL)),
  CHECK (recorded_state <> 'entered_in_error' OR supersedes_entry_id IS NOT NULL),
  CHECK (kind NOT IN ('missing', 'implant', 'supernumerary', 'existing_restoration') OR tooth_canonical_ref IS NOT NULL),
  CHECK (kind NOT IN ('missing', 'implant', 'supernumerary') OR surfaces IS NULL),
  CHECK (kind <> 'supernumerary' OR tooth_canonical_ref LIKE 'sn-%'),
  CHECK (tooth_canonical_ref IS NULL OR tooth_canonical_ref NOT LIKE 'sn-%' OR kind IN ('supernumerary', 'condition'))
);
CREATE INDEX clinical_chart_entries_chart ON cuspatlas.clinical_chart_entries (tenant_id, chart_id, sequence);

CREATE TRIGGER clinical_chart_entries_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_chart_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_chart_entries_author
  BEFORE INSERT ON cuspatlas.clinical_chart_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'recorded_by', 'recorded_by_role', 'recorded_by_credential_ref');
CREATE TRIGGER clinical_chart_entries_encounter
  BEFORE INSERT ON cuspatlas.clinical_chart_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_open_encounter_guard('encounter_id');

ALTER TABLE cuspatlas.clinical_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_charts FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_chart_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_chart_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_charts_select ON cuspatlas.clinical_charts
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_charts_insert ON cuspatlas.clinical_charts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND subject_patient_id = origin_patient_id AND head_sequence = 0);
CREATE POLICY clinical_charts_update ON cuspatlas.clinical_charts
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_chart_entries_select ON cuspatlas.clinical_chart_entries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_chart_entries_insert ON cuspatlas.clinical_chart_entries
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());

-- Explicit grants: entries are append-only; the chart allows only the merge reference, its head and
-- bookkeeping to change (exactly the merge digest exclusions). No DELETE or TRUNCATE.
GRANT SELECT, INSERT ON cuspatlas.clinical_charts, cuspatlas.clinical_chart_entries TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, head_sequence, version, updated_at) ON cuspatlas.clinical_charts TO cuspatlas_app;
