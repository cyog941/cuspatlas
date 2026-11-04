# ADR 0005: Chart, dentition and periodontal semantics (C-S1)

Status: **proposed, 2026-11-04.** Every item below is `recommended-pending-clinical-approval` or `blocking`. No dentist, clinical lead or terminology-rights reviewer has reviewed this record; the deciding roles are named but **no decision has been taken and nothing here is clinically validated**. Evidence category for the recommendations: `proposed` (taken from the open decisions C-D1 to C-D3 of the clinical plan). The incumbent observations in [TAB32-DOMAIN-MODEL](../TAB32-DOMAIN-MODEL.md) are `historical-reference` prompts, not semantics. Synthetic data only.

Plan: [Clinical record](../superpowers/plans/2026-11-04-clinical-record.md), spike C-S1. Reserved number: [ADR-REGISTRY](../ADR-REGISTRY.md) 0005. Blocks C6, C7 and C11.

## Clinical-safety framing

Clinical semantics need dentist validation, which was not available in this session. Per AGENTS.md, domain and workflow validation gates the clinical modules for release. This record states the plan's recommended option for each question so that a synthetic engineering implementation can proceed; it is **not** a decision, not clinical guidance and not clinical decision support. No real patient record, chart value or licensed terminology dataset (CDT, SNOMED CT, ICD or similar) was used or is committed. Where a code is needed, implementations use a clearly provisional internal synthetic vocabulary with placeholder codes of the form `SYN-...` that carry no clinical meaning outside tests.

The spike's walkthrough step ("walk each field with clinician reviewers against a synthetic paper chart") did not happen. The synthetic chart cases listed below are the agenda for that walkthrough, not its result.

## Status vocabulary

- `decided`: a named clinical role approved it (none yet).
- `recommended-pending-clinical-approval`: the plan's recommended option; usable by a synthetic engineering implementation; not usable for a user-facing or clinical release until approved.
- `blocking`: the plan gives no recommendation, or the recommendation needs a clinical value that only a reviewer can supply; no implementation may assume an answer.

## Deciding roles (all pending)

- **Clinical lead / dentist reviewer**: tooth identity, surfaces, dentition handling, perio sites, grades, derived measures and correction behaviour.
- **Terminology-rights reviewer** (named owner still to be assigned by the project lead): any licensed vocabulary, mapping or redistribution.

## Synthetic walkthrough agenda (to be walked with the reviewers)

Synthetic paper charts to prepare (no real content): a full permanent adult arch; a primary dentition; a mixed dentition with a primary and a permanent tooth in the same anatomical position; a missing tooth; a supernumerary tooth; an implant; a perio chart covering six sites per tooth on a full arch with one deliberately unmeasured site.

## Items

| Id | Question | Recommended option | Status | Deciding role (pending) | Blocks until approved |
|---|---|---|---|---|---|
| C-D1 | Canonical tooth identity and displayed numbering | A canonical internal tooth identity independent of any numbering system. Universal is the US default display; FDI is supported per user and per export preference. Conversion is lossless for supported anatomy and **refused, never guessed**, elsewhere (for example a supernumerary tooth with no position in the target system) | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C6 canonical identity table and conversion matrix |
| C-S1-Q1 | Anatomy where conversion is refused | Supernumerary teeth and any tooth whose position has no counterpart in the target system are refused with a typed reason; the exact list needs the reviewer | blocking (list needs reviewer) | clinical lead / dentist reviewer | C6 conversion refusal cases |
| C-S1-Q2 | Surface vocabulary and per-tooth-type scope | Recommended by the plan only structurally: a surface set is validated against the tooth type, and a surface-scoped finding on a tooth type without such surfaces is refused. The surface list itself and which tooth types carry which surfaces are a clinical value | blocking (values need reviewer) | clinical lead / dentist reviewer | C6 surface validation |
| C-S1-Q3 | Missing, supernumerary and implant representation | Distinct chart entry kinds (`missing`, `supernumerary`, `implant`, `existing_restoration`, `prosthodontic`, `condition`) per the plan's `ChartEntry` shape; never inferred from absence of entries | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C6 |
| C-S1-Q4 | Mixed dentition | A primary and a permanent tooth in the same anatomical position resolve to distinct canonical identities and may coexist | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C6 |
| C-D2 | Clinical vocabularies and terminology rights | A provisional internal vocabulary for engineering (`SYN-...` placeholder codes), with mapping points to a licensed set added only after rights review. No licensed dataset in the repository, fixtures, logs or issues | recommended-pending-clinical-approval (vocabulary); blocking for any licensed distribution | clinical lead (content); terminology-rights reviewer (licence) | C6, C9, C11; any release that shows a licensed code |
| C-S1-Q5 | Perio site definition and grade vocabularies | Recommended structurally: per-tooth, per-site raw measurements; an unmeasured site is stored as `not_measured`, never as zero; bleeding, recession, mobility and furcation grades come from a configured vocabulary and an out-of-vocabulary grade is refused. The site count per tooth and the grade scales are clinical values | blocking (values need reviewer) | clinical lead / dentist reviewer | C7 |
| C-D3 | Periodontal derived values | Store raw measurements only; compute derived values from versioned formula definitions that a clinician approves; never rewrite a previously computed value. No formula is defined by this record | recommended-pending-clinical-approval (rule); blocking (every formula) | clinical lead / dentist reviewer | C7 derived values |
| C-S1-Q6 | Correction behaviour compared with a paper chart | A correction writes a superseding entry or measurement with author, instant and reason; the prior value remains retrievable; there is no delete and no in-place update | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C6, C7 |

## Terminology status

| Vocabulary | Status | Rights owner |
|---|---|---|
| Internal synthetic placeholder codes (`SYN-...`) | internal, engineering only, no clinical meaning | project (no licence needed) |
| Procedure codes (CDT or equivalent) | would require a licence; not distributed; C9/C11 hold mapping identifiers only | terminology-rights reviewer (to be assigned) |
| Diagnostic/condition terminologies (SNOMED CT, ICD or equivalent) | would require a licence or affiliate terms; not distributed | terminology-rights reviewer (to be assigned) |

## Consequences of the alternatives

- Numbering-system codes as the stored identity: every display or export change becomes a data migration, and mixed dentition collides on one code.
- Guessing a conversion: a supernumerary or unusual tooth silently lands on a neighbouring identity, which is a wrong-tooth risk.
- Zero for an unmeasured perio site: arithmetic treats missing data as healthy tissue and comparisons report false improvement.
- Recomputing derived perio values in place: past documentation changes after the fact.
- Committing a licensed code set: a licence breach, and fixtures would look like real coding.

## What C5 and C8 rely on (synthetic only)

C5 (encounter and authorship) and C8 (medical history) do not depend on any chart item above. C8 uses the provisional synthetic code pattern from C-D2 (`SYN-...`) for optional item codes and stores free text otherwise. C6 and C7 must cite this record and must not start user-facing work until the blocking items have a reviewer decision.

## Undecided and blocking

Nothing here is `decided`. Each item becomes `decided` only when the named role signs a review note referenced from this file. Until then a user-facing or clinical release of C6, C7 or C11 is blocked on this record, and the blocking items above block even synthetic completion claims for the affected cases.
