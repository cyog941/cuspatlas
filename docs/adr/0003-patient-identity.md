# ADR 0003: Patient identity, matching, relationships and merge (S-S1)

Status: **recommended-pending-approval**, 2026-11-04. Every decision row below uses the option the [patients and scheduling plan](../superpowers/plans/2026-11-04-scheduling-and-patients.md) recommends for S-D2, S-D3, S-D4 and S-D8. No reception, practice-management or jurisdiction reviewer was available, so **reviewer sign-off is pending for every row** and nothing here is decided. The synthetic implementation in S4, S5 and S6 follows these recommendations behind per-tenant configuration where the plan says configurable, so a reviewer can change a value without a code change. Evidence category: proposed (decisions) and, once S4-S6 land, configured and tested on synthetic data only. Not evidence of clinical or legal validity.

Owner of the spike: S workstream. Reviewers required before release: a reception reviewer, a practice-management reviewer and, for guardian/proxy terms, a jurisdiction (legal) reviewer. Sign-off note: not attached (no reviewer available); [reviewer register](../assurance/reviewers.md) is empty.

## Walkthrough

The plan asks for a read-only walk of a permitted environment with reviewers. It was not performed: no reviewer and no permitted environment were available, and broad incumbent research is closed by user direction. No production record content was viewed or recorded. The questions below were therefore answered with the plan's recommendations and are marked pending.

## Question list and synthetic duplicate pairs

The two synthetic pairs are test fixtures (tests/integration/patient-identity.test.ts and tests/integration/patient-merge.test.ts). All names, dates and contact values are synthetic.

| Pair | Records | What it exercises | Expected behaviour under this ADR |
|---|---|---|---|
| P1 shared household phone | "Synthetic Household One" and "Synthetic Household Two", different given names and birth dates, the same synthetic phone number and address | contact data shared by a household | two separate patients after creation and after search; no merge is proposed; not a duplicate candidate because shared phone/address never qualify alone |
| P2 same name, different birth date | two "Synthetic Patient Twin" records, identical legal name, birth dates 2003-02-03 and 1973-02-03 (both day precision) | parent/child or namesakes | listed as a candidate only if its score reaches the configured threshold; by default the birth-date conflict keeps it below the threshold, and the reasons (`same_legal_name`, `birth_date_conflict`) are shown when it is listed |

| # | Question | Recommended answer (pending approval) | Plan decision |
|---|---|---|---|
| Q1 | Does a patient belong to the tenant or to a location? | Tenant-wide identity. A location-restricted member can read and search tenant patients; it may set `homeLocationRef` only to one of its own locations. Location-level access applies to scheduling, clinical and financial workflows that consume `patientRef`, not to identity. | S-D8 |
| Q2 | Which fields are matched? | Legal name (normalized family + given), birth date (exact at day precision, compatible at coarser precision, conflicting when both are day precision and differ), typed identifiers (type + issuer + value), phone, email, address. Matching uses SHA-256 match keys of normalized values, never plaintext copies. | S-D3 |
| Q3 | How are candidates presented? | Scored list for staff review with every contributing reason; never an automatic merge or an automatic write. A candidate requires at least one identity reason (name, birth date or identifier); shared phone, email, address or household membership never produce a candidate on their own. Default threshold 40 (`candidate_min_score`, per tenant). Weights: identifier 50, legal name 40, birth date exact 30, birth date compatible 10, phone 15, email 15, address 10, birth-date conflict −30. | S-D3 |
| Q4 | Merge field precedence? | The survivor's demographics win; nothing is copied automatically from the merged record. The merged record keeps its own identifiers and fields untouched and remains reachable through merge history. Staff update the survivor explicitly afterwards. | S-S1 |
| Q5 | Required confirmation? | A server-issued confirmation token for the exact pair, bound to tenant, actor, both patient versions and a 15-minute expiry, plus a stated reason code. Any change to either patient invalidates the token. | S-S1 |
| Q6 | Roles permitted to merge? | Human principals holding `patients.merge`. Service principals (agents) cannot merge or unmerge. | S-S1 |
| Q7 | Is merge reversible, by whom, for how long? | Reversible by a `patients.merge` holder while the merge is within the unmerge window (default 30 days, `unmerge_window_days`, per tenant) **and** no new clinical or financial fact references the survivor after the merge. Otherwise reversal needs the elevated `patients.mergeReconcile` scope plus a reconciliation review reference. Both paths are audited. Unmerge appends a reversal link; the merge link is never deleted. | S-D2 |
| Q8 | Unmerge window? | 30 days by default, per-tenant configuration; outside it the refusal names the reason (`unmerge_requires_reconciliation_review`). | S-D2 |
| Q9 | Retention of merged records? | The merged patient row, the merge link, the enumerated moves and the reversal links are retained (append-only); no deletion path exists. Retention duration is a later records-retention decision. | S-S1 |
| Q10 | Default guardian authority? | Until the subject reaches the configured age of majority (default 18, `age_of_majority_years`, per tenant), evaluated with the server clock from the subject's birth date. Coarse birth dates fail closed (the earliest possible majority date). A guardian for a subject with an unknown birth date requires an explicit end instant. | S-D4 |
| Q11 | Default proxy authority? | Time-boxed: an end instant is required, at most `proxy_max_days` (default 365, per tenant) after the start. Renewal is an explicit new grant; no command extends an existing window. | S-D4 |
| Q12 | Which scopes may each kind carry? | guardian and proxy: any non-empty subset of `demographics`, `scheduling`, `clinical_read`, `financial`, `consent`; guarantor: `financial` only, and at most one active guarantor per patient; dependent: none (informational link). Staff roles never inherit relationship scopes and relationships grant no staff capability (for example no note signing). | S-D4 |
| Q13 | Who is a relationship counterparty in this slice? | A patient-identity record of the same tenant. A register of non-patient persons and the portal principal that maps a login to a counterparty belong to E1 and are not built; `resolvePatientAccess` takes the counterparty as data, which is the seam E1 will call with a portal-derived counterparty. | S-S1 (seam) |

## Unresolved items

| Item | Status | Owner |
|---|---|---|
| Every row above | recommended-pending-approval | reception and practice-management reviewers; jurisdiction reviewer for Q10-Q12 |
| Jurisdiction-specific age of majority, emancipation and court-order evidence | blocked: needs jurisdiction review | jurisdiction reviewer |
| Which future record classes count as "clinical or financial facts" for Q7 | open: each owning plan (C, B) registers its classes in the merge registry | C and B owners |
| Non-patient person register for guardians/guarantors | deferred to E1/B | E1 owner |
| Retention duration for merged records | open | records-retention owner |

## Consequences

S4, S5 and S6 implement exactly these recommendations ([execution ledger](../execution/scheduling-progress.md)). Changing a value is a configuration change on `cuspatlas.patient_policy_settings`; changing a rule is a code change that must update this ADR in the same commit. When reviewers sign, each row moves to decided with the reviewer named, or to a replacement decision with the affected tests updated.
