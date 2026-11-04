-- I6: device bridge pairing, signed jobs and capability allowlist (SERVER side only). Synthetic data
-- only. No device, sensor SDK or acquisition software is qualified (I-S1, I-S3 blocked-on-discovery)
-- and the native bridge is not built: these tables are the contract a future reviewed bridge calls,
-- exercised by a test-only synthetic bridge client. A device is its own principal kind ('device'):
-- never a staff member (no membership), never a portal principal, authenticated by its own Ed25519
-- key on a distinct audience.
--
-- Merge note: E1 (codex/e-portal-1) adds 'portal' to the same CHECK constraints in an earlier-sorting
-- migration; these constraints list 'portal' too so the merged result keeps both kinds. No code on this
-- branch creates a portal principal.

ALTER TABLE cuspatlas.principals DROP CONSTRAINT principals_kind_check;
ALTER TABLE cuspatlas.principals ADD CONSTRAINT principals_kind_check
  CHECK (kind IN ('human', 'service', 'portal', 'device'));
ALTER TABLE cuspatlas.audit_events DROP CONSTRAINT audit_events_principal_check;
ALTER TABLE cuspatlas.audit_events ADD CONSTRAINT audit_events_principal_check
  CHECK (principal IN ('human', 'service', 'portal', 'device'));
ALTER TABLE cuspatlas.sensitive_read_events DROP CONSTRAINT sensitive_read_events_principal_check;
ALTER TABLE cuspatlas.sensitive_read_events ADD CONSTRAINT sensitive_read_events_principal_check
  CHECK (principal IN ('human', 'service', 'portal', 'device'));

-- A device principal can never hold a staff membership.
CREATE FUNCTION cuspatlas.membership_not_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cuspatlas.principals p WHERE p.id = NEW.principal_id AND p.kind = 'device') THEN
    RAISE EXCEPTION 'a device principal cannot hold a staff membership' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION cuspatlas.membership_not_device() FROM PUBLIC;
CREATE TRIGGER memberships_not_device BEFORE INSERT OR UPDATE ON cuspatlas.memberships
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.membership_not_device();

-- The runtime role may create device principals only (device registration); never staff principals.
GRANT INSERT ON cuspatlas.principals TO cuspatlas_app;
CREATE POLICY principals_insert_device ON cuspatlas.principals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (kind = 'device' AND cuspatlas.current_tenant_id() IS NOT NULL
    AND handle = 'device-' || id::text);

-- A relative bridge path: segments of [A-Za-z0-9._-], no '.' or '..' segment, no leading slash,
-- backslash, drive letter or control character. Paths are data the bridge resolves inside its own
-- configured import root; the server never touches a filesystem path.
CREATE FUNCTION cuspatlas.imaging_safe_bridge_path(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND 240
    AND p ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(p, '/')) s WHERE s IN ('.', '..'));
