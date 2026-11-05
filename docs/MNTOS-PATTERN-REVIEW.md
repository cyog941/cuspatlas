# MntOs schedule demo: interaction patterns worth taking

Status: read-only observation of a public demo, 2026-11-03 evening ET. Source: `https://mntos-demo.vercel.app`, a self-described demo workspace with synthetic sample data and no sign-in.

What this document is: a list of **interaction and information-design patterns** we want to adopt, with the reason each one works and where it lands in our plans. What it is not: a screen design, a visual copy, or code reuse. [AGENTS.md](../AGENTS.md) is explicit that we copy workflow requirements, never a vendor's code, branding, imagery, or screen design, and UI design remains the deferred final planning stage. Nothing here authorises building a screen.

Method: a dedicated Chrome profile with a loopback DevTools endpoint. Structure, labels, computed styles and interaction states were read from the running page; screenshots were taken for local reference only and are not committed. No account was created, nothing was submitted, and no sample record was edited beyond opening dialogs in a demo that discards changes.

REA evidence: `ev_0e4dd00b5accc7e2e95bbb62993264d963d35c189bf002b7b6fe6f544f815ffa` (CDP target list, origin `mntos-demo.vercel.app`).

## Why this one is worth reading

The incumbent we studied keeps six major workflows in overlays with no URL, and reports access through a 29-item matrix that grants everything to everyone. This demo is the opposite temperament: every workflow has a route, every queue states its own freshness, and the dense screens explain themselves in situ. It is a better model for the interaction layer than the incumbent is, even though the incumbent has more functional depth.

## Patterns to adopt

### Scheduling surface

**1. Two-line column headers, code then human name.** `OP1 / Operatory 1`, `HYG1 / Hygiene 1`. An experienced user scans the code; a new one reads the name. Costs one line of vertical space, removes a training dependency.

**2. The appointment block is a complete answer.** A single block carries patient name, payer badge, status pill, procedure codes with tooth numbers, time range, appointment type, an edit affordance, and a next-status affordance. A receptionist answers "who, what, when, is it confirmed, what are we doing, what will insurance do" without opening anything.

**3. Status as a filled pill with a four-letter code and its own hue.** Observed pills: `OUT` green, `IN` magenta, `CNF` blue, `BRK` orange, `CHR` deep purple, `NS` brown-red, `RDY` pink. Rendered at 10px uppercase, `border-radius: 99px`, dark text on light hues and white text on dark ones. Colour is redundant with the label rather than the only signal, which is the correct accessibility posture.

**4. Blockouts span every operatory as one object.** Lunch renders as one band across `OP1/OP2/HYG1/HYG2` rather than four separate blocks. That is the difference between "we are closed" and "four coincidences".

**5. Unavailable time is hatched, not blank.** Empty grid cells mean free; hatched bands mean unavailable. The two are different facts and they look different.

**6. Pinboard: a capped staging area for work that has no slot.** `Pinboard 0/10`, with the instruction "Drag one here, or press P on a focused appointment, to move it to another day." It is a named, bounded queue with a keyboard shortcut and a drag target, not an implicit concept. This is the pattern our scheduling plan calls an unscheduled-work list; the demo shows it belongs on the schedule screen, not in a separate module.

**7. Counters act as navigation.** `Requests 5`, `Blockouts 1`. The count is shown on the control that opens the list, so the user knows whether to bother.

**8. "Find opening" is a search, not a filter.** The dialog takes appointment type, "duration only", minutes, provider, time of day (any / morning / afternoon), weekday checkboxes, a start date and a window (`next 30 days` / `next 60 days`), then answers with openings. Our scheduling plan owns availability as a query; this is the interaction it must support.

**9. Density controls for a dense screen.** Day/Week toggle, `Compact hours`, and a zoom control (`− 100% +`). A scheduler that cannot be compressed is unusable on a laptop.

### Office floor

**10. A glanceable second view of the same data.** The floor board is one card per current visit: room, patient, time and duration, a plain-language status in the top-right corner (`scheduled`, `confirmed`, `checked in`, `in chair`, `ready to seat`, `checked out`), a link back to the appointment in the schedule, and an inline `Request doctor` action that is disabled where it does not apply.

Two things are worth naming. The floor board uses **plain language** where the schedule uses **codes** — same facts, different audience, deliberately different vocabulary. And it exposes a **team presence** block (your room, your availability, doctor to notify), which turns "who is free" from a question into a panel.

**11. Cross-view identity.** Both views open the same appointment. There is no second copy of the visit and no re-entry.

### Claim workspace

**12. Queues with counts as the primary control.** Ten queue buttons, each carrying its count: to create, pending submission, attachments, pending payment, rejected/denied, appeals, paid/closed, returned claims, filing deadline soon, all claims. Work is triaged by state, not by a filter dropdown the user must construct.

**13. Four figures above the queue.** Open insurance A/R, claims over 30 days, needs action, open appeals. Each answers a question a practice manager actually asks in a morning huddle.

**14. "Work priority" is the default sort.** Not newest, not patient name. Filing deadlines and claims needing attention come first, and the screen says so.

**15. The screen states its own freshness and limits.** "Totals and queue counts cover all accessible claims as of 2026-11-04." "Search and filters run on the server before pagination." "each page contains up to 50 claims." Three sentences that prevent the two classic report arguments: "is this current" and "why am I not seeing it".

