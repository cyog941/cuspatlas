# Clinical Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Add a versioned clinical record in which chart findings, periodontal measurements, medical history, treatment plans, estimates, consents, notes and rendered procedures are separate, authored facts; signed content cannot be overwritten, and every later change is an amendment or a superseding version with an identified author.

**Architecture:** One `clinical` domain module, composed of submodules that each own their writes: encounter and authorship, chart, periodontics, history, note templates, notes, treatment planning, estimates, consent, rendered procedures, encounter image links, lab cases and referrals. All clinical mutations pass the foundation policy layer, are idempotent, and write audit and outbox records in the same transaction. Nothing in this module stores image bytes, transmits lab orders or exchanges referrals with another practice; it holds references and records.

**Tech Stack:** The foundation stack only: supported Node LTS, TypeScript, Fastify, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest with SQL integration tests. No imaging, DICOM, e-signature, lab or referral SDK is added by this plan.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [capability matrix](../../CAPABILITIES.md), [API and MCP contract](../../API-AND-MCP.md), [domain-model observations](../../REFERENCE-DOMAIN-OBSERVATIONS.md), [security and readiness](../../SECURITY-AND-READINESS.md).

**Depends on:** [platform foundation](2026-11-03-platform-foundation.md) Tasks 1-8; [patients and scheduling](2026-11-04-scheduling-and-patients.md) Tasks 4, 5, 10, 11 and 12 for identity, guardian authority, the encounter's appointment and the visit context container.

**Task numbering:** this plan's prefix is `C`. Implementation tasks are `C1`–`C18`, discovery spikes are `C-S1`–`C-S4`, and open decisions are `C-D1`–`C-D10`. A cross-workstream reference names the fully qualified task: `F` is [platform foundation](2026-11-03-platform-foundation.md), `S` is [patients and scheduling](2026-11-04-scheduling-and-patients.md), `B` billing, `I` imaging, `E` portal, `M` migration. Spikes have owners, sit in the dependency graph and can block a task. `Blocks` is derived from `Dependencies` and is never maintained as a second list.

## Practice-time acceptance requirements

Consume [PT-01–06 and UX-01–03](../../PRACTICE-TIME-AND-AUTOMATION.md) in the owning tasks: reuse authoritative data, expose current state/next owner, distinguish unavailable from empty, and automate eligible routine steps under explicit policy. Clinical and imaging tasks provide correctly linked evidence for CL-04; scheduling/engagement tasks coordinate cancellation recovery, recall and treatment follow-up with consent and race-safe booking. Preserve human clinical judgment and signatures. Add exception, retry, revocation and provenance cases before implementing these extensions; UI design stays deferred.

## Global Constraints

