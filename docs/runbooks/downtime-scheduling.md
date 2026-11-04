# Runbook: scheduling downtime (read-only continuity and reconciliation)

Status: **proposed, 2026-11-07.** Written for workstream S17 against the synthetic foundation. It has not been exercised in a real outage, reviewed by a practice manager or approved. Evidence category: `proposed`. Synthetic data only; nothing here authorizes handling real patient data.

Scope: what front-desk staff do when the scheduling service (REST and MCP) is unavailable, and how the day is reconciled afterwards. There is **no second write path**: nothing is written into the database during downtime, and everything recorded on paper is entered afterwards through the ordinary domain commands, which re-check conflicts, policy and authorization.

## Before a planned downtime (or daily, as preparation)

1. A tenant-wide administrator retrieves, for each location and each day of the downtime window plus one day, the daily worklist (`GET /v1/scheduling/worklist?locationRef=…&date=…`, MCP `scheduling_worklist_daily`): bookings with times, provider, operatory, derived attendance state and confirmation kind.
2. For contact continuity, the same administrator retrieves the work items staff would otherwise act on: notification intents without a channel (`/v1/scheduling/notifications/worklist`), cancellation recoveries (`/v1/scheduling/recoveries`) and follow-up items (`/v1/scheduling/follow-up/worklist`). Phone numbers come from the patient records of the listed patients (`patients.read`), read by an authorized person.
3. The retrieved lists are kept only in the practice-approved protected location for downtime material (a deployment decision recorded in ADR 0002, not made here). They are never placed in Git, issues, chat or logs. They are destroyed after reconciliation.
4. The full scheduling export (`GET /v1/scheduling/export`) is not a downtime artefact: it is sensitive-read logged and intended for export/exit and the S17 round-trip check. Use the narrower lists above.

## During downtime

- Read-only continuity: staff work from the retrieved worklists. Patients arriving are noted on the downtime sheet with the wall-clock time and the person who observed it.
- New bookings, cancellations and reschedules are written on the downtime sheet with a **manual downtime number** `DT-<locationRef>-<date>-<nn>` (sequential per location and day, starting at 01). The number is a paper reference only; it is never typed into a reference field.
- No outreach is promised by the system: no messaging channel is verified (S-S2), so reminders were never automated; phone contact follows the practice process as on any day.
- Clinical documentation is out of scope here (C plan); billing is out of scope (B plan).

## Reconciliation after recovery (same day if possible)

Performed by a scheduler with `scheduling.write`, one location at a time, in downtime-number order:

1. **Bookings**: enter each `DT-…` booking with the ordinary booking command. A 409 conflict means the slot was taken (for example a recurring occurrence or a portal request entered elsewhere): resolve it with the patient as a normal conflict (another slot, or an authorized override where the policy allows one). Record the resulting appointment reference next to the downtime number on the sheet.
2. **Cancellations and reschedules**: enter them with the cancel or reschedule command against the existing appointment (stale versions are refused; re-read and retry).
3. **Attendance**: enter arrivals and other transitions with the attendance command in the order they happened, passing the paper wall-clock time as `claimedAt`. The server instant (entry time) is kept beside the claimed instant; neither overwrites the other. Out-of-order transitions are refused and corrected with the amendment path, never by editing.
4. **Waitlist offers and recalls**: none are made during downtime; after recovery, open cancellation recoveries and recall tasks appear again in their work lists.
5. **Notification intents**: each command entered in step 1-2 records its intent (channel `none`) at entry time. Nothing is sent.
6. **Verification**: for each location and day, the count of downtime bookings, cancellations and arrivals on the sheet equals the count of commands entered; the daily worklist for the day matches the sheet. Differences are resolved before the sheet is destroyed, and the reconciliation (who, when, counts, unresolved items) is recorded in the practice operations log, not in the product.

## What this runbook does not claim

- It does not provide offline write capability, local caching of patient data or automatic merge of downtime records.
- It does not define the protected storage location for downtime lists (deployment decision) or a retention period for them (practice decision).
- It has not been tested in a real environment; the synthetic suite exercises the commands it relies on (booking conflicts, reschedule, cancel, attendance with a client-claimed instant, worklists), not the procedure itself.
