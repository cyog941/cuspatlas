# Public demo: feature and function notes for our build

**Status: notes only. Nothing in this document is an adopted task, a plan item or an approved requirement.**

Purpose: a notebook of what another dental product does, so we can decide what our own build should be able to do. Not a design to copy, not a rebuild target, not a UI specification. UI design remains deferred under [AGENTS.md](../AGENTS.md), which also requires us to copy workflow requirements rather than another product's code, branding, imagery or screen design.

Source type: public demonstration workspace, no sign-in, synthetic sample data. The source name and URL are omitted from this public summary; this remains an external observation, not an original implementation.

Every entry is tagged **observed** (seen in the running demo or its served assets), **inferred** (a reading we are putting on the observation) or **decision** (a requirement we are choosing). Nothing here is a claim about how their product behaves behind the client.

## Evidence boundary — what the tooling actually established

| Tool | Evidence | Establishes |
|---|---|---|
| REA 6.8.0 | `ev_0e4dd00b5accc7e2e95bbb62993264d963d35c189bf002b7b6fe6f544f815ffa` | one page target on the public demonstration source |
| REA 6.8.0 | `ev_eb3ebc259db7c3a55ec9577db72ed700c7fcce1f5026ebf1a92e112af27f3e41` | 1162 DOM nodes; **no network requests observed in a 4-second window**; one localStorage key reported (`pms-react-open-patients:v2`) |
| REA 6.8.0 | static bundle analysis, parent `ev_b0de463e226574ff50c9dccd9a2ec7d15ce402e6affb84ec745a9752ed22f1b0` | 16 captured script sources: 15 complete, 1 unavailable, 13 gaps; **zero route patterns, zero endpoint candidates recovered** |
| Craft 0.3.0 | `ev_979c2a26b8e65a3f2c682f57108e782d11911ff49c5d3da72694d4c99aaf41f0` | screenshot of `/react/schedule` as publicly served |

Craft's browser-opening tools require interactive consent, which this session cannot grant; only its CDP-attached screenshot ran. A design-token or breakpoint capture was **not** performed.

Three limits follow, and they bound every entry below:

1. **No backend was observed.** One page, one 4-second window, no requests. That is not proof the demo has no backend — only that none was seen. Anything about their server, validation, persistence or enforcement is unknown.
2. **The application was not reverse engineered.** Static analysis of all 16 captured sources recovered no routes and no endpoints: navigation is client-side and the API surface, if any, is not in the client. So this is a *product* study, not a code study.
3. **Screen content beyond the pages I opened is reported from what rendered.** Where I quote a label or a count I saw it; where I describe what a control *would* do, it is inferred.

Two earlier statements in this document were wrong and are corrected here: it is not established that "every workflow has a route" (one nav entry returned "Page not found"), and it is not established that the demo "writes `?patient=`" (no URL change was observed).

## Feature and function notes

### Scheduling

| # | What it does | Why it matters for ours | Tag |
|---|---|---|---|
| 1 | One appointment block carries patient, payer, attendance state, procedure codes with tooth numbers, time range, appointment type, an edit affordance and a next-state affordance | A receptionist answers the whole call without opening a record. Our appointment read model returns one record, not six calls | observed (labels, block contents) |
| 2 | Status is a short code plus a distinct colour (seven codes seen: `OUT`, `IN`, `CNF`, `BRK`, `CHR`, `NS`, `RDY`) | Colour reinforces the label rather than replacing it. Worth pairing a code with an operator-facing full label so a new hire is not blocked | observed codes; **decision**: pair code with label |
| 3 | A blockout covering several operatories renders as one band across their columns | One closure is one fact with one identity and one audit entry, not N coincident bookings | observed; **decision**: model it as one object |
| 4 | Unavailable time is visually distinct from free time | "Nobody booked it" and "you cannot book it" are different answers. Our availability model must return the reason, not just an empty slot | observed as distinct treatment; **decision**: separate reason in the contract |
| 5 | A capped "pinboard" of appointments with no committed slot (shown as `Pinboard 0/10`), with a keyboard shortcut and a drag target | A named, bounded staging queue for reschedules in flight. Capacity and move failures become explicit outcomes instead of silent drops | observed (label and capacity); **decision**: bounded list with audit per move |
| 6 | Counters live on the controls that open the lists (`Requests`, `Blockouts`) | A user knows whether to bother before clicking. Our schedule read returns those counts with its scope stated | observed |
| 7 | "Find opening" is a search: appointment type (type optional, "duration only"), minutes, provider, time of day, weekday set, start date, window (30/60 days) | This is availability *query*, not a filtered calendar. Our S9 must accept duration-only and a bounded window and return openings | observed (dialog fields) |
| 8 | Density controls: Day/Week, "Compact hours", zoom | A scheduler that cannot compress is unusable on a laptop. Our read model must support a coarse and a detailed grain from the same endpoint | observed |
| 9 | On a 390 px viewport the calendar becomes an inner scroller (766 px inside 289 px) with no page-level overflow | Correct pattern for a phone: the calendar scrolls, the chrome stays. Relevant once a mobile surface is authorised | observed |
| 10 | A persistent active-patient bar showing initials, name, phone and jumps to Appts/Billing, or `No active patient` when empty | Every call starts with "which patient". Carrying that context across screens and into URLs is a requirement, not a feature | observed |

### Office floor

