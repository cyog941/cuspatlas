-- S11: attendance as an append-only sequence of transitions (synthetic data only). Attendance is a
-- separate fact from the booking (S10), from clinical completion (C5) and from billing (B1): this
-- table has no clinical or financial column, the runtime role may only read and append it, and the
-- current state is derived from the sequence, never stored.

-- Configured reason vocabulary per tenant and transition kind (late, no_show,
-- left_without_treatment, amendment). Runtime role reads only; no write command until practice
-- configuration exists.
CREATE TABLE cuspatlas.scheduling_attendance_reasons (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  kind text NOT NULL CHECK (kind IN ('late', 'no_show', 'left_without_treatment', 'amendment')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  PRIMARY KEY (tenant_id, kind, reason_code)
);

CREATE TABLE cuspatlas.appointment_attendance_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  kind text NOT NULL CHECK (kind IN ('confirmed_manual', 'confirmed_automated', 'arrived', 'arrived_curbside',
    'waiting', 'in_care', 'late', 'left_without_treatment', 'no_show', 'cancelled', 'rescheduled')),
  -- Who produced the fact: a person, an automation (with its provenance), or the booking command
  -- (cancel and reschedule own the cancelled and rescheduled kinds).
  source text NOT NULL CHECK (source IN ('staff', 'automation', 'booking_command')),
  provenance_ref text CHECK (provenance_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  -- The client-claimed instant, kept beside the server instant (occurred_at), never instead of it.
  claimed_at timestamptz,
  -- A correction names the transition it supersedes; that row stays unchanged. No foreign key (a
  -- self-reference within one table would make row-by-row restore order-dependent); checked by the
  -- domain inside the appending transaction.
  amends_transition_id uuid,
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  UNIQUE (tenant_id, appointment_id, sequence),
  CHECK ((kind = 'confirmed_automated') = (source = 'automation')),
  CHECK ((source = 'automation') = (provenance_ref IS NOT NULL)),
  CHECK ((kind IN ('cancelled', 'rescheduled')) = (source = 'booking_command'))
);
CREATE INDEX appointment_attendance_transitions_appointment
  ON cuspatlas.appointment_attendance_transitions (tenant_id, appointment_id, sequence);

CREATE TRIGGER appointment_attendance_transitions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.appointment_attendance_transitions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.scheduling_attendance_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_attendance_reasons FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_attendance_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_attendance_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduling_attendance_reasons_select ON cuspatlas.scheduling_attendance_reasons
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_attendance_transitions_select ON cuspatlas.appointment_attendance_transitions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_attendance_transitions_insert ON cuspatlas.appointment_attendance_transitions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

GRANT SELECT ON cuspatlas.scheduling_attendance_reasons TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.appointment_attendance_transitions TO cuspatlas_app;
