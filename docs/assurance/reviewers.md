# Evidence reviewer allowlist

Status: empty. No person or role has been appointed to review assurance evidence, so no control in the synthetic evidence manifest can be marked `reviewed`. `scripts/evidence-verify.mjs` reads this file and fails any manifest whose control claims `reviewStatus: "reviewed"` with a reviewer that is not listed below, or without `reviewer` and `reviewedAt`. A `certified` status is always refused: a test pass or a review here is never a certification.

## How to add a reviewer

1. The accountable security owner (an assigned role, see docs/ASSURANCE-AND-CERTIFICATION.md) approves the addition in a reviewed pull request; the reviewer cannot approve their own entry.
2. Add one line under "Allowlist" in exactly this form: ``- `reviewer-id` — role, date added`` where `reviewer-id` matches `^[a-z0-9][a-z0-9._-]{1,63}$`. Use a stable pseudonymous identifier, not an email address, phone number or other personal data.
3. Remove the line when the person leaves the role; past manifests keep their recorded reviewer, but new reviews by that identifier fail verification.

Listing a reviewer is an access decision, not a qualification. Organizational audit evidence (who reviewed what, with what context) belongs in the restricted evidence store, not in Git.

## Allowlist

(none)
