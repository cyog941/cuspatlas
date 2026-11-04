# Supported Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Assemble the evidence that a specific general-dentistry practice can be supported on this software, and record that evidence in a form a reader can audit: a release gate list that resolves to the other plans' own completion conditions, staff validation per role against a measured baseline, a security review whose findings are tracked to closure, a clinical statement of intended use and limitations, migration and restore rehearsals with measured results, operational readiness with a named operator, and a go/no-go record that states explicitly what is not claimed.

**Architecture:** This plan builds no product capability. It builds a gate registry and an evidence pipeline. Every gate stores a reference to the owning plan's task and that task's completion condition, plus the kind of evidence the gate consumes and the role accountable for it; the wording stays in the owning plan, so a changed completion condition changes the gate rather than leaving two divergent copies. Evaluations are recorded as reports with an evaluation instant, and evidence older than its review interval expires rather than staying satisfied. Human judgments — staff validation, clinical safety review, penetration-test closure, the go/no-go decision — are recorded as signed records naming the role, never as the absence of an objection, and the go/no-go record carries a required statement of what the release does not claim.

**Tech Stack:** Inherits the platform foundation. This plan adds no runtime dependency and no vendor relationship of its own. Rehearsals run on the same synthetic and isolated environments the migration and platform plans define. Nothing here requires production data, a production deployment or a paid engagement to be designed; several gates cannot be met until a human decision and a real engagement exist.

**Spec:** [Security gates](../../SECURITY-AND-READINESS.md), [capability matrix](../../CAPABILITIES.md), [delivery roadmap](../../ROADMAP.md), [product design](../specs/2026-11-03-dental-pms-design.md), [shared contracts](../../SHARED-CONTRACTS.md).

**Depends on:** every workstream plan. [Platform foundation](2026-11-03-platform-foundation.md) Tasks 1–8; [scheduling](2026-11-04-scheduling-and-patients.md) Tasks 4–17; [clinical](2026-11-04-clinical-record.md) Tasks 5–18; [billing](2026-11-04-billing-and-rcm.md) Tasks 1–9; [imaging](2026-11-04-imaging-and-devices.md) Tasks 1–8; [portal](2026-11-04-portal-and-communications.md) Tasks 1–8; [migration](2026-11-04-migration-and-operations.md) Tasks 1–9; [API, MCP and AI](2026-11-04-api-mcp-and-ai.md) Tasks 1–19. This plan consumes those plans' completion conditions and states none of its own product requirements.

**Task numbering and prefix:** tasks carry the prefix `R`, discovery spikes `R-S`, and open decisions `R-D`. A reference to another plan names it: `migration Task 9` is the operator, backup and escalation task in [migration and operations](2026-11-04-migration-and-operations.md); `A7` is the forbidden-operation matrix in [API, MCP and AI](2026-11-04-api-mcp-and-ai.md).

## Global Constraints

- This is a reviewed proposal. Nothing here is implemented, tested, validated, certified, approved or authorized.
- This plan creates no product requirement and no domain contract. Where it needs a fact, it names the owning plan's task and consumes that task's output.
- Synthetic data only. No real export, no real patient record, no production system is used for a rehearsal, a validation session or a penetration test.
- No regulatory certification, compliance attestation or clinical validation is claimed. A control that exists is a control that exists; it is not a certification, and this plan's records must say so in the same sentence.
- No vendor capability, penetration-test result, staff measurement or recovery figure is invented. A number appears only when it was measured; otherwise the field is recorded as not measured with an owner.
- Staff validation is per role. One person's approval is not validation of reception, hygiene, dentistry, billing and practice management together, and a composite pass requires every named role.
- Every go/no-go record carries a required statement of what is not claimed. An empty statement is a defect, not a formality.
- No promised dates. Checkpoints and intervals are stated as offsets from the cutover event, and review intervals are configuration, not commitments.
- No named people, practices or patients appear in this plan or in its evidence format. Records name roles; the identity of the human behind a role is held in the operating record, not here.
- Release language distinguishes planned, configured, tested, approved, deployed, compliant and clinically validated. A record that blurs them fails review.

## Evidence gate before executing this plan

No gate in this plan is currently met, and none of the measurements it requires exists. There is no pilot practice, no staff panel, no penetration-test engagement, no clinical reviewer sign-off, no rehearsal run, no operator agreement and no authorization to handle patient data. [Analysis coverage](../../TAB32-ANALYSIS-COVERAGE.md) records the observation boundary this project still operates within, and nothing in this plan should be read as having moved past it.

Three consequences follow, and they decide what can start:

- The gate registry, the evaluator, the access-exercise harness, the go/no-go format, the checkpoint format and the evidence bundle are machinery. They can be built and tested against synthetic gate sets with deliberately unmet, stale and passing states.
- R3, R4, R6, R7, R8 and R9 each require a human participant, an engagement or an environment that does not exist. They are blocked-on-discovery until the named spike or decision closes, and their tasks may not be marked complete on the basis of a designed instrument.
- R10 cannot produce a go record while any gate is unmet. Its acceptance cases are written so that a premature go is a detected failure rather than an interpretation.

## Discovery spikes (resolve before the tasks they gate)

### R-S1: Staff validation instrument, role set and observation protocol — blocked-on-discovery

Determine how a role's work is measured without recording patient content or identifying a person in the evidence: which task statements belong to each role, whether duration, correction count, re-entry count or completion is the primary measure, who observes, how consent to observation is obtained, how the instrument is versioned so a baseline and a later measurement are comparable, and how a synthetic scenario substitutes for a live record where a live record may not be used. Blocks R3. Stop condition: a versioned instrument and a written observation protocol reviewed by the practice manager role, or staff validation is recorded as not performed and the release is declared a limited trial.

