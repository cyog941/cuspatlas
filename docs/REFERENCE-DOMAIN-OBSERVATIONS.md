# Tab32 domain model observations

Status: read-only observation, 2026-11-03 evening ET. Same authenticated session and boundaries as [REFERENCE-WORKFLOW-MAP.md](REFERENCE-WORKFLOW-MAP.md). No patient, staff or account names are recorded below; entity types, column names and control labels only.

## Auditable entity taxonomy

The Activity Audit screen offers three controls: an **action** selector, a **record** selector and an **actor** selector. The observed options are a direct statement of which entities the vendor considers worth auditing.

Actions: `Delete`, `Edit`, `Login`.

Records (26 observed; the selector listed 29 items, of which three were the actions above and are not record types):

| Group | Entities |
|---|---|
| Scheduling | Appointment, Time Block |
| Patient and identity | Patient, Mass Patient Consent, Form, Form Data, ActionNotes |
| Clinical | Notes, Treatment, Tx Detail, Tx Item Detail, Xray |
| Insurance | Carrier, Insurance, Insurance Plan, Insurance Subscriber / Plan, Coverage Book, Coverage Book Detail |
| Money | Check, Credit Card, Payment Plan, Patient Statement Generate |
| Organization | Clinic, Clinic Config, Settings, User Account |

Three things stand out.

**Treatment is audited at three labels.** `Treatment`, `Tx Detail` and `Tx Item Detail` appear as three separate auditable record types. Their relationship, cardinality and per-tooth semantics were **not** observed: three labels are evidence that the incumbent distinguishes three kinds of treatment record, and nothing more. Our three-level model (plan, detail, item) is a design requirement we are choosing, not a description of the vendor schema. Flattening planned procedures into one row would discard a distinction the incumbent treats as auditable, which is the reason to keep three levels of our own.

**Coverage is two levels, and the separation is deliberate.** `Insurance`, `Insurance Plan` and `Insurance Subscriber / Plan` are distinct from `Coverage Book` and `Coverage Book Detail`. The book is a separate aggregate from the plan definition — consistent with a patient's coverage history being versioned independently of the carrier's plan catalog.

**Statement generation is itself an audited event.** `Patient Statement Generate` is a record type, not just an output. That implies generating a statement is a state change someone can be held to, not a read that produces a PDF.

Also audited: `Credit Card` — card data is referenced as an auditable object, which for us means the design must decide explicitly whether we ever store card data at all, and if so, how it is tokenized, rotated and audited.

## Payment plans

Route `/payment-plan`, heading `General Payment Plan Management`, single tab `General Plans`, with summary tiles `Plan Value` and `Monthly Revenue Run Rate`.

Plan columns: Patient, Due Date, Plan Date, Total Amount, Authorized, Installment, Balance, Overdue, Card Expiry, Plan Status, Auto Pay.

That column set implies a specific lifecycle worth matching: a plan has a **contract total**, an **authorization** state, an **installment** amount, a running **balance**, an **overdue** measure, a **card on file with an expiry we must watch**, a **status**, and an **auto-pay** flag. "Card Expiry" as a first-class column means expired cards are an operational work queue, not an exception — which is exactly the kind of failure mode a replacement must handle explicitly rather than silently failing to charge.

## Scheduler

Route `/scheduler/c`. Range heading reads `Nov 1 – 7, 2026`; navigation is `-1W`, `-1D`, `Today`, `+1D`, `+1W` with a `Week`/`Day` view toggle and a month label.

Controls exposed by tooltip: Calendar, Patient Apt Search, Reschedule, Clipboard, **Appointment Conflicts**, **Appointment Requests**, Recall, Waitlist, Edit Time Blocks, Show Time Blocks. Filter: Appointment View Order Templates.

Two of these matter disproportionately:

- **Appointment Conflicts is a distinct surface.** Conflict detection is not buried inside the save path; it is something staff can inspect. Our booking design should expose conflict as an explainable result, not a silent refusal.
- **Appointment Requests is separate from appointments.** That matches the plan's insistence that a request and a booking are different facts with different states.

## Derived requirements

1. **Audit must be entity-typed and complete by construction.** The vendor enumerates 26 auditable record types. Our audit model should be driven by a registry of auditable entities so a new entity cannot ship unaudited by omission.
2. **Model treatment at three levels.** Plan → detail → item. Preserve the distinction in the contract rather than flattening it.
3. **Separate coverage definition from coverage history.** A patient's coverage book is versioned independently of the carrier plan catalog.
4. **Treat statement generation, payment posting and claim submission as audited commands**, each with an actor, a timestamp and a reversible or correctable aftermath.
5. **Make expired card and failed auto-pay first-class states** with their own worklist, because the incumbent already surfaces card expiry as a column.
6. **Expose conflicts and requests as inspectable objects**, not as error paths.

## Boundaries

- Entity names are observed configuration labels. They indicate what the vendor audits; they do not establish field-level schema, cardinality or referential rules.
- No lifecycle transition was executed. Payment-plan worklist labels were seen in an earlier pass but the status vocabulary was not enumerated; the claim status vocabulary was not enumerated. Both remain gaps. The appointment status vocabulary is enumerated separately in [REFERENCE-STATE-VOCABULARIES.md](REFERENCE-STATE-VOCABULARIES.md).
- Role and permission enforcement remains untested; the actor selector observed is a user list, not a role matrix.