| # | What it does | Why it matters for ours | Tag |
|---|---|---|---|
| 11 | A card per current visit: room, patient, time, duration, plain-language state in the corner, link back to the appointment, inline "Request doctor" (disabled when not applicable) | The same facts as the schedule, for a different audience, in different words. Our attendance model must expose an operator-facing label beside the code | observed |
| 12 | A team-presence block: your room, your availability, doctor to notify | Turns "who is free" from a question into a panel. Ours has no owner for this today — recorded as a gap | observed |

### Claims and money

| # | What it does | Why it matters for ours | Tag |
|---|---|---|---|
| 13 | Claim work is a set of labelled queues with counts (to create, pending submission, attachments, pending payment, rejected/denied, appeals, paid/closed, returned claims, filing deadline soon, all claims) | Triage by state, not by constructing a filter. Ours needs queues as addressable states with per-queue counts | observed (labels) |
| 14 | Four headline figures above the queues (open insurance A/R, claims over 30 days, needs action, open appeals) | Answers the morning-huddle questions directly | observed (labels) |
| 15 | Default ordering is "work priority" — deadlines and attention first, with the tie-break documented | Newest-first is the wrong default for money. Ours must define the ordering as part of the contract | observed (sort control); **decision**: documented ordering |
| 16 | The screen states its own freshness, filter location and page cap | Kills the "is this current" and "why am I not seeing it" arguments. Every list response should carry as-of time, applied filters, cap | observed as on-screen copy; **decision**: in the API response, not just the UI |
| 17 | Empty state names the next action and states `0 of 0` | Zero should be legible, not suspicious | observed |

### Reports, messaging, agent

| # | What it does | Why it matters for ours | Tag |
|---|---|---|---|
| 18 | Reports grouped with counts and a favourites tab | The three reports a practice actually uses should not be hunted daily | observed |
| 19 | Messaging split into texts / inbox / team / automation / forms, with all / unread / needs-reply filters | "Needs reply" turns a log into a work queue. Ours has messaging owned by portal/comms but no needs-reply worklist — gap | observed |
| 20 | A first-class `Agent` destination with sessions, memory vault and scheduled tasks | Treats AI as a workspace with history, not a chat box. Relevant to workstream A | observed (nav and headings) |

### Safety and identity

| # | What it does | Why it matters for ours | Tag |
|---|---|---|---|
| 21 | The appointment dialog shows the patient summary it needs (insurance verification state, chart number, age, phone, carrier, balance) with `Open chart` | The user does not lose the appointment to check the balance | observed |
| 22 | `Change patient…` carries the warning that completed procedures belong to this patient and must be undone through procedure review first | The refusal shape we want: name the reason and the remediation. Whether it is actually refused was **not tested** | observed (warning text); inferred (enforcement) |
| 23 | Search-first top bar (`Find patient…` plus `+ Patient`) | The most common task is one keystroke away | observed |

## What this exposes in our own design

These are the notes the exercise was for — gaps in *ours*, not features in theirs. None of them is an adopted task. Each needs a decision before it becomes one, because a requirement that names no owner is worse than a note that does.

1. **No owner for a floor/flow view.** Attendance states exist in S11, but nothing owns the "who is in which room, who needs a doctor" read. New candidate task, or an explicit scope decision.
2. **No needs-reply messaging worklist.** E owns messages and delivery; nothing turns inbound into a queue with an SLA.
3. **No bounded unscheduled-work list by name.** S10 has booking and reschedule, and S8 already owns slotless requests. Whether a staging list for appointments without a slot is a new aggregate or a view over existing ones is an open design question — it is not a new appointment state, and the plan's occupancy rules must not be weakened to create it.
4. **Availability search has no "duration without a type" path** in our current contract (S9 takes a type). Small contract change, real use case: "find me 30 minutes anywhere".
5. **Our read models are per-task.** The demo shows that one screen needs appointment + patient + coverage + procedures + next-states together. No task owns that composition, and it spans aggregates owned by B, C and S — so it needs a decision about who composes, not a requirement bolted onto S10.
6. **Queue-as-navigation is not in our claims design.** B6 has a claim lifecycle; it does not have named work queues with scoped counts. Note that most observed queues are predicates over the lifecycle, not states — they must not be modelled as extra states.
7. **Nothing requires a response to state its own freshness.** We have as-of conventions scattered through acceptance scenarios; no shared contract requires every list response to carry it.

## Things we are deliberately not taking

- **Codes without a legend.** `CNF`/`RDY`/`CHR`/`BRK`/`NS` are efficient for trained staff and opaque to everyone else. We pair code with a label.
- **Five peer destinations for money** (claims, revenue, insurance payments, insurance plans, reports). Our domain model separates those facts; navigation should group them under one financial area.
- **A nav entry with no route.** One observed destination returned "Page not found". Our navigation should be generated from the route registry, not maintained beside it.
- **Their visual treatment.** Colours, type sizes, radii, spacing and component styling were not recorded as a specification, and none of it should be copied. Design is a separate, deferred decision.

## Open questions these notes raise

1. Does a floor view belong in the first release, or is it an attendance report instead? (Owner: product + clinical reviewer.)
2. Should the pinboard be its own aggregate, or a state on booking? (Owner: engineering, with S10.)
3. Does "work priority" ordering need a practice-configurable rule, or is one documented global order enough for release? (Owner: billing reviewer.)
4. Is a needs-reply messaging queue a first-release capability or a follow-on? (Owner: product, with E.)
5. Which of these become tasks, and which stay notes? Nothing here is authorised to implement.
