# CuspAtlas synthetic acceptance scenario pack

Status: **acceptance criteria for work not yet built.** No scenario in this document has run, passed or been validated. Nothing here is implemented, tested, clinically validated or approved. Every statement below describes required behavior, not observed behavior. The word "expected" always means "required by the specification", never "known to occur".

This document is the synthetic acceptance pack required by [the handoff](DEEPSEEK-HANDOFF.md) ("Synthetic acceptance scenario pack, including an ordinary practice day and exceptions") and the P3 exit condition in [the roadmap](ROADMAP.md) ("Every P1 capability has a measurable acceptance case and an owner"). It is written to serve as the definition of done for the first replacement release.

## Cross-workflow additions

The [practice time and automation contract](PRACTICE-TIME-AND-AUTOMATION.md) adds mandatory CL-01–12 claim-to-resolution journeys, PT-01–06 time-saving workflows and MG-01–05 migration cases. Each relevant scenario must report automatic steps, human interventions/reasons, unresolved external outcomes and safe recovery. UX-01–03 later measure role-based ease of use. A clean endpoint response is insufficient evidence of completed practice work.

## What this pack is

1. **Part A** is one continuous synthetic clinic day, end to end, as numbered steps. It is the release smoke test: if a step cannot be demonstrated in a single run against one fixture set, the release is not replacement-ready.
2. **Part B** is the exception and adversarial set. Ordinary days do not break practices; these do.
3. **Part C** is the oracle: for each domain it states what the correct answer is computed from, so a test can never compare a feature to itself.
4. **Part D** is the execution contract: fixtures, seeds, determinism, observable completion conditions and evidence artifacts.

## What this pack is not

- Not a test plan for real patient data. Every scenario runs on fabricated fixtures in a synthetic tenant. No production export, no de-identified real chart, no real payer response, no real card, no real message, no real sensor output.
- Not evidence that a capability exists. A capability becomes implemented only when its plan task's acceptance cases pass under the restricted runtime role and its named reviewer signs the record that task depends on.
- Not a substitute for the plan tasks. Each scenario names the plan tasks that must exist to satisfy it. A scenario with a missing task dependency is a plan gap, not a passing test.
- Not a UI specification. Steps describe facts and commands, never screens. UI design remains the last planning stage.

## Synthetic cast and environment

All identifiers are obviously fabricated. No name below corresponds to a person, and no fixture may be replaced by a real record under any circumstance.

| Label | Kind | Notes |
|---|---|---|
| PRACTICE-1 | Tenant (practice organization) | One location. The default tenant for Part A. |
| LOCATION-1 | Location of PRACTICE-1 | Timezone `America/New_York`. |
| PRACTICE-2 | Tenant (second practice) | Exists only to exercise cross-tenant denials. Holds its own fabricated patients and one resource with the same label as a PRACTICE-1 resource. |
| STAFF-FRONT-DESK-1 | Human actor, reception role | Books, checks in, collects money. No signing scope, no ledger adjustment scope. |
| STAFF-BILLING-1 | Human actor, billing role | Claims, remittance, statements, payment plans. Holds `receivables.read`, `undistributedFunds.read`, `openClaims.read`. |
| STAFF-MANAGER-1 | Human actor, practice manager | Merge, override, plan void, report access. |
| STAFF-IT-1 | Human actor, operator/administrator | Deployment, backup, restore, operator records. Not a clinician. |
| PROVIDER-1 | Provider resource, dentist | Treats PATIENT-A and PATIENT-D. |
| PROVIDER-2 | Provider resource, dentist | Treats PATIENT-C. |
| HYGIENIST-1 | Provider resource, hygienist | Prophylaxis and periodontal charting. |
| ASSISTANT-1 | Staff resource | Chairside. |
| OPERATORY-1, OPERATORY-2 | Operatory resources | Physical rooms. Neither label may resemble an appointment state. |
| EQUIPMENT-1 | Equipment resource | Intraoral acquisition unit, front operatory. |
| DEVICE-1 | Paired bridge device | Bound to EQUIPMENT-1 and OPERATORY-1. |
| PATIENT-A | Adult patient, returning | Has coverage under CARRIER-1 and prior history. The main treated patient of the day. |
| PATIENT-B | Adult patient, new | Calls in the morning. No prior record. |
| PATIENT-C | Minor patient | Date of birth makes PATIENT-C a minor on DAY-1. |
| GUARDIAN-B | Guardian of PATIENT-C | Holds a guardian relationship with scoped authority. |
| PATIENT-D | Adult patient, urgent add-on | Calls with pain; requires an override or a squeeze-in. |
| PATIENT-E | Adult patient | Scheduled, arrives late, then rescheduled to a later window. |
| PATIENT-F | Adult patient | Scheduled and becomes the day's no-show. |
| CARRIER-1 | Canonical payer | One canonical carrier identity. |
| CARRIER-1-ALIAS-1 | Observed alias string | A punctuation variant of CARRIER-1 that appears on an inbound remittance. Must resolve to CARRIER-1, never create a second carrier. |
| DEVICE-1 job scope | Capability grant | `acquire` and `import` only. Never `probe` on arbitrary paths. |

Environment constants for every scenario in this pack: tenant PRACTICE-1; location LOCATION-1; timezone `America/New_York`; DAY-1 = 2026-11-12 (standard time, no clock change on this date); currency USD; money stored as integer minor units. Currency, timezone and date basis are fixture data, never ambient system state.

Amounts, codes and durations are synthetic fixture constants, never real fee schedules or licensed code content. Where a step refers to a fee or an amount, the value is a fixture constant resolved from the fee schedule version in force; this document names no amount and asserts no practice's fees.

## Task reference convention

Tasks are numbered plainly within their own plan. A reference to another plan names it, exactly as the plans themselves do: `scheduling Task 10` is Task 10 of the patients and scheduling plan. Bare "Task N" is never used in this document.

| Short name used here | Plan file |
|---|---|
| `foundation Task N` | [platform foundation](superpowers/plans/2026-11-03-platform-foundation.md) |
| `scheduling Task N` | [patients and scheduling](superpowers/plans/2026-11-04-scheduling-and-patients.md) |
| `clinical Task N` | [clinical record](superpowers/plans/2026-11-04-clinical-record.md) |
| `billing Task N` | [billing and RCM](superpowers/plans/2026-11-04-billing-and-rcm.md) |
| `imaging Task N` | [imaging and devices](superpowers/plans/2026-11-04-imaging-and-devices.md) |
| `portal Task N` | [portal and communications](superpowers/plans/2026-11-04-portal-and-communications.md) |
| `migration Task N` | [migration and operations](superpowers/plans/2026-11-04-migration-and-operations.md) |

Open decisions and discovery spikes are cited with the letter `D` and the number that plan gives them, for example `billing D2` is the claims and clearinghouse partner qualification spike, and `clinical D5` is the amendment authority open decision. A scenario that depends on an unclosed spike is marked as such and **cannot be signed off on synthetic adapters alone**; the plans say this explicitly for `billing Tasks 6-8`, `imaging Tasks 5-6` and `migration Tasks 2 and 7`.

---

# Part A — The ordinary practice day

DAY-1 begins before the first patient and ends after the last recall is booked. The narrative is continuous: each step's preconditions are satisfied by the steps before it, and a single scenario run must reproduce the whole day in order. A step may not be executed against a fixture that was edited by hand between steps; the run is one sequence.

Numbered steps: A-01 through A-20.

## Step A-01 — Opening the day and reviewing the huddle

07:40. STAFF-FRONT-DESK-1 opens the day and STAFF-MANAGER-1 reviews the huddle for LOCATION-1. The huddle is not a dashboard render of cached numbers: each item is a query over stored facts with a stated as-of instant.

| Field | Content |
|---|---|
| Scenario id | A-01 |
| Preconditions | PRACTICE-1, LOCATION-1, OPERATORY-1, OPERATORY-2, PROVIDER-1, PROVIDER-2, HYGIENIST-1, EQUIPMENT-1 defined with effective-dated availability for DAY-1. One confirmed appointment for PATIENT-A with PROVIDER-1. One unsigned note draft from a prior day for PATIENT-A. One unapplied credit already posted for PATIENT-D. Recall policy for LOCATION-1 configured with a version. No time blocks yet. |
| Actor | STAFF-FRONT-DESK-1 (read), STAFF-MANAGER-1 (read) |
| Action | Open the day list for LOCATION-1 for DAY-1. Then open the huddle items: today's appointments with derived attendance state, active medical alerts for today's patients, unsigned note drafts, incomplete treatment, undistributed funds, recall due list. |
| Expected resulting facts | The day list returns exactly the appointments scheduled for DAY-1 at LOCATION-1 and no appointment from another location or tenant. Attendance is returned as an append-only transition sequence plus a derived current state, not a stored status column. Medical alerts return allergies and conditions with an explicit `unknown` state for any patient with no verified history, never an implied "no allergies". Unsigned drafts are listed as drafts with author and version. The undistributed funds query returns the PATIENT-D credit with an age basis. The recall due list states the policy version, the as-of instant and the freshness basis. Every read of patient-identifying material is audited as a sensitive read with actor, tenant, resource and correlation id. |
| Must NOT happen | No write occurs for any huddle read. No appointment, hold, notification intent or task is created. No cached status field is presented as the authoritative attendance state. No record from PRACTICE-2 appears. No clinical narrative, note body or full contact value appears in an audit payload or ordinary log. The recall list does not send anything and creates no outreach task. |
| Plan tasks that must exist | foundation Task 2, foundation Task 3, foundation Task 4, scheduling Task 7, scheduling Task 11, scheduling Task 16, clinical Task 8, clinical Task 10, billing Task 2, billing Task 9, portal Task 6 |

## Step A-02 — A new patient calls

08:05. PATIENT-B telephones. There is no record, so STAFF-FRONT-DESK-1 creates an identity record, records demographics and contact preference, and takes an appointment request. The request is not a booking.

| Field | Content |
|---|---|
| Scenario id | A-02 |
| Preconditions | A-01 complete. The patient search for PATIENT-B returns no match. PATIENT-B shares a household telephone number with PATIENT-A, who already exists in PRACTICE-1. |
| Actor | STAFF-FRONT-DESK-1 |
| Action | Create PATIENT-B with minimum required identity fields, one absent optional field group left explicitly unknown, and the shared household telephone. Then create an appointment request with preferred windows, appointment type, urgency flag false, source channel `phone`, requester identity and contact-consent state. Then run duplicate candidate search for PATIENT-B. |
| Expected resulting facts | One patient record exists with a version, a recorded author and provenance per field group, and an explicit `unknown` where the optional group is absent — not an empty string that reads as "none". One appointment request exists in `open` state and holds no resource. Duplicate candidates are returned with contributing reasons that name the shared household telephone as the reason, and no action is taken. Identity, audit and outbox commit atomically, and exactly one audit success is recorded for the create. A search for appointments for PATIENT-B returns none. The request carries a notification decision recording the channel choice and, where applicable, a suppression reason. |
| Must NOT happen | No appointment, hold or occupancy is created by the request. The shared household telephone does not merge PATIENT-B into PATIENT-A, and neither creation nor search proposes a merge automatically. No message is sent. A resubmission with the same idempotency key does not create a second patient or a second request. No contact value is echoed into an error, log or audit payload. No cross-tenant patient or location identifier is accepted from the caller. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 1, scheduling Task 4, scheduling Task 6, scheduling Task 8, scheduling Task 14, portal Task 4 |

## Step A-03 — A returning patient books

08:25. PATIENT-A calls to move a cleaning into the day. STAFF-FRONT-DESK-1 searches availability and books. The booking is a new fact, distinct from the request and from attendance.