### R-S2: Penetration-test engagement scope and independence — blocked-on-discovery

Determine who performs the test, whether the engagement is independent of the implementation, what scope and rules of engagement are proposed, which environment is provided and how it is proven synthetic, what access the testers receive and how it is withdrawn, what disclosure and confidentiality terms apply, how findings are delivered and retested, and what the engagement does not cover. Blocks R4. Stop condition: a written scope and rules-of-engagement document accepted by the security owner, or the security review is recorded as internal only and the release cannot claim independent testing.

### R-S3: Regulatory, legal and claims review intake — blocked-on-discovery

Establish who performs the review and what it covers: the security risk analysis obligation, business-associate and subprocessor arrangements for every service in the deployment, state-level requirements that differ from the federal baseline, record-retention obligations by record class, professional and legal review of the software's claims and of the intended-use statement, and what may and may not be said publicly at release. Blocks R6 and R10. Stop condition: a written review record naming the reviewer role, the material reviewed, the conclusions and the constraints on release language, or the release is declared internal and no public claim is made.

### R-S4: Incident response, breach notification and on-call capacity — blocked-on-discovery

Establish who is reachable at which hours, what constitutes a security incident and a reportable breach for this deployment, the notification path and its timing obligations, who may declare an incident, what the first-hour actions are, how the operator and the maintainer divide response, and what capacity actually exists rather than what is intended. Blocks R8 and R9. Stop condition: a written incident-response arrangement naming a responder class for after-hours security events and a recorded escalation path, or operational readiness is recorded as unmet.

## Open decisions (human required)

| Decision | Options | Recommended | Blocks | What settles it |
|---|---|---|---|---|
| R-D1 What "supported" covers | Every dental practice; a declared configuration envelope; one named practice at one named configuration | One named practice, one hosting model with a named operator, US general dentistry, a declared device and integration set; anything outside that boundary is explicitly a limited trial | R1, R12 | Operator, maintainer and practice agreement |
| R-D2 Go/no-go authority | Product owner alone; the operator alone; concurrence of accountable roles | Concurrence of the accountable operator, the clinician reviewer and the security owner, with dissent recorded rather than resolved by seniority | R10 | Governance agreement recorded before any gate is evaluated |
| R-D3 Baseline comparison and claim discipline | Publish improvement claims from post-launch data; publish only paired measurements; publish no claims | Publish an improvement only where the same instrument measured the baseline and the later state; otherwise report the measurement and decline the claim | R3, R11 | Practice agreement and the R-S1 instrument |
| R-D4 Penetration-test severity threshold for release | No open findings; no open critical or high; case-by-case | No open critical or high; mediums either closed or accepted with a named owner, an expiry and a stated compensating control; lows triaged with a recorded decision | R4, R10 | Security owner and maintainer agreement on a written rubric |
| R-D5 Clinical intended-use boundary | Record-keeping support with an explicit exclusion list; broad clinical decision support; diagnostic aid | Record-keeping and workflow support only; explicitly not diagnosis, not radiograph interpretation, not an autonomous treatment recommendation, not emergency triage | R6 | Clinician reviewer sign-off |
| R-D6 Patient-data deployment and cutover authorization | Authorize when the tests pass; authorize by signed instrument naming scope and instant | A signed authorization naming the operator, the hosting region, the arrangements covering each service, the practice and the effective instant; nothing before it | R10, R12 | Practice and operator signature after R-S3 |
| R-D7 Checkpoint offsets and fallback triggers | Fixed calendar reviews; offsets from cutover with named reviewers | Offsets from the cutover event — first operating day, first full week, first month, first quarter — each with a named reviewer, plus a trigger set that suspends new-patient intake rather than waiting for the next checkpoint | R11 | Practice and operator agreement |
| R-D8 Support commitment published at release | Availability guarantee; best-effort statement; a scoped commitment | A published security-fix commitment for all users plus named support hours for the pilot; no availability figure until a drill-backed measurement exists | R8, R10 | Maintainer capacity decision |

## Implementation review focus

- A gate whose text is copied from another plan drifts the first time that plan changes; R1 must be able to show that the wording is resolved from the owning plan, not stored here.
- A gate marked met by the role that produced its own evidence is a single point of self-certification; R2 must report it as unverified until a second role concurs.
- A staff validation completed by one enthusiastic role must not satisfy the composite; R3 must fail a record set that omits a role.
- A penetration finding closed with a note and no retest must reopen; R4 must treat closure without evidence as open.
- A rehearsal that reports matching totals while per-account differences remain must fail; R7 must compare at the account level, not only in aggregate.
- An operational readiness review that names a business-hours contact for a security incident must fail; R8 must check the after-hours responder.
- A degradation drill where a provider outage silently drops queued work must fail even if every alert fired; R9 must check the work, not only the alert.
- A go record with an empty non-claims statement, or a "conditional" decision with no condition owner, must fail; R10 must refuse to produce a valid record.

## Proposed file structure (create only during authorized execution)

`packages/domain/src/release/` owns the gate registry, the evaluator, gate evaluation records, role validation records, finding records, rehearsal records, checkpoint records and the go/no-go record. `packages/contracts/src/release/` owns their schemas, versioned from the first commit. `docs/release/` owns the human-readable gate index, the intended-use statement, the security review record, the operational readiness record, the go/no-go records and the supported-release declaration. `docs/release/evidence/` owns the evidence index that points at artifacts produced elsewhere; it stores references and digests, never copies of clinical content. `tests/integration/release-*.test.ts` holds the suites and `tests/fixtures/release/` holds synthetic gate sets, a synthetic export rehearsal package and a deliberately incomplete backup. No product module is created here, and no evidence file contains patient content.

