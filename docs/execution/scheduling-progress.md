# Scheduling and patients execution ledger (workstream S)

Branch: `codex/s-patients` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `e3f18b4` (verified foundation head). A sibling worktree builds S7/S9 on `codex/s-resources`; the orchestrator merges both. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction on 2026-11-04 to build workstream S on synthetic data. Scope of this branch: S-S1, S4, S5, S6 and the shared negative harness. Synthetic patients only; no real patient data, no cloud connection, no host installs. Decisions S-S1, S-D2, S-D3, S-D4 and S-D8 need human reviewers who were not available: they are recorded as **recommended-pending-approval** in [ADR 0003](../adr/0003-patient-identity.md) and implemented behind per-tenant configuration. Nothing here is clinically validated, approved or deployed.

## Batch status

| Task | Status | Head SHA | Notes |
|---|---|---|---|
| S-S1 patient identity decision record | recommended-pending-approval (no reviewer) | the commit containing this row | ADR 0003 |

## Command log

### S-S1

- Wrote `docs/adr/0003-patient-identity.md`: question list Q1-Q13, two synthetic duplicate pairs (P1 shared household phone; P2 same name, different birth date) used as fixtures in S4 and S6, every answer marked recommended-pending-approval with the reviewer role named, unresolved items with owners.
- Deviation: the plan's read-only walkthrough with reception and practice-management reviewers did not happen (no reviewer, no permitted environment). Reviewer sign-off is pending; the reviewer register is empty.