| Field | Content |
|---|---|
| Scenario id | A-03 |
| Preconditions | A-02 complete. HYGIENIST-1 has availability for a prophylaxis duration on DAY-1. PATIENT-A has one existing confirmed appointment with PROVIDER-1 on DAY-1 (from A-01) that is not being rescheduled by this step. |
| Actor | STAFF-FRONT-DESK-1 |
| Action | Search availability for a prophylaxis of the configured duration with HYGIENIST-1 at LOCATION-1 on DAY-1. Then book the chosen window with HYGIENIST-1 and OPERATORY-2, recording the notification decision. Then read PATIENT-B's still-open request. |
| Expected resulting facts | Search returns only windows free for the full duration plus buffer for every required resource, names the resources each result would occupy, names the constraints applied, and states what was not considered. Search writes no hold, no booking and no outbox event. The booking returns outcome `booked` with an appointment reference and a version. The appointment records provider, operatory, window in UTC plus display zone, duration in integer minutes, and its own actor and instant. Exactly one audit success and one outbox event exist for the booking. The notification decision row exists even when the channel is `none`, with the suppression reason recorded. |
| Must NOT happen | Search does not persist any side effect. Booking does not create a clinical note, a procedure completion, a charge or a payment. A conflict does not produce a partial appointment or an unhandled error. The booking does not silently join an existing recurring series. Confirmation source is not collapsed: nothing here records a confirmation. The operatory is not inferred from a label. No message is sent from inside the booking transaction. Booking for one patient does not link or close another patient's open request. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 7, scheduling Task 9, scheduling Task 10, scheduling Task 14 |

## Step A-04 — A guardian books for a minor

08:40. GUARDIAN-B telephones for PATIENT-C, who is a minor. The guardian relationship is the only basis for authority, so it is resolved at the moment of the command rather than assumed from the call.

| Field | Content |
|---|---|
| Scenario id | A-04 |
| Preconditions | A-03 complete. PATIENT-C exists with a birth date that makes PATIENT-C a minor on DAY-1. GUARDIAN-B holds an active guardian relationship for PATIENT-C scoped to `demographics`, `scheduling`, `financial` and `consent`, with an effective window that includes DAY-1 and an expiry rule configured per the tenant. GUARDIAN-B does not hold `clinical_read` and is not staff. |
| Actor | GUARDIAN-B (portal principal), assisted by STAFF-FRONT-DESK-1 for provider assignment |
| Action | Resolve portal principal for GUARDIAN-B. Submit a portal appointment request for PATIENT-C with PROVIDER-2 preference. Staff book the resulting request for PATIENT-C with PROVIDER-2 and OPERATORY-1. Separately, attempt to read a clinical note for PATIENT-C as GUARDIAN-B. |
| Expected resulting facts | `resolvePatientAccess` returns the effective relationship, its scope, its expiry and the reason, computed at command time. The portal request is created in the same shared request aggregate staff read, with origin `portal`, one identifier and one audit entry naming the portal origin. Booking the request produces one appointment linked to the request, and both records show the link. The clinical note read is denied with a typed denial because the grant scope does not include `clinical_read`. Portal and staff transports produce the same policy outcome for the same operation on the same record. |
| Must NOT happen | Guardian relationship does not grant staff capability and is not upgraded by the staff assistance. The portal principal cannot supply a tenant, location or provider value outside the allowed set. The request does not become an appointment without an explicit staff booking. The guardian does not read, sign or amend clinical content. Access is not inferred from surname, household phone, household email or family membership. The denial does not disclose whether a clinical note exists. |
| Plan tasks that must exist | foundation Task 2, foundation Task 3, scheduling Task 1, scheduling Task 5, scheduling Task 8, scheduling Task 10, portal Task 1, portal Task 3, clinical Task 10 |

## Step A-05 — An urgent add-on

09:10. PATIENT-D calls with pain. There is no free window of the required duration with PROVIDER-1 for the rest of the morning, so the add-on requires either a hold on a later window or an authorized override of a soft conflict. Resource overlap is never overrideable.

| Field | Content |
|---|---|
| Scenario id | A-05 |
| Preconditions | A-04 complete. PROVIDER-1's DAY-1 morning is fully occupied. The appointment type for urgent assessment has a configured duration. The tenant policy names which conflict kinds are overrideable and which are not. STAFF-MANAGER-1 holds the override permission and STAFF-FRONT-DESK-1 does not. |
| Actor | STAFF-FRONT-DESK-1 (attempt and refusal), STAFF-MANAGER-1 (authorized override) |
| Action | Create an urgent request for PATIENT-D with the urgency flag true. Search availability. Attempt to book a window that overlaps an existing PROVIDER-1 booking. Then place a hold on the earliest window that fits and offer it. Then, separately, attempt an override of the soft conflict kind `insufficient_duration` with a reason while STAFF-FRONT-DESK-1 is the actor. |
| Expected resulting facts | The urgency flag is stored as a boolean on the request and changes no lifecycle state. The overlapping booking attempt returns outcome `conflict` with a non-empty conflict list naming the blocking resource and the existing record, and stating that the overlap is not overrideable. No appointment, occupancy or success audit is written by the refused attempt, and exactly one audited denial is recorded. The hold occupies the chosen window for its configured lifetime and appears to availability search as unavailable. The override attempt by STAFF-FRONT-DESK-1 is refused for insufficient permission, not for the conflict kind. A subsequent override by STAFF-MANAGER-1 with an override code, reason and identified actor succeeds, is audited, and records the override on the appointment. |
| Must NOT happen | `ASAP` or urgency is never stored as a lifecycle state or as a status value. A refused booking never leaves a partial appointment, a phantom occupancy or a success audit. A resource overlap is never overridden by any actor. The hold is not converted to a booking without an explicit acceptance or booking command. No double booking is created by retrying the refused attempt. The hold does not block another tenant's resource. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 3, scheduling Task 7, scheduling Task 8, scheduling Task 9, scheduling Task 10, scheduling Task 15 |

## Step A-06 — Arrivals and check-ins, including curbside

09:00 to 10:20. The front desk records arrivals as they happen. Arrival is an attendance fact only; it never implies clinical completion, billing, or a change of the booking.

| Field | Content |
|---|---|
| Scenario id | A-06 |
| Preconditions | Steps A-03 through A-05 produced bookings for PATIENT-A, PATIENT-C and PATIENT-D on DAY-1. A curbside arrival variant is configured for LOCATION-1. |
| Actor | STAFF-FRONT-DESK-1 |
| Action | Record `arrived` for PATIENT-A's prophylaxis appointment. Record `arrived_curbside` for PATIENT-C's appointment, then `waiting`. Record `arrived` and then `waiting` for PATIENT-D's urgent appointment. Read `getVisitStatus` for each of the three appointments. |
| Expected resulting facts | Each attendance transition is appended with actor, instant, source and reason, and the current state is derived rather than stored as a mutable column. Curbside arrival and in-person arrival are distinguishable as different transition kinds in the append-only history. `getVisitStatus` returns attendance, clinical-completion reference and billing reference as three separate fields, each either a resolvable reference or an explicit unavailable status with a reason. Each transition is retrievable in order with its actor and instant, and no prior transition value changes. |
| Must NOT happen | Arrival does not set clinical completion. Arrival does not set any billing fact. Arrival does not change the booking's window, provider or operatory. A repeated arrival with the same idempotency key does not append a second transition. An out-of-order transition, such as leaving before arriving, is refused rather than recorded. Attendance is not reported as one overloaded status field. No transition is recorded for another tenant's appointment. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 10, scheduling Task 11, clinical Task 14 |

## Step A-07 — A late arrival

10:35. PATIENT-E arrives twenty minutes late for a 10:30 appointment. Lateness is an exception fact with a configured reason code, and the schedule consequence is a separate decision.

| Field | Content |
|---|---|
| Scenario id | A-07 |
| Preconditions | A-06 complete. The DAY-1 fixture seeds a 10:30 appointment for PATIENT-E with PROVIDER-1 in OPERATORY-1 that was confirmed earlier by an automated reminder, so the confirmation source is `confirmed_automated`. A `late` reason code set is configured. |
| Actor | STAFF-FRONT-DESK-1 |
| Action | Record `late` for PATIENT-E's appointment with the configured reason code and an optional note. Then record `arrived` and `waiting`. Then reschedule the appointment to a later window with PROVIDER-1 and OPERATORY-1, because the remaining time is insufficient. |
| Expected resulting facts | The `late` transition is recorded as an exception kind with actor, instant and reason code, and does not overwrite the booking or the earlier automated confirmation. The automated confirmation remains distinguishable from a manual one in a query that counts the two separately. `arrived` follows `late` without erasing it, so the history shows both the exception and the arrival. The reschedule preserves the original appointment and its version, records a link to the new booking, and releases the old occupancy in the same transaction. A stale `expectedVersion` on the reschedule returns a typed conflict with reconciliation guidance and writes nothing. |
| Must NOT happen | Recording lateness does not create a cancellation, a no-show, a charge or a clinical fact. Rescheduling does not delete or overwrite the original appointment, does not lose the late transition and does not leave the old occupancy in place. The automated confirmation is not converted to a manual one. A failed reschedule leaves no partial occupancy. No message is sent from inside the reschedule transaction; the notification decision is recorded separately. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 10, scheduling Task 11, scheduling Task 14 |

## Step A-08 — A no-show

11:00. PATIENT-F does not arrive for an 11:00 appointment. The no-show is an attendance outcome with a reason code, not a deletion and not a pseudo-room.

| Field | Content |
|---|---|
| Scenario id | A-08 |
| Preconditions | A-07 complete. The DAY-1 fixture seeds an 11:00 appointment for PATIENT-F with PROVIDER-1. A `no_show` reason code set is configured. The tenant model allows an appointment to carry no operatory with a typed exception reason. |
| Actor | STAFF-FRONT-DESK-1 |
| Action | Record `no_show` for PATIENT-F's appointment with a reason code and a note. Then read the appointment, its operatory reference and its attendance history. |
| Expected resulting facts | The `no_show` outcome is an attendance transition with actor, instant, reason code and optional note. The appointment remains readable with its version. Its operatory reference may be cleared to null with a typed exception reason, and the null operatory is a valid stored state that participates in conflict checks. The note attached to the no-show is stored as an attendance note and is not searchable as a clinical note. A no-show count query for DAY-1 returns exactly one for PRACTICE-1 and distinguishes it from a late arrival and from a cancellation. |
| Must NOT happen | No pseudo-resource or state-labeled room is created or referenced to park the appointment. The no-show does not delete the appointment, its clinical context, its forms or a lab slip reference. No charge, no claim and no ledger entry is created by the no-show. A no-show without a configured reason code is refused; a recorded one does not fall back to a default reason. The appointment's attendance history is not rewritten. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 7, scheduling Task 10, scheduling Task 11, scheduling Task 14, scheduling Task 16 |

## Step A-09 — Treatment delivered and charted

10:05 to 11:30. PATIENT-A's prophylaxis and PATIENT-D's urgent assessment are treated. The encounter, the chart findings, the periodontal exam, the history changes and the rendered procedures are separate authored facts.

| Field | Content |
|---|---|
| Scenario id | A-09 |
| Preconditions | A-08 complete. PATIENT-A's attendance is `waiting` and PATIENT-D's is `waiting`. An encounter can be opened for each appointment. A treatment plan exists for PATIENT-D with one plan version, one detail and two items. |
| Actor | PROVIDER-1, HYGIENIST-1 |
| Action | Open an encounter for PATIENT-A's appointment with treating, secondary, staff and completing assignments recorded separately. Record a surface-specific chart finding on one tooth and one existing restoration. Record a periodontal exam with six sites per tooth over the examined arch, leaving one site unmeasured. Record a history change (one allergy, patient-reported). Record two rendered procedures for PATIENT-D, one of which renders a plan item. Close both encounters with a configured disposition. |
| Expected resulting facts | Opening the encounter twice for one appointment returns the same encounter and one audit success. Each role assignment is independent: changing one leaves the others. The chart entry records the canonical tooth identity, the display system as a projection, the surface set, the finding, the author, the instant and its provenance. The unmeasured periodontal site is stored as `not_measured` and excluded from derived arithmetic while remaining listed. Derived periodontal values carry the version of the formula that produced them. The history change is an event with state, provenance `patient_reported` and author, and a read as-of the prior instant returns the earlier version. Rendering a procedure sets exactly that plan item to `completed` through the rendering command. Closing an encounter with a disposition is audited and refuses new chart entries afterward. |
| Must NOT happen | Closing an encounter does not complete every planned procedure. Rendering one procedure does not change any other plan item. No clinical command posts money, creates a ledger entry or creates a claim. No amount is written by a clinical command. The unmeasured site is not stored as zero. A derived periodontal value is not stored without its formula version. A finding on a tooth type with no such surfaces is refused rather than recorded. No signed content is edited; chart corrections are supersessions. Imported or patient-reported provenance is never promoted to clinician-verified without the verification command. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, clinical Task 1, clinical Task 5, clinical Task 6, clinical Task 7, clinical Task 8, clinical Task 11, clinical Task 14 |