$$;
CREATE FUNCTION cuspatlas.imaging_safe_bridge_paths(ps text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(bool_and(cuspatlas.imaging_safe_bridge_path(x)), true) FROM unnest(ps) x;
$$;

CREATE TABLE cuspatlas.imaging_devices (
  id uuid PRIMARY KEY REFERENCES cuspatlas.principals (id),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  -- Synthetic operator label; kept out of audit, outbox, idempotency and logs.
  label text NOT NULL CHECK (label ~ '^[A-Za-z0-9 ._-]{1,64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  allowed_job_kinds text[] NOT NULL CHECK (allowed_job_kinds <@ ARRAY['acquire', 'import', 'probe']::text[]
    AND cardinality(allowed_job_kinds) <= 3),
  allowed_path_prefixes text[] NOT NULL CHECK (cardinality(allowed_path_prefixes) <= 8
    AND cuspatlas.imaging_safe_bridge_paths(allowed_path_prefixes)),
  key_version integer NOT NULL DEFAULT 0 CHECK (key_version >= 0),
  last_heartbeat_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  revoke_reason text CHECK (revoke_reason ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (state <> 'active' OR key_version >= 1)
);

-- Identity is fixed; pending -> active -> revoked only (revocation final); a heartbeat changes only
-- the heartbeat time (no version bump); every other change bumps the version by one.
CREATE FUNCTION cuspatlas.imaging_devices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'devices are never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.label, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.label, OLD.created_by, OLD.created_at)
     OR OLD.state = 'revoked'
     OR NOT (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state IN ('active', 'revoked'))
             OR (OLD.state = 'active' AND NEW.state = 'revoked'))
     OR NEW.key_version < OLD.key_version
     OR (NEW.version = OLD.version AND (NEW.state, NEW.allowed_job_kinds, NEW.allowed_path_prefixes,
           NEW.key_version, NEW.revoked_at) IS DISTINCT FROM (OLD.state, OLD.allowed_job_kinds,
           OLD.allowed_path_prefixes, OLD.key_version, OLD.revoked_at))
     OR (NEW.version <> OLD.version AND NEW.version <> OLD.version + 1)
     OR (NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL AND NEW.revoked_by IS DISTINCT FROM cuspatlas.current_actor_id()) THEN
    RAISE EXCEPTION 'device change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_devices_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_devices
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_devices_guard();

-- Per-device Ed25519 public keys (raw 32 bytes, base64url). Private keys never reach the server.
CREATE TABLE cuspatlas.imaging_device_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  device_id uuid NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL CHECK (state IN ('active', 'retired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  FOREIGN KEY (device_id, tenant_id) REFERENCES cuspatlas.imaging_devices (id, tenant_id),
  UNIQUE (device_id, key_version),
  UNIQUE (tenant_id, public_key),
  CHECK ((state = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX imaging_device_keys_one_active ON cuspatlas.imaging_device_keys (device_id)
  WHERE state = 'active';
-- A key only ends (active -> retired | revoked), once.
CREATE FUNCTION cuspatlas.imaging_device_keys_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'active' OR NEW.state = 'active'
     OR (NEW.id, NEW.tenant_id, NEW.device_id, NEW.key_version, NEW.public_key, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.device_id, OLD.key_version, OLD.public_key, OLD.created_at) THEN
    RAISE EXCEPTION 'device key change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_device_keys_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_device_keys
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_device_keys_guard();

-- One-time pairing codes: only a SHA-256 of the secret is stored; single use, short-lived.
CREATE TABLE cuspatlas.imaging_device_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  device_id uuid NOT NULL,
  secret_sha256 text NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  superseded_at timestamptz,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, tenant_id) REFERENCES cuspatlas.imaging_devices (id, tenant_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);
CREATE UNIQUE INDEX imaging_device_pairings_one_open ON cuspatlas.imaging_device_pairings (device_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE FUNCTION cuspatlas.imaging_device_pairings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.consumed_at IS NOT NULL OR OLD.superseded_at IS NOT NULL
     OR (NEW.id, NEW.tenant_id, NEW.device_id, NEW.secret_sha256, NEW.expires_at, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.device_id, OLD.secret_sha256, OLD.expires_at, OLD.created_by,
          OLD.created_at) THEN
    RAISE EXCEPTION 'pairing change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_device_pairings_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_device_pairings
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_device_pairings_guard();

-- Single-use device assertion identifiers (replay protection). Append-only.
CREATE TABLE cuspatlas.imaging_device_nonces (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  device_id uuid NOT NULL,
  nonce uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, nonce),
  FOREIGN KEY (device_id, tenant_id) REFERENCES cuspatlas.imaging_devices (id, tenant_id)
);
CREATE TRIGGER imaging_device_nonces_append_only BEFORE UPDATE OR DELETE ON cuspatlas.imaging_device_nonces
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- A job names its ingress record by (id, tenant_id) like every other imaging reference.
ALTER TABLE cuspatlas.imaging_ingress_sessions ADD CONSTRAINT imaging_ingress_sessions_id_tenant UNIQUE (id, tenant_id);

CREATE TABLE cuspatlas.imaging_bridge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  device_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('acquire', 'import', 'probe')),
  scope_path text CHECK (scope_path IS NULL OR cuspatlas.imaging_safe_bridge_path(scope_path)),
  intended_patient_id uuid,
  state text NOT NULL CHECK (state IN ('queued', 'claimed', 'transferring', 'completed', 'failed', 'expired',
    'denied', 'outcome_unknown', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  claim_nonce uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  staging_key text,
  observed_digest text CHECK (observed_digest ~ '^[0-9a-f]{64}$'),
  observed_byte_length bigint CHECK (observed_byte_length > 0),
  ingress_id uuid,
  object_id uuid,
  result_digest text CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  failure_reason text CHECK (failure_reason ~ '^[a-z_]{1,64}$'),
  duplicate_reports integer NOT NULL DEFAULT 0 CHECK (duplicate_reports >= 0),
  late_report_at timestamptz,
  deferral_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, tenant_id) REFERENCES cuspatlas.imaging_devices (id, tenant_id),
  FOREIGN KEY (intended_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (ingress_id, tenant_id) REFERENCES cuspatlas.imaging_ingress_sessions (id, tenant_id),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  CHECK (staging_key IS NULL OR staging_key ~ ('^staging/' || tenant_id::text || '/[0-9a-f-]{36}$')),
  CHECK (kind <> 'import' OR scope_path IS NOT NULL),
  CHECK (attempts <= max_attempts),
  CHECK ((state IN ('claimed', 'transferring')) = (claim_nonce IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR state = 'outcome_unknown'),
  CHECK (state <> 'completed' OR (kind = 'probe' OR (object_id IS NOT NULL AND result_digest IS NOT NULL)))
);
CREATE INDEX imaging_bridge_jobs_ready ON cuspatlas.imaging_bridge_jobs (tenant_id, device_id, next_attempt_at)
  WHERE state = 'queued';

-- Identity is fixed; terminal states are final (a duplicate or late report only counts); every change
-- bumps the version by one.
CREATE FUNCTION cuspatlas.imaging_bridge_jobs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bridge jobs are never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.device_id, NEW.kind, NEW.scope_path, NEW.intended_patient_id, NEW.created_by,
      NEW.created_at, NEW.deferral_id)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.device_id, OLD.kind, OLD.scope_path, OLD.intended_patient_id,
      OLD.created_by, OLD.created_at, OLD.deferral_id)
     OR NEW.version <> OLD.version + 1
     OR NEW.attempts < OLD.attempts AND NOT (OLD.state IN ('failed', 'outcome_unknown', 'expired') AND NEW.state = 'queued')
     OR (OLD.state IN ('completed', 'denied', 'cancelled')
         AND (NEW.state, NEW.object_id, NEW.result_digest, NEW.failure_reason)
             IS DISTINCT FROM (OLD.state, OLD.object_id, OLD.result_digest, OLD.failure_reason))
     OR (OLD.object_id IS NOT NULL AND NEW.object_id IS DISTINCT FROM OLD.object_id) THEN
    RAISE EXCEPTION 'bridge job change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_bridge_jobs_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_bridge_jobs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_bridge_jobs_guard();

-- Server-side recheck at execution, not only at enqueue: a job can be claimed only by an active device
-- whose current allowlist admits its kind and path.
CREATE FUNCTION cuspatlas.imaging_bridge_job_allowed(p_device uuid, p_kind text, p_path text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM cuspatlas.imaging_devices d
    WHERE d.id = p_device AND d.state = 'active' AND p_kind = ANY (d.allowed_job_kinds)
      AND (p_path IS NULL OR EXISTS (
        SELECT 1 FROM unnest(d.allowed_path_prefixes) pre WHERE p_path = pre OR p_path LIKE pre || '/%')));
$$;
CREATE FUNCTION cuspatlas.imaging_bridge_jobs_claim_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'claimed' AND OLD.state IS DISTINCT FROM 'claimed'
     AND NOT cuspatlas.imaging_bridge_job_allowed(NEW.device_id, NEW.kind, NEW.scope_path) THEN
    RAISE EXCEPTION 'job not allowed for this device' USING ERRCODE = '42501';
  END IF;
  IF NEW.state = 'claimed' AND NEW.device_id IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'only the device itself claims its job' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_bridge_jobs_claim_check BEFORE UPDATE ON cuspatlas.imaging_bridge_jobs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_bridge_jobs_claim_check();

ALTER TABLE cuspatlas.imaging_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_device_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_device_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_device_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_device_pairings FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_device_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_device_nonces FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_bridge_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_bridge_jobs FORCE ROW LEVEL SECURITY;

-- Before a tenant context exists, a device whose assertion signature is being verified may read only
-- its own device row and keys (auth_principal_id set by the device source, like memberships).
CREATE POLICY imaging_devices_select ON cuspatlas.imaging_devices
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() OR id = cuspatlas.current_auth_principal_id());
CREATE POLICY imaging_devices_insert ON cuspatlas.imaging_devices
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state = 'pending' AND key_version = 0);
CREATE POLICY imaging_devices_update ON cuspatlas.imaging_devices
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_device_keys_select ON cuspatlas.imaging_device_keys
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() OR device_id = cuspatlas.current_auth_principal_id());
-- Keys are added only by the device itself (pairing, rotation): the acting principal is the device.
CREATE POLICY imaging_device_keys_insert ON cuspatlas.imaging_device_keys
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND device_id = cuspatlas.current_actor_id()
    AND state = 'active');
