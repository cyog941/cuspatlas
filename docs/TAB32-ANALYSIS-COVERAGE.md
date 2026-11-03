# Tab32 analysis coverage

Status: incomplete. This ledger distinguishes visible workflow inspection from instrumented analysis and from behavioral verification. No production transactions are permitted merely to test behavior. UI design and product implementation remain deferred.

| Area | Current evidence | What remains |
|---|---|---|
| Daily workflow | Authenticated huddle states and provider/operatory filters observed | Transition rules, recovery and role-specific differences |
| Appointment entry | Empty form inspected: resources, duration, recurrence, status/type, treatment and notification controls | Saved conflict behavior, recurrence exceptions and rescheduling history in a sandbox |
| Clinic administration | Setup categories, location structure, timezone and billing identities observed | Detailed configuration lifecycle and effective permissions |
| Scheduling setup | Appointment type/code association, groups, public-view mode and survey triggers observed | Constraint semantics and consent-trigger tests |
| Claims | Management filters and assignment/appeal/history navigation observed | Submission, rejection, correction, ERA and secondary-claim lifecycles in a sandbox |
| Payment plans | Pending, defaulted, missing-signature, completed, uncollected and void worklists observed | Plan creation, authorization, failed installments, retries and allocation |
| Statements | Carrier/type/billing-status filters and statement/service-date/installment/print/freshness columns observed; CSV and bulk-print controls present | Generation cutoff, balance snapshot, stale statement handling and delivery semantics |
| Audit | Actor/date/action/resource filters and historical view observed | Completeness, retention, tamper resistance and privileged-access audit |
| Clinical chart/perio | Historical skill references and proposed requirements only | Synthetic patient walkthrough and clinician validation |
| Notes/treatment | Proposed requirements; appointment-related tabs observed | Draft, sign, amend, alternate plan and consent lifecycle |
| Images/device bridge | Imaging Studio menu observed; public claims | Patient matching, mount/import, annotation and actual hardware compatibility |
| Prescribing | Proposed integration gate | Partner, roles, identity and prescription workflow |
| Migration/export | Proposed requirements | Vendor-approved export sample, completeness and reconciliation |
| Security/API/MCP | Proposed architecture; vendor public API/MCP claims | Actual contracts, scopes, enforcement and failure behavior |

## Tool connection status

REA and Craft Anything MCP servers are available after restart. Their earlier captures cover the public marketing page only. Chrome browser-control access is working again. The installed analysis tools require a loopback Chrome DevTools Protocol endpoint for an existing authenticated page; the current Chrome launch does not advertise one. The browser-control extension is a different connection and is not automatically a CDP endpoint for these tools.

Automatic execution review previously rejected launching a separate debugging-enabled profile. Specific approval of the isolated profile setup has now been requested. Do not retry that action without resolving the approval boundary. Do not transfer browser cookies, saved credentials, patient data or private artifacts into the public repository.

## Evidence acceptance

1. Tool attachment: both tools identify the same authenticated target through their own supported interfaces.
2. Safe capture: bounded data-minimized captures, credential/body capture disabled, with evidence IDs and stated coverage.
3. Workflow coverage: record each domain as observed, partially observed or untested; never infer transaction semantics from a menu label.
4. Specification traceability: map observations to original requirements and distinguish proposed improvements.
5. Plan traceability: include synthetic tests for the observed states and failure cases before implementation approval.
6. Closure: verify no accidental production changes and preserve no patient data in published artifacts.

The user authorized a clearly synthetic demo patient if necessary. No such record has been created. Never relabel an existing real patient. Before creating a demo, inspect whether contact fields and notification enrollment can remain empty/disabled; do not invent reachable contact information or post clinical/financial events merely to populate a demo.
