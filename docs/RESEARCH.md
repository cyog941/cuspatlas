# Research ledger and evidence limits

Research date: 2026-11-03. No patient records or credentials are included here. Raw public-page captures are retained locally under ignored `.research-local/`; the repository contains original requirements and summaries only.

## Direct live observations

Authenticated Tab32 via the user's in-app browser: Daily Huddle states and provider/operatory filters; labeled module navigation; empty New Appointment form; Production and Patient report catalogs. The form includes appointment details, insurance/forms/lab/history tabs, resource assignment, duration, recurrence, linked treatment and an email/text notification checkbox checked by default. Save was disabled and nothing was saved. Report catalogs were inspected without generating or exporting patient results.

Derived requirement: expose explicit communication policy in booking APIs; keep request, booking, attendance, procedures and money separate; make date basis and filter state visible in reporting. These are our requirements, not proof of the incumbent's backend behavior.

The user also supplied a private `tab32-operations` skill with workflow references, dated 2026-10-27. It maps patient/visit identity, financial allocations, appointment requests, scheduling and reporting, with clear untested areas. It was read with explicit user authorization. Its private file paths and clinic-specific identifiers are intentionally omitted from this public repository. Historical guidance was not represented as fresh verification of clinical, claims or payment transactions.

## REA and Craft Anything runs

| Tool | Actual action and evidence | What it proves | What it does not prove |
|---|---|---|---|
| REA 6.8.0 | Bounded headless Edge scenario on the public feature page; accessibility and URL capture; evidence `ev_92e00cf183483986ca712ef1c6f56d9b4583bbfe68ac8c109a1bd3b735e882ff` | Public page was observed; scenario completed with browser cleanup | Authenticated product behavior, private APIs, schema, clinical correctness |
| Craft Anything 0.3.0 | Public-page walkthrough after explicit user authorization for per-run Deep mode; network capture disabled; evidence `ev_1fc9ce6c10382e2703066232932932a27f640de9469a855b3dc44134cd9db312` | One successful navigation and public accessibility snapshot; browser closed | Equivalent implementation, authenticated access, full feature validation |

Craft initially refused the walkthrough in Clean room mode. The user then authorized it; only this run used Deep mode. No global mode change, patient session transfer, private script extraction, form submission or target mutation was performed. The tools have no established attachment to the authenticated in-app browser: no supported CDP endpoint was exposed/discovered. That limitation is distinct from permissions and from successful public-page execution.

Public page observed: [Tab32 all-in-one platform](https://tab32.com/dental-practice-management-all-in-one/). It groups scheduling/engagement, clinical/imaging, billing, specialty and analytics capabilities, and advertises REST APIs and an on-demand MCP service. Those are vendor claims. This evidence informs scope and prevents claiming MCP itself as a unique advantage; it is not a parity test or contractual API-access verification.

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

Supabase changelog reviewed 2026-11-03. Near-term notes include TLS cipher deprecation and timezone-data fixes. Record and test actual database/runtime versions at implementation; no version compatibility is claimed for an uncreated project.

## Unresolved discovery before construction

1. Staff-observed clinical chart/perio/note signing workflows using a demo or explicitly suitable test patient; no production writes for testing.
2. Payer/ERA/secondary claim exceptions and financial allocation lifecycle in a sandbox.
3. Lawful export/API availability, archival completeness and migration reconciliation samples.
4. Actual sensor/driver/OS, prescribing, clearinghouse, payment and communications requirements for a consenting pilot.
5. Practice staffing, support needs and baseline task times/costs. No market demand, savings or clinical claims have yet been validated.