## Shared interfaces

Proposed contract definitions to create during execution, not code already present:

- `ReleaseGate = { gateId: string; capabilityRef: string; owningPlan: string; owningTask: string; completionConditionRef: string; evidenceKind: 'suite' | 'drill' | 'measurement' | 'reviewRecord' | 'signedDecision'; accountableRole: string; concurringRole: string; reviewInterval: string }` — it stores references, never the completion condition's text.
- `GateEvaluation = { gateId: string; state: 'met' | 'unmet' | 'expired' | 'unverified' | 'notApplicable'; evidenceRef: string; evaluatedAt: string; evaluatorRole: string; concurrenceRef?: string }`.
- `ReadinessReport = { reportId: string; evaluatedAt: string; evaluations: readonly GateEvaluation[]; blockedBy: readonly string[]; unverified: readonly string[]; notClaimed: readonly string[] }`.
- `BaselineTaskSet = { taskSetRef: string; version: string; role: 'reception' | 'hygiene' | 'dentist' | 'billing' | 'practiceManager'; tasks: readonly { taskKey: string; statement: string; measure: 'duration' | 'corrections' | 'reEntries' | 'completion' }[] }`.
- `TaskMeasurement = { taskSetRef: string; version: string; taskKey: string; actorRole: string; observedValue: number; instrumentRef: string; observedAt: string }` — no patient content and no person identifier in the measurement.
- `RoleValidationRecord = { role: string; taskSetRef: string; taskSetVersion: string; measurements: readonly TaskMeasurement[]; result: 'pass' | 'fail' | 'incomplete'; reviewerRef: string; signedAt: string }`.
- `SecurityFinding = { findingId: string; source: 'internalReview' | 'penetrationTest' | 'scan' | 'exercise'; severity: 'critical' | 'high' | 'medium' | 'low' | 'informational'; affectedSurface: string; state: 'open' | 'remediating' | 'closed' | 'acceptedRisk'; closureEvidenceRef?: string; retestRef?: string; acceptedByRef?: string; acceptedUntil?: string }`.
- `IntendedUseStatement = { version: string; purpose: string; intendedUsers: readonly string[]; careSettings: readonly string[]; provided: readonly string[]; explicitlyExcluded: readonly string[]; limitations: readonly string[]; reviewerRefs: readonly string[]; signedAt: string }`.
- `RehearsalRecord = { rehearsalRef: string; kind: 'migrationRehearsal' | 'restoreDrill' | 'degradationDrill'; environmentRef: string; startedAt: string; completedAt?: string; measuredDuration?: number; targetRef: string; result: 'met' | 'missed' | 'incomplete'; gaps: readonly string[] }`.
- `GoNoGoRecord = { recordRef: string; readinessReportRef: string; decision: 'go' | 'noGo' | 'conditional'; conditions: readonly { statement: string; ownerRole: string; expiresAt: string }[]; decidedByRoles: readonly string[]; dissent: readonly string[]; notClaimed: readonly string[]; effectiveFrom?: string; reviewBy?: string }`.
- `CheckpointRecord = { checkpointRef: string; offsetKind: 'firstOperatingDay' | 'firstFullWeek' | 'firstMonth' | 'firstQuarter'; reviewerRoles: readonly string[]; measurements: readonly TaskMeasurement[]; findings: readonly string[]; fallbackDecision: 'none' | 'suspendNewPatients' | 'revertToLimitedTrial' }`.

The gate index this plan publishes, at family level. Every row resolves to the owning plan's task and that task's completion condition; the wording is not repeated here.

| Gate family | Owning plan and task | Evidence kind |
|---|---|---|
| Tenant isolation and the single policy layer | foundation Task 2 | suite |
| Versioned contract and authorization parity | foundation Task 3 | suite |
| Atomic audit and outbox | foundation Task 4 | suite |
| Idempotency and concurrent-update safety | foundation Task 5 | suite |
| Durable worker with fresh authorization | foundation Task 6 | suite |
| MCP parity and no privileged back door | foundation Task 7 | suite |
| Foundation restore proof and privacy-log check | foundation Task 8 | drill |
| Patient identity, merge and guardian scoping | scheduling Tasks 4–6 | suite |
| Booking conflict and attendance separation | scheduling Tasks 10–11 | suite |
| Notification decision separated from booking | scheduling Task 14 | suite |
| Recall and worklist correctness | scheduling Task 16 | suite |
| Scheduling parity and negative matrix | scheduling Task 17 | suite |
| Chart, perio and history integrity | clinical Tasks 6–8 | suite |
| Note signing, amendment and immutability | clinical Task 10 | suite |
| Treatment plan versioning and consent | clinical Tasks 11–13 | suite |
| Clinical parity and export/restore evidence | clinical Task 18 | suite |
| Journal invariants and reversal | billing Tasks 1–2 | suite |
| Statement snapshot and staleness | billing Task 4 | suite |
| Claim lifecycle and remittance reconciliation | billing Tasks 6–8 | suite |
| Imaging association, retention and legal hold | imaging Tasks 3 and 8 | suite |
| Portal grant scoping and consent | portal Tasks 1, 4 and 6 | suite |
| Export and import completeness, reconciliation sign-off | migration Tasks 1, 3 and 6 | suite |
| Downtime and timed restore exercise | migration Task 8 | drill |
| Operator, backup verification and escalation | migration Task 9 | review record |
| Scope registry, refusal matrix and agent identity | A3, A7 and A8 | suite |
| AI boundary and evaluation threshold | A11 and A12 | suite plus signed decision |
| Export surface with no entitlement gate | A15 and A19 | suite |
| Huddle shared-display privacy rule | A18 | suite plus practice sign-off |

