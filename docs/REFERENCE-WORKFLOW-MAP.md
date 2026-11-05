# Authenticated reference PMS surface map

Status: first instrumented pass, 2026-11-03 evening ET. Read-only production observation. No record was created, changed, saved or exported. No patient names, identifiers, balances or notes are recorded here; only structure, labels and field inventories.

## How this was obtained

A dedicated Chrome 156 profile (a dedicated local path outside cloud sync) was launched with a loopback DevTools endpoint on `127.0.0.1:9222`. The user signed in normally in that window; no cookies, credentials or profile data were copied from any other browser.

Two independent tools then attached to the **same** CDP target (`5027A82368DFBD50B40C64C393D4F241`, origin the authenticated reference PMS):

| Tool | Evidence | Proves |
|---|---|---|
| REA 6.8.0 | `ev_f7e86f7130b4ba4f7b5b77d595ffef531a8f16ea35276bee0378f9087e2068d4` | target list, unauthenticated `/v2/login` |
| REA 6.8.0 | `ev_402fbaf307da290938eca1c5fdf178c1cd390efd5641e853570f10e24e23a5be` | login page inspection; storage 0 bytes |
| REA 6.8.0 | `ev_d9a9e6f22018e3c3f7b75203c509102dc565f82f298e8d57fae71665c8b1c985` | same target after sign-in, URL `/dashboard` |
| REA 6.8.0 | `ev_5f367702bf169879c29d9ac42a5dd5274096d1ad818db7dfbba6c2afbbc24392` | authenticated dashboard, 1611 DOM nodes |
| Craft 0.3.0 | `ev_8c443bf49520434438dd32bd83d73e596e3cccdc76d9caa6030e8fc62066cd72` | authenticated `/reports/patient` screenshot |

Surface enumeration after that used targeted scripted queries rather than bulk DOM capture. Those queries are **not** themselves retained evidence; they are navigation aids whose results are reproduced below and must be re-confirmed against the live UI before being treated as durable.

## Application shape

Angular single-page application. Root element `PMS-ROOT`, Material components throughout, `shared-ui-button` wrappers around real `button` elements — query the inner button, not the wrapper.

JavaScript payload is large and unsplit by source map: `main` 6.28 MB, vendor chunk `353` 13.9 MB, chunk `99` 2.24 MB, `scripts` 391 KB, `487` 31 KB. No source maps are declared, so static bundle analysis is the only code-level route and will be expensive.

## Primary routes

| Route | Screen | Verification |
|---|---|---|
| `/dashboard` | Daily Huddle | seen in scripted pass — not retained |
| `/scheduler/c` | Scheduler | seen in scripted pass — not retained |
| `/payment-plan` | Payment Plan Management | seen in scripted pass — not retained |
| `/claims` | Claims Management | seen in scripted pass — not retained |
| `/claims/my-appeals` | Appeal Assigned | seen in scripted pass — not retained |
| `/activity-audit` | Activity Audit | seen in scripted pass — not retained |
| `/reports/production` | Reports hub (Production) | seen in scripted pass — not retained |
| `/reports/patient` | Patient report catalog | seen in scripted pass — not retained |
| `/reports/kpi-dashboard/production` | KPI Dashboard | seen in scripted pass — not retained |
| `/reports/revenue-discovery` | Revenue Discovery Dashboard | seen in scripted pass — not retained |
| `/settings/clinic` | Clinic Setup | seen in scripted pass — not retained |
| `/insurance/carriers` | Insurance Setup | seen in scripted pass — not retained |
| `/template-setup/note-templates` | Templates Setup | seen in scripted pass — not retained |
| `/hellopatient/profile-settings` | HelloPatient Setup | seen in scripted pass — not retained |

## Overlay screens

These open over the huddle and **do not change the URL**. A URL-based crawler cannot find or distinguish them, and automation must close the overlay before touching the page behind it.

| Menu path | Screen | Distinguishing columns |
|---|---|---|
| Claims → Claim History | Claim History | Is Pre Auth, Pri/Sec, Sent, ADA |
| Statements & Bulk check → Billing Statements | Billing Statements | Patient Billing Status, Statement Type, Date Of Service, Payment Plan, Next Installment Due Date |
| Statements & Bulk check → Bulk check | Bulk Check | Source, Type, Payor, Amount, Balance, Check #, Note |
| More → Referral Source List | Referral Source List | Program, Specialty, Address, City, Phone |
| More → Specialty Referrals | Specialty Referrals | Referral Type, Description, Notes |
| Toolbar → Advanced Patient Search | Advanced Patient Search dialog | — |

## Menu inventory

- **Reports**: Reports, KPI Dashboard, Revenue Discovery, TIP
- **Claims**: Claim Management, Claim Assigned, Appeals Assigned, Claim History, Claim Assignment Summary
- **Statements & Bulk check**: Billing Statements, Bulk Check
- **Settings**: Clinic, HelloPatient, Insurance, Progress Notes
- **More**: Activity Audit, Imaging Studio, Time Keeper, Referral Source List, Specialty Referrals, Google Drive, Patient Announcement

