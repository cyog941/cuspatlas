# Research ledger and evidence limits

Research date: 2026-11-03. No patient records or credentials are included here. Raw captures, both public-page and authenticated, are retained locally under ignored `.research-local/`; the repository contains original requirements and summaries only.

## Direct live observations

Authenticated Tab32 via the user's in-app browser: Daily Huddle states and provider/operatory filters; labeled module navigation; empty New Appointment form; Production and Patient report catalogs. The form includes appointment details, insurance/forms/lab/history tabs, resource assignment, duration, recurrence, linked treatment and an email/text notification checkbox checked by default. Save was disabled and nothing was saved. Report catalogs were inspected without generating or exporting patient results.

Derived requirement: expose explicit communication policy in booking APIs; keep request, booking, attendance, procedures and money separate; make date basis and filter state visible in reporting. These are our requirements, not proof of the incumbent's backend behavior.

The user also supplied a private `tab32-operations` skill with workflow references, dated 2026-10-27. It maps patient/visit identity, financial allocations, appointment requests, scheduling and reporting, with clear untested areas. It was read with explicit user authorization. Its private file paths and clinic-specific identifiers are intentionally omitted from this public repository. Historical guidance was not represented as fresh verification of clinical, claims or payment transactions.

## REA and Craft Anything runs

| Tool | Actual action and evidence | What it proves | What it does not prove |
|---|---|---|---|
| REA 6.8.0 | Bounded headless Edge scenario on the public feature page; accessibility and URL capture; evidence `ev_92e00cf183483986ca712ef1c6f56d9b4583bbfe68ac8c109a1bd3b735e882ff` | Public page was observed; scenario completed with browser cleanup | Authenticated product behavior, private APIs, schema, clinical correctness |
| Craft Anything 0.3.0 | Public-page walkthrough after explicit user authorization for per-run Deep mode; network capture disabled; evidence `ev_1fc9ce6c10382e2703066232932932a27f640de9469a855b3dc44134cd9db312` | One successful navigation and public accessibility snapshot; browser closed | Equivalent implementation, authenticated access, full feature validation |

Craft initially refused the walkthrough in Clean room mode. The user then authorized it; only this run used Deep mode. No global mode change, patient session transfer, private script extraction, form submission or target mutation was performed. At the time of this run the tools had no established attachment to the authenticated in-app browser: no supported CDP endpoint was exposed/discovered. That limitation is distinct from permissions and from successful public-page execution, and it was resolved later the same day by the pass recorded below.