### R1: Release gate registry that resolves to other plans' completion conditions

**Dependencies:** every plan listed in the gate index above; R-D1 for the supported boundary. **Status:** implementation of the registry and its resolver.
**Files (proposed):** `packages/contracts/src/release/gate.schema.json`, `packages/domain/src/release/gates.ts`, `docs/release/gate-index.md` (generated), `tests/integration/release-gates.test.ts`.
**Contract:** `ReleaseGate` as above; `registerGate(gate)`; `resolveCompletionCondition(gate)` reading the owning plan's task heading and its completion condition at build time and failing when either is absent; `describeGateCoverage()` comparing capability matrix rows against registered gates; and the rule that no gate stores the owning condition's text.

**Acceptance cases:** a gate naming a task that does not exist in the owning plan fails resolution and names the plan and task; a gate naming a task that exists but carries no completion condition fails rather than resolving to the task title; two gates resolving to the same owning task and completion condition are reported as duplicate coverage rather than both counted; a capability matrix row with no gate is reported as a gap; a gate whose evidence kind is a review record but whose accountable role is unset is rejected; a gate with no concurring role is rejected; a gate pointing at a plan document rather than a task fails; the generated gate index matches the registry exactly, so a hand-edited index fails the build.

**Failure and recovery:** an unreadable owning plan file fails the registry build rather than silently dropping that plan's gates; a plan that renumbers its tasks breaks resolution visibly, with every affected gate listed, instead of leaving stale references; a gate registered for a capability that no plan owns is preserved as an open gap rather than deleted.

**Observable completion condition:** the registry resolves every gate to a live completion condition in an owning plan, the generated index matches it exactly, and a synthesized gap row is reported as a gap rather than omitted.

- [ ] Write the missing-task, missing-condition, duplicate, gap and hand-edited-index cases and confirm failure.
- [ ] Implement the registry and the resolver against the plans as they exist in the repository.
- [ ] Generate the gate index from the registry and prove regeneration is diff-free.
- [ ] Record every unresolved gap explicitly, then commit; no gate is marked met by this task.

### R2: Gate evaluation, staleness and the readiness report

**Dependencies:** R1. **Status:** implementation.
**Files (proposed):** `packages/domain/src/release/evaluation.ts`, `packages/domain/src/release/readiness.ts`, `docs/release/readiness-report.md` (generated), `tests/integration/release-readiness.test.ts`.
**Contract:** `GateEvaluation` and `ReadinessReport` as above; `evaluateGate(gate, evidence)` producing one of the five states; `evaluateReadiness(instant)` returning blocked, unverified and not-claimed sets; `assertDualEvaluation(evaluation)` requiring a concurrence distinct from the evidence-producing role; staleness derived from the gate's review interval against the evaluation instant.

**Acceptance cases:** a gate whose evidence is older than its review interval evaluates as expired rather than met; a gate whose evidence is a failing suite result evaluates as unmet and names the suite; a gate evaluated only by the accountable role that produced the evidence evaluates as unverified until a distinct concurring role records concurrence; a gate whose evidence reference cannot be resolved evaluates as unverified rather than met; an evidence artifact whose digest does not match the recorded one evaluates as unverified; a gate marked notApplicable without a recorded rationale is rejected; the readiness report lists blocked and unverified gates separately and never sums them into a single score that hides one behind the other; the generated report states its evaluation instant and the instant each piece of evidence was produced.

**Failure and recovery:** an evaluation run that cannot reach one evidence source reports that gate unverified and continues rather than aborting the whole report; a report produced while an evaluation is partially complete is marked partial and cannot be used as a go/no-go input; a superseded evidence artifact leaves the earlier evaluation readable for audit rather than overwriting it.

**Observable completion condition:** the readiness report separates blocked from unverified gates, expires stale evidence, and refuses to treat a self-evaluated gate as met.

- [ ] Write the expiry, failing-suite, self-evaluation, unresolvable-evidence and partial-report cases and confirm failure.
- [ ] Implement evaluation, staleness and dual evaluation over the registry.
- [ ] Run the evaluator against a synthetic gate set with one met, one expired, one unmet and one unverified gate.
- [ ] Commit the generated report with its evaluation instant recorded.

### R3: Staff validation per role against a measured baseline

**Dependencies:** R1, R2; R-S1; scheduling Task 17 and clinical Task 18 for the ordinary-day scenarios. **Status:** blocked-on-discovery until the instrument and the practice panel exist.
**Files (proposed):** `packages/contracts/src/release/validation.schema.json`, `packages/domain/src/release/role-validation.ts`, `docs/release/staff-validation.md`, `tests/integration/release-staff-validation.test.ts`.
**Contract:** `BaselineTaskSet` and `TaskMeasurement` and `RoleValidationRecord` as above; `recordBaseline`, `recordMeasurement`, `signRoleValidation`; `evaluateRoleSet()` returning pass only when every required role has a passing record against the same task-set version; `compareToBaseline(measure)` reporting a paired comparison or an explicit statement that no comparable baseline exists.

**Acceptance cases:** a record set omitting the billing role evaluates as incomplete, not as pass; a measurement recorded against a different task-set version than the baseline refuses comparison and states the mismatch; a task that the actor could not complete at all is recorded as a failure rather than dropped from the set; a permission-restricted actor who cannot reach a required location produces a recorded permission finding rather than a workflow failure, and the two are distinguishable; a measurement carrying a patient identifier is rejected by the schema; a signed validation without an instrument reference is rejected; the same instrument and task-set version are required on both sides of a comparison; a role whose validation was signed before a workflow change affecting its task set is reported as stale rather than passing.