## Step A-10 — A note is signed, then amended

11:45. PROVIDER-1 signs the encounter note for PATIENT-A. At 14:10 the same clinician discovers an omission and amends it. Signing freezes content; the amendment is additive.

| Field | Content |
|---|---|
| Scenario id | A-10 |
| Preconditions | A-09 complete. PATIENT-A has one open note draft for the encounter, bound to a template version whose required sections are addressed. STAFF-FRONT-DESK-1 holds no signing scope. |
| Actor | PROVIDER-1 (sign and amend), STAFF-FRONT-DESK-1 (refused sign attempt) |
| Action | Sign the draft. Attempt to update the signed content through the draft update command. Attempt a direct write to the signed content under the application role. Create an amendment with a reason. Read all note versions and verify digests. Attempt to sign the same draft again as STAFF-FRONT-DESK-1. |
| Expected resulting facts | Signing freezes the content digest, the signer identity, the signing instant, the template version and the history version referenced. The update command refuses with a typed error, and the direct write is refused by table privilege, not only by handler code. The amendment appends a new version that references the signed version and states the reason, author and instant, and the signed version remains retrievable byte-identical with its digest verifying. The version chain is linear and each version is addressable. A second signature attempt returns one typed conflict with guidance and writes no second signature. The sign attempt by STAFF-FRONT-DESK-1 is denied for scope and is audited. |
| Must NOT happen | No path updates, overwrites, re-signs or backdates signed content. The amendment is not attributed to a different author, and it does not replace the signed version. The digest of the signed version does not change. A template enforcement deficit does not get bypassed at signing. An unattributed or model-authored draft is never signed. A concurrent signature does not merge two contents into one version. The audit does not contain the note body. |
| Plan tasks that must exist | foundation Task 2, foundation Task 4, foundation Task 5, clinical Task 2, clinical Task 8, clinical Task 9, clinical Task 10, clinical Task 18 |

## Step A-11 — An estimate is presented and consent is captured

12:15. After the urgent assessment, PROVIDER-1 presents a treatment estimate to PATIENT-D for a two-item plan and captures the patient's consent for the plan version presented.

| Field | Content |
|---|---|
| Scenario id | A-11 |
| Preconditions | A-10 complete. PATIENT-D has an accepted plan version with two alternatives, each with its own detail and items. An eligibility record for PATIENT-D exists with a capture instant and a staleness window; for this step the record is stale on DAY-1. Fee schedule version FEE-1 is published and effective for DAY-1. |
| Actor | PROVIDER-1, PATIENT-D |
| Action | Generate an estimate for the first alternative against FEE-1 and the stale eligibility record. Present it. Record acceptance of that exact plan version and estimate version. Record consent with method `in_person` against the same plan version and the consent template digest. Generate a revised estimate after a coverage assumption changes. |
| Expected resulting facts | The estimate records the plan version, the fee schedule version, the coverage assumptions with origin and freshness, and amounts as integer minor units with USD. Because the eligibility record is stale, the estimate presents a labeled unknown or stale coverage status and does not present a guaranteed patient-responsibility figure. Presentation marks the estimate presented and refuses to present a superseded version as current. Acceptance binds the exact plan version and estimate version with actor and instant. Consent records the subject, scope, bound plan version, method, template digest, signer, effective instant and, where the method requires it, a witness. The revised estimate is a new version; the earlier version, its acceptance and its consent remain intact. |
| Must NOT happen | No estimate is presented as a coverage guarantee. A stale eligibility record is not silently treated as current. Changing a fee reference or a coverage assumption does not mutate the accepted estimate or the accepted plan version. A newer plan version does not inherit the earlier consent. Consent is not recorded against a superseded plan version. No signature image is stored in the domain store; a paper capture records an evidence reference and digest. The second alternative is not deleted. No amount is invented for an item without a fee reference; such an estimate is marked incomplete. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 5, clinical Task 11, clinical Task 12, clinical Task 13, billing Task 5, billing Task 9, billing D3, clinical D6, clinical D7 |

## Step A-12 — Check-out and payment

12:40. PATIENT-A checks out. Charges post from the rendered procedures, the patient pays part of the balance by card, and the payment is allocated to specific charges.

| Field | Content |
|---|---|
| Scenario id | A-12 |
| Preconditions | A-11 complete. PATIENT-A has two rendered procedures from A-09 with completion facts and a rendering provider. Fee schedule FEE-1 resolves a fee for each. A synthetic payment adapter is configured that can return `confirmed`, `declined` and `unknown`. |
| Actor | STAFF-FRONT-DESK-1 |
| Action | Post one charge journal entry per rendered procedure with the resolved fee and the recorded fee-schedule version. Record a patient payment intent through the payment adapter with an idempotency key. Post the confirmed patient payment. Allocate the payment across the two charges with an explicit remainder policy. Record `checked_out` attendance for PATIENT-A's appointment. Read the patient balance. |
| Expected resulting facts | Each charge is a balanced journal entry with integer minor units, USD, a service date, a posting instant, the actor and the fee-schedule version used. The payment is a separate balanced entry with a provider reference and its idempotency key. The allocation rows reference the payment entry and the charge entries, and their sum equals the allocated amount with any residual minor unit assigned by the documented deterministic rule. The patient ledger balance is derived from posted entries and their allocations, and equals the sum of charges minus payments minus adjustments. `checked_out` is an attendance transition only. Exactly one audit success exists per command, and each command carries a correlation id. |
| Must NOT happen | No billing fact is created from an attendance state and no attendance state is created from a billing fact. A declined card creates no payment entry, no allocation and no charge reversal; it records the attempt outcome. An `unknown` adapter outcome is not posted as collected and is not retried automatically. A repeated provider receipt does not create a second payment entry. The allocation does not exceed available funds. No balance is stored as a mutable column. No card data is stored beyond the provider token reference. No floating-point money value appears anywhere. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 11, clinical Task 14, billing Task 1, billing Task 2, billing Task 9, billing D1 |

## Step A-13 — A payment plan with auto-pay

13:05. PATIENT-D cannot pay the remaining balance in full and asks for a plan. A plan is created, authorized, and enrolled in auto-pay. Authorization, schedule, collection and closure remain separate facts.

| Field | Content |
|---|---|
| Scenario id | A-13 |
| Preconditions | A-12 complete, but for PATIENT-D rather than PATIENT-A: PATIENT-D has an open balance after a partial payment. A payment-method token with an expiry after the final scheduled installment is on file. A signed authorization record is required before the plan can be authorized. |
| Actor | STAFF-BILLING-1, PATIENT-D |
| Action | Create a payment plan for the guarantor with a contract total equal to the open balance, an installment amount and a due date schedule. Attempt to set the plan authorized without an authorization fact. Record the authorization fact with the patient, then authorize the plan. Enroll auto-pay with the consent basis and payment-method reference. Run the installment scheduler once for the first due period. Run the scheduler a second time for the same period. |
| Expected resulting facts | The plan records contract total, installment amount, schedule, next due date, authorization state, auto-pay state and card expiry state as distinct fields. Authorization without a recorded authorization fact is refused with a typed error. After the authorization fact, the plan is authorized and that state is derived from the facts rather than set as a free field. Each auto-pay run for a due period creates exactly one attempt record with amount, time, adapter result, idempotency key and retry count. The second scheduler run for the same period adds no second attempt. The plan balance is derived from scheduled and posted installments and the journal, not from a stored computed field. |
| Must NOT happen | The plan is never authorized without an authorization fact. Card expiry is never a silent non-event; it is a state with a worklist. A failed or unknown installment attempt does not disappear and does not advance the schedule. No card data beyond the provider token and its expiry is stored. Two concurrent scheduler runs do not produce two charges for one installment. The plan balance is not stored as mutable data. Auto-pay enrollment without a consent and authorization record is refused. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, billing Task 1, billing Task 2, billing Task 3, billing D1 |

## Step A-14 — An insurance eligibility check

13:25. Before the claim, STAFF-BILLING-1 verifies benefits for PATIENT-A through the synthetic eligibility adapter. The result is provenance with a staleness window, not a permanent fact.

| Field | Content |
|---|---|
| Scenario id | A-14 |
| Preconditions | A-13 complete. PATIENT-A has effective-dated coverage: CARRIER-1 primary, rank 1, effective before DAY-1. A synthetic eligibility adapter is configured to return a mapped response, a timeout, and an unmappable response on demand. |
| Actor | STAFF-BILLING-1 |
| Action | Resolve active coverage for PATIENT-A for service date DAY-1. Record an eligibility response with source, capture instant and staleness window. Assess freshness for DAY-1. Then force a timeout on a second request and record its outcome. Then force an unmappable response and record its outcome. |
| Expected resulting facts | Coverage resolution returns exactly the primary coverage effective on DAY-1, with order of benefits and effective dates, and a service date outside the effective range resolves to nothing. The eligibility record names its source, capture instant and staleness window, and derives as fresh or stale for a given service date. The timeout outcome is recorded as `unknown`, never as ineligible, and it creates no coverage conclusion. The unmappable response is stored as raw evidence with an explicit unparsed state rather than a partially interpreted benefit. Each recorded response is auditable and carries the carrier identity resolved to CARRIER-1 with the observed alias string preserved verbatim beside the canonical reference. |
| Must NOT happen | A timeout is never recorded as ineligible. An unmappable response is never partially interpreted into benefit fields. A stale record is never silently treated as current, and an estimate or claim that used one does not rewrite the assumption afterwards. An unrecognized carrier alias does not silently create a new carrier. The eligibility record does not become a coverage guarantee. Retention of a real response is not assumed; only synthetic responses appear here. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, billing Task 5, billing D3 |

## Step A-15 — A claim is created and submitted for one visit

13:50. STAFF-BILLING-1 prepares and submits one claim for PATIENT-A's visit. Preparation draws only on procedures with a completion fact and a rendering provider.

| Field | Content |
|---|---|
| Scenario id | A-15 |
| Preconditions | A-14 complete. PATIENT-A's two rendered procedures exist with completion facts and a rendering provider. FEE-1 resolves the fees. A synthetic claims partner adapter is configured and an authorized partner reference exists. |
| Actor | STAFF-BILLING-1 |
| Action | Prepare a claim from PATIENT-A's rendered procedures for DAY-1. Validate it. Submit the validated version with an idempotency key. Record the partner acknowledgement. Re-submit the same claim with the same idempotency key. Attempt to submit a stale claim version. |
| Expected resulting facts | The claim is prepared only from procedures carrying a completion fact and a rendering provider, and it cites the exact claim version submitted. Validation produces a typed result with any deficits listed. Submission requires the validated version and an authorized partner, and returns the partner reference. Acknowledgement is recorded as its own fact, separate from acceptance and rejection. The idempotent resubmission returns the same partner reference and creates no second claim. A stale version returns a typed conflict naming the current version. The submitted body is immutable and is replaced only by a new version. |
| Must NOT happen | No claim is prepared from a procedure without a completion fact or without a rendering provider. No claim is prepared from an appointment, an attendance state or a plan item. The submitted claim body is never edited. Acknowledgement is never collapsed into a single claim status, and rejection never removes the claim from the actionable worklist. Submission never happens twice for one idempotency key. No licensed code-set content is bundled; fixtures use synthetic placeholder codes. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, foundation Task 6, clinical Task 14, billing Task 5, billing Task 6, billing Task 9, billing D2, billing D4 |

## Step A-16 — A denial is received and an appeal is opened

14:55. The synthetic partner returns a rejection for the claim. STAFF-BILLING-1 records the denial with its source vocabulary identity, keeps the claim actionable, and opens an appeal as a separate object.