## Field inventories

**Daily Huddle** — tabs carry live counters (Scheduled, In Office, Finished, Deferred). Filters: Select Provider, Select Operatory, Select Date. Columns: Time, Location, Name, DOB, Contact, Status, Insurance, Chart.

**Clinic Setup** — sections `Clinic Information` and `Clinic Locations`. Identity fields: Practice Name, Short Name, Timezone, Claim Entity Name. Location fields: Address Line 1/2, City, State, Zip Code, Phone, Last Four (SSN/TIN fragment). Locations table: Location, Address, Type, Operatories, Staff, Active. Actions: Add Branch Location, Save, Disable.

**Insurance Setup** — carriers table: Name, Address, Phone, Status, No Claim, Payer ID, #Plans. Filters: Status, Search Carriers, Filter By Payer Id.

**Templates Setup** — note templates table: Type, Label, CDT Codes, Enforced, Template. Filter: Search Template. This is the progress-note template surface, and `Enforced` implies a per-template requirement flag.

**Claims Management** — filters: Date Type, Service Date, Billing Entity, Treating Provider, Provider, Fee Amount, Insurance Carrier, Insurance Plan, Service Code / Patient Name, Claim Review Group, Claim Reviewer, Sort By. Columns: Insurance Carrier, Billing, Treating, First/Last Name, Completed, Appointment, Service, Fees, Claim Fees, Ins., Status. Actions: Search, Export to CSV, EOB & Docs, Claim.

**Appeal Assigned** — same filter set as Claims Management minus review-group/reviewer.

**Activity Audit** — tabs `Activity Audit Search` and `Historical Activity`. Required fields Type and Record; also Select Date and By. Columns: Date, User, Summary.

**Reports hub** — period scopes Daily, Weekly, Monthly, Quarterly, Yearly. Production report list observed (titles only): Production, Production By Claim Fee, Production By Patient, Production By Procedure, Production By Treatment, Aggregate, Aggregate By Day, Net Production, Adjustment, Aggregate By Month, Aggregate By Quarter, Net Production By Month, Net Production By Quarter, Adjustment By Month.

**KPI Dashboard** — sections: Goals (MTD, YTD), Trailing, KPI Metric, Data Analysis, Breakdown (Treatment Categories), Breakdown (User Defined Groups), Breakdown (Providers - Claims), Breakdown (Providers - Tag).

**HelloPatient Setup** — sections `Call/Text Settings` and `Profile Settings`; Call Forwarding Number field. A dedicated setup screen exists; whether HelloPatient is core or a subscription add-on was not established, and a separate subscription endpoint was observed.

**Patient report catalog** — categories Production, Collection, Patient, Accounting, Other, Migration, Custom. Patient reports observed include New Patient, Patient Referral, Patient List, Patient Billing Status, Patient Insurance, Patient Treatment (plus Ortho and Referral variants), Patient Recall Due, Patient Recall Projection (marked Deprecated Soon in the vendor UI), Patient Recall History, Patient Notes, Active/Inactive Patient, Patient Without Insurance, Patient Xray, Patient Statement, Form Submission Report, Incomplete TX, Walkout Receipt, Patient Incomplete Treatment.

A report labeled "Deprecated Soon" left visible in the catalog is a useful reminder that the incumbent itself carries schema/feature debt we should not copy.

## Derived requirements

These are our requirements, inferred from structure. They are not claims about vendor internals.

1. **Overlays must be modelled as first-class routes.** Claim history, statements, bulk check and referrals are reachable states with no URL. Our API and UI should give every workflow screen an addressable route so linking, deep-linking, back/forward and support all work.
2. **Reporting is period-scoped and date-basis-scoped.** The UI separates date type from date and offers five period grains. Report APIs need explicit date basis, filters and freshness in the response, not just rows.
3. **Financial surfaces separate four facts.** Bulk check (deposit/batch), statement (billing artifact), payment plan (installment contract) and claim (payer expectation) are distinct screens. They must be distinct entities with their own lifecycles, linked by allocation — not one "payment" table.
4. **Insurance is carrier → plan → patient coverage.** Carrier carries Payer ID, status and a "No Claim" flag; plans count per carrier. Eligibility is recorded as unobserved: the pass found no eligibility control, route or endpoint.
5. **Note templates are configurable, with enforcement.** `Type`, `Label`, `CDT Codes`, `Enforced` implies template-driven note structure where the CDT association and requirement flag are configuration, not code.
6. **Auditing is record-typed and searchable by actor and record.** `Type` and `Record` are required. That implies an audit model keyed by entity type plus entity id, searchable by actor and date — which is exactly what a replacement must expose.

## Boundaries and unknowns

- Not established: appointment create/edit persistence or conflict behavior; ledger/payment posting; claim submission and ERA lifecycles; role and permission enforcement; export completeness; network/API contract shape.
- Transaction semantics require an authorized sandbox, not production.
- The vendor's `pms-feature-*` element names and Angular component IDs are implementation details and must not be treated as a spec.