CREATE POLICY imaging_device_keys_update ON cuspatlas.imaging_device_keys
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_device_pairings_select ON cuspatlas.imaging_device_pairings
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_device_pairings_insert ON cuspatlas.imaging_device_pairings
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND consumed_at IS NULL AND superseded_at IS NULL);
CREATE POLICY imaging_device_pairings_update ON cuspatlas.imaging_device_pairings
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_device_nonces_select ON cuspatlas.imaging_device_nonces
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_device_nonces_insert ON cuspatlas.imaging_device_nonces
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND device_id = cuspatlas.current_actor_id());
CREATE POLICY imaging_bridge_jobs_select ON cuspatlas.imaging_bridge_jobs
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_bridge_jobs_insert ON cuspatlas.imaging_bridge_jobs
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state = 'queued' AND attempts = 0);
CREATE POLICY imaging_bridge_jobs_update ON cuspatlas.imaging_bridge_jobs
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.imaging_devices TO cuspatlas_app;
GRANT UPDATE (state, allowed_job_kinds, allowed_path_prefixes, key_version, last_heartbeat_at, revoked_at, revoked_by,
  revoke_reason, version, updated_at) ON cuspatlas.imaging_devices TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_device_keys TO cuspatlas_app;
GRANT UPDATE (state, ended_at) ON cuspatlas.imaging_device_keys TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_device_pairings TO cuspatlas_app;
GRANT UPDATE (consumed_at, superseded_at) ON cuspatlas.imaging_device_pairings TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_device_nonces TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_bridge_jobs TO cuspatlas_app;
GRANT UPDATE (state, attempts, claim_nonce, lease_expires_at, next_attempt_at, expires_at, staging_key, observed_digest,
  observed_byte_length, ingress_id, object_id, result_digest, failure_reason, duplicate_reports, late_report_at,
  version, updated_at) ON cuspatlas.imaging_bridge_jobs TO cuspatlas_app;
REVOKE ALL ON FUNCTION cuspatlas.imaging_devices_guard(), cuspatlas.imaging_device_keys_guard(),
  cuspatlas.imaging_device_pairings_guard(), cuspatlas.imaging_bridge_jobs_guard(),
  cuspatlas.imaging_bridge_jobs_claim_check(), cuspatlas.imaging_bridge_job_allowed(uuid, text, text),
  cuspatlas.imaging_safe_bridge_path(text), cuspatlas.imaging_safe_bridge_paths(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.imaging_bridge_job_allowed(uuid, text, text),
  cuspatlas.imaging_safe_bridge_path(text), cuspatlas.imaging_safe_bridge_paths(text[]) TO cuspatlas_app;