**Failure and recovery:** an incomplete validation session preserves the measurements taken and reports the remainder as not performed; an observer who withdraws consent causes the affected measurements to be discarded rather than retained anonymously; a baseline that cannot be measured is recorded as absent, and the release declines the improvement claim under R-D3 rather than substituting a guess.

**Observable completion condition:** the role set evaluates as pass only when every required role has signed the same task-set version, and a comparison without a matching baseline produces an explicit no-claim result.

- [ ] Write the missing-role, version-mismatch, dropped-task, patient-content, stale-signature and no-baseline cases and confirm failure.
- [ ] Implement task sets, measurements and the composite evaluation with no path that treats an omission as a pass.
- [ ] Run the suite against a synthetic record set missing one role and confirm incomplete.
- [ ] Record that no real validation has occurred, then commit the instrument and mechanism only.

### R4: Security review and penetration-test intake to closure

**Dependencies:** R1, R2; R-S2; R-D4; A7 for the refusal matrix and `foundation Task 8` for privacy logging. **Status:** blocked-on-discovery; the finding ledger is implementation.
**Files (proposed):** `packages/contracts/src/release/finding.schema.json`, `packages/domain/src/release/findings.ts`, `docs/release/security-review.md`, `docs/release/rules-of-engagement.md`, `tests/integration/release-findings.test.ts`.
**Contract:** `SecurityFinding` as above; `recordFinding`, `transitionFinding`, `closeFinding({ findingId, closureEvidenceRef, retestRef })`, `acceptRisk({ findingId, acceptedByRef, acceptedUntil, compensatingControl })`; `evaluateReleaseThreshold(threshold)` returning which findings block release under the configured severity rule; `describeEngagementCoverage()` recording which surfaces the engagement did and did not include.

**Acceptance cases:** a critical or high finding in any non-closed state blocks release and is named in the readiness report; closing a finding without retest evidence leaves it open and reopens it if it had been marked closed; accepting a medium risk without a named owner, an expiry and a compensating control is rejected; a finding against a surface added after the engagement is recorded as untested rather than as covered; a finding downgraded in severity by the role that owns the affected code requires a recorded rationale and a concurring role; the rules-of-engagement record proves the test environment was synthetic, and a finding whose evidence contains real patient content is quarantined and reported rather than filed; a duplicate finding reported twice is linked rather than counted as two closures; the review record states which surfaces, hosts and credential classes were in scope and which were excluded.

**Failure and recovery:** a finding whose evidence cannot be read is recorded as unverified and blocks release rather than being closed by default; a retest that cannot be scheduled leaves the finding open with the reason; a disclosure dispute is escalated to the security owner with the record preserved rather than the finding deleted.

**Observable completion condition:** every finding carries a state, a severity and either closure evidence or a dated risk acceptance, and the threshold evaluation names every finding that blocks release.

- [ ] Write the no-retest, missing-owner, untested-surface, downgrade, duplicate and real-content cases and confirm failure.
- [ ] Implement the finding ledger and threshold evaluation with closure requiring evidence.
- [ ] Run the suite against a synthetic finding set containing one open high finding and confirm release is blocked.
- [ ] Record that no engagement exists, then commit the ledger and the rules-of-engagement template.

### R5: Cross-surface access review and revocation exercise

**Dependencies:** A8 and A17; `portal Task 1`; `imaging Task 6`; `migration Task 7`. **Status:** implementation of the exercise; the review requires human participation.
**Files (proposed):** `packages/domain/src/release/access-exercise.ts`, `docs/release/access-review.md`, `tests/integration/release-access-exercise.test.ts`.
**Contract:** `runRevocationExercise({ principalRefs, surfaces })` producing, per principal, one result per surface: staff session, integration credential, agent principal, service account, portal grant, device credential, queued job, previously issued export location, signed storage reference, realtime subscription and archive reference. `recordAccessReviewPeriod` capturing who reviewed which grants and what was removed.

**Acceptance cases:** each principal class is revoked and refused on every surface it could previously reach, in one run, with the results reported per surface rather than as a single pass; a queued job enqueued before revocation is refused at execution; a previously issued export location stops working; a signed storage reference stops working or expires at its stated time, and the difference between revocation and expiry is reported; a portal grant revoked without deleting the patient record is proven by reading the record through a staff path; a device credential revoked mid-job causes the job to fail closed rather than complete; the review records at least one grant that was removed as a result of the review, and a review that removed nothing is reported as a review of unknown thoroughness rather than a clean result; a review period left open past its interval appears as overdue.

**Failure and recovery:** a revocation that succeeds on some surfaces and fails on another reports the failure and does not close the review; an unreachable surface is reported as unverified rather than denied; a credential reissued to replace a revoked one is recorded as a new issuance so the audit trail does not show a resurrected credential.

**Observable completion condition:** the exercise denies every revoked principal on every surface it previously reached and reports any surface it could not verify, with the review period and its removals recorded.

- [ ] Write the per-surface denial, queued-job, export-location, storage-reference and unverified-surface cases and confirm failure.
- [ ] Implement the exercise harness over the transports rather than by inspecting configuration.
- [ ] Run the exercise against a synthetic principal set that includes an agent, a device and a portal grant.
- [ ] Record the review period and its removals, then commit.

### R6: Clinical safety review and the statement of intended use and limitations

