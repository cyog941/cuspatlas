-- A14 hardening (A batch 4): a webhook transport never follows a redirect. A 3xx answer is recorded
-- as the terminal response class redirect_refused (dead-lettered, never retried). '3xx' stays
-- admissible for rows written before this migration.
ALTER TABLE cuspatlas.webhook_deliveries DROP CONSTRAINT webhook_deliveries_last_response_class_check;
ALTER TABLE cuspatlas.webhook_deliveries ADD CONSTRAINT webhook_deliveries_last_response_class_check
  CHECK (last_response_class IN ('2xx', '3xx', 'redirect_refused', '4xx', '5xx', 'network', 'timeout'));
