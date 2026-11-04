# Assurance and certification requirements

Date: 2026-11-03. Status: proposed assurance targets and original engineering requirements, not certification, audit completion or a complete clause-by-clause standards mapping. This targeted requirements addition does not reopen broad incumbent research. No purchases, auditor engagement or product implementation are authorized here.

## Recommended scope and priorities

Target ISO/IEC 27001:2022 for the organization's information security management system (ISMS) and ISO/IEC 42001:2023 for its AI management system (AIMS). Integrate their governance and evidence work while keeping each standard's scope and requirements explicit. ISO describes these as organizational management systems; source availability does not itself establish or prevent conformity. Obtain properly licensed standards, including applicable amendments, and qualified gap review before claiming a complete mapping. ISO itself does not issue certificates. [ISO 27001](https://www.iso.org/standard/27001), [ISO 42001](https://www.iso.org/standard/42001), [ISO certification](https://committee.iso.org/certification.html).

| Target | Proposed priority and purpose | Boundary |
|---|---|---|
| ISO/IEC 27001:2022 | First security certification target; build the ISMS alongside engineering | Covers the certified organization's defined scope, not all deployments or a guarantee of no breaches |
| ISO/IEC 42001:2023 | Design AI governance now; certify when the in-scope AI lifecycle is operating and evidenced | Does not certify individual model accuracy, clinical effectiveness or medical-device authorization |
| SOC 2 Type 2 | Consider for managed-service procurement demand; reuse evidence where applicable | CPA attestation report over a specified period, not an ISO certificate or automatic assurance for self-hosters |
| ISO/IEC 27701:2025 | Later privacy-management target if justified by service scope and customers | Review the current 2025 PIMS requirements rather than assuming the older edition's structure |
| HITRUST | Later healthcare buyer-driven assessment; select scope/type with assessor and buyer | Do not assume the least expensive assessment fits a clinical platform or promise every certification at launch |
| HIPAA obligations | Applicable production requirement, independent of voluntary certificates | HHS does not recognize private Security Rule certifications as proof of compliance |
| Medical-device and transaction qualifications | Assess when intended use/integration requires them | ISO management-system certificates do not replace FDA analysis, payer enrollment, prescribing or device/clearinghouse qualification |

Sources: [AICPA SOC 2 report review](https://assets.ctfassets.net/rb9cdnjh59cm/3xbcLlNc5rd72So4nQpNIk/7a3e8e5945c78c35fc5e116859b96e6a/SOC_2_Report_%C3%82_Review_Checklist.pdf), [ISO 27701:2025](https://www.iso.org/standard/27701), [HITRUST assessment options](https://hitrustalliance.net/assessments-and-certifications), [HHS certification FAQ](https://www.hhs.gov/hipaa/for-professionals/faq/are-we-required-to-certify-our-organizations-compliance-with-the-standards/index.html). Priorities are our recommendation, not a finding that these credentials are unique in dentistry.

## Open-source and certification boundary

The legal entity accountable for the management systems must be identified. Proposed certification scope to discuss with the auditor: development, release, maintenance and support of CuspAtlas, plus managed operation only if we actually provide it, and the AI systems/services we develop, provide or use within that scope. Document locations, personnel, suppliers, assets and exclusions. A founder's personal training certificate is not organizational certification.

Keep source, essential security controls, AI approval mechanisms, API/MCP, export and self-hosting open under existing licensing. Publish original control descriptions, architecture, synthetic tests, SBOMs, signed releases, security advisories and safe assurance summaries. Maintain sensitive audit evidence, personnel/training records, contracts, vulnerabilities and customer data in restricted systems. Open source does not mean public production logs or public audit workpapers. Do not redistribute paid standards, licensed controls or restricted reports in Git.

Community contributions undergo the same review and release controls; no unsigned or unreviewed plugin gains clinical privileges. Document contribution provenance, dependency licenses, supported versions, patch policy and vulnerability reporting. Certify the defined operating scope; forks and independent self-hosters do not inherit our certificate. Supply them with deployment controls and a responsibility matrix identifying their access, backup, patching, monitoring and incident obligations.

## Software requirements and evidence contracts

The following are project requirements supporting assurance, not a claim that each is prescribed verbatim by an ISO clause. Owners are roles to assign, not evidence of staffing. All rows remain planned.

| ID | Requirement | Workstream / owner | Required proof |
|---|---|---|---|
| AS-01 | Maintain traceability from control objective/risk to requirement, implementation, test, release and evidence | F/A/R; security owner | A manifest identifies control ID, owner, scope, artifact version/digest, test time, result and review/expiry; stale/missing evidence never passes |
| AS-02 | MFA, least privilege, current membership, revocation and scoped agents across every surface | F/A; security owner | Cross-tenant/role/revocation tests; recurring access review and termination records |
| AS-03 | Protected successful-change and independent denial audit; privacy-safe diagnostics | F/A; engineering | Rollback, audit-sink outage, secret/PHI-marker exclusion and access-separation tests under runtime credentials |
| AS-04 | Approved changes, reproducible dependency inventory, SBOM/provenance, signed releases and vulnerability remediation | F/R; release owner | Release bound to reviewed commit and passing checks; tampered/unsupported artifacts rejected; tracked remediation with owner and deadline |
| AS-05 | Data inventory, classification, configurable retention/legal holds, export/deletion and key/secret lifecycle | I/M/E; privacy and operations | Scoped deletion/export tests, backup-retention handling, rotation drill and documented legal-hold precedence |
| AS-06 | Recovery, incident detection, escalation and service continuity | F/M/R; operations | Timed restore/downtime drills and incident exercises; failed controls create tracked corrective actions |
| AS-07 | Register each AI use case, intended/prohibited use, affected people, owner, model/provider and risk/impact assessment | A; AI governance owner + clinical reviewer | Unregistered/unapproved use cases cannot be enabled; assessment revision linked to release |
| AS-08 | Version models/prompts/retrieval and data provenance/rights; enforce supplier and egress policy | A/I; AI governance + privacy | Provider change triggers reevaluation; unapproved destinations blocked; dataset/source access and retention enforced |
| AS-09 | Evaluate factual support, omissions, harmful outputs, misuse, prompt injection and relevant subgroup performance | A/C/B; AI and domain reviewers | Versioned synthetic/authorized evaluation set, justified thresholds, limitations, reviewer sign-off and regression blocking; small samples labeled insufficient |
| AS-10 | Human oversight, source-linked drafts, high-impact approvals, feedback/contestability and AI disable controls | A/C/B/E; domain owners | Agent cannot self-approve/sign; staff can reject/correct output and report an issue; disable/outage leaves ordinary workflows usable |
| AS-11 | Monitor AI quality, incidents, drift and provider/model changes with budget and scope limits | A/R; AI governance | Deliberate regression triggers alert and suspension/rollback; preserve approved version and review disposition |
| AS-12 | Deployments declare versions, security configuration, responsibility boundaries and assurance scope | M/R; operator | Configuration checks distinguish supported from unverified deployment; certificate claims never inherit automatically |

AI evaluations must use clinically appropriate cases and authorized data. Synthetic tests alone do not establish clinical validity or population fairness. Do not gather protected characteristics or retain patient prompts merely to fill an assurance dashboard. Data collection needs a justified purpose and reviewed privacy basis.

Evidence export is an authorized business operation through the same policy layer as UI/API/MCP: bounded scope, safe metadata, audit and protected delivery. Raw patient records, secrets and private model reasoning are excluded by default. A signed manifest proves integrity, not that a control was effective; preserve reviewer and test context.

## Organizational requirements that code cannot satisfy

Assign executive accountability and security, privacy, AI-governance, clinical, release and operations responsibilities. Define management-system scope, interested parties, objectives, risk criteria, treatment decisions and applicable control selection/Statement of Applicability. Document AI impact assessments, supplier due diligence, competence/training, incident and complaint handling, change control, internal audit, management review, corrective action and ongoing improvement. Keep evidence of these processes actually operating, not only template policies.

Use a qualified independent certification body with appropriate accredited scope; verify the actual accreditation and certificate scope rather than relying on a badge. Plan a gap assessment, internal audit, management review, Stage 1/Stage 2 audits, correction of nonconformities and subsequent surveillance/recertification under the selected scheme. [BSI certification process overview](https://www.bsigroup.com/globalassets/localfiles/en-th/webinars/document/material/webinar-ai-management-system-iso-iec42001-r2.pdf), [ANAB AI accreditation](https://anab.ansi.org/industry/artificial-intelligence/).

For SOC 2, engage a qualified CPA firm and agree system boundaries, trust-services categories, period and evidence; do not invent a universal minimum period. For every program obtain a scoped quote including standards, gap work, staff effort, assessor/audit fees, remediation, surveillance and renewals. Cost and completion dates remain unknown; no certification purchase is authorized.

## Delivery integration and claims gates

1. **Foundation after build authorization:** implement AS-01 through AS-04 evidence hooks and synthetic failure tests, including manifest tampering, stale evidence, forged reviewer, cross-tenant access and accidental sensitive export. Record control owners and open evidence in a registry. Do not build an unrelated governance SaaS; existing controlled organizational tools may hold governance records.
2. **Domain and AI workstreams:** implement remaining controls with each module. Before enabling an AI use case, require its use-case record, impact/risk review, approved provider/data policy, evaluation, human-oversight design and disable procedure. Reassess material changes.
3. **Operating program:** assign accountable entity/roles and run the management systems with real organizational evidence. Contract and professional review remain distinct from synthetic development tests.
4. **Independent assessment:** pursue 27001 and 42001 within confirmed scopes when evidence supports audit. SOC 2/27701/HITRUST remain conditional business decisions, not automatic blockers to the first synthetic build.
5. **Public claims:** a claim of certification requires valid certificate, named entity, standard edition, scope, issuer, dates and verification. Never imply that ISO certifies us, that the source repository is certified, or that certification validates clinical decisions. Track expiry, scope changes and suspension; remove stale claims. No ISO logo use without applicable permission; follow the issuer's mark rules.

Product safety/privacy controls remain release requirements whether or not voluntary certification has been purchased. A certificate becomes a release/procurement gate only when explicitly committed for that scope. No voluntary credential replaces the existing PHI, clinical, hardware, claims, recovery or legal release gates. UI remains deferred.