| Field | Content |
|---|---|
| Scenario id | A-16 |
| Preconditions | A-15 complete. The synthetic partner is configured to return a rejection with a denial code drawn from a versioned synthetic vocabulary. |
| Actor | STAFF-BILLING-1 |
| Action | Record the rejection adjudication with the denial code, its source vocabulary identity and version. Read the open-claims worklist. Open an appeal citing the claim version and the basis. Attempt a second appeal on the same basis. Attempt to submit a replacement claim version that cites the rejected version. |
| Expected resulting facts | The denial is stored with the code and the vocabulary identity and version, not as free text only. Rejection, acceptance and acknowledgement remain separate recorded facts. The open-claims worklist shows the claim as rejected and actionable, with the reviewer, the age and the assignment history. The appeal is a separate object linked to the claim and does not mutate the claim state. A second appeal on the same basis is refused with a typed conflict. The replacement claim version cites the rejected version explicitly and leaves the rejected version readable. |
| Must NOT happen | The denial is never recorded as a bare status value on the claim. The claim is never deleted, hidden or marked closed by a rejection. An appeal is never represented as a claim state. Reassignment never orphans the claim or erases assignment history. The rejected version is never edited into a corrected one. No real payer denial vocabulary or adjudication timeline is asserted; this scenario runs only against a synthetic partner and is blocked until `billing D2` closes. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, billing Task 6, billing D2 |

## Step A-17 — An ERA is posted and reconciled

15:20. A remittance file arrives for the claim. It is staged, posted all-or-nothing, and reconciled against the claim and the charge.

| Field | Content |
|---|---|
| Scenario id | A-17 |
| Preconditions | A-16 complete. A synthetic remittance file exists for one claim, with one insurer payment line and one contractual adjustment line, and one line that cannot be matched to a single charge. The file carries a control identity. |
| Actor | STAFF-BILLING-1 |
| Action | Stage the remittance file, recording the artifact digest and control identity. Post the remittance. Re-ingest the same file. Read the reconciliation result and the unmatched list. |
| Expected resulting facts | Staging records a digest and a control identity and posts nothing. Posting creates insurer payment and adjustment journal entries that are balanced, plus a reconciliation item for the line that cannot be matched. The insurer payment and the adjustment together reconcile the charge to its expected allowed amount, and the patient responsibility is derived from the posted entries. Re-ingesting the same control identity is rejected as a duplicate and changes no total. The unmatched line appears in a reconciliation item naming the subject and the required action rather than being guessed onto a patient. Every posted entry cites the staged artifact it came from. |
| Must NOT happen | Re-ingesting the same file never posts twice and never changes totals. An unmatched line is never guessed onto a patient or a charge. A partially parsed file posts nothing. A posting failure midway leaves no partial posting. A correction is never an edit of a posted entry; it is a reversal with linkage. A remittance referencing another tenant's claim is refused. No payer remittance layout is assumed; the fixture is synthetic and the scenario is blocked until `billing D2` closes. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, billing Task 1, billing Task 2, billing Task 6, billing Task 7, billing D2 |

## Step A-18 — Undistributed funds are allocated

15:45. PATIENT-D's credit from A-12 is still undistributed. STAFF-BILLING-1 allocates it. Moving money between patients requires an explicit command with a reason.

| Field | Content |
|---|---|
| Scenario id | A-18 |
| Preconditions | A-17 complete. PATIENT-D has an unapplied credit entry with an age basis. PATIENT-D also has an open charge from the plan. A second patient, PATIENT-A, also carries an unapplied credit that originated from an insurer overpayment. |
| Actor | STAFF-BILLING-1, STAFF-MANAGER-1 |
| Action | List undistributed funds for PRACTICE-1. Allocate PATIENT-D's unapplied credit to PATIENT-D's open charges. Attempt to allocate PATIENT-A's credit to a PATIENT-D charge. Then move the remaining PATIENT-A credit to PATIENT-D under an explicit command with a reason. |
| Expected resulting facts | The undistributed funds query returns, per patient and currency, the unapplied amount with an age basis, derived from posted entries and their allocations rather than a stored remainder. Allocating one patient's credit to that patient's charges succeeds and reduces the undistributed amount to the derived residual. The cross-patient allocation attempt without the move command is refused. The explicit move command with a reason succeeds, is audited, records the from and to patients and the reason, and produces a transfer entry. After the commands, a query distinguishes allocated from undistributed money per patient and currency exactly. |
| Must NOT happen | Undistributed funds never appear as an unexplained silent remainder. Money is never moved between patients without an explicit command and a reason. Allocation never exceeds available funds. A denial of the `undistributedFunds.read` scope does not permit inferring totals through a filter, a count or a report. Cross-tenant allocation is refused with the same error shape as a missing record. No allocation is created for a patient whose coverage is unresolved without a recorded reason. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, billing Task 1, billing Task 2, billing Task 9 |

## Step A-19 — A statement is generated

16:10. STAFF-BILLING-1 generates and delivers a statement for PATIENT-A's guarantor with a cutoff, a snapshot and a stated basis.

| Field | Content |
|---|---|
| Scenario id | A-19 |
| Preconditions | A-18 complete. PATIENT-A's guarantor has an open balance after posting, allocation and the insurer payment. The statement basis and cutoff are configured. A statement template version exists. |
| Actor | STAFF-BILLING-1 |
| Action | Generate the statement for the guarantor with a cutoff instant and a stated basis. Record delivery through the configured channel. Re-generate with the same idempotency key and the same cutoff. Re-generate for a new cutoff. Post a payment after generation, then read statement freshness. Attempt to generate for a guarantor of PRACTICE-2. |
| Expected resulting facts | Generation is one audited command with the actor, tenant, cutoff, basis, snapshot digest and the version of the statement body that produced it. The statement row carries a balance computed at generation and is never updated afterwards. The idempotent re-generation returns the same record. Re-generation for a new cutoff produces a new record that supersedes the earlier one by reference without altering it. After the later payment, the earlier statement derives as stale from its snapshot compared with the current derived balance, and staleness is derived rather than stored. Delivery is a separate event from generation, and a delivery failure does not void the statement. The cross-tenant generation attempt is denied with the same error shape as a missing guarantor. |
| Must NOT happen | A generated statement is never updated, restated or corrected in place. A stale statement is never delivered through the ordinary path without an explicit reissue that names the superseded record. Generation never reads a cached balance field as its authority. Print, delivery and generation are never collapsed into one event. A negative statement is never produced silently for a credit balance. No statement is addressed to a guarantor outside the tenant. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, billing Task 1, billing Task 2, billing Task 4, billing Task 9, portal Task 2 |

## Step A-20 — A recall is scheduled

16:40. The day closes with recall. STAFF-FRONT-DESK-1 works the due list, creates a contact task, and books the patient's next visit. Computing the list sends nothing.

| Field | Content |
|---|---|
| Scenario id | A-20 |
| Preconditions | A-19 complete. A recall policy for LOCATION-1 names the recall category, the interval, the qualifying event basis, the already-booked exclusion rule and the outreach authorization flag, and it has a version. PATIENT-A's qualifying completed procedure exists with a service date. PATIENT-B has no qualifying event. PATIENT-C has a future booked appointment. |
| Actor | STAFF-FRONT-DESK-1 |
| Action | Compute the recall due list for DAY-1. Create a recall contact task for PATIENT-A with the explicit command. Book PATIENT-A's recall appointment for the computed due window. Recompute the due list for the same as-of instant and policy version. |
| Expected resulting facts | The due list returns, per patient, the last qualifying event, the due date, the reason, the policy version and the as-of instant. PATIENT-A appears as due. PATIENT-B appears in a separate "no baseline" group and is not counted as overdue. PATIENT-C is either excluded under the exclusion rule or shown with the exclusion reason, depending on the configured rule, and the behavior is stated rather than implied. Computing twice for the same as-of instant and policy version returns identical rows. Creating the contact task is a separate audited command. Booking the recall appointment produces a booking linked to the patient, and the exclusion rule is applied consistently at the next computation. |
| Must NOT happen | Computing the due list creates no appointment, no hold, no notification intent and no task. The due list does not send outreach; outreach remains a notification decision with consent and suppression reasons. A booked patient is not silently dropped from the list under an unstated rule. A no-baseline patient is not treated as overdue. A policy change never silently rewrites an earlier result; the earlier result keeps its recorded policy version. A deceased or inactive patient is not listed as due. |
| Plan tasks that must exist | foundation Task 4, foundation Task 5, scheduling Task 3, scheduling Task 10, scheduling Task 14, scheduling Task 16, clinical Task 14, portal Task 6 |

---

# Part B — Exception and adversarial scenarios

Each scenario is independently executable against the same fixture pack, in any order, after Part A has produced the shared facts. Scenarios marked **blocked-on-discovery** cannot be signed off until the named spike closes; a synthetic adapter proves our machinery, not a vendor's contract.

Numbered scenarios: B-01 through B-18.

## B-01 — Double-booked provider

| Field | Content |
|---|---|
| Scenario id | B-01 |
| Trigger | Two actors, STAFF-FRONT-DESK-1 and STAFF-MANAGER-1, book the same PROVIDER-1 window with overlapping ranges within the same controlled-concurrency window. A third attempt names the same provider with a different operatory. |
| Expected system behavior | Exactly one attempt returns outcome `booked`. Every other attempt returns outcome `conflict` with a non-empty list naming the blocking resource and the existing record. Occupancy is enforced by a database constraint per reserved resource and time range, including holds, and a constraint violation maps to a conflict result rather than an unhandled error. The losing attempts write no appointment, no occupancy, no outbox event and exactly one audited denial each. A deadlock is retried within a bounded budget and then returns a conflict; it never produces a partial booking. A conflict refusal names the constraint; a resource overlap is not overrideable by any role. |
| Evidence that proves it | The controlled-concurrency run output with per-attempt outcomes; the appointment row count per contended slot; the occupancy rows per range; the audit entries showing one success and N denials with correlation ids; the captured conflict payload as a stored example; a repeat run at higher concurrency with an unchanged count of committed bookings per slot. |
| Plan tasks | foundation Task 4, foundation Task 5, scheduling Task 7, scheduling Task 9, scheduling Task 10 |

## B-02 — Booking into a closed time block

| Field | Content |
|---|---|
| Scenario id | B-02 |
| Trigger | A time block covers OPERATORY-1 and PROVIDER-1 for a closure window on DAY-1 with a reason and no patient. Staff attempt to book inside the closure, first by naming the window directly and then by choosing a window that straddles the block boundary. |
| Expected system behavior | Availability search does not return the blocked window and lists the time block among the constraints applied. Both booking attempts return a conflict naming the time block as the blocking subject with an explanation and an overrideable flag. No appointment, occupancy or success audit is written. A time block that overlaps an existing booking is refused at creation with the affected booking references. A booking-side conflict returns before any write. |
| Evidence that proves it | The time block record with its reason; the availability search response showing the constraint and the absent window; the two conflict payloads; the appointment and occupancy row counts before and after; the audit denials; the refused overlapping-block creation error. |
| Plan tasks | scheduling Task 7, scheduling Task 9, scheduling Task 10, foundation Task 4 |

## B-03 — Appointment deleted while a claim references the visit

| Field | Content |
|---|---|
| Scenario id | B-03 |
| Trigger | After a claim was submitted for a visit, an actor attempts to delete the appointment: through the cancel path, through a domain delete command if one exists, and through a direct delete under the application role. |
| Expected system behavior | There is no appointment delete command, and the direct delete under the application role is refused by privilege. Cancellation records a reason code and a notification decision reference and does not remove the appointment. The clinical facts recorded during the visit and the financial facts the visit produced remain readable and linked. The claim keeps its visit reference and remains actionable. The visit context resolves through the canceled appointment and is marked with the appointment state. |
| Evidence that proves it | The typed error or privilege denial for each delete attempt; the appointment still readable with its version; the unresolved claim reference resolving to the appointment; the attendance history intact; the audit entries for the refused attempts; a query count of appointments before and after; the cancellation record with its reason and notification decision. |
| Plan tasks | foundation Task 2, foundation Task 4, scheduling Task 10, scheduling Task 11, scheduling Task 12, clinical Task 5, billing Task 6 |

## B-04 — A note is amended after a claim was submitted

