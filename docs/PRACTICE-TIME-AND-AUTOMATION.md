# Practice time, usability and end-to-end automation

Status: user-directed product requirements, 2026-11-04. Proposed behavior, not implemented or validated capability. Extends existing contracts; does not authorize product coding, UI design, vendor outreach or production actions.

## Product pillars

Ease of use is a first-class acceptance requirement alongside correctness, security and portability. The user's "Apple-like" direction means coherent behavior, understandable language, low setup burden, accessible interactions and predictable recovery; it does not mean copying Apple's design or hiding uncertainty. UI visual/interaction design remains deferred.

Optimize for completed practice work and staff time returned, not generated text, number of features or automation counts. Enter a fact once and reuse its authoritative source. Never ask staff to reconstruct information the system already knows. Present a clear current state, next action and responsible owner; distinguish completed, awaiting external response, blocked and unknown. Show costs, limitations and external dependencies before commitment.

Routine approved work should progress without repeated staff clicks. Humans handle material judgment, missing facts, policy exceptions and legally/professionally required actions. Automation must be configurable per practice and operation; disabling AI must preserve deterministic workflows. No silent expansion of consent, scope or spending authority.

## Automation authority

Use three modes: read/recommend, prepare-for-approval, and policy-authorized execution. Initial AI remains read/draft until its evaluation gate passes. Deterministic validated workflows may execute under an explicitly granted, revocable standing policy rather than requesting human approval on every item. Each policy names owner, permitted operations, scope, prerequisites, limits, expiry/review, escalation and stop conditions. Workers recheck authority at execution and record the policy version and action receipt.

Standing authorization is not permission to fabricate documentation, sign as a clinician, change codes to obtain payment, waive balances or bypass consent. Clinical signatures and prescribing retain required human roles. Refunds, write-offs, appeals, external messages and submissions follow their operation-specific approved policy; uncertain or material changes escalate. A rule-approved submission of an unchanged, validated claim need not require another redundant click if the practice and partner permit it. An AI-generated narrative remains a draft until the required factual review occurs.

## Claims: closed loop from delivered care to resolved account

| ID / stage | Required behavior | Human exception / acceptance proof |
|---|---|---|
| CL-01 Visit preparation | Refresh qualified eligibility, identify relevant authorization/documentation requirements and unresolved coverage before the visit; show source and freshness | Unknown/stale coverage stays unknown; never imply eligibility guarantees payment |
| CL-02 Claim assembly | Build a versioned claim from actually completed procedures, rendering/billing identities and current source records; capture payer/subscriber linkage | Missing provider enrollment, subscriber mismatch, unsupported route or incomplete clinical record blocks release; never invent care or coding |
| CL-03 Readiness validation | Run deterministic and qualified payer/clearinghouse checks; identify exact missing facts with source links and responsible owner | Correction resolves the original issue without re-entering unrelated information; changes invalidate stale validation |
| CL-04 Attachment package | Locate authorized images, perio data, notes, EOBs and narratives appropriate to the request; create a patient/claim/version/hash-bound package, preserve originals | Staff reviews uncertain matches and generated narratives; wrong patient, wrong date, altered source or missing document cannot pass |
| CL-05 Authorized dispatch | Submit the validated immutable claim/package automatically under qualified standing policy or explicit approval | Consent/authority, source versions and partner requirements rechecked; approved payload changes require revalidation and applicable approval |
| CL-06 Acknowledgements and tracking | Distinguish queued, sent, unknown, clearinghouse receipt/rejection, payer acceptance and adjudication; ingest/poll qualified status and associate attachments | Receipt is not payment; duplicate/out-of-order responses do not regress state or duplicate work |
| CL-07 Rejection and correction | Normalize rejection reason with protected original evidence; route a precise corrective task; prepare linked replacement/correction claim | Safe mechanical fixes may follow approved rules; coding/clinical/subscriber ambiguity needs review; no blind resubmission after timeout |
| CL-08 Aging and follow-up | Detect missing acknowledgements, unanswered attachment requests and overdue payer follow-up using configurable partner-aware deadlines | One owned exception per underlying issue; escalation is bounded, deduplicated and visible; portal-only steps explicitly identified |
| CL-09 Denials and appeals | Separate denial from transport rejection; assemble reason, supporting evidence, deadline and draft appeal | No invented facts or guaranteed recovery; require appropriate review before sending; preserve original claim and appeal history |
| CL-10 Remittance and cash | Match ERA lines to claim/procedure/adjustment and reconcile EFT/check settlement using qualified references; propose or rule-post authorized allocations | ERA is not cash settlement; duplicate ERA, ambiguous match, unexpected adjustment and underpayment route to review; posted corrections reverse/amend |
| CL-11 Secondary responsibility | Prepare secondary claim with primary adjudication/COB evidence when qualified; track its full submission lifecycle | Do not prematurely bill the patient for unresolved insurer responsibility; exceptions remain assigned |
| CL-12 Patient balance and closure | Produce explainable remaining responsibility and approved statement/payment follow-up; close only when all responsibilities and exceptions are resolved | Closure distinguishes payment, approved adjustment, transfer and unresolved amounts; no silent write-off; reconciliation includes unapplied credit |

A persistent workflow instance links claim versions, attachment packages, submission attempts, payer responses, appeal tasks, remittances, settlement and allocations without collapsing their state machines. Each step records input versions, rule/model provenance where applicable, authority, outcome, retries and next expected event. Only the owning domain posts changes. Durable timers/outbox advance the workflow; models do not own financial state.

## Exception-first operation

Cross-module work items carry reason code, safe explanation, evidence references, owner/queue, due time, priority rationale, suggested next action and blocking dependencies. Group duplicates by underlying problem; one repair can resolve related tasks only after revalidation. Make who owes the next action explicit: practice, patient, payer, vendor or platform. Preserve assignment/escalation history and prevent orphaned tasks when staff leave.

