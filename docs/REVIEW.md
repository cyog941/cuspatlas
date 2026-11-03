# Design review record

2026-11-03: a fresh architecture reviewer, as requested by the brainstorming workflow, identified four material gaps: first replacement-release boundary, incoming migration/cutover, structured longitudinal clinical data, and supported self-hosting operator.

Resolution: added explicit sections to the design. Mandatory pilot modules include structured chart/perio/history, claims/ERA/secondary workflows and patient portal; imaging uses a qualified bridge initially. Prescribing is a pilot-dependent cutover gate. Initial migration uses reconciled active records/open items plus accessible integrity-checked historical archive, not fabricated historical postings. Self-hosting initially requires a qualified named operator. These are documented engineering proposals, not claims of user or clinical sign-off.

Clinical, financial, legal, hardware/vendor and deployment validation remains outstanding. A design review is not certification of an implementation that does not yet exist.