**Dependencies:** R-S3; R-D5; clinical Tasks 18 and 10; A11 for AI boundaries. **Status:** blocked-on-discovery until a clinician reviewer and a legal review exist.
**Files (proposed):** `packages/contracts/src/release/intended-use.schema.json`, `packages/domain/src/release/intended-use.ts`, `docs/release/intended-use.md`, `docs/release/clinical-hazard-review.md`, `tests/integration/release-intended-use.test.ts`.
**Contract:** `IntendedUseStatement` as above; `recordHazardReview({ hazardRef, path, severity, detection, mitigationRef, residual })` covering at least note signing and amendment, patient merge and unmerge, deletion and legal hold, prescription submission, claim submission, payment posting and reversal, recall outreach, shared-display privacy and AI draft handling; `validateIntendedUse(statement)` requiring a non-empty exclusion list and limitation list.

**Acceptance cases:** a statement with an empty exclusion list is rejected; a statement that omits an excluded capability the software actually offers is rejected against a checklist derived from the capability matrix; a statement signed only by non-clinical roles fails the clinician reviewer requirement; a statement containing a marketing or comparative claim is rejected; a hazard with no detection path or no mitigation reference is rejected; a hazard whose residual risk is recorded as accepted without a named accepting role and a review date is rejected; a statement describing the AI capability as diagnostic fails; a statement that reuses the word "validated" for an unevaluated capability fails the language check; a statement version referenced by a go/no-go record cannot be silently replaced, and a newer version requires a new record.

**Failure and recovery:** a review that cannot complete leaves the previous statement version as the only readable one and marks the new version as draft, not signed; an unresolved hazard blocks the section it belongs to rather than being carried as a note; a hazard discovered after signing reopens the statement version rather than being appended informally.

**Observable completion condition:** a signed statement names the provided capabilities, the excluded ones and the limitations, and every reviewed hazard carries a detection path, a mitigation reference and a recorded residual risk.

- [ ] Write the empty-exclusion, missing-clinician, marketing-claim, residual-risk and version-replacement cases and confirm failure.
- [ ] Implement the statement and hazard records with the language check.
- [ ] Run the suite and confirm a diagnostic-framing statement is rejected.
- [ ] Record that no clinician has reviewed anything, then commit the mechanism and the draft statement.

### R7: Migration rehearsal against a synthetic export with a timed restore drill

**Dependencies:** R1; migration Tasks 1, 3, 5, 6 and 8; `portal Task 3`; `imaging Task 1`. **Status:** implementation of the rehearsal harness; the real migration remains blocked under `migration D1`.
**Files (proposed):** `packages/domain/src/release/rehearsal.ts`, `docs/release/rehearsal-plan.md`, `docs/release/rehearsal-record.md`, `tests/integration/release-rehearsal.test.ts`, `tests/fixtures/release/rehearsal-package/`.
**Contract:** `RehearsalRecord` as above; `runMigrationRehearsal({ packageRef, targetEnvironmentRef })` exercising intake, dry run, apply, identity decisions, opening figures, the reconciliation report and the two-role sign-off gate; `runRestoreDrill({ backupRef, isolatedTargetRef })` returning a measured duration against the agreed target; `runRollbackWalk()` exercising the documented reconciliation of post-cutover events.

**Acceptance cases:** a rehearsal whose package is not the synthetic fixture is refused, and a package containing real identifiers is quarantined and reported; a rehearsal that reports matching aggregate totals while a per-account difference remains fails, and the differing account is named; a rehearsal that applies twice produces the same target counts and reports the second as a replay; a sign-off simulated by one role fails the two-role gate; a restore drill that omits one entity class is detected by the verification set rather than passing on a checksum alone; a measured duration above the agreed target records `missed` with the gap, and no path rounds it to `met`; a rollback walk that discards post-cutover events instead of reconciling them fails; the rehearsal record states its environment, its package digest and its synthetic-only basis.

**Failure and recovery:** a rehearsal interrupted mid-apply leaves the environment marked incomplete and the record `incomplete` rather than partially passing; an environment reused from a previous rehearsal is reset and its reset recorded, so a leftover row cannot be mistaken for a successful import; a restore that fails leaves the source untouched and the isolated target in a failed state, both reported.

**Observable completion condition:** one rehearsal runs intake through reconciliation sign-off on a synthetic package and one timed restore drill reports a measured duration against the agreed target with any gap named, or records `missed`.

- [ ] Write the non-synthetic-package, per-account-difference, double-apply, single-role-signoff, incomplete-backup and over-target-duration cases and confirm failure.
- [ ] Implement the rehearsal harness over the migration tasks' commands rather than a parallel import path.
- [ ] Run a complete rehearsal and a restore drill against the synthetic fixture and the deliberately incomplete backup.
- [ ] Record the measured results honestly, including any miss, then commit.

### R8: Operational readiness review

**Dependencies:** R1; migration Tasks 8 and 9; R-S4; R-D8. **Status:** implementation of the review record; the operator, objectives and support commitment require human decisions.
**Files (proposed):** `packages/domain/src/release/operational-readiness.ts`, `docs/release/operational-readiness.md`, `tests/integration/release-operations.test.ts`.
**Contract:** `recordOperationalReview({ operatorProfileRef, backupVerificationRef, monitoringPlanRef, incidentPlanRef, escalationRef, maintenancePlanRef, capacityPlanRef, dependencyInventoryRef })`; `evaluateOperationalReadiness(instant)` returning the unmet obligations by name; every item consumed from `migration Task 9` is referenced, not redefined.