| Field | Content |
|---|---|
| Scenario id | B-04 |
| Trigger | After the claim was submitted in A-15, PROVIDER-1 amends the signed note. Separately, the rendered procedure that generated a claim line is corrected by reversal and replacement. |
| Expected system behavior | The note amendment appends a new version referencing the signed version, with author, instant and reason; the signed version remains byte-identical with its digest verifying. The claim body, its version and its digest are unchanged by the note amendment. The rendered-procedure correction emits a correcting event rather than mutating the earlier event, and the claim becomes flagged as requiring a replacement version rather than being silently resubmitted. A replacement claim version cites the earlier version explicitly. |
| Evidence that proves it | The note version chain with per-version digests before and after the amendment; the claim version row and its digest unchanged; the correcting outbox event with its correction relationship; the replacement claim link; the claim review flag; the audit entries naming the note version and the claim version separately; proof that no audit entry reports an item edit as a plan edit. |
| Plan tasks | clinical Task 10, clinical Task 14, billing Task 6, foundation Task 4 |

## B-05 — A payment is reversed after a statement was mailed

| Field | Content |
|---|---|
| Scenario id | B-05 |
| Trigger | A posted patient payment is reversed by STAFF-BILLING-1 after the statement covering it was generated and delivered. The reversal is attempted twice concurrently. |
| Expected system behavior | The reversal is a new journal entry that cites the reversed entry; both entries remain readable and their amounts net exactly. Two concurrent reversals produce one reversal and one typed conflict. The statement row is not updated. Its snapshot digest and balance are unchanged, and it derives as stale because the current derived balance differs. Delivering a further statement through the ordinary path is refused until an explicit reissue that names the superseded record. Delivery and print events already recorded remain. |
| Evidence that proves it | The journal entry pair with the reversal link; the derived balance recomputed from posted entries; the unchanged statement snapshot digest; the freshness derivation output naming stale; the reissue record naming the superseded statement; the one-conflict-one-success concurrency output; the audit entries; a direct update attempt on the statement row denied. |
| Plan tasks | billing Task 1, billing Task 2, billing Task 4, foundation Task 4, foundation Task 5 |

## B-06 — A payment plan card expires before the final installment

| Field | Content |
|---|---|
| Scenario id | B-06 |
| Trigger | The card token on file for a payment plan expires before the final scheduled installment. The scheduler runs for the period whose due date falls after the expiry. The patient later supplies a new payment method. |
| Expected system behavior | The derived card expiry state becomes `expired` on the plan, and the plan enters the expired-card worklist without being voided. The auto-pay run does not silently skip the installment: it creates an attempt record with an explicit failure or blocked state and exactly one open reconciliation item. The prior authorization remains readable and is not rewritten. Updating the card expiry requires a new authorization record, and the worklist entry resolves only through a recorded outcome. Collected money and previously posted installments remain in the journal. |
| Evidence that proves it | The plan view showing contract total, installment, derived balance, next due date, authorization state, auto-pay state and card expiry state as separate fields; the worklist query returning exactly the synthetic plan with its reason; the attempt record with its outcome and idempotency key; the new authorization record linked to the card update; the absence of a posted charge for the failed period; the audit entries; a second scheduler run for the same period adding no attempt. |
| Plan tasks | billing Task 1, billing Task 2, billing Task 3 |

## B-07 — Duplicate patient created twice in one day

| Field | Content |
|---|---|
| Scenario id | B-07 |
| Trigger | STAFF-FRONT-DESK-1 creates PATIENT-B by telephone at 08:05, and STAFF-MANAGER-1 creates the same person again at 14:20 from the walk-in queue, because the search used a different spelling. Both records share the household telephone. |
| Expected system behavior | Both records are created; there is no silent block and no automatic merge at creation or search. A duplicate-candidate query returns a scored candidate list with the contributing reasons and performs no write and no outbox event. Merging requires a server-issued confirmation token for that specific pair, a permitted role and a stated reason. After the merge, the enumerated record classes are re-pointed to the survivor, every moved record is listed with its prior owner, and the merged record is readable only through its merge history. A signed note touched by the merge still verifies against its original content digest. A merge attempt without the confirmation token, without the role, or across tenants is refused. |
| Evidence that proves it | The two patient records and their versions; the candidate list with reasons; the row counts per affected class before and after the merge compared with the merge result counts; the signed-note digest before and after the merge; the merge link holding both source identifiers; the merge history; the typed denial for the invalid confirmation and for the cross-tenant attempt; the audit entries; an unmerge within the permitted window restoring the prior links. |
| Plan tasks | foundation Task 5, scheduling Task 1, scheduling Task 4, scheduling Task 6, clinical Task 10 |

## B-08 — Guardian access revoked mid-episode

| Field | Content |
|---|---|
| Scenario id | B-08 |
| Trigger | GUARDIAN-B's relationship is revoked at 10:50, between an issued session and an in-flight command: a portal form submission, an appointment request and a consent capture. A second variant uses expiry at the configured age of majority instead of revocation. |
| Expected system behavior | Each in-flight command fails closed at its next authorization check with a typed denial, and each failure is audited. A command that had already committed before the revocation is retained and audited, not rewritten or deleted. The patient record, the relationship history and any captured consent remain intact. The portal grant denies the corresponding view at read time and the corresponding command at execution. Denial outcomes are identical in shape across REST and MCP. |
| Evidence that proves it | The relationship row with its revocation instant and reason, never deleted; `resolvePatientAccess` output immediately before and after revocation; the typed denials on both transports with correlation ids; the retained committed consent and its as-of reconstruction before and after revocation; the portal view denial; the audit entries showing allowed and denied outcomes; proof that no denial discloses record existence. |
| Plan tasks | foundation Task 2, foundation Task 3, scheduling Task 5, scheduling Task 17, clinical Task 13, portal Task 1 |

## B-09 — Cross-tenant access attempt on every entity class

| Field | Content |
|---|---|
| Scenario id | B-09 |
| Trigger | A PRACTICE-1 session, a PRACTICE-1 service account, and an MCP client authenticated to PRACTICE-1 each attempt to read and write a PRACTICE-2 record for every registered entity class, including patient, relationship, appointment, attendance, chart entry, periodontal exam, history, note, treatment plan, estimate, consent, rendered procedure, imaging reference, lab case, referral, journal entry, allocation, statement, payment plan, coverage, eligibility, claim, appeal, remittance, portal grant, archive reference, operator profile and backup verification. Each attempt also names a forged tenant identifier in the payload. |
| Expected system behavior | Every attempt is denied with the same safe error shape as a missing record, and no denial, status code, count or timing difference reveals existence. Tenant and actor are derived from authenticated context, and a client-supplied tenant value that does not match the authenticated scope is rejected. RLS denies the same access for the runtime role as an independent layer, including the pooled-connection reuse case. The negative matrix covers REST, MCP and worker paths with the same typed denial. |
| Evidence that proves it | A single negative matrix run listing every entity class with its operation, transport, expected denial code and observed denial code, with no row missing; the direct-runtime-role denial output; the pooled-connection reuse case proving no tenant context leaks between sequential or concurrent transactions; the audit entries for denials; a log and error fixture scan proving no PHI, token or identifier leak; the report-scope denials for ledger, receivables, payment distribution, undistributed funds and open claims. |
| Plan tasks | foundation Task 2, foundation Task 3, foundation Task 7, scheduling Task 17, clinical Task 18, billing Task 9, imaging Task 1, portal Task 2, migration Task 7 |

## B-10 — Revoked-role token replay

| Field | Content |
|---|---|
| Scenario id | B-10 |
| Trigger | A staff access token issued while STAFF-BILLING-1 held the billing role is replayed after a role downgrade that removed `claims.submit` and `receivables.read`. A worker job for the same actor was enqueued before the downgrade. A cached export download link was issued before it. A membership is revoked entirely in a second variant. |
| Expected system behavior | The command is denied using fresh authorization, not the token's embedded claims, and the denial is audited with actor, operation and outcome. The enqueued job is denied at execution and reaches an explicit denied or dead-letter state rather than delivering. The pre-issued export or read authorization is short-lived and its remaining validity is stated, and it stops working once revoked or expired. No partial write occurs: the affected record version is unchanged. The MCP path produces the same typed denial as REST. |
| Evidence that proves it | The denial records with correlation ids; the record version before and after; the job state transition to denied or dead-letter with its attempt history; the expired or revoked signing behavior of the read authorization; the audit actor and outcome entries; the parity comparison between the REST and MCP outcomes; the absence of any outbox event for the denied operations. |
| Plan tasks | foundation Task 2, foundation Task 3, foundation Task 6, foundation Task 7, foundation Task 5 |

## B-11 — Concurrent edit of the same chart

| Field | Content |
|---|---|
| Scenario id | B-11 |
| Trigger | Two clinicians correct the same chart entry, and separately the same periodontal measurement, inside one controlled-concurrency window. A third attempt corrects an entry that is already superseded. |
| Expected system behavior | Each correction writes a superseding entry and marks the prior entry `superseded`; no delete and no update of a recorded entry exists. Exactly one successor is created per base entry, and the other concurrent attempt returns a typed conflict naming the current successor. The correction against an already-superseded base is refused with a typed conflict naming the current successor. The prior measurements and entries remain readable with the correction reason. Derived periodontal values are recomputed under a recorded formula version and no stored derived value is rewritten in place. |
| Evidence that proves it | The entry chain showing one successor per base with all prior entries readable; the conflict payloads naming the current successor; a successor row count of one per base entry; the periodontal exam read showing current and prior values with the correction reason; the formula versions on derived values before and after; the audit entries; a direct update attempt on a recorded entry denied by privilege. |
| Plan tasks | foundation Task 5, clinical Task 6, clinical Task 7, clinical Task 18 |

## B-12 — A device captures an image for the wrong patient

| Field | Content |
|---|---|
| Scenario id | B-12 |
| Trigger | An acquisition through DEVICE-1 for PATIENT-A completes after the operatory patient changed to PATIENT-D. The object is then associated to PATIENT-D, and an operator later discovers the image belongs to PATIENT-A. A second variant uploads identical bytes for two different patients. |
| Expected system behavior | Registration records the object in a staging state and no patient association until a decision is made. Candidate proposal returns candidates with a stated basis and never binds automatically. Confirming an association writes a match decision with the basis, the actor and the confidence. Correcting the association appends a new decision that supersedes the earlier one and leaves the earlier decision readable; the object is never simultaneously associated with two patients as current. Identical bytes for one resolved patient deduplicate to one object with two provenance records; identical bytes for two different patients produce two objects, and a digest appearing under two patients is flagged for review and not auto-resolved. A quarantined or staged object cannot be associated. The original bytes are unchanged by any association decision. |
| Evidence that proves it | The match decision chain with both decisions and the supersession link; the object digest before and after; the patient association query showing exactly one current decision per object; the two-object versus one-object dedupe results with their provenance rows; the review item for the cross-patient digest; the refused association of a quarantined object; the audit entries naming the decision; a reconciliation that shows no retired signed content touched. |
| Plan tasks | imaging Task 1, imaging Task 2, imaging Task 3, imaging Task 6, clinical Task 15 |

## B-13 — A migration batch contains a patient with the same name and birth date as an existing patient

| Field | Content |
|---|---|
| Scenario id | B-13 |
| Trigger | A synthetic migration package contains a patient whose name and birth date match an existing PRACTICE-1 patient, with a different source identifier, and a shared household address with a third patient. The dry run is followed by a live apply, then the same run is applied again. |
| Expected system behavior | Manifest validation compares declared counts and digests against the observed artifacts and rejects a mismatch naming the entity. Intake stages every entity as mapped or explicitly unmapped, records per-row issues, and refuses an unauthorized or cross-practice package before staging. The dry run leaves table state unchanged. Identity resolution proposes groups with a stated basis and performs no automatic merge; two source rows with the same name and different identifiers are proposed for review, not merged. Both source identifiers and the full provenance are retained. The apply is idempotent, and the second apply reports a replay with no duplicates. An unresolved ambiguity leaves both records staged and visible in the exception list with a required action, and cutover readiness stays blocked until every exception carries an action and a sign-off. |
| Evidence that proves it | The manifest comparison report naming each entity, claimed and observed; the pre-apply and post-dry-run table-state comparison showing no durable change; the staged entity rows with mapped or unmapped state; the proposed identity groups with their basis and the absence of any merge; the reconciliation report with declared, staged, applied and excluded counts per entity; the exception list with required actions; the readiness check refusing to mark the run ready; the audit entries for the import commands; the second-apply replay result with identical target counts. |
| Plan tasks | migration Task 1, migration Task 2, migration Task 3, migration Task 4, migration Task 6 |

