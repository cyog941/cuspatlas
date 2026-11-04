# ADR 0006: Note template enforcement and signing policy (C-S2)

Status: **proposed, 2026-11-04.** Every item below is `recommended-pending-clinical-approval` or `blocking`. No dentist, clinical lead or compliance reviewer has reviewed this record; the deciding roles are named but **no decision has been taken and nothing here is clinically validated**. Evidence category: `proposed` (the plan's open decisions C-D4 and C-D5); the incumbent's per-template enforcement flag in [TAB32-DOMAIN-MODEL](../TAB32-DOMAIN-MODEL.md) is `historical-reference` and does not establish what enforcement prevents. Synthetic data only.

Plan: [Clinical record](../superpowers/plans/2026-11-04-clinical-record.md), spike C-S2. Reserved number: [ADR-REGISTRY](../ADR-REGISTRY.md) 0006. Blocks C9 and C10.

## Clinical-safety framing

Clinical semantics need dentist validation, which was not available in this session. Per AGENTS.md, domain and workflow validation gates the clinical modules for release. This record states the plan's recommended option where one exists and marks every other question `blocking`. It is not a decision, not clinical guidance and not clinical decision support. No real note text, template or licensed procedure-code set was used or is committed; procedure-code associations in C9 are mapping identifiers or provisional `SYN-...` placeholders.

The spike step "obtain clinical reviewer decisions and record the rationale" did not happen. The concrete outcome questions below are the reviewer agenda.

## Status vocabulary

As in ADR 0005: `decided` (none), `recommended-pending-clinical-approval`, `blocking`.

## Deciding roles (all pending)

- **Clinical lead / dentist reviewer**: enforcement semantics, required sections, code association, amendment and addendum authority, co-signature.
- **Compliance/records owner** (to be assigned): attestation wording and retention of signed versions.

## Concrete enforcement questions (reviewer agenda)

1. A synthetic draft under an enforced template lacks one required section. Can it be saved as a draft? (Recommended: yes.) Can it be signed? (Recommended: no; the signing refusal lists the missing section.)
2. A synthetic draft addresses an associated procedure code only in free text. Is the association satisfied? (No recommendation in the plan: **blocking**.)
3. A draft under a non-enforced template lacks a required section. (Recommended by the plan's C9 contract: permitted, with a recorded warning.)

## Items

| Id | Question | Recommended option | Status | Deciding role (pending) | Blocks until approved |
|---|---|---|---|---|---|
| C-D4 | What an enforced template prevents, and at which command | Enforcement blocks **signing, not drafting**, until the named required sections and associated procedure codes are addressed; the deficit list is returned in the refusal. One documented enforcement point (the sign command), identical for REST and MCP | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C9 enforcement point; C10 sign refusal |
| C-S2-Q1 | Required-section list per template type | No recommendation in the plan; the list is a clinical value | blocking | clinical lead / dentist reviewer | C9 template definitions beyond synthetic examples |
| C-S2-Q2 | How a procedure-code association is satisfied (structured code entry vs text mention) | No recommendation in the plan | blocking | clinical lead / dentist reviewer | C9 `validateAgainstTemplates` code rule |
| C-D5 | Whether addenda and amendments both exist, and who may author them | Both exist and both are additive and audited. An amendment to **another clinician's** signed note requires an explicit clinical-oversight scope; an addendum is preferred for clarifying text | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C10 amendment/addendum commands and their scope |
| C-S2-Q3 | Amendment and addendum rules as commands | `createAmendment(noteRef, signedVersion, reason, content)`: actor must hold `clinical.sign` and be the signer, or additionally hold the oversight scope (name to be registered in SHARED-CONTRACTS before C10). `createAddendum(noteRef, signedVersion, reason, content)`: actor must hold `clinical.write` and a resolved clinical author profile. Neither command alters the signed version; each appends a version naming the signed version it references | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C10 |
| C-S2-Q4 | Who owns the attestation wording shown at signing | No recommendation in the plan | blocking | compliance/records owner | C10 user-facing release |
| C-S2-Q5 | Whether co-signature is required for any note class (for example a note authored by an assistant or hygienist) | No recommendation in the plan. The C5 encounter records a supervising-provider assignment separately from the author so a later decision can require it without a schema change | blocking | clinical lead / dentist reviewer | C10 co-signature rule |
| C-S2-Q6 | Whether a model may author a signed note | The plan's C10 contract: an AI-assisted draft records model and prompt version identifiers, stays a draft and can be signed only by a named human clinician; the model is never the author of a signed note | recommended-pending-clinical-approval | clinical lead / dentist reviewer | C10 |

## Rejected alternatives (with the plan's reasons)

- Enforcement at drafting: blocks partial documentation during a visit and pushes clinicians to placeholder text.
- Enforcement as a warning only: the per-template flag would mean nothing; incomplete notes become signed history.
- Amendments only (no addenda): every clarification rewrites the clinical meaning of the record version chain.
- Any clinician may amend any note: authorship of the signed content becomes ambiguous.

## What C5 and C8 rely on (synthetic only)

C5 records the clinical author (the authenticated human with a configured clinical role) separately from the treating, secondary and supervising provider assignments, so C10 can apply C-D5 and a future co-signature rule. C8 provides the history version a signed note will reference. Neither task implements templates, signing or amendment.

## Undecided and blocking

Nothing here is `decided`. C9 and C10 must cite this record. The blocking items (C-S2-Q1, Q2, Q4, Q5) block their affected behaviour even for synthetic completion claims; the recommended items block only user-facing or clinical release until the named role signs a review note referenced from this file.