**Acceptance cases:** a review with no named operator profile fails; a backup verification older than its interval, or one performed by checksum only where the requirement is an isolated restore, fails; an escalation path naming only business hours fails the after-hours security incident requirement; a monitoring plan with no named alert recipient fails; an incident plan without a breach-notification path fails; a support statement implying an availability figure that no drill measured is rejected; a capacity plan with no measured basis is recorded as an estimate rather than a plan; the dependency inventory missing a service named in the deployment record fails; the evaluation names each unmet obligation separately rather than reporting an overall score.

**Failure and recovery:** an evaluation that cannot read one referenced record reports that obligation as unverified and blocks readiness rather than skipping it; a change of operator is recorded as a new profile with the prior one retained, and readiness re-evaluates rather than carrying forward; a support commitment that cannot be met is reported as unmet rather than reworded.

**Observable completion condition:** the readiness evaluation returns an explicit list of unmet operational obligations for a deliberately under-provisioned synthetic deployment and returns an empty list only when every referenced record is present and current.

- [ ] Write the missing-operator, stale-backup, business-hours-escalation, unmeasured-support and unverified-obligation cases and confirm failure.
- [ ] Implement the review record and evaluation consuming the migration task's records by reference.
- [ ] Run the suite against an under-provisioned synthetic deployment and confirm every gap is named.
- [ ] Record the open operator and support decisions, then commit.

### R9: Degradation drill for provider outage, dead-letter backlog and unknown outcomes

**Dependencies:** R8; `foundation Task 6`; billing Tasks 2, 6 and 7; portal Task 7; A9 and A11. **Status:** implementation of the drill.
**Files (proposed):** `packages/domain/src/release/degradation.ts`, `docs/release/degradation-drill.md`, `tests/integration/release-degradation.test.ts`.
**Contract:** `runDegradationDrill({ scenarioRef, environmentRef })` for scenarios including a payment provider outage, a claims partner outage, a messaging provider outage, an eligibility source outage, an AI provider outage, an expired integration credential, a dead-letter backlog and an object store unavailable state; `assertNoSilentDrop()` comparing intended work items against visible state; `assertAlertsDelivered()`.

**Acceptance cases:** every scenario leaves each affected work item in a visible state — queued, retrying, blocked or unknown — and the assertion fails when any item disappears; an outage that preserves work but delivers no alert fails the drill because nobody would act on it; an alert delivered to no named recipient fails; a retry after an unknown outcome reuses the same external identity so a duplicate charge or duplicate submission is detectable rather than performed; the AI provider outage leaves every care workflow usable, proven by running the ordinary-day scenario during the outage; a dead-letter backlog is surfaced with an age, not only a count; a credential expiry raises a distinct alert before it stops work when the expiry is known in advance; recovery after the scenario restores processing without duplicating an external action.

**Failure and recovery:** a drill that cannot inject one scenario reports that scenario as not exercised rather than as passed; a scenario that corrupts the environment is reported with the reset performed; a partially delivered alert is recorded with the recipient that was missed.

**Observable completion condition:** the drill runs every scenario, each work item remains visible with a state, and a synthetic silent drop and a synthetic undelivered alert are both detected.

- [ ] Write the silent-drop, no-recipient, duplicate-external-action, AI-outage-continuity and unexercised-scenario cases and confirm failure.
- [ ] Implement the drill scenarios against synthetic adapters and the existing worker.
- [ ] Run the drill with one scenario delivering no alert and confirm detection.
- [ ] Record the drill results and any unexercised scenario, then commit.

### R10: Go/no-go record and the explicit non-claims statement

**Dependencies:** R1–R9; R-D2, R-D4, R-D6. **Status:** implementation of the record format; the decision requires humans.
**Files (proposed):** `packages/contracts/src/release/go-no-go.schema.json`, `packages/domain/src/release/go-no-go.ts`, `docs/release/go-no-go/` (one record per decision), `tests/integration/release-go-no-go.test.ts`.
**Contract:** `GoNoGoRecord` as above; `createDecisionRecord({ readinessReportRef, decision, decidedByRoles, dissent, notClaimed, conditions })`; `validateRecord(record)` requiring a readiness report whose blocked set is empty for a go decision, a non-empty `notClaimed` list, a named owner and expiry on every condition, and the required concurring roles.

The required content of `notClaimed` is stated once: not certified against any framework, not clinically validated, not compliant merely because a control exists, not covered by an availability or recovery guarantee the drills did not measure, not validated for any practice, hosting model, device or integration outside the boundary recorded under R-D1, and not a replacement for professional or legal review.

**Acceptance cases:** a go decision whose readiness report has any blocked gate is refused; a go decision whose report has unverified gates is refused until they are resolved or the decision becomes conditional with a condition covering each; an empty or missing non-claims list is refused; a conditional decision whose condition has no owner or no expiry is refused; a record signed by fewer than the configured concurring roles is refused; a decision recorded without a dissent field is refused, and dissent recorded as none is stored explicitly rather than left absent; a record whose readiness report is superseded by a later report is refused; a no-go decision without stated reasons is refused; a go record whose effective instant precedes the patient-data authorization under R-D6 is refused.

**Failure and recovery:** a decision recorded against a partial readiness report is refused rather than stored as pending; a record whose signature cannot be completed leaves the decision as not taken rather than assumed; a later unmet gate reopens the decision as suspended with the reason, rather than editing the record.

**Observable completion condition:** the validator refuses every premature or under-specified go record and accepts exactly one record that has an empty blocked set, named concurring roles, a dissent field and a non-empty non-claims list.

- [ ] Write the blocked-gate, empty-non-claim, ownerless-condition, insufficient-concurrence, superseded-report and pre-authorization cases and confirm failure.
- [ ] Implement the record, the validator and the required non-claims content.
- [ ] Run the suite and confirm no path produces a valid go record from an incomplete readiness report.
- [ ] Commit the format; no decision is recorded by this task.

