/**
 * Audited application-clock reads (clock audit, scripts/clock-guard.test.ts). Each entry is one
 * `Date.now` / bare `new Date()` occurrence: its file, its trimmed source line and why the host clock
 * is safe there. Class (a) only: every mixed-clock (b) and precision (c) use was moved to the database
 * clock (packages/domain/src/clock.ts). Adding an entry is a review decision, not a way to pass the guard.
 */
export interface ClockAllowlistEntry {
  readonly file: string;
  readonly code: string;
  readonly reason: string;
}

export const CLOCK_ALLOWLIST: readonly ClockAllowlistEntry[] = [
  {
    file: 'apps/api/src/device-auth.ts',
    code: 'const now = Math.floor(Date.now() / 1000);',
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'apps/api/src/list-envelope-hook.ts',
    code: 'CALLS.set(request, { operation, spec, asOf: new Date(), scope });',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'apps/api/src/pair-throttle.ts',
    code: 'check(source: string, pairingId: string | null, now = Date.now()): void {',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'apps/api/src/pair-throttle.ts',
    code: 'recordFailure(source: string, pairingId: string | null, now = Date.now()): void {',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'apps/mcp/src/server.ts',
    code: 'const asOf = new Date();',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'apps/worker/src/compose.ts',
    code: 'sampleTarget: `cuspatlas_synthetic_backup_verify_${Date.now().toString(36)}${randomUUID().slice(0, 8)}`,',
    reason: '(a) synthetic fake adapter event time or a unique name suffix; not compared with stored facts',
  },
  {
    file: 'packages/db/src/backup-verify.ts',
    code: 'const started = Date.now();',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/backup-verify.ts',
    code: 'restoreSeconds: Math.round((Date.now() - started) / 10) / 100,',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/backup.ts',
    code: 'createdAt: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/db/src/object-store-backup.ts',
    code: 'createdAt: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    code: 'const now = new Date();',
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    code: 'if (!hit || hit.fingerprint !== fingerprint || Date.now() - hit.at >= verificationTtlMs) {',
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    code: 'verified.set(cacheKey, { fingerprint, at: Date.now() });',
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    code: 'const body = JSON.stringify({ objectRef, digestSha256, deletedAt: new Date().toISOString() });',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    code: 'if (!st?.isFile() || Date.now() - st.mtimeMs <= olderThanMs) return false;',
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/object-store-local.ts',
    code: 'if (st?.isFile() && Date.now() - st.mtimeMs > olderThanMs) out.push(`staging/${tenantId}/${n}`);',
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    code: 'const started = Date.now();',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    code: 'const backupDone = Date.now();',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    code: 'const restoreStart = Date.now();',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/restore-drill.ts',
    code: 'const done = Date.now();',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/db/src/security-attempts.ts',
    code: 'occurredAt: new Date().toISOString(),',
    reason:
      '(a) schema-validation placeholder only; the stored instant is the database now() (clock audit fix)',
  },
  {
    file: 'packages/domain/src/administration/administration.ts',
    code: 'asOf: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/administration/administration.ts',
    code: 'asOf: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/agents/ai.ts',
    code: 'return present((await markStale(ctx, row.id)) ?? row, false, new Date());',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/agents/ai.ts',
    code: "return present(row, open ? true : row.state !== 'stale', new Date());",
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/agents/governance.ts',
    code: 'if (!Number.isFinite(expires) || expires <= Date.now())',
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/principals.ts',
    code: 'if (!Number.isFinite(expires) || expires <= Date.now())',
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/principals.ts',
    code: 'if (expires > Date.now() + AGENT_MAX_LIFETIME_DAYS * 86_400_000) {',
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/workspace.ts',
    code: 'if (!Number.isFinite(expires) || expires <= Date.now())',
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/workspace.ts',
    code: "if (expires > Date.now() + 90 * 86_400_000) throw failed('expiry_beyond_maximum', '/expiresAt');",
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/agents/workspace.ts',
    code: 'if (raw.firstRunAt !== undefined && !(Date.parse(raw.firstRunAt as string) > Date.now())) {',
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/automation/exports.ts',
    code: 'const manifest = buildScopedManifest(row.id, new Date().toISOString(), scope, docs);',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/automation/exports.ts',
    code: ').rows[0]?.revoked_at ?? new Date();',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/automation/webhooks.ts',
    code: 'asOf: new Date(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/automation/webhooks.ts',
    code: 'const timestamp = Math.floor(Date.now() / 1000);',
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/billing/adjustments.ts',
    code: 'checkedAt: (at[0]?.at ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/billing/entries.ts',
    code: 'asOf: (s?.as_of ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/billing/plans.ts',
    code: 'checkedAt: (at[0]?.at ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/billing/worklist.ts',
    code: 'checkedAt: (totals[0]?.at ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/clinical/estimates.ts',
    code: 'const serviceDate = at[0]?.service_date ?? new Date().toISOString().slice(0, 10);',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/clinical/history.ts',
    code: 'computedAt: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/history.ts',
    code: 'computedAt: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/insurer-estimate.ts',
    code: 'const readAt = q.readAt ?? new Date().toISOString();',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/lab-cases.ts',
    code: 'async function view(tx: TenantTransaction, r: CaseRow, asOf = Date.now()): Promise<LabCase> {',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/clinical/lab-cases.ts',
    code: 'return { format: LAB_EXPORT_FORMAT, generatedAt: new Date().toISOString(), labCase };',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/lab-cases.ts',
    code: 'const asOf = q.asOf === undefined ? Date.now() : Date.parse(q.asOf);',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    code: 'async function view(tx: TenantTransaction, r: ReferralRow, asOf = Date.now()): Promise<Referral> {',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    code: "if (expires <= Date.now()) throw failedAt('/expiresAt', 'expiresInPast');",
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    code: 'if (expires > Date.now() + MAX_SHARE_DAYS * 86_400_000)',
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    code: 'generatedAt: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/clinical/referrals.ts',
    code: 'const asOf = q.asOf === undefined ? Date.now() : Date.parse(q.asOf);',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/engagement/communications/consent.ts',
    code: 'const at = q.at === undefined ? new Date() : new Date(q.at);',
    reason: '(a) quiet-hours preview instant against a wall-clock policy window; no stored fact compared',
  },
  {
    file: 'packages/domain/src/engagement/communications/recall-enrollment.ts',
    code: 'await recallDueFor(tx, decision.locationRefs, q.category, Date.now(), false, clinical);',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/engagement/portal/session.ts',
    code: 'projectedAt: (grants[0]?.projectedAt ?? new Date().toISOString()) as string,',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/events/record-command.ts',
    code: 'const occurredAt = new Date().toISOString();',
    reason:
      '(a) schema-validation placeholder only; the stored instant is the database now() (clock audit fix)',
  },
  {
    file: 'packages/domain/src/imaging/bridge-update.ts',
    code: 'now: Date = new Date(),',
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/imaging/bridge.ts',
    code: 'if (Math.abs(Date.parse(r.reportedAt) - Date.now()) > opts.resultSkewSeconds * 1000)',
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/imaging/orphan-bytes.ts',
    code: 'else if (Date.now() - at.getTime() <= graceMs) {',
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/domain/src/imaging/orphan-bytes.ts',
    code: 'const now = Date.now();',
    reason: '(a) filesystem mtime or an in-process cache entry: the host clock on both sides',
  },
  {
    file: 'packages/domain/src/migration/operations.ts',
    code: 'return { lastCheckedAt: rows[0]?.last ?? null, at: rows[0]?.at ?? new Date() };',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/patients/identity.ts',
    code: "if (effectiveAt.getTime() > Date.now() + FUTURE_SKEW_MS) throw invalid('effective_at_in_future');",
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/patients/merge-confirmation.ts',
    code: 'const now = options.now ?? Date.now;',
    reason:
      '(a) protocol time of a host-clock token or signature (issued and checked by the application, or the peer clock); no stored fact',
  },
  {
    file: 'packages/domain/src/patients/model.ts',
    code: 'export function checkBirthDate(b: BirthDate, today: Date = new Date()): void {',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/policy/patient-access.ts',
    code: 'evaluatedAt: (clock ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/preferences/preferences.ts',
    code: 'asOf: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/rcm/clearinghouse.ts',
    code: 'const at = new Date().toISOString();',
    reason: '(a) synthetic fake adapter event time or a unique name suffix; not compared with stored facts',
  },
  {
    file: 'packages/domain/src/rcm/coverage.ts',
    code: 'checkedAt: (at[0]?.at ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/rcm/workflow.ts',
    code: 'const deadline = Date.now() + ADVANCE_WAIT_MS;',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/domain/src/rcm/workflow.ts',
    code: 'if (Date.now() >= deadline)',
    reason:
      '(a) elapsed time or an in-process wait on the host clock, compared only with other host-clock readings',
  },
  {
    file: 'packages/domain/src/reporting/measures.ts',
    code: 'asOf: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/availability.ts',
    code: 'const asOf = new Date().toISOString();',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/availability.ts',
    code: 'const now = Date.now();',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/booking.ts',
    code: "if (s < Date.now()) throw failedAt('/startsAt', 'inThePast');",
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/floor.ts',
    code: 'asOf: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/recall.ts',
    code: 'const asOf = q.asOf === undefined ? Date.now() : Date.parse(q.asOf);',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/recall.ts',
    code: 'const asOf = p.asOf === undefined ? Date.now() : Date.parse(p.asOf);',
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/recurrence.ts',
    code: "(c) => c.status === 'booked' && c.startsAt > Date.now(),",
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/requests.ts',
    code: 'checkedAt: (first?.at ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/scheduling/resources.ts',
    code: 'checkedAt: (first?.at ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/scheduling/staging.ts',
    code: 'asOf: new Date().toISOString(),',
    reason:
      '(a) response metadata stamp (asOf/computedAt/generatedAt/checkedAt); never compared server-side with a stored fact',
  },
  {
    file: 'packages/domain/src/scheduling/visit-context.ts',
    code: 'asOf: (now.rows[0]?.at ?? new Date()).toISOString(),',
    reason:
      '(a) unreachable fallback: the left side is a database now()/RETURNING value that is always present',
  },
  {
    file: 'packages/domain/src/scheduling/waitlist.ts',
    code: "if (r.state !== 'open' || r.starts_at.getTime() <= Date.now()) throw refused('recovery_closed');",
    reason:
      '(a) compared with a user-scheduled instant or a calendar date (starts_at, due dates), not a database-stamped fact',
  },
  {
    file: 'packages/domain/src/scheduling/waitlist.ts',
    code: "if (expires <= Date.now()) throw failedAt('/expiresAt', 'inThePast');",
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
  {
    file: 'packages/domain/src/scheduling/waitlist.ts',
    code: 'if (expires > Date.now() + MAX_POLICY_DAYS * 86_400_000)',
    reason:
      '(a) bound on a client-supplied instant before it is stored; enforcement against stored rows is SQL now(), so skew only moves the accept edge for an instant seconds away',
  },
];