**16. An empty state that gives the next action.** "No accessible claims match these filters. Choose another queue or adjust the filters." Plus `Showing 0 of 0 matching claims`, so zero is legible rather than suspicious.

### Patient context

**17. A persistent active-patient bar.** With no selection the bar reads `No active patient`, greyed. With a selection it shows an initials avatar, the patient name and phone, and quick jumps to Appts and Billing, and it stays across screens. Any workflow that starts with "which patient" is answered before the user asks.

**18. Identity is carried in the URL.** The demo writes `?patient=<id>` when a patient is in context, so a patient's workspace can be linked and reloaded. This is the same addressability property our design requires of workflow screens, applied to context.

**19. The appointment dialog carries the patient summary it needs.** Opening an appointment shows, in the dialog itself: insurance verified state with a link, chart number, age, phone, carrier, balance, and two actions (`Open chart`, `Schedule patient`). The user does not lose the appointment to check the balance.

**20. An identity change that could corrupt the record is blocked with its reason.** `Change patient…` carries the warning "Completed procedures belong to this patient. Undo them through the procedure review before changing patient." That is exactly the kind of guard our design demands: the refusal explains itself and names the remediation path, instead of failing silently or succeeding wrongly.

### Cross-cutting

**21. Search-first top bar.** `Find patient…` plus an always-visible `+ Patient`. The one thing every phone call needs is one keystroke away.

**22. Reports with favourites.** Reports are grouped and counted, with a favourites tab, so the three reports a practice actually uses do not require hunting through the catalogue every morning.

**23. Messaging with triage tabs.** Texts, inbox, team, automation and forms, with `all / unread / needs reply` filters. "Needs reply" as a first-class filter is the difference between a message log and a work queue.

## Patterns to adapt rather than copy

- **Status codes without a legend.** `CNF`, `RDY`, `CHR`, `BRK`, `NS`, `OUT` are efficient for staff who already know them, and opaque to anyone new or colour-blind until learned. Our design should pair the short code with an accessible full label (tooltip, aria-label, and a legend), which the floor board already demonstrates is affordable.
- **Patient context as a query parameter.** It deep-links, but it shares a route and loses meaning if the parameter is dropped. Our addressability requirement is a path per workflow; context can travel with it, but the screen must still be its own route.
- **Four separate top-level destinations for money** (`Claim Center`, `Revenue`, `Insurance payments`, `Insurance Plans`) plus `Reports`. Our domain model deliberately separates those facts; navigation should group them under one financial area rather than flattening five peers.
- **A fourteen-item icon rail.** Every destination visible is good; fourteen labels at this size is a density risk, and one of the observed routes (`/react/lists`) returned "Page not found", which suggests the nav is ahead of the routes. Our navigation should be derived from the same registry as the routes, not maintained beside it.
- **Status colour as the only differentiator between adjacent states.** Two of the observed hues (`IN` magenta and `RDY` pink) are close. Any colour system we adopt needs a pairwise contrast check, not just per-swatch contrast.

## Design values observed, for reference only

Not a design system to copy; recorded so the numbers are available when UI design is authorised. Re-derive and re-validate at that point.

| Property | Observed |
|---|---|
| Page background | `rgb(233, 235, 230)` |
| Font stack | `-apple-system, "SF Pro Text", BlinkMacSystemFont, "Segoe UI", Roboto, ...` |
| Status pill | 10px uppercase, weight 700+, radius `99px` |
| Column header | 11px, weight 750 |
| Card radius | rounded, consistent across schedule blocks and floor cards |

## What this does not tell us

- Whether any of it is enforced server-side; this is a demo with no backend guarantees, and every request would have been against mocked or local data.
- Real behaviour under load, with hundreds of visits, multiple locations, or conflicting edits.
- Anything clinical: the demo shows scheduling, floor, claims, revenue, messages, reports, an `Agent` workspace and settings, but no odontogram, periodontal chart, note signing or imaging.
- Whether the patterns survive a five-location practice; the screens assume one clinic's operatories.

## Where these patterns land in our plans

| Pattern | Owning plan / document |
|---|---|
| Appointment block content, status presentation | scheduling Task 10 (booking) and the status vocabulary in [workflow and role matrix](WORKFLOW-ROLE-MATRIX.md) |
| Blockouts, unavailable time, density controls | scheduling Task 10 |
| Pinboard, unscheduled work list | scheduling, patient/visit scheduling tasks |
| Find opening | scheduling availability task (Task 7 in the current draft) |
| Floor board, request doctor, team presence | scheduling attendance task (Task 11 in the current draft) |
| Claim queues, work priority, freshness statement | billing and RCM claim lifecycle task, plus the reporting contract in [shared contracts](SHARED-CONTRACTS.md) |
| Active patient bar, patient in URL, appointment summary | scheduling Task 5 (identity) and the API context rules in [API-AND-MCP.md](API-AND-MCP.md) |
| Change-patient guard | clinical record, amendment and procedure-completion rules |
| Empty states, freshness, queue counts | [acceptance scenarios](ACCEPTANCE-SCENARIOS.md), as observable expectations rather than screenshots |

These are requirements on behaviour. They do not move UI design ahead of its gate, and they do not authorise implementation.