Public page observed: [Tab32 all-in-one platform](https://tab32.com/dental-practice-management-all-in-one/). It groups scheduling/engagement, clinical/imaging, billing, specialty and analytics capabilities, and advertises REST APIs and an on-demand MCP service. Those are vendor claims. This evidence informs scope and prevents claiming MCP itself as a unique advantage; it is not a parity test or contractual API-access verification.

## Authenticated instrumented pass, 2026-11-03 evening ET

The first instrumented read of the authenticated product was completed on a new host. A dedicated Chrome profile outside any synced folder was launched with a loopback-only DevTools endpoint on `127.0.0.1:9222`. The user signed in normally in that window. No cookies, credentials or profile data were transferred from any other browser.

Five retained evidence records establish that this was tool-level capture of the signed-in application rather than a visual claim. The first two are the pre-authentication state, which is what makes the later captures meaningful.

| Tool | Evidence | Establishes |
|---|---|---|
| REA 6.8.0 | `ev_f7e86f7130b4ba4f7b5b77d595ffef531a8f16ea35276bee0378f9087e2068d4` | target list while the page was still at `/v2/login` |
| REA 6.8.0 | `ev_402fbaf307da290938eca1c5fdf178c1cd390efd5641e853570f10e24e23a5be` | login-page inspection; no stored session data (storage 0 bytes) |
| REA 6.8.0 | `ev_d9a9e6f22018e3c3f7b75203c509102dc565f82f298e8d57fae71665c8b1c985` | the same DevTools target after sign-in, resolved to `/dashboard` |
| REA 6.8.0 | `ev_5f367702bf169879c29d9ac42a5dd5274096d1ad818db7dfbba6c2afbbc24392` | authenticated dashboard inspection; 1,611 DOM nodes |
| Craft 0.3.0 | `ev_8c443bf49520434438dd32bd83d73e596e3cccdc76d9caa6030e8fc62066cd72` | authenticated reports catalog screenshot |

Surface enumeration after those captures used targeted scripted queries rather than bulk DOM capture. Those queries are navigation aids, not retained evidence; their results are reproduced in [TAB32-AUTHENTICATED-MAP.md](TAB32-AUTHENTICATED-MAP.md) and must be re-confirmed against the live UI before being treated as durable.

The pass was read-only. All 96 observed HTTP responses were `200`, so error behavior is unobserved: validation failures, permission denials, conflicts and rate limits must not be inferred, because no failing request was made. No transaction was executed; no record was created, edited, saved or exported, and the appointment dialog was opened and closed without saving. No patient data was published. The retained DOM record of the dashboard stores element names, attribute names and text lengths; its schema carries no node text values, and accessibility text was excluded by option. That is a property of the capture schema, not a redaction step, and the record has not been exported. The local `.research-local/` folder is gitignored but is not anonymous: it holds the authenticated account URL, the practice name and the clinic identifier, so it must be treated as private working data and reviewed before any sharing. Role and permission enforcement was not tested, nor was whether the server rejects a clinic id outside the session token's coverage — the negative cross-tenant case the readiness gates already require. A menu label, a selector value or an endpoint name does not establish behavior, and status values observed in a selector do not establish permitted transitions.

The same session produced four companion documents: the surface map, the HTTP conventions, the domain model and the state vocabularies. Their derived requirements are ours, inferred from observed structure, and are labeled as such there.

Entries elsewhere in this ledger that record direct authenticated attachment as blocked or unresolved were accurate when written and are superseded by this pass. The public-page evidence in the earlier tool-run table remains public-page evidence and must not be relabeled as authenticated product evidence.

## Architecture sources

- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): policies complement privileges; privileged/owner paths require special attention. Basis for independent isolation tests.
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html): relational integrity tools underpin proposed booking and ledger invariants.
- [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/): schema-based runtime contracts; do not accept arbitrary untrusted executable schemas.
- [Tauri security](https://tauri.app/security/) and [capabilities](https://tauri.app/security/capabilities/): native bridge needs explicit boundaries; Rust code and broad permissions can still compromise the host.
- [Open Dental imaging devices](https://www.opendental.com/manual/imagingdevices.html): driver-specific acquisition behavior supports requiring a real hardware matrix rather than assuming browser access to all sensors.
- [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting): production self-hosting differs from local development and has operator obligations.
- [Supabase HIPAA projects](https://supabase.com/docs/guides/platform/hipaa-projects), [HHS Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html), [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html): basis for deployment gates, not a compliance conclusion.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization): explicit protocol baseline consulted; refresh the supported revision when implementing.
- [ADA CDT](https://www.ada.org/publications/cdt): terminology/version governance is separate from making our code open source; resolve distribution licensing before bundling datasets.
- [OpenMolar](https://openmolar.com/om1): existing dental open source is useful prior art; its own site describes the project as mothballed. We are not forking or importing its code.

Supabase changelog reviewed 2026-11-03. Near-term notes include TLS cipher deprecation and timezone-data fixes. Record and test actual database/runtime versions at implementation; the created development project reports PostgreSQL 17.11.0.011, but application compatibility remains untested.

## Unresolved discovery before construction

### Authenticated follow-up, 2026-11-03

After a desktop restart, the Chrome connector successfully attached to the authenticated session and navigated to Payment Plan Management. The visible plan worklists distinguish collected, current/pending, open defaulted, missing signature, closed successfully, closed uncollected and void. Summary concepts include active-plan value, amounts due, collected and overdue. No plan was created or modified; the new-plan form contents were not verified. REA and Craft MCP servers are now available, but direct authenticated CDP attachment was still unestablished at the time of this entry and was established later the same day, as recorded above. The browser asset export supports fonts/images/stylesheets/video, not script export, so it is not a substitute for a runtime/code capture.

Read-only browser inspection additionally verified Clinic Setup navigation for Preferences, Colors, Access Control, User Account, Care Team, Scheduler, Lab, Payment Gateway, Custom Fields, Accounting and Statement configuration. Clinic settings expose separate claim and patient billing information, practice timezone and location/operatory/staff structure. No settings were saved.

The Access Control screen exposes resource categories and report-specific access entries, including ledger, receivables, payment distribution, undistributed payments and open claims. This establishes visible configuration surfaces only; backend permission enforcement and role isolation were not tested. Proposed acceptance requirement: test each sensitive operation independently across UI, API, MCP and exports, including undistributed funds and report access.

At the time of this entry, direct authenticated REA/Craft capture remained blocked: the available in-app browser capabilities expose page assets and WebMCP, not a CDP attachment endpoint. A bounded check of running Chrome, Edge, Electron and Codex process command lines found no advertised remote-debugging port or pipe. This does not establish absence of all possible endpoints. No credentials or browser profiles were copied. Finishing tool-based authenticated analysis required a supported debugging-enabled browser session with a user login; that requirement was met later the same day, as recorded above. The existing public-page tool evidence must not be represented as authenticated PMS evidence.

Further live inspection verified scheduler configuration sections for appointment types with name/code columns, operatory/provider groups, calendar and public-view modes, time-slot display templates, and checkout-triggered survey configuration. Their presence is observed; editing, notification dispatch and persistence are untested. These imply proposed requirements for procedure-linked appointment types, resource grouping, privacy-safe schedule displays and separately controlled communication triggers. Accounting navigation was attempted but the scheduler screen remained visible, so accounting configuration is not verified.

Additional read-only observation verified Claims navigation entries for management, assigned claims, assigned appeals, history and assignment summary. Management filters include date type/service date, billing entity, treating provider, insurer/plan, service-code/patient search, review group and reviewer. No claim was opened, submitted, assigned, edited or exported. Activity Audit provides action type, resource class, date range and actor filters plus a historical-activity tab. Resource choices include appointments, time blocks, clinic/configuration, coverage/insurance records, forms, notes, patients, statements, payment plans, treatment details, user accounts and X-rays. No audit search or restoration was executed. More-navigation also exposes Imaging Studio, Time Keeper, referral sources, specialty referrals, Google Drive and Patient Announcement; these are menu-level observations only.

Attempting to launch an isolated Edge analysis profile with a loopback debugging port was rejected by automatic execution policy before launch. No alternative launch mechanism was attempted from that host. Direct authenticated tool attachment therefore remained unresolved until the Chrome-profile pass recorded above; browser-observed workflow notes are a separate evidence source.

1. Staff-observed clinical chart/perio/note signing workflows using a demo or explicitly suitable test patient; no production writes for testing.
2. Payer/ERA/secondary claim exceptions and financial allocation lifecycle in a sandbox.
3. Lawful export/API availability, archival completeness and migration reconciliation samples.
4. Actual sensor/driver/OS, prescribing, clearinghouse, payment and communications requirements for a consenting pilot.
5. Practice staffing, support needs and baseline task times/costs. No market demand, savings or clinical claims have yet been validated.


