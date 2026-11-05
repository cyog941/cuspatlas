# Operational read models implementation plan

> Implements the [operational read models spec](../specs/2026-11-04-operational-read-models.md). Task IDs continue each owning workstream's numbering per [SHARED-CONTRACTS](../../SHARED-CONTRACTS.md#plan-taxonomy-task-identifiers). Synthetic data only. UI remains deferred. Every decision marked OR-D is recommended-pending-approval.

**Depends on:** the integrated backend (F, S, C, B, E, I), plus A4 (operation catalog) for the A tasks.

## Tasks

### A20: List envelope and state vocabularies (OR-01, OR-02)
- Define `ListEnvelope` in contracts and the vocabulary resource `GET /v1/vocabularies/{name}` (plus MCP `vocabularies_get`) generated from each owning module's registered state set.
- Retrofit every list and worklist operation in S, C, B, E, I and M. Add a catalog-wide conformance test that fails any list operation without the envelope, and a test that every state CHECK value has exactly one vocabulary entry with a label.
- **Observable completion:** the conformance test is green across the whole catalog.

### S18: Availability search filters (OR-04)
- Add time-of-day windows, a weekday set, a provider preference, next-N mode and a configurable maximum window (OR-D6) to S9.
- Keep search read-only. Cover with REST, MCP and negative-harness rows.

### S19: Schedule view read model (OR-03)
- Add the scheduling-owned read functions: day/range appointments with next transitions, blocks as single objects, unavailable intervals with reason, counters with scope, and grain.
- A21 composes them with B, C and E components.
- **Observable completion:** one synthetic day agrees with S9 and S10.

### S20: Bounded staging list (OR-05)
- Add a per-location staging aggregate with capacity (OR-D2), entries referencing an appointment or a request, and moves through the S10 reschedule.
- Add, remove and move are audited.
- Add concurrency tests, and merge registration for patient refs.

### S21: Floor view, provider request and team presence (OR-06)
- Add the per-operatory flow read, the `requestProvider`/acknowledge/clear commands with internal notification only, and staff presence with expiry.
- Add the display-principal privacy rule, coordinated with A18.

### S22: Reassigning an appointment's patient (OR-11)
- Add the command with typed refusals and remediation.
- Use attachment probes supplied by C (encounters, procedures, notes) and B (charges, claims).
- Add the race test against C14 render.

### B11: Claims work queues and headline measures (OR-07)
- Add queue predicates over the B6/B7/B8 lifecycle, counts, the work-priority ordering contract (OR-D3) and declared measure definitions.
- Add a reconciliation test of measures against the journal.

### E10: Needs-reply messaging queue (OR-08)
- Add the filters, the policy-defined due time (OR-D4), escalation, assignment and counts.
- The existing awaiting-reply work item is the source.

### A21: Read composers: schedule view and appointment detail (OR-09, OR-10)
- Add the composer framework: published read functions only, per-component authorization, and `restricted`/`unavailable` semantics.
- Add the schedule view composer (S19 plus B balance and coverage, plus C planned procedures) and the appointment detail composer.
- Add a structural no-write test, and REST/MCP parity.

### A22: Saved views, favourites and recent patients (OR-12)
- Add per-user preference aggregates with isolation, retention (OR-D5) and purge.

### A23: Agent workspace (OR-13)
- Add sessions, scoped memory with a PHI policy, retention and deletion, and scheduled tasks under a standing policy.
- Builds on A8, A9 and A11.

### A24: Navigation from the catalog (OR-14)
- Add navigable capability groups to the A4 catalog, plus a resolution test.

## Order
A20 first, because the other tasks emit the envelope. Then S18, S19, S20, S21, S22, B11 and E10 in parallel by owner. Then A21 (needs S19, B and C reads). A22, A23 and A24 follow alongside the remaining A tasks.
