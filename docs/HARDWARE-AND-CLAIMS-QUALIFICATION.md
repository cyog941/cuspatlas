# Hardware and claims qualification

Date: 2026-11-03. Status: researched planning requirements, not implemented integrations, partner selection, certification or legal clearance. Public documentation was reviewed; no vendor was contacted, account purchased, driver installed or patient data transmitted.

## Decisions for architecture

1. Keep existing acquisition software for the first pilot. Qualify a supported patient-context bridge and image-return path. Launching the vendor application alone is not a complete bridge.
2. Offer safe import as a baseline; qualify TWAIN, vendor SDK or DICOM interfaces individually. No universal sensor promise, browser USB assumption or proprietary driver redistribution.
3. Qualify DentalXChange first for claims and attachments because public developer contracts exist. This is a research priority, not a procurement decision. Keep the adapter replaceable and evaluate an alternative before commitment.
4. Separate image originals, claim attachment renditions, claim versions, submissions, acknowledgements, payer decisions, remittances and ledger postings.
5. Partner access, costs, rights, production enrollment and validation remain explicit gates. Core development can proceed with synthetic adapters after build authorization; affected features and practice cutover cannot pass on mocks alone.

## Primary-source evidence

All vendor material below is vendor-documented, not independently tested. Regulatory sources establish research inputs; qualified review must determine applicability to our exact intended use and deployment.