- This is a reviewed proposal. Nothing here is implemented, tested, clinically validated or authorized.
- US general dentistry first. Tooth-numbering and terminology support must not hardcode a single jurisdiction where the internationalization requirement applies.
- Synthetic patients and synthetic clinical findings only, in fixtures, examples, logs and issue text. No real chart values, note text, images or identifiers.
- No clinical rule, terminology licence, device contract, lab contract or referral exchange is asserted. Unverified behaviour is marked blocked-on-discovery with an owner and a probe.
- Signed clinical content is immutable. Later change is an amendment or a superseding version with author, instant and reason; there is no update command for signed content and no direct table write path to it.
- Clinical authorship, attendance (S11) and billing are separate. Completing an encounter does not complete plan items, and no clinical command posts money.
- Tenant and actor are derived from authenticated context; no record shape in this plan carries a tenant field.
- Negative testing is stated once for the whole plan: the shared harness `tests/integration/negative-harness.test.ts` attempts every command cross-tenant, with a revoked membership, with a downgraded role and through MCP, and each task cites the harness instead of restating the case list.
- Money appears only as a reference or as the shared `Money` contract from [SHARED-CONTRACTS](../../SHARED-CONTRACTS.md#money) — `{ currency, minor }` — never as a scalar minor amount with a separate currency, and no amount is invented in this plan.
- No UI layout, odontogram rendering, chart interaction or form design is included.

## Evidence gate before executing this plan

Consult [reference PMS analysis coverage](../../WORKFLOW-RESEARCH-COVERAGE.md). The clinical chart, perio, notes, treatment and imaging rows are recorded there as proposed requirements, not observations: no synthetic patient chart was walked, no note was drafted or signed, and no treatment plan or consent lifecycles were inspected. The domain-model observations establish only that the incumbent audits treatment at three levels and enumerates note-template attributes including a per-template enforcement flag; they do not establish field-level cardinality, transition guards or enforcement semantics.

Consequently the first four tasks are discovery spikes, and Tasks 6, 7, 9 and 10 cannot be claimed complete on engineering evidence alone. Clinical reviewers must validate chart semantics, perio calculation and correction expectations, enforcement semantics and amendment rules. Terminology rights review precedes any distribution of a licensed code set. No clinical record is created in production to test behaviour.

## Open decisions (human required)

- **C-D1 Tooth identity and display.** Question: the canonical tooth identity and which numbering system is displayed. Recommended option: a canonical internal tooth identity independent of numbering, Universal as the US default display, FDI supported per user and per export preference, with conversion lossless for supported anatomy and refused, not guessed, elsewhere. Blocks C6.
- **C-D2 Clinical vocabulary and terminology rights.** Question: which condition, surface and procedure vocabularies are used, and whether a licensed terminology set is distributed. Recommended option: a provisional internal vocabulary for engineering, with mapping points to a licensed set added only after rights review; no licensed dataset in the repository or fixtures. Blocks C6, C9 and C11.
- **C-D3 Periodontal derived values.** Question: which derived measurements are computed and by whom they are approved. Recommended option: store raw measurements only; compute derived values from versioned formula definitions that a clinician approves; never rewrite previously computed values. Blocks C7.
- **C-D4 Template enforcement semantics.** Question: what an enforced template actually prevents, and at which command. Recommended option: enforcement blocks signing, not drafting, until the named required sections and associated procedure codes are addressed; the deficit list is returned in the refusal. Blocks C9 and C10.
- **C-D5 Amendment authority.** Question: whether both addenda and amendments exist and who may author them. Recommended option: both exist; an amendment to another clinician's signed note requires an explicit clinical-oversight scope, and an addendum is preferred for clarifying text. Both are additive and audited. Blocks C10.
- **C-D6 Consent evidence per method.** Question: which capture methods are accepted and what evidence each requires. Recommended option: a structured attestation with an optional artifact reference; paper and portal captures record a reference and digest, not a signature image in the domain store; witness requirements are configured per method. Blocks C13.
- **C-D7 Estimates with unknown coverage.** Question: whether a patient-responsibility figure may be presented when coverage is unknown, and who owns eligibility data. Recommended option: present ranges or a labelled unknown, never a guaranteed patient responsibility; eligibility provenance comes from B5, not from this module. Blocks C12.
- **C-D8 Imaging store boundary.** Question: which component owns image bytes in the first release. Recommended option: imaging owns bytes, storage and patient association per I1 and I3; this module stores only an encounter link by `imageRef`. Blocks C15.
- **C-D9 Lab status vocabulary and ordering channel.** Question: the lab case states and whether any electronic ordering is in the first release. Recommended option: a configurable proposed state set with print/export as the only channel until a lab partner is verified. Blocks C16.
- **C-D10 Referral sharing.** Question: whether electronic referral exchange is in the first release and on what legal basis. Recommended option: record-keeping plus print/export only, with an explicit share record for any cross-practice disclosure, until C-S4 verifies a channel. Blocks C17.

## Implementation review focus

- A signed note altered by any path: C10 must fail, and the digest check after restore in C18 must fail too.
- Two clinicians signing one draft concurrently: C10 must produce one signature and one typed conflict, with no merged content.
- A merge (S6) over patients with signed notes: no note content or authorship changes, only the audited patient reference.
- Perio correction that rewrites a prior measurement: C7 must retain the original and add a superseding version.
- Changing a fee or a coverage assumption after acceptance: C12 must create a new estimate version and leave the accepted version attached to its own consent, without ever re-binding the earlier acceptance.

## Proposed file structure (create only during authorized execution)

`packages/domain/src/clinical/` holds one submodule per aggregate: `encounters.ts`, `authorship.ts`, `chart.ts`, `tooth-identity.ts`, `perio.ts`, `history.ts`, `note-templates.ts`, `notes.ts`, `treatment-plans.ts`, `estimates.ts`, `consents.ts`, `procedures.ts`, `imaging-links.ts`, `lab-cases.ts`, `referrals.ts`. `packages/contracts/src/clinical/` holds JSON Schema and generated types. `apps/api/src/routes/clinical/` holds thin transports. `supabase/migrations/` holds schema, append-only privileges, constraints and RLS. `tests/integration/clinical/` proves invariants; `tests/scenarios/` holds the synthetic clinical day. No imaging, rendering or UI package is added.

## Shared interfaces

Proposed definitions to create during authorized execution, extending the foundation and scheduling contracts:

- `Money` is not redefined here. It comes from [the shared contract](../../SHARED-CONTRACTS.md#money) as `Money = { currency: string; minor: integer }`; an estimate carries `amount?: Money` or no amount at all, never a scalar pair and never a string.
- Identifiers are opaque `<entity>Ref` strings throughout, and tenant is derived from context rather than stored on a shape.
- `ClinicalAuthor = { actorRef: string; role: 'dentist' | 'hygienist' | 'assistant' | 'other_clinical'; credentialRef?: string }` recorded on every clinical mutation; the credential detail stays in the staff module.
- `EncounterRef = { encounterRef: string; patientRef: string; appointmentRef?: string }`.
- `ToothRef = { canonicalRef: string; displaySystem: 'universal' | 'fdi'; dentition: 'primary' | 'permanent' | 'mixed' }` where `canonicalRef` is the authority and the display system is a projection.
- `ChartEntry = { entryRef: string; patientRef: string; toothRef?: ToothRef; surfaceSet?: readonly string[]; findingRef: string; kind: 'condition' | 'existing_restoration' | 'missing' | 'supernumerary' | 'implant' | 'prosthodontic'; state: 'active' | 'resolved' | 'superseded'; recordedBy: ClinicalAuthor; recordedAt: string; supersedesEntryRef?: string; provenance: 'recorded' | 'imported' | 'patient_reported' }`.
- `HistoryVersion = { patientRef: string; version: number; recordedAt: string; recordedBy: ClinicalAuthor; provenance: 'staff' | 'patient_reported' | 'imported'; changeSet: readonly HistoryChange[] }` where removal is a state change, never a delete.
- `NoteVersion = { noteRef: string; version: number; state: 'draft' | 'signed' | 'amended'; authorRef: ClinicalAuthor; signedAt?: string; contentDigest: string; templateVersionRef?: string; supersedesVersion?: number; amendmentReason?: string }`.
- `PlanVersion`, `PlanDetail` and `PlanItem` are three distinct addressable levels; an item always belongs to a detail, and a detail always belongs to one plan version.
- `EstimateRecord = { estimateRef: string; planVersionRef: string; assumptions: readonly EstimateAssumption[]; amount?: Money; coverageStatus: 'entered' | 'unknown' | 'stale'; presentedAt?: string; notAGuarantee: true }`. This plan owns the estimate aggregate; `B5` consumes it by `estimateRef` and defines no competing estimate or acceptance command.
- `ConsentRecord = { consentRef: string; subjectRef: string; scope: string; planVersionRef?: string; method: 'in_person' | 'portal' | 'paper' | 'verbal_attested'; templateDigest: string; evidenceRef?: string; signerRef: string; witnessRef?: string; effectiveAt: string; revokedAt?: string }`.
- `EncounterImageLink = { linkRef: string; encounterRef: string; imageRef: string; linkedBy: ClinicalAuthor; linkedAt: string; state: 'active' | 'unlinked' }`. Imaging owns the image object, its storage, digest, patient association and match decision; this plan stores only the encounter link and references `imageRef`. `matchStatus` and `correctReferenceAssociation` do not exist here. The mapping is: `I3`'s current `MatchDecision` selects the `imageRef`; `C15` records which encounter that `imageRef` was used in and nothing about the patient match.
- Commands in this plan that can legitimately refuse return `Denial = { outcome: 'denied'; reasonCode: string; actorRef: string; detailRef?: string }` rather than throwing; a thrown error is reserved for faults.

### C-S1 (discovery spike): Chart, dentition and periodontal semantics

Dependencies: none technical. Blocks C6, C7 and C11; C-D1–C-D3.

Files (proposed): `docs/adr/0005-chart-semantics.md`, a clinician sign-off sheet mapping each field to a synthetic paper chart.

Consumes: the clinical-chart and periodontal capability rows. Produces: a decision record naming the canonical tooth identity, supported display systems and the anatomy where conversion is refused; the surface vocabulary and its per-tooth-type scope; missing, supernumerary and implant representation; mixed-dentition handling; the perio site definition, grade vocabularies and which derived measures are computed; and the expected correction behaviour compared with a paper chart.

- [ ] Prepare a synthetic paper chart and a synthetic perio chart covering a full adult arch, a primary dentition, a mixed dentition, a missing tooth, a supernumerary tooth and an implant.
- [ ] Walk each field with clinician reviewers; record only decisions and the reasons, never any real record content.
- [ ] Record terminology status separately: which vocabularies are internal, which would require a licence, and the owner of that rights review.
- [ ] Commit the record with per-item decided, recommended-pending-approval or blocked status, and link it from C6 and C7.

**Observable completion condition:** a committed record states the canonical tooth identity, the conversion refusal cases, the surface scope, the perio formulas and the correction expectation, with clinician sign-off and every open item named.

### C-S2 (discovery spike): Note template enforcement and signing policy

Dependencies: none technical. Blocks C9–C10; C-D4–C-D5.

Files (proposed): `docs/adr/0006-note-signing.md`.

Consumes: the observed template attributes and the clinical-documentation capability row. Produces: a decision record stating what an enforced template prevents and at which command; the required-section list per template type; how a procedure-code association is satisfied; whether addenda and amendments both exist; who may amend another clinician's note; attestation wording ownership; and whether co-signature is required for any note class.

- [ ] Draft the enforcement question as concrete yes/no outcomes for a synthetic draft that lacks one required section and for one that addresses a code in text only.
- [ ] Obtain clinical reviewer decisions and record the rationale, including the rejected alternatives.
- [ ] Record the amendment and addendum rules as commands with an actor requirement, not as prose guidance.
- [ ] Commit; mark any undecided item as blocking for C9 or C10.

**Observable completion condition:** the record answers every enforcement and amendment question with a decision or an explicit block, and C9 and C10 cite it.

### C-S3 (discovery spike): Imaging reference boundary and device qualification

Dependencies: none technical. Blocks C15 and I1–I3. Status: blocked-on-discovery for the store and bridge contract.

Files (proposed): `docs/integrations/imaging-qualification.md`.

Consumes: the imaging/documents capability row and the design's device-integration boundary. Produces: a per-item qualification note stating who owns bytes, whether a content digest is obtainable, what matching evidence is available, how derived images and annotations are identified, what DICOM support means for the first release, how retention and legal hold apply, and which test environment is available.

- [ ] Enumerate the minimum reference contract C15 needs, independently of any vendor's interface.
- [ ] Record each item as verified, unavailable or unknown with an owner; do not sign, purchase or configure anything.
- [ ] Record the fallback: reference-only registration with a manual matching step and an explicit unverified state.
- [ ] Commit with the unknown rows preserved.

**Observable completion condition:** every item carries a status and an owner, and C15 can be executed against an external store without assuming a vendor interface.

### C-S4 (discovery spike): Referral and lab exchange qualification

Dependencies: none technical. Blocks C16–C17. Status: blocked-on-discovery for any electronic channel.

Files (proposed): `docs/integrations/lab-referral-qualification.md`.

Consumes: the lab/referrals capability row. Produces: a per-channel note covering outbound referral package contents, transmission and return-record handling, lab order transmission, attachment formats, cross-practice sharing consent and legal basis, and whether any partner interface exists, each with an owner.

- [ ] Enumerate the minimum record contract for a lab case and a referral, independent of channel.
- [ ] Record which channels are verified, unavailable or unknown, and which first-release workflow they block.
- [ ] Record the fallback: print and export with an explicit share record.
- [ ] Commit with the unknowns preserved.

**Observable completion condition:** each channel is recorded as verified, unavailable or unknown with an owner and a fallback command path.

### C5: Encounter and clinical authorship

Dependencies: F2, F4–F5; S4, S10 and S11. Blocks C6, C7, C8, C9, C10, C11, C14, C15 and C18.

Files (proposed): `packages/domain/src/clinical/encounters.ts`, `packages/domain/src/clinical/authorship.ts`, `packages/contracts/src/clinical/encounter.schema.json`, `apps/api/src/routes/clinical/encounters.ts`, migration via `supabase migration new clinical_encounter`, `tests/integration/clinical/encounters.test.ts`.

Consumes: `authorize`, `executeOnce`, `recordCommand`, the appointment and attendance records. Produces: `openEncounter`, `closeEncounter`, `readEncounter`, `getAuthorContext`; `EncounterRef`, `ClinicalAuthor`.

Contract (proposed):

- An encounter links a patient, an optional appointment, a location, the treating and secondary provider roles, the staff role and the completing role as distinct assignments. It never infers a treating provider from a procedure.
- `openEncounter` for an appointment with an existing open encounter returns that encounter rather than creating a second one.
- `closeEncounter` requires a disposition from configuration and records the closing author and instant; a closed encounter refuses new clinical entries except amendments routed through their own commands.
- Every clinical mutation in this plan records `ClinicalAuthor`; a mutation without a resolvable clinical role is refused.

Acceptance cases:

1. Opening an encounter twice for one appointment yields one encounter and one audit success.
2. An encounter records treating, secondary, staff and completing assignments independently; changing one leaves the others.
3. Closing without a configured disposition is refused; with one, the encounter is closed and the closure is audited.
4. A new chart entry against a closed encounter is refused; an amendment command against a closed encounter names the correct alternative path.
5. An encounter naming another tenant's patient or appointment is refused without disclosing the foreign record.
6. An encounter opened for a cancelled appointment is permitted but flagged with the appointment state.

Failure and recovery cases:

1. A failed close rolls back the disposition, audit and outbox together.
2. Two concurrent opens for one appointment produce one encounter and one returning the same reference.
3. An encounter whose appointment is later rescheduled keeps its original appointment reference and records the change, rather than silently re-pointing.
4. A merge of the patient relinks the encounter with an audit record and leaves clinical content untouched.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement the encounter aggregate, role assignments, disposition vocabulary and authorship resolver.
- [ ] Run `pnpm test:integration -- clinical/encounters`; expect all cases to pass under the restricted role.
- [ ] Commit with the encounter contract published and the authorship rule recorded.

**Observable completion condition:** one synthetic visit has exactly one encounter that names each clinical role separately, and duplicate opens, cross-tenant opens and closes without a disposition are all refused with typed errors.

### C6: Structured chart and odontogram record

Dependencies: C-S1 and C5; S4; C-D1 and C-D2. Blocks C7, C11 and C14.

Files (proposed): `packages/domain/src/clinical/tooth-identity.ts`, `packages/domain/src/clinical/chart.ts`, `packages/contracts/src/clinical/chart.schema.json`, `apps/api/src/routes/clinical/chart.ts`, migration via `supabase migration new clinical_chart`, `tests/integration/clinical/chart.test.ts`.

Consumes: `executeOnce`, `recordCommand`, the encounter author. Produces: `recordChartEntry`, `correctChartEntry`, `readChart`, `convertToothRef`; `ToothRef`, `ChartEntry`.

Contract (proposed):

- `readChart(ctx, { patientRef, dentition?, asOf? })` returns active entries plus superseded history, each with author and provenance.
- `recordChartEntry` validates the tooth against the patient's dentition model, validates the surface set against the tooth type, and refuses a surface-scoped finding on a tooth type that has none.
- `correctChartEntry` writes a superseding entry and marks the prior entry `superseded`; there is no delete and no update of a recorded entry.
- `convertToothRef(from, to)` is lossless for supported anatomy and returns an explicit refusal, not a best guess, elsewhere.
- Imported historical findings carry `provenance: 'imported'` and are never attributed to a current clinician as their author.

Acceptance cases:

1. A surface-specific finding is recorded and read back with its surfaces; correcting it creates a second entry and the first remains retrievable as superseded.
2. A permanent tooth and a primary tooth in the same anatomical position resolve to distinct canonical identities and coexist in a mixed dentition.
3. Universal-to-FDI conversion round-trips for supported anatomy and returns an explicit refusal for an unsupported case.
4. A finding naming another patient's chart, or another tenant's patient, is refused.
5. An imported finding shows `imported` provenance and does not appear as newly diagnosed work in a query that filters by provenance.
6. A surface-scoped finding attempted on a tooth type recorded as having no such surfaces is refused with the reason.

Failure and recovery cases:

1. A duplicate entry with the same tooth, finding and surfaces is idempotent; a deliberately duplicated correction of the same base entry conflicts and keeps one successor.
2. A correction whose base entry was itself superseded is refused with a typed conflict naming the current successor.
3. A chart read for a patient with no chart returns an explicit empty state, not an error.
4. A tooth-identity vocabulary change is a versioned migration with a recorded mapping; it never rewrites entries silently.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests, including the conversion refusal cases from C-S1.
- [ ] Implement canonical tooth identity, chart entries, corrections and the chart read projection.
- [ ] Run `pnpm test:integration -- clinical/chart`; expect all cases to pass.
- [ ] Commit with the conversion matrix and the provenance query output recorded.

**Observable completion condition:** a synthetic mixed-dentition chart with surfaces, a missing tooth, a supernumerary tooth and one correction reads back through both numbering systems with every prior entry retained.

### C7: Periodontal charting and comparison

Dependencies: C-S1, C5 and C6; C-D3. Blocks C18.

Files (proposed): `packages/domain/src/clinical/perio.ts`, `packages/contracts/src/clinical/perio.schema.json`, `apps/api/src/routes/clinical/perio.ts`, migration via `supabase migration new clinical_perio`, `tests/integration/clinical/perio.test.ts`.

Consumes: the chart, the encounter author. Produces: `recordPerioExam`, `correctPerioExam`, `comparePerioExams`, `readPerioExam`; raw site measurements and derived values with a formula version.

Contract (proposed):

- An exam records per-tooth, per-site raw measurements plus bleeding, recession, mobility and furcation grades where configured. A site not measured is stored as `not_measured`; it is never stored as zero.
- Derived values are computed from a versioned formula definition, stored with that version, and labelled derived. Recomputing under a new formula version never rewrites a stored derived value.
- `correctPerioExam` supersedes the affected measurements with a reason; the prior exam and its values remain.
- `comparePerioExams` returns deltas per site with the formula versions involved and excludes `not_measured` sites from arithmetic while listing them.

Acceptance cases:

1. An exam with six sites per tooth over a full arch reads back with every measurement; a deliberately unmeasured site reports `not_measured` and is excluded from derived arithmetic.
2. A correction supersedes one measurement and the exam read shows both the current and the prior value with the correction reason.
3. Two exams a period apart compare with per-site deltas, listing unmeasured sites rather than treating them as improvement.
4. An invalid mobility or furcation grade outside the configured vocabulary is refused.
5. A perio exam naming another tenant's patient, or referencing a tooth absent from the chart, is refused unless the chart entry is created explicitly in the same workflow.
6. Recomputing derived values under a new formula version creates new derived values and leaves the prior ones readable with their old version.

Failure and recovery cases:

1. A partially written exam is refused as a whole, or stored as an explicit draft, but never as a complete exam with missing sites.
2. Two concurrent corrections of one measurement produce one successor and one conflict.
3. A merged patient's exams remain distinct, with their source patient recorded, and are not silently concatenated into one timeline.
4. A formula definition withdrawn after use does not invalidate past derived values; it is flagged as historical.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement exams, site storage, corrections, the formula registry and comparison.
- [ ] Run `pnpm test:integration -- clinical/perio`; expect all cases to pass.
- [ ] Commit with a two-exam comparison output that names the formula version.

**Observable completion condition:** two synthetic exams compare with per-site deltas, unmeasured sites reported as unmeasured, one correction visible in history, and no derived value rewritten in place.

### C8: Medical history, allergies and medications changes

Dependencies: C5; S4; F4. Blocks C10 and S12.

Files (proposed): `packages/domain/src/clinical/history.ts`, `packages/contracts/src/clinical/history.schema.json`, `apps/api/src/routes/clinical/history.ts`, migration via `supabase migration new clinical_history`, `tests/integration/clinical/history.test.ts`.

Consumes: `executeOnce`, `recordCommand`, the encounter author. Produces: `recordHistoryChange`, `verifyHistoryItem`, `readHistory`, `getHistoryVersion`, `getActiveAlerts`.

Contract (proposed):

- History kinds are `condition`, `allergy`, `medication`, `vital` and `social`. Each change is an event with a state (`active`, `resolved`, `discontinued`, `entered_in_error`), provenance (`staff`, `patient_reported`, `imported`), effective dates and the recording author.
- Removing a fact is a state change with a reason; nothing is deleted.
- `readHistory(ctx, { asOf })` returns the version effective at that instant with its provenance.
- `getActiveAlerts` returns allergies and conditions relevant to care with an explicit `unknown` state when nothing verified is recorded; absence is never reported as "no allergies".
- Clinician verification is a separate command that names the verifying author and never overwrites the patient-reported value.

Acceptance cases:

1. An allergy added and later marked `entered_in_error` reads correctly at both instants, and the earlier version remains retrievable.
2. A patient-reported allergy and a clinician-verified allergy are distinguishable, and verification records who verified and when.
3. A snapshot read as-of a past instant returns that version, and a change recorded afterwards does not alter it.
4. A patient with no recorded allergy data returns `unknown` from `getActiveAlerts`, not an empty "no allergies" answer.
5. A history change naming another tenant's patient is refused; a read across tenants is denied.
6. A medication discontinued without an end date stores an explicit `discontinued` state, not a null date that reads as ongoing.

Failure and recovery cases:

1. A duplicate change submission is idempotent; two concurrent conflicting changes both persist in order, each with its own version.
2. An imported history batch carries `imported` provenance and cannot be attributed to a current clinician's verification.
3. A change attempted against a closed encounter is refused, and the alternative path is named.
4. A verified item later corrected requires a new verification version; the prior verification is not edited.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement history events, verification, as-of reads and the alert projection.
- [ ] Run `pnpm test:integration -- clinical/history`; expect all cases to pass.
- [ ] Commit with an as-of read demonstrating two versions and an unknown-alert output.

**Observable completion condition:** a synthetic history reads correctly at two as-of instants with provenance preserved, an unknown alert state for unrecorded data, and no removed fact.

### C9: Progress-note templates with per-template enforcement and code association

Dependencies: C-S2 and C5; C-D2 and C-D4. Blocks C10.

Files (proposed): `packages/domain/src/clinical/note-templates.ts`, `packages/contracts/src/clinical/note-template.schema.json`, `apps/api/src/routes/clinical/note-templates.ts`, migration via `supabase migration new clinical_note_templates`, `tests/integration/clinical/note-templates.test.ts`.

Consumes: the encounter, the procedure-code reference vocabulary. Produces: `defineNoteTemplate`, `retireNoteTemplate`, `listApplicableTemplates`, `validateAgainstTemplates`; versioned templates with `type`, `label`, `procedureCodeRefs`, `enforced`, `requiredSections`.

Contract (proposed):

- A template is versioned. Once a signed note references a version, that version is retained and immutable; editing creates a new version.
- `procedureCodeRefs` are references to the practice's configured procedure codes. Where those codes derive from a licensed set, the reference is a mapping identifier, not a redistributed code table.
- `enforced: true` means `validateAgainstTemplates` returns a non-empty deficit list until the named required sections and associated codes are addressed. Enforcement is evaluated at one documented point, and the same point for REST and MCP.
- `listApplicableTemplates(ctx, { encounterRef })` returns templates whose code associations match the encounter's proposed or rendered procedures, plus unassociated templates as a separate group; nothing is applied silently.

Acceptance cases:

1. An enforced template with an unaddressed required section produces a deficit list and blocks the documented command.
2. A non-enforced template permits the same draft while recording a warning that the note does not satisfy the template.
3. A template associated with a code present on the encounter is offered; an unassociated template is offered only in the general group.
4. Editing a template used by a signed note creates a new version, and the signed note still resolves the old version.
5. A cross-tenant template read is denied; a template referencing another tenant's code set is refused.
6. A retired template is absent from new drafts and still resolvable for existing references.

Failure and recovery cases:

1. A template retired while drafts reference it leaves those drafts valid against the retained version.
2. A draft whose required section cannot be resolved fails with an explicit unresolved list rather than an empty deficit.
3. Duplicate template creation with the same type and label is refused or versioned, never two ambiguous active templates.
4. A code association removed from configuration does not silently detach from historical template versions.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement templates, versions, code associations, applicability and validation.
- [ ] Run `pnpm test:integration -- clinical/note-templates`; expect all cases to pass.
- [ ] Commit with the enforcement point recorded and the deficit payload captured as an example.

**Observable completion condition:** one enforced and one non-enforced synthetic template produce different outcomes on the same draft, and each signed note records the template version it was validated against.

### C10: Note drafting, signing and amendment

Dependencies: C-S2, C5, C8 and C9; F2, F4–F5; C-D4 and C-D5. Blocks C18.

Files (proposed): `packages/domain/src/clinical/notes.ts`, `packages/contracts/src/clinical/note.schema.json`, `apps/api/src/routes/clinical/notes.ts`, migration via `supabase migration new clinical_notes`, `tests/integration/clinical/notes.test.ts`.

Consumes: `executeOnce`, `recordCommand`, `authorize`, the template validator, the history snapshot. Produces: `createNoteDraft`, `updateNoteDraft`, `signNote`, `createAmendment`, `createAddendum`, `readNoteVersions`.

Contract (proposed):

- Three commands, three outcomes: `createNoteDraft` and `updateNoteDraft` operate only on `draft`; `signNote` freezes the content digest, the signer, the signing instant, the template version and the history version referenced; `createAmendment` and `createAddendum` append a new version referencing the signed version and stating a reason.
- No command updates signed content. Table privileges deny update and delete on signed-note content to the application role, so a bug in a handler cannot overwrite history.
- Signing re-runs template enforcement at the documented point and refuses with the deficit list.
- An AI-assisted draft records model and prompt version identifiers, is labelled as a draft, and cannot be signed unless a named clinician is the signer; the model is never the author of a signed note.
- `readNoteVersions` returns every version with its digest, and verifies the signed digest on read.

Acceptance cases:

1. A draft is editable repeatedly; after signing, an update attempt is refused by the command layer, and a direct write attempt is refused by privilege.
2. An amendment creates the next version with author, instant and reason; the signed version is retrievable byte-identical and its digest verifies.
3. Signing a draft that fails an enforced template is refused with the deficit list and writes no signature.
4. Two concurrent signature attempts produce exactly one signed version and one typed conflict with guidance.
5. An AI-assisted draft carries its model and prompt identifiers; signing records the human signer, and an unattributed draft cannot be signed.
6. A clinician without the signing scope is refused even with patient read access; a cross-tenant note read, sign and amend are all denied.
7. An amendment to another clinician's note without the oversight scope is refused under C-D5.

Failure and recovery cases:

1. A crash after the signature write and before the response returns the recorded signature on retry; no second signature is written.
2. A signature that references a template version retired later still succeeds against the retained version.
3. An amendment racing another amendment yields one next version and one conflict; the version chain remains linear.
4. A note whose referenced history version is later superseded keeps its reference and states the version it recorded against.

Steps:

- [ ] Write cases 1-7 and the failure cases as failing tests, including the direct-write privilege test.
- [ ] Implement drafting, freezing, signing, amendment, addenda, digest verification and the append-only privileges.
- [ ] Run `pnpm test:integration -- clinical/notes`; expect all cases to pass, including the privilege denial.
- [ ] Commit with a three-version chain and its digest verification recorded.

**Observable completion condition:** a synthetic note yields three distinguishable audited versions, the signed version verifies by digest after an amendment, and every overwrite path is refused both by command and by database privilege.

### C11: Treatment plan, detail and item

Dependencies: C5 and C6; C-D2. Blocks C12, C14 and C16.

Files (proposed): `packages/domain/src/clinical/treatment-plans.ts`, `packages/contracts/src/clinical/treatment-plan.schema.json`, `apps/api/src/routes/clinical/treatment-plans.ts`, migration via `supabase migration new clinical_treatment_plans`, `tests/integration/clinical/treatment-plans.test.ts`.

Consumes: the chart, the encounter author. Produces: `createTreatmentPlan`, `addPlanDetail`, `addPlanItem`, `setPlanItemState`, `supersedePlanVersion`, `readPlan`; `PlanVersion`, `PlanDetail`, `PlanItem`.

Contract (proposed):

- Three addressable levels. A plan version contains details; a detail contains items. An item without a detail is refused.
- A detail is scoped to a tooth, a surface set, an area or the whole mouth. An item references a procedure code reference, a tooth or area where applicable, a sequence and a fee-schedule reference; it carries no invented amount.
- Item states are `proposed`, `accepted`, `scheduled`, `completed`, `declined`, `discontinued`, with an explicit allowed-transition set. Declining a detail records the consequence for its items explicitly rather than cascading silently.
- An accepted plan version is immutable; a change creates a new version that names the version it supersedes.
- A plan version with no fee reference is valid and reported as incomplete for estimate purposes; it is never given a placeholder price.

Acceptance cases:

1. A plan with two details and several items reads back at all three levels with stable identifiers.
2. Adding an item without a detail, or a detail without a plan version, is refused.
3. Superseding an accepted plan creates a new version; the accepted version remains retrievable and unchanged.
4. Declining a detail records the resulting item states and the reason, and a query shows them as declined with the parent reference.
5. An item naming another tenant's chart or patient is refused; an item referencing a tooth absent from the chart requires an explicit chart entry and does not create one implicitly.
6. A plan version without a fee reference is returned as estimate-incomplete rather than with a zero or placeholder amount.

Failure and recovery cases:

1. Concurrent item edits conflict on the plan version, and one edit is retained with a typed conflict for the other.
2. Deleting a detail with items is refused; the supported path is discontinuation with a reason.
3. Acceptance recorded while an item is being edited conflicts and leaves the plan unaccepted.
4. A treatment plan whose patient is merged keeps its structure and records the new patient reference with an audit entry.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement the three levels, state transitions, versioning and the immutability rule for accepted versions.
- [ ] Run `pnpm test:integration -- clinical/treatment-plans`; expect all cases to pass.
- [ ] Commit with a three-level read projection and a superseded version recorded.

**Observable completion condition:** a three-level synthetic plan is independently addressable at each level, its accepted version is immutable, and no item exists without a detail or with an invented amount.

### C12: Treatment alternatives, estimates and versioned acceptance

Dependencies: C11; F4–F5; C-D7; B5 for eligibility provenance. Blocks C13 and C18. Status: estimate structure is implementable now; real coverage figures are blocked-on-discovery pending B5. This plan owns the estimate aggregate; B5 consumes it by `estimateRef` and defines no competing estimate or acceptance command.

Files (proposed): `packages/domain/src/clinical/estimates.ts`, `packages/contracts/src/clinical/estimate.schema.json`, `apps/api/src/routes/clinical/estimates.ts`, migration via `supabase migration new clinical_estimates`, `tests/integration/clinical/estimates.test.ts`.

Consumes: plan versions, the fee-schedule reference, staff-entered coverage assumptions. Produces: `createAlternative`, `generateEstimate`, `presentEstimate`, `recordAcceptance`; `EstimateRecord`, `EstimateAssumption`.

Contract (proposed):

- An alternative is a plan version linked to the same clinical problem as another version; creating an alternative never deletes or mutates the sibling.
- `generateEstimate(ctx, envelope: CommandEnvelope<EstimateInput>): Promise<CommandResult<EstimateRecord>>` records the plan version, fee-schedule version, coverage assumptions with provenance and freshness, discounts as references, and produces an immutable estimate version.
- Amounts use the shared `Money` contract; no amount is invented, and an estimate without fee references carries no patient-responsibility figure.
- Coverage and eligibility values are read from B5 by reference; this plan records the reference and freshness it was given and never computes coverage itself.
- `presentEstimate` marks the estimate as presented and refuses to present a superseded version as current.
- An estimate is explicitly not a coverage guarantee. `coverageStatus: 'unknown'` or `'stale'` must be visible on the presented record.
- `recordAcceptance` binds the accepted plan version and estimate version and records the actor and instant; accepting a superseded estimate is refused. C13 attaches a consent reference as a separate, later fact, and an acceptance without that binding is never treated as consented treatment. This task's completion does not wait on C13.

Acceptance cases:

1. Two alternatives for one problem produce two plan versions and two estimates; accepting one leaves the other retrievable and declined or unselected.
2. Changing a fee reference or a coverage assumption creates a new estimate version; the earlier version and its acceptance remain intact.
3. An estimate generated with unknown coverage presents a labelled unknown and no guaranteed patient-responsibility figure.
4. An estimate with no fee references is marked incomplete and cannot be presented as a quote.
5. Accepting a superseded estimate is refused with a typed conflict naming the current version.
6. A cross-tenant estimate or acceptance is refused; an estimate referencing another patient's plan is refused.

Failure and recovery cases:

1. A coverage assumption whose source timestamp is older than the configured tolerance is marked stale at presentation, not silently reused.
2. Acceptance racing a new estimate version conflicts and leaves the earlier acceptance recorded against its own version.
3. A partially accepted plan (phase-level) is recorded with the covered scope or refused, never recorded as full acceptance.
4. A fee-schedule version withdrawn after an estimate is generated leaves the estimate readable and labelled with the withdrawn version.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests; use synthetic assumption records, never real coverage data.
- [ ] Implement alternatives, estimate versions, assumptions, presentation state and acceptance binding.
- [ ] Run `pnpm test:integration -- clinical/estimates`; expect all cases to pass.
- [ ] Commit; record that real eligibility values remain a B5 dependency.

**Observable completion condition:** a synthetic case with two alternatives yields two independent versioned estimates, one accepted against that exact version and one retained as unselected, and the accepted estimate records that a consent binding is still outstanding rather than claiming consented treatment. The consent binding itself is C13's completion, not this task's.

### C13: Consent capture

Dependencies: S5; C12; F2 and F4; C-D6. Blocks C18.

Files (proposed): `packages/domain/src/clinical/consents.ts`, `packages/contracts/src/clinical/consent.schema.json`, `apps/api/src/routes/clinical/consents.ts`, migration via `supabase migration new clinical_consents`, `tests/integration/clinical/consents.test.ts`.

Consumes: the patient access resolver, the plan version, the consent template version and digest. Produces: `recordConsent`, `revokeConsent`, `readConsentState`; `ConsentRecord`.

Contract (proposed):

- A consent records subject, scope, the plan version it binds where applicable, the method, the template digest, the signer relationship, an optional witness, an evidence reference and the effective instant.
- Signer authority is rechecked at signing: a guardian whose grant expired or was revoked cannot consent, and a patient recorded as a minor without a valid relationship cannot consent alone.
- Revocation sets a revocation instant and reason; it never deletes the prior consent, and it does not rewrite the record of care already delivered.
- An evidence reference points to an artifact held elsewhere; this module stores no signature image.
- Consent text is versioned by digest; a text change produces a new template digest and does not alter previously captured consents.

Acceptance cases:

1. A guardian records consent for a synthetic minor while holding a valid grant; the same attempt after the grant expires is refused.
2. Consent binds a specific plan version; generating a newer plan version does not inherit the signature, and a new consent is required.
3. Revocation records an instant and reason, and an as-of read reconstructs the consent state before and after it.
4. A consent naming another tenant's patient, or signed by a proxy without an active relationship, is refused.
5. A paper capture records an evidence reference and digest only; a direct signature-image upload is refused by this module.
6. A method requiring a witness without one recorded fails closed with a typed error.

Failure and recovery cases:

1. Duplicate consent submission is idempotent; a concurrent consent and revocation conflict by version and leave one linear history.
2. A consent recorded against a plan version superseded before presentation is refused, with the current version named.
3. A template digest that no longer resolves is retained with the consent and flagged, rather than cleared.
4. A merged patient's consents remain distinct records with their original signer relationships.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement consent records, authority recheck, revocation and as-of reads.
- [ ] Run `pnpm test:integration -- clinical/consents`; expect all cases to pass.
- [ ] Commit with a guardian, an adult and a revocation case recorded.

**Observable completion condition:** three synthetic consents (guardian, adult, revoked) are distinguishable and reconstructable as-of any instant, with authority rechecked at signing rather than inherited.

### C14: Rendered procedures and the billing boundary

Dependencies: C5, C6 and C11; F4–F5. Blocks S16, B1 and C18.

Files (proposed): `packages/domain/src/clinical/procedures.ts`, `packages/contracts/src/clinical/rendered-procedure.schema.json`, `apps/api/src/routes/clinical/rendered-procedures.ts`, migration via `supabase migration new clinical_rendered_procedures`, `tests/integration/clinical/rendered-procedures.test.ts`.

Consumes: the encounter, the plan item, the chart. Produces: `recordRenderedProcedure`, `correctRenderedProcedure`, `listRenderedProcedures`, and the outbox event `procedure.rendered.v1` consumed by B1.

Contract (proposed):

- A rendered procedure records encounter, optional plan item, code reference, tooth and surfaces, rendering provider, service date and a sequence within the visit.
- Rendering from a plan item sets that item to `completed` only through this command; closing an encounter changes no plan item.
- A procedure not on any plan is recordable as unscheduled treatment with provenance.
- Correction is a reversal plus a replacement, both linked; the original remains and the replacement carries the reason. No amount is written; money belongs to B.
- The event carries identifiers and the correction relationship, never clinical narrative or amounts.

Acceptance cases:

1. Completing an encounter leaves every plan item unchanged; rendering one procedure changes only that item.
2. Recording an unscheduled procedure succeeds with provenance and no plan item.
3. Correction produces a reversal and a replacement pair; a list query shows the net set plus the history.
4. An encounter, plan item or provider from another tenant is refused; a rendering provider not assigned to the encounter is refused unless an explicit override with reason is recorded.
5. Submitting the same procedure twice without an explicit duplicate indicator is refused with a conflict, not silently recorded twice.
6. The emitted event contains identifiers and no narrative, no amounts and no patient demographic values.

Failure and recovery cases:

1. A failed render rolls back the procedure, the item state change, audit and outbox together.
2. A procedure corrected after B1 has consumed the event emits a correcting event rather than mutating the earlier one.
3. A plan item rendered twice across two visits requires distinct encounters and explicit sequences, and is not merged.
4. A chart tooth referenced by a rendered procedure that is later superseded on the chart keeps the recorded tooth reference and flags the discrepancy for review.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests, including the event payload assertion.
- [ ] Implement rendering, correction by reversal and replacement, and the versioned event.
- [ ] Run `pnpm test:integration -- clinical/rendered-procedures`; expect all cases to pass.
- [ ] Commit with the event payload and the correction pair recorded.

**Observable completion condition:** one synthetic visit renders two procedures from a three-level plan, corrects one by reversal, and the outbox holds exactly the expected event sequence with no monetary or narrative content.

### C15: Encounter image links

Dependencies: C-S3, C5 and I3; S4. Blocks M7. Status: encounter-link registration is implementable now, but it cannot be claimed before I3 produces a current `imageRef`. Byte storage, digest, patient association and match decisions are I's and remain blocked-on-discovery there.

Files (proposed): `packages/domain/src/clinical/imaging-links.ts`, `packages/contracts/src/clinical/encounter-image-link.schema.json`, `apps/api/src/routes/clinical/imaging-links.ts`, migration via `supabase migration new clinical_encounter_image_links`, `tests/integration/clinical/imaging-links.test.ts`.

Consumes: the encounter, the patient identity from S4, and `imageRef` from I3. Produces: `linkImageToEncounter`, `unlinkImageFromEncounter`, `listEncounterImages`, `readImageLink`; `EncounterImageLink`.

Contract (proposed):

- This module stores no image object, locator, digest, modality, capture instant or match status. Those are I1's and I3's records; this plan references `imageRef` only and copies no metadata into a clinical table.
- `linkImageToEncounter(ctx, envelope: CommandEnvelope<ImageLinkInput>): Promise<CommandResult<EncounterImageLink>>` requires an `imageRef` whose current I3 association names the same patient; a mismatch returns `Denial` with `reasonCode: 'image_patient_mismatch'`.
- `unlinkImageFromEncounter` records the prior link and the reason; the earlier link remains in history and is never deleted.
- An image already linked to another encounter requires an explicit relink with a reason, and the prior link is retained.
- `listEncounterImages` returns I's metadata projection by `imageRef`; it never defines a second matching or correction command.

Acceptance cases:

1. Linking an `imageRef` whose current I3 association names the same patient creates one link that reads back with its encounter and author.
2. A link to an `imageRef` whose current association names another patient is denied with `image_patient_mismatch` and writes nothing.
3. Unlinking preserves both the link history and the reason, and the image remains I's record.
4. A relink to another encounter is refused unless the explicit relink command is used, and both links remain addressable.
5. A cross-tenant `imageRef` is denied indistinguishably from a missing one.
6. This module refuses any command that would register an image object, store a digest or record a `matchStatus`; those commands exist only in I.

Failure and recovery cases:

1. An `imageRef` that I cannot resolve returns an explicit unavailable state with a reason, never a fabricated link.
2. A link whose I association was superseded afterwards remains readable and is flagged for review, not silently re-pointed.
3. A merge re-points the encounter's patient reference through S6 and leaves the image link and I's association evidence intact.
4. A failed link rolls back its link row, audit and outbox together.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests, using a fake I resolver for `imageRef` and its association.
- [ ] Implement the encounter link, its history and the I metadata projection read.
- [ ] Run `pnpm test:integration -- clinical/imaging-links`; expect all cases to pass.
- [ ] Commit; record that storage, digest, patient association and matching belong to I1 and I3.

**Observable completion condition:** one synthetic encounter links and unlinks an `imageRef`, every link state is retained with its author, a mismatched patient is denied, and the clinical module stores no bytes, digest or match status of its own.

### C16: Lab cases

Dependencies: S10 for the appointment reference; C-S4; C11; C-D9. Blocks S12. Status: record-keeping is implementable now; electronic ordering and any lab interface are blocked-on-discovery.

Files (proposed): `packages/domain/src/clinical/lab-cases.ts`, `packages/contracts/src/clinical/lab-case.schema.json`, `apps/api/src/routes/clinical/lab-cases.ts`, migration via `supabase migration new clinical_lab_cases`, `tests/integration/clinical/lab-cases.test.ts`.

Consumes: the appointment reference from S10, the plan detail or item, and I's `imageRef` contract for attachments. S12's visit context reads this case by reference; this task does not depend on S12, so the two are not mutually blocked. Produces: `createLabCase`, `setLabCaseState`, `attachLabDocument`, `recordLabReturn`, `listLabCases`; `LabCase`.

Contract (proposed):

- A lab case records the patient, the relating plan detail or item, the appointment it serves, the counterparty as recorded data, a case reference scoped per counterparty, a requested and expected return date, and attachment references.
- The state set is provisional and configurable pending C-D9; states are `draft`, `sent`, `in_progress`, `received`, `seated`, `remake`, `cancelled`, and each transition records actor and instant.
- `recordLabReturn` requires a received date and either an attachment reference or an explicit "no attachment" reason.
- A remake creates a new case linked to the original; it never overwrites the original's state history.
- An overdue case is a derived flag from the expected return date, not a state.
- Attachment references use the reference contract; this module stores no document bytes.

Acceptance cases:

1. A case linked to a plan detail and an appointment moves from draft to sent to received and reads back with its full history.
2. A received transition without a received date, or without an attachment reference and without a stated reason, is refused.
3. A remake creates a linked case and the original remains readable as superseded-by-remake.
4. A duplicate case reference for the same counterparty is refused; the same reference under a different counterparty is allowed.
5. A case referencing another tenant's patient, appointment or plan is refused; cross-practice sharing requires an explicit share record.
6. An overdue case appears in an overdue query without any state change.

Failure and recovery cases:

1. A failed transition rolls back its state, audit and outbox rows.
2. A case whose plan item is later superseded keeps its link and is flagged for review rather than silently re-pointed.
3. A cancelled case retains every prior state and attachment reference.
4. A lab case attached to a visit whose appointment is cancelled retains the link and is marked with the appointment state.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement cases, transitions, attachments, remake linkage and overdue derivation.
- [ ] Run `pnpm test:integration -- clinical/lab-cases`; expect all cases to pass.
- [ ] Commit; record the provisional vocabulary and its C-D9 dependency.

**Observable completion condition:** a synthetic case moves through send, return and seat with one attachment reference and a complete history, and an overdue case is visible without any state change.

### C17: Referral records

Dependencies: S4–S5; C-S4; C14; C-D10. Status: record-keeping and print/export are implementable now; electronic exchange is blocked-on-discovery.

Files (proposed): `packages/domain/src/clinical/referrals.ts`, `packages/contracts/src/clinical/referral.schema.json`, `apps/api/src/routes/clinical/referrals.ts`, migration via `supabase migration new clinical_referrals`, `tests/integration/clinical/referrals.test.ts`.

Consumes: the patient, the rendered procedures and chart entries selected for the package, the consent record. Produces: `createReferral`, `prepareReferralPackage`, `recordReferralResponse`, `closeReferral`; `Referral`.

Contract (proposed):

- A referral records direction, counterparty as recorded data, reason, requested scope, the explicitly selected record references, the share record, the consent reference where required, and a state (`prepared`, `sent`, `responded`, `closed`, `cancelled`).
- Package assembly takes an explicit selection; nothing is shared by default, and the selection is recorded so a later review can see what was disclosed.
- Any cross-practice disclosure requires an explicit share record naming purpose, scope and expiry; without it the command is refused.
- Returned records are recorded with provenance and are never attributed to the referring clinician's signature.
- Transmission failure leaves the referral in `prepared` with a recorded error; no false `sent` state.

Acceptance cases:

1. A package assembled from an explicit selection contains exactly the selected references, and the selection is retrievable afterwards.
2. A referral for a patient without the configured disclosure consent is refused.
3. A cross-practice share without a share record, or beyond its scope or expiry, is refused.
4. A returned record is stored with its source and is not presented as authored by the referring clinician.
5. A duplicate referral to the same counterparty for the same reason is flagged for confirmation rather than silently duplicated.
6. A cross-tenant referral read or update is denied.

Failure and recovery cases:

1. A failed package preparation writes no partial selection and no audit success.
2. A transmission failure records the error and preserves the prepared state; retry is explicit and idempotent.
3. A referral recalled after sending is recorded as a correction with a reason, never a deletion of the sent fact.
4. A referral whose patient is merged keeps its package selection and records the new patient reference.

Steps:

- [ ] Write cases 1-6 and the failure cases as failing tests.
- [ ] Implement referrals, package selection, share records, responses and closure.
- [ ] Run `pnpm test:integration -- clinical/referrals`; expect all cases to pass.
- [ ] Commit; record electronic exchange as a C-S4 dependency rather than an assumed capability.

**Observable completion condition:** a synthetic referral package is assembled from an explicit selection, shared under a share record, answered with a provenance-carrying response, and closed with an auditable trail.

### C18: Clinical parity, immutability proof, export and release evidence

Dependencies: C5–C17, plus the spike records from C-S1–C-S4.

Files (proposed): `tests/integration/clinical/parity.test.ts`, `tests/integration/clinical/immutability.test.ts`, `tests/integration/clinical/export-restore.test.ts`, `tests/scenarios/ordinary-day-clinical.test.ts`, `docs/api/openapi.yaml` updates.

Consumes: every clinical command. Produces: a parity matrix across REST, MCP and worker paths, an export manifest for clinical records, and restore evidence proving signed content is unchanged.

- [ ] Run the shared negative harness (`tests/integration/negative-harness.test.ts`, stated once in Global Constraints) over every clinical command through REST and MCP, asserting the same allow, deny and conflict outcomes and the same `Denial` reason codes.
- [ ] Write the immutability proof: attempt to alter a signed note, a chart entry, a perio measurement, an accepted plan version and a captured consent through every available path, including a direct table write under the application role; every attempt must fail.
- [ ] Write the export and restore check: chart, perio, history versions, plans, alternatives, estimates, consents, note versions, encounter image links, lab cases and referrals export with stable identifiers and digests, and survive a restore with signed content verifying. Image objects and their digests export from I, not from this plan.
- [ ] Run the ordinary clinical day scenario: encounter, history, chart, perio, plan with alternatives and estimate, consent, note draft and signature, amendment, rendered procedures, lab case, encounter image link and referral.
- [ ] Run the full suite and record every operation present in the matrix with its policy outcome; commit.

**Observable completion condition:** one test run reports a complete parity matrix, a failed attempt to alter each immutable record class, and an export that restores with every signed digest verifying.

## Plan self-review and scope boundary

This plan covers the clinical record through encounters, chart, periodontics, history, note templates, notes, three-level treatment planning, alternatives and estimates, consent, rendered procedures, encounter image links, and lab and referral records. It does not specify image acquisition, DICOM processing, image storage or patient matching, electronic lab ordering, electronic referral exchange, claims, payments, statements, portal intake or UI. Amounts use the shared `Money` contract and are referenced or labelled unknown, never invented, and eligibility provenance belongs to B5.

Chart semantics, perio calculation, template enforcement, amendment authority, terminology rights, image storage and association, lab channels and referral exchange remain unverified pending C-S1–C-S4, I1–I3 and the named reviewers. Every task is a proposal. No capability becomes implemented until its acceptance cases pass under the restricted runtime role and the clinician sign-off that the task depends on is recorded.

## Known deviations from docs/SHARED-CONTRACTS.md

- `Blocks` was re-derived from `Dependencies` for the tasks named in the correction list (C5, C8) and for every other task touched here. C12 no longer waits on C13's consent binding, and C13 no longer claims to block the estimate acceptance path.
- Imaging ownership is now split cleanly: I owns the image object, digest, patient association and match decision; C15 keeps only the encounter link. The `matchStatus` field and `correctReferenceAssociation` command were removed from this plan rather than deprecated.
- The relationship-derived signer authority used by C13 still resolves through S5, and the relationship scope names that S5 owns are not yet registered in the shared scope registry. That registration remains an open item with the owner of `docs/SHARED-CONTRACTS.md`.
- Typed command contracts were not retrofitted to every clinical task in this pass; only the shared types and the tasks whose ownership changed were tightened. The four newer plans received the full contract treatment the review asked for.