Detect connector outage separately from missing clinical information. Unknown external success is reconciled before retry or route change. Support bounded retries, pause/resume, cancellation of unexecuted steps and replay protection. Reversal/amendment is required for committed clinical/financial history. Bulk actions expose scope and per-item results; partial completion never appears as full success.

## Time savings across the practice

| ID | Capability and automated routine path | Required boundary |
|---|---|---|
| PT-01 | Prepare the next day's huddle from forms, eligibility, balances, labs and schedule dependencies | Sources/freshness shown; missing modules never treated as checked |
| PT-02 | Match cancellations to clinically appropriate waitlist candidates and coordinate approved outreach | Provider/resource/duration/preferences/consent checked; race-safe booking; invitation is not attendance |
| PT-03 | Track accepted-unscheduled/incomplete treatment, lab returns and referral responses | Assigned work and closure evidence; contact policy, no inappropriate automated clinical recommendation |
| PT-04 | Draft documentation from approved inputs and reuse verified data | Human clinical review/signing; no invented findings or silent history changes |
| PT-05 | Explain balances, detect unmatched funds and prepare reconciliation work | Deterministic arithmetic and provenance; no model-authored journal posting |
| PT-06 | Provide understandable analytics and operational priorities | Declared definitions, dates, filters and freshness; measured outcomes, not proxy success counts |

## Easy migration and exit are product capabilities

MG-01: support reusable, versioned source adapters and an inventory-led onboarding checklist. Tab32 remains the first qualified source; identify subsequent source systems by demand and lawful export/API availability. Do not claim universal import or require practices to hand-map every field on each run.

MG-02: identify input format, propose mappings and show confidence/provenance; automatically map known validated fields, queue ambiguous identities, terminology and monetary semantics for review. Never guess patient matches, signatures, money or clinical meaning. Staff receive a concise discrepancy summary with actionable fixes; technical details remain available to the migration operator.

MG-03: provide resumable dry runs, idempotent staged imports, counts/checksums and per-account reconciliation. Preserve original provenance and an explicit not-imported list. Supported history is searchable through the approved archive; missing source export cannot silently become missing patient history.

MG-04: guide the authorized operator through freeze/delta import, review, cutover and reconciliation-based rollback. Keep clinical/billing sign-off proportionate to risk, not a demand to inspect every correctly validated field. No dual writes or destructive reset after new clinical work. Support assistance and explain downtime expectations without promising zero downtime.

MG-05: export complete usable records and attachments with verified manifests; the practice can leave without a feature key. Document any continuing acquisition-software/archive license and operating cost before migration commitment. "Easy" cannot hide vendor restrictions or transfer all technical burden to the dentist.

## Usability and outcome acceptance

UX-01: plain-language states, consistent operation names, sensible defaults, progressive disclosure of advanced settings, keyboard-accessible workflows, clear validation and preservation of entered work after recoverable failure. Do not hide clinically material warnings for visual simplicity.

UX-02: routine workflows reuse existing facts, avoid unnecessary context changes, show progress/next action and support safe correction. Automatic actions are inspectable with receipts and a pause mechanism. Do not insert confirmation dialogs for every harmless action; use proportional safeguards for consequential operations.

UX-03: later role-based testing with reception, billing, hygienist, dentist and manager measures unaided completion, active handling time, corrections, duplicate entry, context switches, onboarding effort and support requests. Establish task-specific thresholds and baselines before testing; do not invent an "Apple-like" score or claim improvement without evidence.

Outcome measures include staff minutes/touches per resolved claim/account, first-pass clearinghouse acceptance (distinct from payer adjudication), rejection/denial rates by reason, days to payment, aged unresolved claims, intervention rate by workflow and avoidable duplicate effects. Measure scheduler effort and actual filled/attended cancellations separately. Migration measures include operator/practice hours, mapping exceptions, unreconciled records/balances, downtime and time to usable history. Report automation failures and corrections alongside successes; never optimize financial throughput by suppressing exceptions.

## Build-plan ownership and gates

- B5–B8 own CL-01–12 coverage/claim/ERA/COB behavior; B1–B4/B9 own journal and patient balance effects. B10 must prove the complete cross-step synthetic journey and failure cases, not only endpoint tests.
- A owns orchestration/standing-policy registration, scopes, provenance and parity; F supplies durable execution/approvals/audit. Extend validated infrastructure rather than introducing a second privileged automation engine.
- S/E own PT-01–03 scheduling and communication portions; C/I own clinical context, documents and lab/referral facts. A reporting consumes authoritative projections for PT-05–06.
- M1–M10 own MG-01–05 mapping/dry-run/import/archive/cutover/exit evidence. R owns UX-03 measurement and end-to-end benefit validation before public claims.
- For each affected implementation task, add operation schemas, policy/limit configuration, negative/retry/concurrency tests, observable completion and owner before coding. Extend the current branch without overwriting active builders' work.

Mandatory synthetic journeys: clean claim with qualified automatic dispatch and matched payment; missing/incorrect attachment; stale approval; payer rejection followed by linked correction; post-acceptance timeout; denial/appeal; duplicate/out-of-order response; partial remittance with secondary claim; unresolved settlement; provider outage; revoked standing policy mid-job; exception owner departure; migration retry and mismatched balance; inability to export required history. No external actions are exercised on real patients as tests.

Routine automation can release progressively as its dependencies and gates pass. Clinical/legal judgments, partner enrollment and staff validation are not waived. No claim of zero-touch operation, guaranteed reimbursement, zero-effort migration or measured time savings until demonstrated. All capabilities remain subject to the existing privacy, security, open-source and certification-scope rules.
