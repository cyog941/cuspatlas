# End-to-end PMS capability and acceptance matrix

Status: requirements, not implemented features. Initial market: US general dentistry. P1 means required for a supported pilot's replacement workflow, not already delivered. P2 means later breadth. Every row requires API parity, authorization, audit, synthetic tests and export coverage.

| Domain | Required scope | Representative acceptance scenario | Release |
|---|---|---|---|
| Practice setup | Organization, locations, operatories, providers, hours, holidays, roles, procedure catalogs, fee schedules | Staff member restricted to one location cannot change another's settings; timezone survives DST | P1 |
| Patient identity | Demographics, preferred name/pronouns, language, contact preference, identifiers, duplicate review, merge/unmerge strategy | Shared household phone never auto-merges two patients; merge preserves source IDs and history | P1 |
| Family and consent | Guarantors, dependents, guardians/proxies, consent versions, communication preferences, deceased/inactive state | Guardian access is scoped and expires/revokes without deleting the child's record | P1 |
| Scheduling | Day/week, location/provider/operatory views, holds, blocks, appointment types, duration, recurrence exceptions, waitlist, availability search | Two concurrent bookings for one constrained resource produce one accepted booking and one conflict | P1 |
| Intake and portal | Appointment requests, approved bookings, forms, history, consent, secure documents, authenticated balances | A request remains pending until an appointment is saved; duplicate submission is idempotent | P1 |
| Daily workflow | Huddle, confirmation, arrival, in-care, completion, cancellation, no-show, tasks and handoff | Payment does not change attendance; cancelling preserves reason and notification decision | P1 |
| Clinical chart | Adult/primary/mixed dentition, Universal and FDI numbering, tooth/surface conditions, existing work, missing/supernumerary teeth | A surface-specific finding is versioned; tooth numbering conversion is lossless for supported anatomy | P1 |
| Periodontal | Six-site measurements, bleeding, recession, mobility/furcation and longitudinal comparison | Clinician validates calculations and correction history against a synthetic paper chart | P1 |
| Clinical documentation | History, allergies, medications, vitals, alerts, customizable templates, signed notes, addenda, attachments | Signing freezes note version; amendment identifies author/time/reason and retains original | P1 |
| Treatment planning | Alternative plans, phases, linked teeth/surfaces, estimates, benefits assumptions, consent, accepted/declined state | Revised fee/coverage creates a new estimate; consent stays attached to the version accepted | P1 |
| Procedures/encounters | Planned vs completed procedures, rendering provider, service date, linked encounter and code version | Completing an encounter cannot silently complete every planned procedure | P1 |
| Imaging/documents | Upload/import, originals, mounts, annotations, access controls, integrity, vendor bridge; DICOM where supported | Image is matched to verified patient; incorrect association is corrected with an audit trail | P1 import/bridge; acquisition expansion P2 |
| Insurance | Subscribers, dependents, effective-dated primary/secondary plans, benefits, eligibility provenance, preauthorization | Stale eligibility is visible; estimate never asserts coverage guarantee | P1 |
| Claims/RCM | Dental claim preparation, validation, attachments, submission adapter, acknowledgements, rejections, status, resubmission, appeals, ERA reconciliation and secondary claims | Duplicate acknowledgement/ERA never duplicates posting; rejected claim remains actionable | P1 with validated partner |
| Financial ledger | Balanced journal, charges, patient/insurer payments, adjustments, allocations, unapplied credit, refunds, voids, transfers, close/reopen policy | Charge+payment+partial refund reconcile to penny; correction reverses rather than edits posted history | P1 |
| Patient billing | Statements, payment links, tokenized cards through provider, receipts, payment plans and collections worklists | Retried payment request never charges twice; statement uses correct guarantor and cutoff | P1 |
| Prescribing | Medication review, partner adapter, prescriber identity, pharmacy, reconciliation, controlled-substance workflow where applicable | Submission requires authorized prescriber and partner requirements; no agent-only signature | Integration gate before a pilot depends on it |
| Communications | Secure portal messaging, optional SMS/email reminders, consent/opt-out, templates, delivery tracking, call references | A booking does not send an unexpected message; opt-out and quiet-hour policy are enforced | P1 |
| Recall and follow-up | Recall intervals, due history, already-booked exclusion, incomplete-treatment worklists, referrals | Recall list excludes booked care only under an explicit rule; worklist creation does not send outreach | P1 |
| Lab/referrals | Lab cases, due dates, attachments, specialist referral packages and returned records | Lab return is linked to correct case and appointment; cross-practice sharing is explicit | P1 basic; advanced P2 |
| Analytics | Production, collections, AR aging, scheduling, recall, treatment acceptance and new-patient cohorts | Every metric declares numerator/denominator, timezone, date basis, filters and freshness | P1 |
| Administration | Audit search, user lifecycle, permissions, access reviews, retention/legal holds, incident tools, export | Revoked user cannot call API/MCP, download cached export or continue a privileged job | P1 |
| Integrations | Versioned API, OAuth/service accounts, webhooks, MCP, import/export, vendor adapters | Same forbidden operation fails through UI, API, MCP and job worker | P1 |
| Specialty breadth | Ortho installments/progress, advanced surgery/endodontics, specialty templates, richer inventory/timekeeping | Separate clinical and workflow validation per specialty; no universal-parity claim | P2 |
| International | Country packs for terminology, tax, payers, prescribing, language and residency | US assumptions are not hardcoded into identity, currency or tooth numbering | P2 |

## A complete pilot day

1. Configure synthetic practice, users, working hours and resources.
2. Import synthetic patients and reconcile duplicates, guardians, balances and attachments.
3. Receive an appointment request; verify identity, availability and consent; book with explicit notification policy.
4. Check in, update medical history, chart findings/perio, create treatment alternatives and estimate.
5. Obtain consent; document only the care delivered; sign note; attach correctly matched images.
6. Post charges and payment allocation; prepare a validated claim; track acknowledgement and rejection/acceptance separately.
7. Process synthetic ERA/secondary responsibility; handle a reversal and a retry safely.
8. Schedule recall/referral/lab follow-up and deliver approved communications.
9. Reconcile daily financial totals, show-rate cohort and unresolved work.
10. Export the entire record, restore a backup, and revoke a user/device/agent while checking every access path.

Each step needs positive, unauthorized, duplicate, partial-failure, concurrent-edit and recovery cases. Staff validation must include reception, dentist, hygienist, billing and practice manager; one person's approval is not validation of every role.
