# Tab32 state vocabularies and appointment form

Status: read-only observation, 2026-11-03 evening ET. Same session and boundaries as [REFERENCE-WORKFLOW-MAP.md](REFERENCE-WORKFLOW-MAP.md). Configuration vocabularies only; no patient, staff or provider names are recorded.

## Appointment status vocabulary

The Status selector in the appointment form offers these values, in this order:

| # | Status | Kind |
|---|---|---|
| 1 | Mark as Scheduled | lifecycle |
| 2 | Mark as Confirmed | lifecycle |
| 3 | Mark as Confirmed (auto) | lifecycle, system-set |
| 4 | Mark as Checked-In | arrival |
| 5 | Mark as Curbside Check-In | arrival variant |
| 6 | Mark as In Chair | in-progress |
| 7 | Mark as Waiting | in-progress |
| 8 | Mark as Late | exception |
| 9 | Mark as No Show | exception |
| 10 | Mark as Left Without Treatment | exception |
| 11 | Mark as Canceled | terminal |
| 12 | Mark as Reschedule | terminal |
| 13 | Mark as Treatment Complete | clinical completion |
| 14 | Mark as Billed | financial completion |
| 15 | Mark as Checked-Out | departure |
| 16 | Mark as ASAP | priority flag, not a lifecycle state |
| 17 | `-- All --` | filter sentinel, not a state |

Two observations with design consequences.

**One status field carries four different kinds of fact.** Lifecycle position (`Scheduled`, `Confirmed`), physical presence (`Checked-In`, `In Chair`, `Waiting`, `Checked-Out`), clinical completion (`Treatment Complete`), financial completion (`Billed`) and exceptions (`No Show`, `Canceled`, `Late`) all compete for one field. That is why the plan's insistence that attendance, procedure completion and billing be *separate facts* matters: a single field cannot represent "the patient arrived, was treated, and has not been billed" without losing one of them.

**`Confirmed (auto)` is a distinct value from `Confirmed`.** The system distinguishes a human confirmation from an automated one. Any replacement that wants to measure no-show rates per reminder policy must keep that distinction, or it cannot tell whether automation helped.

`ASAP` sits in the same list as lifecycle states but is a priority, not a state. Treating it as a state is a modeling error we should not reproduce.

## Appointment form

Tabbed dialog with these panes: Appointment Details, Insurance, Forms, Lab Slip, Appointment List, Patient Notes, Medical History, Selected, Incomplete.

Appointment Details fields: Date, Time, Duration (in mins), Operatory, Provider, Secondary, Staff, Completed By, Status, Appointment Types, Recurrence (max 26), Select HelloPatient Service, More Options.

Design notes:

- **Two provider slots** (Provider, Secondary) plus Staff and Completed By. "Who is treating" and "who completed it" are distinct roles, and a secondary provider is explicit rather than inferred from a procedure.
- **Recurrence is capped at 26.** A hard cap on a recurrence series exists in the incumbent. We should decide our own limit deliberately rather than discovering one at runtime.
- **Lab Slip is a first-class pane on the appointment**, not a separate lab module screen.
- **Medical History is a pane inside the appointment**, which is where a clinician needs it, rather than only inside the chart.

## Operatory configuration

Ten operatory values are configured, and two of them are not physical rooms:

- `8. NO SHOW`
- `9. CANCELLED APPTS.`

Two operatory labels name exception states. Whether staff actually book into them was **not** observed — only the labels were. If they do, it is a workaround for a model that wants every appointment to occupy a resource. Our schema should allow an appointment to have no operatory and an explicit exception reason, so staff do not have to invent a fake room.