| Source | Finding and implication |
|---|---|
| [Open Dental imaging devices](https://www.opendental.com/manual/imagingdevices.html) | Its implementation documents 32-bit TWAIN and driver-specific behavior. This supports testing bitness, orientation and acquisition sequences; it does not establish our compatibility. |
| [DEXIS conformance statements](https://dexis.com/en-au/conformance-statements) | Manufacturer conformance documents exist. Obtain the exact product/version statement; the presence of DICOM somewhere in a product family does not prove our required exchange works. |
| [DentalXChange Claim API](https://developer.dentalxchange.com/claim-api) | Documents validation, submission and status, including attachment-related checks. Some submissions may need ClaimConnect portal intervention. Qualify those exceptions and do not promise all cases remain inside our app. |
| [DentalXChange Attachment API reference](https://api.dentalxchange.com/docs/latest/attachment-api.pdf) | Documents creating, adding, removing, submitting and checking attachments. Confirm current API revision, account entitlements and supported payer routes during onboarding. |
| [Vyne payer connectivity](https://vynedental.com/payers/) and [eligibility API portal](https://developers.onederful.co/) | Alternative investigation candidate. Public eligibility documentation is not proof of available claims/attachment developer access or equivalent coverage. Request those contracts explicitly. |
| [CMS adopted standards](https://www.cms.gov/priorities/key-initiatives/burden-reduction/administrative-simplification/hipaa/adopted-standards-operating-rules) | Transaction standards include 837 claims, 270/271 eligibility and 835 remittance. Map the dental implementation and partner companion guides; a JSON API does not erase downstream obligations. |
| [CMS claims-attachments final rule](https://www.cms.gov/newsroom/fact-sheets/administrative-simplification-adoption-standards-health-care-claims-attachments-transactions) | CMS-0053-F adopts 6020 X12N 275/277 and HL7 attachment specifications with electronic-signature requirements. Effective May 26, 2026; compliance is 24 months later (May 26, 2028). Prior-authorization attachment standards were not finalized in this rule. Obtain the partner's transition plan and applicability review. |
| [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html) | Hosting ePHI requires applicable BAA arrangements and safeguards; encrypted storage alone does not remove a cloud provider's business-associate obligations. Pro development hosting is not production authorization. |
| [FDA MDDS guidance](https://www.fda.gov/medical-devices/general-hospital-devices-and-supplies/medical-device-data-systems) and [regulated software examples](https://www.fda.gov/medical-devices/device-software-functions-including-mobile-medical-applications/examples-device-software-functions-fda-regulates) | Limited transfer/storage functions differ from device control and diagnostic image processing. Review intended use before implementing acquisition, diagnostic viewing, measurement, enhancement or image AI. Do not claim the entire imaging module is exempt. |

## Hardware qualification record

Create one record per supported combination, not per brand. Actual pilot inventory is pending user input; nothing is currently certified.

Required fields: device model and modality; acquisition application/version; OS/build and architecture; driver/version/bitness; workstation scope; SDK/bridge/TWAIN/DICOM/export mechanism; license and redistribution rights; vendor support contact; patient-ID mapping; image-return mechanism; file/transfer formats; metadata and orientation; test evidence; support owner; fallback; known limitations; retest trigger.

| Path | Initial disposition | Gate |
|---|---|---|
| Existing acquisition app + documented bridge/export | Preferred pilot path | Stable patient mapping, verified return/import and vendor support terms |
| Manual authorized file import | Baseline and recovery path | Clinician confirms identity, fidelity and acceptable workflow; no claim of automated acquisition |
| TWAIN | Candidate per device | Driver rights, 32/64-bit compatibility, multi-image ordering and workstation tests |
| Vendor SDK | Later unless pilot needs it | SDK contract, supported OS/runtime, distribution rights and intended-use review |
| DICOM exchange | Candidate for qualifying products | Matching SOP classes, transfer syntaxes, roles and transport configuration tested end to end |

The companion receives short-lived, tenant/user/device-bound jobs from the authorized API. Enroll and revoke devices, sign updates and restrict allowed operations. Prefer outbound authenticated connections; any local endpoint requires origin/authentication controls and replay resistance. Isolate incompatible vendor runtimes in narrow adapters. Do not execute arbitrary paths or shell text supplied by a web page or model.

Patient binding uses explicit source-ID mappings and a confirmed acquisition context, never name alone. Ambiguous, late or mismatched images enter quarantine. Preserve original bytes and hashes; derivatives carry transformation provenance. Validate orientation, bit depth, metadata, mount order and clinical usability; an attachment JPEG does not replace a diagnostic original. Local temporary storage needs encryption, bounded retention, crash recovery and verified cleanup. Do not copy images into source repositories or telemetry.

Hardware acceptance pack: two patients with similar names; patient changed while acquisition runs; duplicate export; incorrect association correction; partial file; multi-image sequence; unsupported format; corrupt data; driver crash; disconnected sensor; WAN outage; reboot mid-upload; revoked workstation; malicious filename; unauthorized tenant; update/rollback. Test with synthetic or lawfully supplied non-patient fixtures and suitable test equipment, not new patient exposures for software testing. Clinician and device/IT owner sign off on the exact configuration.

## Clearinghouse qualification record

For each candidate capture: named business/technical owner; API version and licensed specifications; developer access; sandbox fixtures; partner acceptance process; BAA/subprocessors; supported self-hosted deployments; credential ownership; pricing/minimums/termination; payer and transaction matrix; provider/TIN/NPI/location enrollment; attachments; secondary claims; remittance; support/SLA; outage and exit arrangements. Pricing and commercial access are currently unknown.

Payer capability must be recorded separately for claims, eligibility, preauthorization, attachments, status and ERA. A payer appearing in one list does not establish every service. Confirm commercial and Medicaid routes needed by the pilot. Include enrollment lead times and portal-only exceptions. Never put account credentials or actual provider enrollment documents in Git.

Proposed internal adapter operations: validate claim, submit immutable claim version, query submission, create/upload/submit attachment package, query attachment, ingest acknowledgement, retrieve remittance and reconcile external outcome. Operation names are proposals, not working endpoints. Store provider-specific references behind the adapter and preserve normalized status plus the protected original response where retention permits.

Keep status dimensions separate:

- Claim: draft, validated, approved, superseded; linked correction/replacement versions.
- Submission: queued, in flight, received, rejected, unknown outcome; correlation and external control numbers.
- Payer processing: pending, accepted for processing, adjudicated/denied; retain events and reason provenance.
- Attachment: prepared, uploading, submitted, acknowledged/failed; separate payer-viewed evidence if available.
- Remittance and posting: received, matched, reviewed, posted/reversed; ERA is not proof that cash settled.

Persist submission intent with idempotency and payload digest before dispatch. After timeout, reconcile by stable provider reference before retrying; do not assume the vendor supports an idempotency header. Route unresolvable outcomes for staff review. Handle late, duplicated and out-of-order responses without overwriting newer state. Never enable a vendor's duplicate-override option as the default retry mechanism.

An attachment manifest binds patient, claim/version, service date, document version/hash, narrative approval, rendition settings and external attachment reference. Enforce partner file/type/size rules; fail visibly if documents are missing or mismatched. Support unsolicited packages and requests for additional information as distinct workflows when the qualified route permits them. Keep claim attachment signatures distinct from clinical-note signing. Do not silently reuse a package after material claim/document changes.

Claims acceptance pack: primary and secondary claims; dependent/subscriber mismatch; unsupported payer; missing enrollment; missing attachment; partial upload; incorrect package association; rejected/corrected claim; portal intervention; timeout after acceptance; duplicate/out-of-order acknowledgement; delayed status; duplicate ERA; reversal/adjustment; unmatched remittance; provider outage and credential revocation. Billing staff must reconcile expected results to the ledger using sandbox fixtures. Partner acceptance and enrollment evidence are required beyond our tests.

## Regulatory and commercial gates

Assign a privacy/security owner and qualified regulatory/legal reviewer; these roles are not staffed by naming them here. Review each data flow and deployment responsibility, BAAs, risk analysis, access/retention, incident response, state requirements and vendor agreements. Track applicable X12/CDT/other content licenses without redistributing licensed guides or terminology in the open repository. Confirm whether our exact operating model introduces clearinghouse or other additional responsibilities; do not assume a vendor API contract resolves classification.

Record the 2028 attachment transition with owner, applicability decision, vendor readiness milestones, test version and release deadline. Recheck standards and effective dates before implementation and production release. Do not conflate the claims-attachment rule with all prior authorization or prescribing requirements.

Free core software does not imply free vendor networks, drivers or SDKs. Keep proprietary vendor binaries separately installed when required and avoid placing essential core functions behind our own feature keys. An unsupported device or unqualified payer route is a visible limitation and a pilot cutover blocker if the practice depends on it.

## Execution backlog and stop conditions

| ID | Next deliverable | Responsible role / dependency | Completion evidence |
|---|---|---|---|
| H1 | Pilot hardware inventory | Practice + IT; exact products needed | Completed combination records |
| H2 | Interface/rights assessment | Integration engineer + vendor | Written supported interface, terms, fallback and intended-use review |
| H3 | Synthetic bridge specification | Engineer + clinician; H1/H2 | Input/output contracts, identity handling and acceptance pack |
| H4 | Real configuration qualification after build authorization | Engineer + IT + clinician | Reproducible device tests, support matrix and signed review |
| C1 | Vendor questions and comparison | Product + billing | Written answers to the qualification record; cost/access comparison |
| C2 | Partner and pilot payer qualification | Product/legal + billing | Contract, sandbox, payer matrix and enrollment plan |
| C3 | Adapter/attachment state contracts | Engineer + billing; C2 | Reviewed schemas, transition rules and synthetic expected outcomes |
| C4 | Sandbox and production enablement after build authorization | Engineer + partner + billing | Round-trip tests, partner acceptance, enrollment and reconciled results |
| R1 | Responsibility/intended-use/standards review | Security + qualified reviewer | Scope decisions, assigned controls and dated transition plan |

H1/H2 and C1/C2 are the next external information gates. Research can stop when supported interfaces, rights, dependencies and testable contracts are established; browsing cannot substitute for vendor answers or hardware tests. No claimed completion until evidence is attached. Each role needs a named assignee before execution.

### Vendor inquiry drafts (not sent)

Hardware: Can you provide the supported PMS integration interface for the specified model/application/OS versions, patient-context and image-return contracts, test fixtures, SDK/driver distribution terms, diagnostic intended-use constraints, update policy and escalation support? Does it work for both self-hosted and managed PMS deployments?

Clearinghouse: Can an open-source PMS use your claims, attachments, status and remittance APIs in managed and self-hosted deployments? Please provide sandbox/onboarding requirements, API and companion guides, pilot payer/service coverage, enrollment, primary/secondary and correction workflows, portal-only exceptions, retry/reconciliation mechanisms, attachment limits/linkage, 2028 standards transition, BAA/subprocessors, fees/minimums, data-export/termination terms and production acceptance criteria.
