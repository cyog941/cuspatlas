-- Closeout E (synthetic engineering implementation, recommended-pending-approval): the reply-escalation
-- sweep walks overdue episodes in keyset batches ordered by the millisecond instant of the episode start
-- (the precision a JavaScript Date carries) and the thread id. It ordered and compared by
-- date_trunc('milliseconds', created_at), which no index can hold: date_trunc(text, timestamptz) is
-- STABLE (it truncates in the session time zone). Truncating to a millisecond does not depend on the
-- zone (every zone offset is a whole number of seconds), so the same instant is computed IMMUTABLY in
-- UTC by cuspatlas.instant_ms. The episode lookup orders by it (then by created_at and id, which is the
-- same order as created_at, id, because the millisecond is monotone in created_at) and returns it as the
-- keyset value, and this expression index serves that lookup per thread.
CREATE FUNCTION cuspatlas.instant_ms(p_at timestamptz) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT pg_catalog.timezone('UTC', pg_catalog.date_trunc('milliseconds', pg_catalog.timezone('UTC', p_at))) $$;
REVOKE ALL ON FUNCTION cuspatlas.instant_ms(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.instant_ms(timestamptz) TO cuspatlas_app;

CREATE INDEX thread_messages_episode_ms ON cuspatlas.thread_messages
  (tenant_id, thread_id, author_kind, cuspatlas.instant_ms(created_at), created_at, id);