## B-14 — A restoration drill from backup

| Field | Content |
|---|---|
| Scenario id | B-14 |
| Trigger | STAFF-IT-1 restores a synthetic backup into an isolated environment after the day contains a signed note, an approved payment, a completed image deletion, an unmergeable merge link and a revoked membership. A second drill uses a deliberately incomplete backup. A third attempts a restore over an environment with post-cutover writes. |
| Expected system behavior | The complete backup restores and verifies tenant counts, record versions, audit and outbox invariants, and denied cross-tenant access. Signed note digests verify after restore. The completed image deletion does not reappear as available, and the object record is marked deleted with its audit retained. The deliberately incomplete backup is detected by entity class and by count and fails the drill. A restore over an environment containing post-cutover writes is refused without an explicit reconciliation step. The drill reports measured elapsed time and any gap against the agreed targets rather than rounding to pass. Operator readiness remains blocked while the named operator, the backup verification freshness or the security-incident escalation path is missing. |
| Evidence that proves it | The backup verification record with method, entity classes checked and gaps; the timed drill log with measured restore duration; the per-entity and per-version verification output; the signed-note digest verification after restore; the deleted-object state after restore; the refusal of the post-cutover restore; the incomplete-backup detection result naming the missing class; the readiness assertion listing unmet operator obligations. |
| Plan tasks | foundation Task 8, clinical Task 18, imaging Task 8, migration Task 8, migration Task 9 |

## B-15 — An offline device during clinic hours

| Field | Content |
|---|---|
| Scenario id | B-15 |
| Trigger | DEVICE-1 stops reporting heartbeats at 10:15 while an acquisition is requested for PATIENT-A. A second acquisition is requested after the deferred queue reaches its configured bound. The device returns at 11:05 and the acquisition is released. |
| Expected system behavior | With no reachable device, the acquisition becomes a visible deferred item with a reason, not a silent failure and not an indefinite spinner state. A device with a stale heartbeat does not appear available. A request beyond the configured queue bound is refused with a typed error rather than growing without limit. On return, the deferred item is released to exactly one job, and that job produces exactly one object. A bridge restart after reconnection does not duplicate previously completed jobs. An acquisition for a patient whose association is unresolved cannot be completed and stays visible. An operator cancellation is recorded with actor and reason. |
| Evidence that proves it | The deferred worklist row with its reason and age; the heartbeat-derived availability query showing the device unavailable and then available; the typed refusal of the over-bound request; the job count and object count after release, each exactly one; the attempt count in the job record; the canceled-item record with actor and reason; the audit entries; proof that no acquisition produced an object with an unverified digest. |
| Plan tasks | imaging Task 2, imaging Task 6, imaging Task 7 |

## B-16 — The same remittance is re-ingested

| Field | Content |
|---|---|
| Scenario id | B-16 |
| Trigger | The synthetic remittance file from A-17 is delivered again with the same control identity. Then a corrected file arrives with the same control identity and one adjusted line. Then a file arrives whose currency differs from the claim, and one whose parse fails halfway. |
| Expected system behavior | Re-ingesting the same control identity is rejected as a duplicate and posts nothing; totals are unchanged. The corrected file is treated as an explicit supersede event that reverses the earlier postings with linkage rather than editing them, and no line is posted twice. The currency mismatch is rejected. A partial parse stages in an incomplete state and posts nothing, preserving the staged artifact and the diagnostic. A remittance referencing another tenant's claim is refused. |
| Evidence that proves it | The staged artifact digests and control identities; the posting totals before and after each ingestion; the duplicate rejection error; the supersede linkage from the correction to the original; the reversal entries that net to zero; the currency rejection error; the incomplete staged artifact with its diagnostic and zero postings; the cross-tenant refusal; the audit entries. |
| Plan tasks | billing Task 1, billing Task 2, billing Task 7, foundation Task 5 |

## B-17 — An idempotency key is replayed with an altered payload

| Field | Content |
|---|---|
| Scenario id | B-17 |
| Trigger | A command is submitted with an idempotency key K and payload P. It is replayed with the same key K and an altered payload P'. It is replayed by a PRACTICE-2 session using K. The original call is replayed after a simulated crash that occurred after commit but before the response. |
| Expected system behavior | The altered-payload replay returns a typed conflict and never returns the previous unrelated result. The cross-tenant replay is denied and cannot read or reuse the original result. The crash-after-commit replay returns the recorded result with the replay indicator set and writes no second mutation, no second audit success and no second outbox event. Retention of the key and its result is bounded and documented. |
| Evidence that proves it | The command results for each attempt; the mutation counts per target aggregate; the audit success count; the outbox event count; the stored payload digest per key; the typed conflict and denial codes; the replay indicator on the recovered call; the retention boundary recorded in the contract. |
| Plan tasks | foundation Task 4, foundation Task 5, scheduling Task 10, billing Task 1 |

## B-18 — The same forbidden operation through every transport

| Field | Content |
|---|---|
| Scenario id | B-18 |
| Trigger | One operation that the policy must refuse, namely a service account calling `claims.submit` without the scope, is attempted through four paths: the staff application transport, the REST API, the MCP adapter, and a durable worker job. A second variant makes a portal principal attempt a staff route, and a third makes a staff session attempt to act as a portal principal. |
| Expected system behavior | All four paths produce the same typed denial code and the same policy outcome, and each denial is audited with the transport named. No path bypasses tenant policy, clinical signing rules, financial constraints or audit. The MCP adapter exposes no arbitrary SQL, shell, file reader or HTTP proxy capability. A portal principal cannot call a staff route and a staff session cannot act as a portal principal. |
| Evidence that proves it | The parity matrix run with one row per operation and per transport, no row missing, each with its expected and observed outcome; the audit entries naming the transport; the MCP tool inventory showing no privileged capability; the cross-transport denials for the portal and staff directions; the proof that no path created an outbox event for a denied operation. |
| Plan tasks | foundation Task 3, foundation Task 6, foundation Task 7, scheduling Task 17, clinical Task 18, billing Task 9, portal Task 1, portal Task 2 |

---

# Part C — The oracle

A test that compares a feature to itself proves only that the feature is self-consistent. This part states, per domain, what the correct answer is computed from, so an assertion has an independent source of truth.

## The five anti-tautology rules

1. **Recompute, do not re-read.** The expected value in an assertion is computed from the underlying committed facts by a path that does not reuse the feature's own projection, cache, stored total or aggregate table. A ledger balance is recomputed from posted journal lines and allocations, never read from a balance column.
2. **Two independent sources agree, or the difference is stated.** Where two sources exist, for example the journal and the payment provider's settlement report, the test asserts either agreement or an explicit discrepancy state. It never asserts that the two numbers are equal because one was copied from the other.
3. **Fixture constants are derived by hand, not by the code under test.** Each expected amount, count, date and status is written into the fixture as a hand-derived constant, with the derivation visible in the fixture, before the implementation exists. A test whose expected value was produced by running the implementation is not a test.
4. **Assert the write, not only the response.** Counts of mutations, audit successes, outbox events and version increments are asserted independently of the response body, so a client-visible success cannot mask a missing or duplicated write.
5. **No assertion on a derived display status.** Derived current states are asserted by recomputing them from their own history, never by comparing two reader paths to each other. A single stored status field may never be the authority for a fact whose history exists.

## Domain oracle table

| Id | Domain | The correct answer is computed from | Must never be derived from |
|---|---|---|---|
| C-01 | Patient ledger balance | The sum of posted balanced journal entries for the patient in the stated currency, with allocations and reversals applied exactly once | A cached or mutable balance column, an aggregate table, a report row or a previous statement's balance |
| C-02 | Guarantor accounts receivable | Open balances for the guarantor, computed as charges minus payments minus adjustments minus write-offs, currency by currency, from posted journal lines | The patient-level balance, a billing status field, a claim status or the presence of a payment plan |
| C-03 | AR aging buckets | Open balances grouped by age measured from each open item's stated service date to the as-of date, with the bucket boundaries and the as-of instant declared | A stored aging field, a last-run report, or the current date obtained from ambient system time |
| C-04 | Undistributed and unapplied funds | Posted patient and insurer money minus the sum of its allocations, per patient and currency | A stored remainder, a balance field, or the difference between two report totals |
| C-05 | Production totals | Completed procedures whose completion fact exists and whose rendering provider and service date fall in the stated date range, valued at the fee schedule version recorded on each charge | An appointment status, a billed or checked-out state, a claim total, or a plan item marked completed without a rendered procedure |
| C-06 | Collections totals | Posted patient and insurer payment entries plus posted adjustments that reduce patient responsibility, within the stated date basis | Charges, production totals, deposits, or provider settlement figures without a stated reconciliation |
| C-07 | Contractual adjustments, discounts and write-offs | Posted adjustment and write-off entries with their configured reason codes and their reversals | A fee difference computed at report time from two fee schedules, or an unposted intended adjustment |
| C-08 | Fee resolved for a posted charge | The fee schedule version and effective date recorded on the charge, resolved for the procedure reference and service date at posting time | The fee schedule currently in force, a current fee list, or a total divided by a line count |
| C-09 | Claim lifecycle state and open-claims worklist | Independent recorded facts for preparation, submission, acknowledgement, adjudication, appeal and reassignment, filtered by billing entity, rendering provider, plan, service date, reviewer and review group | One claim status column, an appeal treated as a status value, or the worklist count returned by the same query the worklist renders |
| C-10 | Remittance posting totals | Balanced insurer payment and adjustment entries derived from the staged remittance artifact, net of reversals, with the control identity recorded once | A remittance file total, a claim's expected allowed amount, or a provider settlement figure without linkage |
| C-11 | Statement balance and freshness | The snapshot balance and cutoff digest captured at generation, and the current derived balance recomputed from the journal for the freshness comparison | The statement's own stored balance for the current value, or a balance column updated after generation |
| C-12 | Payment plan balance, overdue and run rate | Scheduled installments from the plan's own schedule, posted installments from the journal, and attempt records with their outcomes, evaluated at a stated as-of instant | A stored plan balance, the contract total minus a count of attempts, or a plan status value |
| C-13 | Eligibility freshness for a service date | The eligibility record's capture instant, its stated staleness window and the service date | The current date, a cached "active" flag, or the absence of a newer response |
| C-14 | Scheduling counts and no-show rate | Bookings in the stated window and attendance transition histories, with automated and manual confirmations counted separately and cancellations, no-shows and left-without-treatment counted as distinct outcomes | A single appointment status field, the day list render, or a total that nets no-shows against arrivals |
| C-15 | Recall due list | The last qualifying completed event per patient, the policy version and interval in force, the exclusion rule, and the as-of instant | A stored due flag, an outreach message history, or the presence of a future appointment read without the exclusion rule |
| C-16 | Chart and periodontal derived values | Raw recorded measurements, the versioned formula definition that was applied, and the correction chain, excluding `not_measured` sites from arithmetic | A stored derived value recomputed in place, a prior exam's derived value, or the aggregate of unmeasured sites treated as zero |
| C-17 | Signed record integrity | The content digest computed over the stored signed bytes and compared with the digest recorded at signing, together with the recorded signer, instant and template version | A read path's own checksum, an audit row asserting a signature, or the absence of an error from the write path |
| C-18 | Audit completeness | The set of commands that committed, recovered from domain rows and outbox events, compared against the set of audit records for the same correlation ids and outcomes | The audit table alone, a log stream, or a UI activity list |
| C-19 | Tenant and role isolation verdict | The authorization decision recorded for an operation, compared with the record's actual tenant and the actor's live membership and scope at command time | The absence of an error, a client-supplied tenant value, a token claim, or a row count of zero |
| C-20 | Exactly-once effect of a command | Mutation counts per aggregate, audit success counts, outbox event counts and version increments, all counted independently of the response | The response body's success flag, a replayed flag alone, or an idempotency table's own row count |
| C-21 | Migration reconciliation totals | Declared counts from the manifest, observed artifact rows, staged rows, applied rows and excluded rows, plus a per-account opening balance comparison against the source statement | The import run's own summary, the count of patients after import, or a total that ignores excluded rows |
| C-22 | Backup and restore verification | Per-entity class counts and per-record versions measured in the restored isolated target, plus digest verification of signed content, plus the deleted-object state, compared with the source measurement taken before the backup | The backup's own manifest, the restore tool's exit code, or a checksum-only result presented as a restore |
| C-23 | Report-scope authorization | The authorization decision for the specific report scope at the command, compared across a role that holds patient read only, a role without the scope, a service account without the scope and a cross-tenant request | Whether the report returned rows, a count of denied rows, or an inference from a differently shaped result |
| C-24 | Date basis, cutoff and timezone | The declared basis recorded on each fact (service date, posting date, claim status date, statement cutoff), converted through the stated IANA zone for display, with the as-of instant stated on every derived answer | The ambient system clock, a server-local date, a display zone silently substituted for the storage zone, or a day boundary inferred from a week range heading |
| C-25 | Portal projection field set | The declared allowlist for the view and the declared redaction list, compared against the exact response key set for any grant scope, role or record state | The response itself, a sample of selected values, or the internal projection's field names unmapped to the allowlist |
| C-26 | Image association current state | The ordered match decisions per object with their supersession links, resolving to exactly one current decision per object, with the object digest verified against the recorded digest | A single patient reference column on the object, the last decision returned by a list, or the study composition's current mount |