Operatory labels themselves are free-text and prefixed with their own ordinal (`1.`, `2.`, "¦), which duplicates ordering already implied by display order. That is a small example of the label drift that accumulates when configuration is unconstrained text.

## Claims filter vocabularies

- **Date Type**: Date of Service, Claim Status Date. Two date bases, selectable, exactly as the reporting screens do.
- **Fee Amount**: All Claims, Claims with fees, Claims without fees.
- **Claim Review Group**: All, Unassigned, Staff, Admin.
- **Billing Entity**: configured per clinic.
- **Insurance Carrier**: 26 configured carriers.

The carrier list is the most instructive artefact in this pass. It contains near-duplicates and punctuation variants of the same payer — multiple `AETNA` entries distinguished by suffix or by a mailing address embedded in the name, and `ANTHEM BCBS`, `ANTHEM BCBS ^` and `ANTHEM BCBS*` as separate rows.

That is real-world payer data quality, not a vendor failing. A replacement must plan for carrier identity as a *resolved* concept with aliases: a canonical payer id, a set of alias strings, and a mapping from the alias observed on a claim to the canonical payer. Without that, every downstream report inherits the duplicates.

## Access control matrix

Route `/settings/access-control`, reached from Clinic Setup navigation (Clinic, Preferences, Colors, Access Control, User Account, Care Team, Scheduler, Lab, Payment Gateway, Custom Fields, Accounting, Statement, Claim Billing Information, Patient Billing Information).

The matrix has three columns: **Category**, **Resource**, **Access**. Observed categories are `Financial`, `Report` and `Setup`.

Observed resources, grouped as the UI groups them:

| Category | Resources |
|---|---|
| Financial | Account Receivables (AR), Dashboard (Key Performance Indicators), Ledger, Patient Statement |
| Report | Daysheet Adj/Dis Summary, Aging, Daysheet, Appointment Status, Daysheet Summary, Deposit, New Patient, Patient Communication, Patient Insurance, Patient Treatment, Payment Report (All), Patient Statement, Production And Collection, Referral, Treatment Summary, Incomplete Treatment (Without Apt.), Payment Distribution (All), **Manage Open Claims**, **Payment Report (Undistributed Amounts)** |
| Setup | Setup Wizard, Setup Clinic |

**Every observed row had Access set to `All Users`** — including the ledger, AR, undistributed payment amounts, open-claims management and clinic setup.

Two separate conclusions, and they must not be conflated:

1. **A per-resource `Access` column exists at report granularity.** That is finer than a coarse admin/staff split. Whether the column can actually be narrowed, and for whom, was **not** observed: every row we saw read `All Users`, and the access-level list was not enumerated.
2. **This clinic's configuration grants everything to everyone.** That is an operational finding about one practice, not a claim about the vendor's defaults or enforcement.

For our design this is the strongest available argument for **default-deny** and for negative permission tests written before the permission check is implemented. A permission system that supports the right granularity but is configured open in practice delivers nothing; our readiness gate already requires cross-tenant, role and revoked-access tests on every permission-sensitive path, and this is the concrete failure it is guarding against.

Access levels themselves (whether the `Access` column selects a group, a role, or a per-user list) were not enumerated, and server-side enforcement was not tested.

## Derived requirements

1. **Model attendance, clinical completion and billing as three separate facts.** The incumbent's single status field proves the need by its own overload.
2. **Keep automated confirmation distinct from manual confirmation.** It is a different fact with different measurement value.
3. **Do not encode priority inside lifecycle state.** `ASAP` is a flag on an appointment, not a status.
4. **Allow an appointment with no operatory and a typed exception reason.** Pseudo-rooms are a symptom of a required field that should be optional.
5. **Plan for payer identity resolution** with canonical ids and alias sets, because observed payer names are already dirty in a single practice.
6. **Treat the appointment as the clinical context.** Medical history, notes, forms and lab slips belong where the visit happens.

## Boundaries

- Status values are configuration labels observed in a selector. Their permitted transitions, guards and audit effects were not tested and must not be assumed.
- No appointment was created, edited or saved. The dialog was opened and closed only.
- Claim status vocabulary and the claim detail sub-structure remain unobserved.
- Provider and staff names are deliberately excluded here. Carrier names are public payer brands and are included, because the punctuation variants are the evidence for payer-identity resolution.





