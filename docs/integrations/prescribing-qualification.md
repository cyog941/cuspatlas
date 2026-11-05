# Prescribing partner qualification (A13)

Status: no e-prescribing partner is qualified and no prescriber-identity verification source exists.
This is an explicit non-claim: CuspAtlas does not prescribe, does not transmit prescriptions, and
does not support controlled-substance prescribing.

## What exists (synthetic implementation)

- The operation envelope: `prescriptions.drafts.create`, `prescriptions.submit` (bound to an approved
  A10 proposal) and `prescriptions.cancel`, human only; `prescriptions.submit` is non-delegable, so no
  agent can ever submit, on any transport.
- The contract a partner would fill: `PrescriberIdentity` (prescriber, credential, verified at,
  verification source), `PrescribingPort` with an explicit `unsupported` outcome and an `unknown`
  outcome to be reconciled by request identity (never retried as a new prescription).
- Refusal semantics: every prescribing operation answers 503 `service_unavailable` with
  `detail.reason = prescribing_not_available` and blocking references naming each missing fact and
  capability (`fact:prescriber_identity_verified`, `capability:eprescribing_partner`,
  `capability:controlled_substance_submission` for a controlled substance). Validation (400) and
  authorization (403) come first; nothing is written; no success is ever fabricated. Even a partner
  reporting every capability cannot submit without a verified prescriber, and the port is not called.

## What qualification would need (blocked)

A named partner, its certification and transport, a prescriber identity-proofing and credential
source, controlled-substance requirements where applicable, the medication-review record of
`clinical Task 8`, and a qualification note recorded here before any submission path is enabled.