## Recomputation procedures that must exist independently

The following are separate, deliberately simple implementations used only by tests, written from the posted facts and never from the production projections. They are the mechanism that makes rules 1 and 2 enforceable.

| Procedure | Input facts | Output |
|---|---|---|
| Ledger recomputation | All posted journal entries, their reversal links, all allocations and their reversals | Per patient and currency: charges, payments, adjustments, refunds, write-offs, transfers and net balance, with each subtotal available separately |
| Allocation recomputation | Payment entries, charge entries, allocation links | Allocated and unallocated amounts per payment entry |
| Aging recomputation | Open items derived by the ledger recomputation, stated service dates, as-of instant | Bucket totals with counts per bucket and the boundary rule applied |
| Production and collections recomputation | Rendered procedures with completion facts and service dates, posted charges with fee schedule versions, posted payments and adjustments | Production, collections, adjustments and the reconciliation between them, each on its stated date basis |
| Attendance recomputation | The ordered attendance transitions per appointment | Current derived attendance state, confirmation source split, exception counts and the no-show rate with its denominator |
| Claim and remittance recomputation | Claim versions, submission and adjudication facts, appeal links, staged remittance artifacts and posted entries | Per claim: version chain, current adjudication facts, appeal count; per remittance: posted totals net of reversals |
| Plan recomputation | The plan's installment schedule, posted installments, attempt records and authorization facts | Derived balance, overdue amount, next due date, card expiry state and the worklist membership such a plan must appear in |
| Recall recomputation | Completed qualifying events, policy version and interval, exclusion rule, as-of instant | Due patients, no-baseline patients and excluded patients with their reasons |
| Audit recomputation | Domain rows and outbox events for the run | The required audit record set keyed by correlation id and outcome, compared against stored audit |

---

# Part D — Execution requirements

## D-1 Synthetic-only fixtures

1. Every scenario runs in a synthetic tenant with synthetic patients, staff, providers, payers, devices and money. No production data, no de-identified production extract, no real payer response, no real card, no real message, no real device output.
2. Fixtures are generated by a committed generator, not hand-edited between steps. Images, DICOM containers, remittance files, migration packages and message payloads are fabricated by the generator and clearly labeled as fabricated.
3. No fixture contains a real name, address, telephone number, email address, date of birth, member identifier, card number or chart value. Placeholder people use labels such as PATIENT-A and GUARDIAN-B; placeholder payers use CARRIER-1; placeholder procedure references are synthetic and contain no licensed code-set content.
4. Fixture constants are hand-derived and committed before the implementation. A fixture whose expected value was produced by the code under test is rejected at review.

## D-2 Determinism

1. Each scenario run is seeded with a recorded seed. The seed appears in the evidence artifact. Two runs with the same seed produce identical domain state, identical audit sets and identical report values.
2. Time is injected. No scenario reads the ambient system clock. Every as-of instant, effective date, due date, cutoff and service date is an explicit fixture value. DAY-1 is fixed at 2026-11-12 in `America/New_York`.
3. Concurrency is controlled, not raced. Concurrent cases use a controlled harness that releases attempts at a defined point. No scenario relies on sleeping, polling or timing luck as its assertion.
4. Ordering is explicit. Pagination, list results and report rows are asserted on a declared sort order, never on incidental database order.
5. No test depends on network access. Every external adapter is a synthetic implementation returning deterministic configured outcomes, including timeout, unknown, decline and partial-parse outcomes.
6. Where randomness is part of the behavior, as in retry jitter, the assertion is on bounded invariants and the recorded attempt count, not on an exact instant.

## D-3 Observable completion condition and evidence artifact per scenario

Every scenario names one observable completion condition and the evidence artifact it produces. An evidence artifact is a committed, reviewable output of the run, not a console claim: a stored payload, a query result, a digest, a report file, a matrix file or a pre-and-post state comparison. A scenario with no written artifact is not executed.

| Id | Observable completion condition | Evidence artifact |
|---|---|---|
| A-01 | The day list and every huddle item return the DAY-1 facts with a stated as-of instant and policy version, and no huddle read mutates anything | Huddle query output per item, the read audit set, a pre-and-post state comparison |
| A-02 | One patient and one open resource-free request exist, the duplicate candidate list names the shared telephone, and no appointment and no merge exist | Patient and request rows with versions, candidate list payload, appointment count of zero, audit and outbox set |
| A-03 | One booked appointment with its notification decision exists and availability search produced no persisted side effect | Appointment row, search response with constraints, pre-and-post state comparison, audit and outbox set |
| A-04 | Guardian authority resolves to its scope at command time and the clinical read is denied while the portal request reaches the shared aggregate | Resolved access output, shared request row with portal origin, denial payload, audit set |
| A-05 | Every overlap attempt returns a conflict and no write, the hold is visible to search, and only the authorized override succeeds | Attempt outcome log, conflict payloads, hold row, override record with code and reason, audit denials and one override success |
| A-06 | Three appointments each carry an ordered attendance history with distinct curbside and in-person arrivals, and derived status shows three separate fields | Attendance history per appointment, derived status output, audit set |
| A-07 | Lateness and arrival both appear in history, the automated confirmation remains distinguishable, and the reschedule links rather than overwrites | Attendance history, confirmation source query, rescheduled appointment pair with link, audit set |
| A-08 | The no-show is an attendance outcome with a reason code, the appointment is readable with a null operatory and typed reason, and no charge exists | Attendance transition, appointment row with null operatory and reason, charge count of zero, no-show count query |
| A-09 | Encounter, chart, perio, history and two rendered procedures are recorded as separate authored facts, and closing the encounter completes nothing extra | Encounter rows, chart entries with tooth identity and provenance, perio exam with `not_measured`, history version, rendered procedure set with item state change, audit set |
| A-10 | Three distinguishable audited note versions exist, the signed version verifies and every overwrite path including a direct write is refused | Version chain with digests, digest verification output, command refusal, privilege denial, audit set |
| A-11 | The estimate presents a labeled stale coverage status, acceptance binds one exact version, and the revised estimate leaves the accepted version and consent intact | Estimate versions, presented record, acceptance record, consent record, coverage status output, audit set |
| A-12 | Two balanced charges, one payment and one allocation set reconcile exactly, and attendance recorded checkout only | Journal entries, allocation rows, recomputed ledger balance, attendance transition, audit set |
| A-13 | The plan is authorized only with an authorization fact, one attempt exists per due period after two scheduler runs, and the worklist membership is derived | Plan view with separated fields, authorization record, attempt rows with keys, scheduler run comparison, audit set |
| A-14 | Coverage resolves for the service date, freshness derives from the window, and a timeout records `unknown` rather than ineligible | Coverage resolution output, eligibility records with source and window, freshness derivation, timeout outcome, unmapped raw evidence, audit set |
| A-15 | One claim version is submitted once with a partner reference, acknowledgement is a separate fact, and a stale version conflicts | Claim version chain, validation result, partner reference, acknowledgement record, idempotent resubmission result, conflict payload, audit set |
| A-16 | The denial carries its vocabulary identity and version, the claim stays actionable in the worklist, and the appeal is a separate linked object | Denial record, worklist query output, appeal object with link, second-appeal conflict, replacement claim link, audit set |
| A-17 | Posting is all-or-nothing and balanced, the unmatched line becomes a reconciliation item, and re-ingestion changes no total | Staged artifact with digest and control identity, posted entries, reconciliation item, posting totals before and after re-ingestion |
| A-18 | Undistributed funds are derived per patient and currency, the cross-patient move requires the explicit command, and the residual is exact | Unapplied funds query, allocation rows, move record with reason, recomputed residual, audit set |
| A-19 | Generation is one audited command with a snapshot digest, later payments derive the earlier statement stale, and reissue names the superseded record | Statement rows, snapshot digest, freshness derivation, reissue link, delivery events, cross-tenant denial, audit set |
| A-20 | The due list is reproducible at a stated policy version and as-of instant, computing sends nothing, and booking the recall updates the next computation consistently | Due list rows with policy version and as-of instant, determinism comparison of two computations, task record, booking, no-impact count of appointments before computation |
| B-01 | Exactly one booking commits per contended slot under repeated concurrent runs, and every loser has a conflict payload and a denial | Concurrency run log, appointment and occupancy counts, conflict payloads, audit set |
| B-02 | The blocked window is absent from availability and both booking attempts conflict without writing | Time block row, search response with constraint, conflict payloads, pre-and-post state comparison |
| B-03 | No delete path exists or succeeds, the appointment remains readable, and the claim reference still resolves | Refusal and privilege denial, appointment row, claim reference resolution, audit set |
| B-04 | The amended note verifies, the claim digest is unchanged, and a replacement claim is created by linkage only | Note version digests, claim version digest, correcting outbox event, replacement link, audit set |
| B-05 | The reversal nets exactly, the statement row is unchanged, and the statement derives stale | Journal pair, derived balance, statement snapshot digest, freshness output, reissue record, audit set |
| B-06 | The expired card produces a worklist row and one attempt with an explicit outcome, with no posted charge for the period | Plan view, worklist query, attempt row, new authorization record, charge count of zero, audit set |
| B-07 | Merge moves the enumerated records, the signed digest is unchanged, and an invalid or cross-tenant merge is refused | Merge result versus history counts, digest verification, merge link, denial payloads, audit set, unmerge restoration |
| B-08 | Every in-flight command fails closed after revocation while committed facts remain, on both transports | Access resolution before and after, denial payloads, as-of consent reconstruction, portal denial, audit set |
| B-09 | The negative matrix has no missing entity class or transport, and no denial reveals existence | Negative matrix file, runtime-role denial output, pooled-connection case, PHI scan of logs and errors |
| B-10 | The replayed token, the enqueued job and the pre-issued read authorization are all denied with no partial write | Denial set, unchanged record version, job state with attempts, authorization expiry behavior, parity output |
| B-11 | One successor per base entry, one conflict naming the current successor, and prior values readable | Entry chain, conflict payloads, successor count, perio exam read, formula versions, privilege denial |
| B-12 | Exactly one current association decision per object, both decisions readable, and dedupe scoped to a resolved patient | Decision chain, digest verification, association count, dedupe results with provenance, review item, audit set |
| B-13 | The dry run changes nothing, the apply is idempotent, the same-name pair is proposed and not merged, and cutover stays blocked | Manifest comparison, pre-and-post dry-run state, staged rows, identity groups, reconciliation report, exception list, readiness refusal |
| B-14 | The complete backup restores and verifies, the incomplete one fails, and the post-cutover restore is refused | Backup verification record, timed drill log, per-entity and digest verification, deleted-object state, readiness assertion |
| B-15 | The offline acquisition is a visible deferred item with a reason, and release produces exactly one job and one object | Deferred worklist row, heartbeat availability output, over-bound refusal, job and object counts, audit set |
| B-16 | Duplicate ingestion posts nothing, the correction supersedes with linkage, and totals are unchanged by the duplicate | Staged digests, posting totals per ingestion, duplicate rejection, supersede linkage, reversal entries, partial-parse artifact |
| B-17 | The altered-payload and cross-tenant replays conflict or deny, and the crash replay writes no second effect | Command results, mutation and audit and outbox counts, payload digests, replay indicator, retention boundary |
| B-18 | All four transports return the same typed denial for the same operation, and the MCP surface exposes no privileged capability | Parity matrix file, per-transport denials with audit, MCP tool inventory, portal and staff cross-direction denials |
| B-19 | Moving an appointment to the bounded unscheduled list and back preserves booking history, writes two audit entries, and an over-capacity move returns a typed refusal that names the limit | `E-AUDIT`, `E-ROWS`, `E-DENIAL`, `E-STATE` (the refused move leaves no appointment row) |
| B-20 | Two availability searches with identical inputs — duration only, 60-day window — return identical ordered openings, and neither writes a hold, appointment or outbox event | `E-STATE`, `E-AUDIT` (read only), ordered result comparison |
| B-21 | Claim queue counts and claim rows are read at one as-of instant; a count that includes work outside the caller's page is explained, never presented as if the rows were missing | `E-REPORT`, `E-ROWS`, both as-of timestamps |
| B-22 | A caller without a restricted queue's scope receives zero for that queue and a typed refusal on its filter, never a count that includes work they cannot see | `E-DENIAL`, `E-WORKLIST`, `E-AUDIT` |
| B-23 | Changing the patient on an appointment that has completed procedures is refused, the refusal names the procedure review as the remediation path, and no procedure, claim or journal row changes patient | `E-DENIAL`, `E-STATE`, `E-ROWS`, `E-AUDIT` |