### R11: Post-launch review checkpoints and the fallback trigger

**Dependencies:** R10; R-D7; R3 for the paired measurements; R9 for incident classes. **Status:** implementation of the checkpoint format and evaluator; the offsets require agreement.
**Files (proposed):** `packages/contracts/src/release/checkpoint.schema.json`, `packages/domain/src/release/checkpoints.ts`, `docs/release/checkpoints.md`, `tests/integration/release-checkpoints.test.ts`.
**Contract:** `CheckpointRecord` as above; `describeCheckpointObligations(decisionInstant)` returning the required checkpoints at their offsets with their named reviewer roles and measures; `evaluateFallbackTriggers(incidents, measurements)` returning `none` or a named fallback with its basis.

The trigger set is stated once, as proposed: a data-loss or cross-tenant exposure incident, a financial reconciliation difference outside the agreed tolerance, a clinical incident in a path this plan reviewed, an unresolved unplanned downtime beyond the agreed window, or a support commitment missed beyond its stated allowance. A trigger suspends new-patient intake until the checkpoint's fallback decision is recorded, rather than waiting for the next checkpoint.

**Acceptance cases:** a checkpoint recorded without measurements is refused; a checkpoint whose reviewer roles do not include the roles the obligation named is refused; a checkpoint closed without reviewing the incidents in its interval is refused; a fallback trigger that was met but not acted on is reported as an overdue fallback rather than a noted finding; the first operating day checkpoint requires a narrower measure set than the first quarter checkpoint and cannot be closed with the quarter's measures alone; a checkpoint recorded ahead of its offset is refused; a checkpoint after a fallback decision records the decision it implements; a comparison to baseline is reported only where the same instrument and task-set version measured both, otherwise as no claim.

**Failure and recovery:** a missed checkpoint remains open and overdue rather than being skipped; an unavailable measure is recorded as unavailable with the reason, and the checkpoint reports partial rather than pass; a fallback decision taken outside a checkpoint is recorded as its own event and referenced by the next checkpoint.

**Observable completion condition:** the evaluator returns the required checkpoints and their reviewers for a synthetic decision instant, and a met-but-unactioned fallback trigger is reported as overdue.

- [ ] Write the no-measurement, wrong-reviewer, unactioned-fallback, premature and partial cases and confirm failure.
- [ ] Implement checkpoint obligations and fallback evaluation.
- [ ] Run the suite with a synthetic incident that meets a trigger and confirm the overdue fallback is reported.
- [ ] Record the proposed offsets as open under R-D7, then commit.

### R12: Release evidence bundle and the supported-release declaration

**Dependencies:** R1–R11; R-D1 and R-D6. **Status:** implementation of the bundle and the declaration format; the declaration requires the decisions.
**Files (proposed):** `packages/domain/src/release/evidence-bundle.ts`, `docs/release/evidence-index.md` (generated), `docs/release/release-declaration.md`, `tests/integration/release-bundle.test.ts`.
**Contract:** `buildEvidenceIndex({ readinessReportRef, records })` producing an index of every artifact with its digest, producing task, instant and location, and the rule that the index stores references and digests rather than copies of clinical content; `validateDeclaration(text)` rejecting language that claims certification, clinical validation, compliance from a control's existence, or an unmeasured guarantee, and rejecting an undeclared boundary.

**Acceptance cases:** an index missing an artifact referenced by a met gate fails; an index whose recorded digest does not match the artifact fails; an evidence artifact containing patient content is rejected and quarantined; a declaration that uses the word certified, validated, compliant or guaranteed outside an explicit denial is rejected; a declaration that does not state the supported boundary under R-D1 is rejected; a declaration naming a hosting model, device or integration outside the recorded boundary is rejected; the declaration names the go decision record it implements and cannot exist without a go record; the index states what is deliberately excluded, including the evidence that cannot exist before a real engagement.

**Failure and recovery:** a bundle built while a gate is unverified states the gap rather than omitting the row; an artifact that cannot be read is recorded as missing with the affected gates named; a declaration superseded by a new decision is retained with its supersession recorded rather than deleted.

**Observable completion condition:** the evidence index resolves every met gate to a digest-verified artifact, and the declaration validator rejects each prohibited claim while requiring the boundary statement.

- [ ] Write the missing-artifact, digest-mismatch, patient-content, prohibited-claim and missing-boundary cases and confirm failure.
- [ ] Implement the index builder and the declaration validator.
- [ ] Run the suite against a synthetic evidence set containing one broken digest and one prohibited claim.
- [ ] Commit the formats; no declaration is issued by this task.

## Plan self-review and scope boundary

This plan covers release evidence: the gate registry and its resolver, gate evaluation with staleness, staff validation per role against a measured baseline, security and penetration findings tracked to closure, a cross-surface revocation exercise, clinical intended-use and hazard review, migration and restore rehearsals, operational readiness, degradation drills, the go/no-go record with its required non-claims statement, post-launch checkpoints and the final evidence bundle.

It creates no product capability and no domain contract. It does not restate any other plan's completion condition, does not claim a penetration test, a staff measurement, a clinical review, a rehearsal result, a recovery figure or an operator agreement, and cannot produce a go record while any gate is unmet. Every one of R3, R4, R6, R7, R8 and R9 is blocked until a human participant, an engagement or an environment exists, and this document records that rather than scheduling it.

Nothing here asserts regulatory certification, compliance, clinical validation or a service-level guarantee. A control that exists is recorded as a control that exists. Nothing in this document is implemented, tested, validated, approved, deployed or certified, and no release decision has been taken.