## D-4 Evidence artifact kinds

| Tag | Artifact |
|---|---|
| `E-AUDIT` | The audit record set for the run, keyed by correlation id, actor, operation, resource, tenant and outcome, with no PHI body |
| `E-OUTBOX` | The outbox event set for the run, with aggregate identity, version and a minimized classified payload |
| `E-JOURNAL` | Posted journal entries, reversal links and allocations |
| `E-DIGEST` | Content digests for signed, accepted, submitted or immutable records, with the verification result |
| `E-ROWS` | Domain row counts and versions for the aggregates the scenario touches, taken before and after |
| `E-CONFLICT` | The captured typed conflict payload with its conflict list |
| `E-DENIAL` | The captured typed denial with code, correlation id and proof that no existence was disclosed |
| `E-REPORT` | A report or reconciliation artifact stating its numerator, denominator, date basis, as-of instant, filters, policy or formula version and freshness |
| `E-WORKLIST` | A worklist query result with the inclusion and exclusion reasons for each row |
| `E-STATE` | A pre-and-post state comparison of the affected tables for a command that must write nothing |
| `E-MATRIX` | A cross-transport or cross-entity-class matrix run listing every required row with its expected and observed outcome |
| `E-DRILL` | A timed drill log with measured elapsed time, verified entity classes and any stated gap |
| `E-LOGSCAN` | A scan of emitted logs, errors, traces and artifacts for forbidden markers such as `SYNTHETIC_SECRET_42`, contact values and note bodies |
| `E-CONCURRENCY` | A controlled-concurrency run log with per-attempt outcomes and the commit count per contended resource |

## D-5 Scenario suite mapping

The plans already name the scenario suites these cases belong in. This pack does not invent new file paths for implementation; it assigns cases to the suites the plans propose, so a case cannot be silently unowned.

| Suite named by a plan | Plan | Part A and Part B cases it must contain |
|---|---|---|
| `tests/scenarios/ordinary-day-scheduling.test.ts` | scheduling Task 17 | A-01 through A-08, A-20, B-01, B-02, B-03 |
| `tests/scenarios/ordinary-day-clinical.test.ts` | clinical Task 18 | A-09, A-10, A-11, B-04, B-08, B-11 |
| `tests/integration/billing-journal.test.ts` and `tests/integration/billing-allocations.test.ts` | billing Tasks 1 and 2 | A-12, A-18, B-05, B-17 |
| `tests/integration/billing-payment-plans.test.ts` | billing Task 3 | A-13, B-06 |
| `tests/integration/billing-statements.test.ts` | billing Task 4 | A-19, B-05 |
| `tests/integration/rcm-eligibility.test.ts` | billing Task 5 | A-11, A-14 |
| `tests/integration/rcm-claims.test.ts` | billing Task 6 | A-15, A-16, B-04 |
| `tests/integration/rcm-remittance.test.ts` | billing Task 7 | A-17, B-16 |
| `tests/integration/imaging-matching.test.ts` and `tests/integration/imaging-offline.test.ts` | imaging Tasks 3 and 7 | B-12, B-15 |
| `tests/integration/portal-grants.test.ts` | portal Task 1 | A-04, B-08 |
| `tests/integration/comms-reminders.test.ts` | portal Task 6 | A-20 |
| `tests/integration/migration-identity.test.ts` and `tests/integration/migration-reconciliation.test.ts` | migration Tasks 4 and 6 | B-13 |
| `tests/integration/ops-restore.test.ts` and `tests/integration/ops-operator.test.ts` | migration Tasks 8 and 9, foundation Task 8 | B-14 |
| `tests/integration/tenant-isolation.test.ts`, `transport-policy.test.ts`, `idempotency.test.ts`, `mcp-parity.test.ts` | foundation Tasks 2, 3, 5 and 7 | B-09, B-10, B-17, B-18 |
| `tests/integration/clinical/immutability.test.ts` | clinical Task 18 | A-10, B-04, B-11 |
| `tests/integration/clinical/parity.test.ts` and `scheduling-negative-matrix.test.ts` | clinical Task 18, scheduling Task 17 | B-09, B-18 |

## D-6 Gate dependencies that block sign-off

A scenario marked blocked below may be executed against synthetic adapters to prove our own machinery, but it must not be reported as satisfied for the release until the named gate closes with written evidence. The plans state this restriction themselves; this table only collects it in one place.

| Scenario group | Gate | What remains unproven until it closes |
|---|---|---|
| A-14, and the eligibility portion of A-11 | `billing D3` eligibility source qualification | That real payer responses exist for the pilot's payers, what fields they carry, and what retention the agreement permits |
| A-15, A-16, A-17, B-16 | `billing D2` claims and clearinghouse partner qualification | That a real submission, acknowledgement, rejection, appeal and remittance are possible at all, in the formats and timelines the partner actually uses |
| A-12, A-13, B-05, B-06 | `billing D1` payment processor qualification | That tokenization, capture, void, refund, retry and duplicate-charge protection behave as required |
| A-15, A-11 and every fee or code reference | `billing D4` fee schedule and terminology rights | That any procedure code set may be distributed, and under what license |
| A-11, A-10 | `clinical D4` and `clinical D5` | What an enforced template actually blocks, and who may amend another clinician's note |
| A-09, A-11 | `clinical D1`, `clinical D2`, `clinical D3` | Tooth identity and display, terminology rights, and which periodontal derived values a clinician approves |
| B-12, B-15 | `imaging D1`, `imaging D2`, `imaging D3` | The hardware matrix, the DICOM boundary and where acquisition actually runs |
| A-04, A-20, B-08, and every reminder or recall send | `portal D1`, `portal D3` | A verified messaging channel and the assurance level required for portal access |
| B-13 | `migration D1`, `migration D2` | That an authorized export exists at all, and what archive arrangement covers history that does not export |
| B-14 | `migration D3` | The agreed RPO and RTO and the named operator the drill is measured against |

## D-7 What must be true before the first release claim

This list is the definition of done this pack defines. Every line requires evidence, not assertion.

1. All twenty Part A steps execute in one continuous run against one fixture pack, in order, with the per-step completion condition met and its evidence artifact committed.
2. All eighteen Part B scenarios execute and produce their evidence artifacts. Any scenario still blocked by an open spike is named as blocked in the release record, and the release is labeled a limited trial rather than replacement-ready.
3. Every Part C domain has an independent recomputation procedure, and every assertion in Parts A and B that names a financial, production, aging, plan, recall, attendance, audit or verification value uses it rather than a production projection.
4. The negative matrix has no missing entity class and no missing transport, and every denial is indistinguishable from a missing record.
5. The immutability proof attempts to alter a signed note, a chart entry, a periodontal measurement, an accepted plan version, a captured consent, a submitted claim and a posted journal entry through every available path, including a direct table write under the application role, and every attempt fails.
6. The restore drill restores a verified backup into an isolated environment, detects a deliberately incomplete backup, verifies signed digests after restore, does not resurrect a completed deletion, and reports measured time against the agreed targets.
7. No evidence artifact, log, error, trace or committed fixture contains a real patient, staff or provider name, contact value, chart value, licensed code-set content, token or secret.
8. Every scenario in this pack is recorded as planned or tested, never as validated, approved, deployed, compliant or clinically validated on the strength of a synthetic run. Passing this pack is an engineering event, not a clinical or compliance determination.

## D-8 Maintenance of this pack

- A new P1 capability adds a Part A step or a Part B scenario and its oracle row before its plan task is marked complete. A capability that appears in no scenario has no definition of done.
- A new entity class adds a row to the B-09 negative matrix and, where it carries a derived value, a row to the Part C oracle table.
- A schema or contract change that alters a date basis, a cutoff, a status separation or a money rule updates the affected Part C rows in the same change. An oracle that silently drifts from the contract converts every dependent test into a tautology.
- A scenario whose evidence artifact cannot be produced is a blocked scenario, not a passing one. Deferred audit coverage, deferred negative cases and deferred oracle recomputation are release blockers, not follow-up tasks.

---

# Traceability summary

Each P1 capability row from [the capability matrix](CAPABILITIES.md) maps to at least one Part A step and, where the failure mode is financial, clinical, security or operational, at least one Part B scenario. A capability with a Part A step but no Part B scenario is untested against its own failure modes; a capability with neither is not in scope for this pack and must be named as such in the release record.

| Capability row | Part A steps | Part B scenarios | Oracle rows |
|---|---|---|---|
| Practice setup | A-01 | B-09 | C-19, C-24 |
| Patient identity | A-02 | B-07, B-13 | C-19, C-20 |
| Family and consent | A-04, A-11 | B-08 | C-19 |
| Scheduling | A-03, A-05, A-07 | B-01, B-02 | C-14, C-24 |
| Intake and portal | A-02, A-04 | B-08, B-18 | C-25 |
| Daily workflow | A-01, A-06, A-07, A-08, A-12 | B-03 | C-14 |
| Clinical chart | A-09 | B-11 | C-16 |
| Periodontal | A-09 | B-11 | C-16 |
| Clinical documentation | A-10 | B-04 | C-17 |
| Treatment planning | A-11 | B-04 | C-08 |
| Procedures and encounters | A-09, A-12 | B-04 | C-05 |
| Imaging and documents | A-09 (reference only) | B-12, B-15 | C-26 |
| Insurance | A-14 | B-16 | C-13 |
| Claims and RCM | A-15, A-16, A-17 | B-04, B-16 | C-09, C-10 |
| Financial ledger | A-12, A-18 | B-05, B-17 | C-01, C-02, C-04, C-07 |
| Patient billing | A-13, A-19 | B-05, B-06 | C-03, C-11, C-12 |
| Communications | A-20 | B-08 | C-14, C-15 |
| Recall and follow-up | A-20 | B-08 | C-15 |
| Lab and referrals | Not covered by this pack | Not covered | Not covered |
| Analytics | A-01, A-12, A-19, A-20 | B-09 | C-03, C-05, C-06, C-14, C-23, C-24 |
| Administration | A-01 | B-09, B-10, B-14 | C-18, C-22 |
| Integrations | A-03, A-15 | B-10, B-17, B-18 | C-19, C-20 |

## Gaps this pack deliberately leaves open

- Lab cases and referrals have plan tasks (`clinical Tasks 16-17`) but no scenario in this pack. That is an intentional omission only if the first release is labeled accordingly; otherwise a Part B scenario is required before the release claim.
- Prescribing and controlled-substance workflow is an integration gate in the capability matrix, not a first-release feature in this pack.
- Specialty breadth and international behavior are explicit non-goals for this pack.
- No scenario asserts a vendor's actual behavior. Every external interaction is a synthetic adapter. Nothing in this document establishes what any incumbent, payer, clearinghouse, processor or device does.
