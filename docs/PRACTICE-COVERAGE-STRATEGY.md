# Broad practice compatibility strategy

Date: 2026-11-03. User-directed target: suitability for at least 90% of practices. Working denominator is US general-dentistry practice locations, consistent with the launch scope; international practices and specialties need separate assessments. Status: target and proposed research program, not measured coverage. No installed-base dataset or tested integrations currently establishes 90% suitability.

## Architecture for breadth

Do not make the product depend on a single pilot's equipment. Build the compatibility design around imaging ecosystems and supported interfaces, while qualifying exact configurations before production support. One imaging application may support multiple sensor brands; those combinations must still be verified. Preserve existing acquisition and diagnostic software where lawful and operationally viable rather than requiring every practice to replace hardware.

Support four paths: documented patient-context bridges with image return; standards-based exchange where qualified; optional direct acquisition adapters where justified; explicit manual import for limited fallback. A launch-only bridge and manual export are not equivalent to integrated acquisition. Published support levels must distinguish context launch, image return, historical access, acquisition and diagnostic viewing.

Keep a versioned adapter capability registry with OS/application/driver versions, modalities, interface rights, bidirectional behavior, known limitations, evidence, owner and retest policy. Isolate vendor SDK/runtime dependencies behind the local companion; do not embed one vendor's licensing or data model into the core. Check whether acquisition software can remain licensed after cancelling the incumbent PMS. A nominal bridge is useless if switching removes the license or access to historical images.

## Initial ecosystem investigation matrix

This is a breadth-oriented research shortlist, not a market-share ranking. No row is implemented or certified. References are vendor-documented or historical documentation, not live tests of CuspAtlas.

| Ecosystem | Evidence and next investigation |
|---|---|
| DEXIS legacy / DTX Studio Clinic | [DTX PMS integration help](https://helpfiles.dtxstudio.com/help/50784413-8047-4699-82f7-d1e9a868909e/1.7/EN/PMS_integration.htm) documents PMS integration for an older revision. Obtain current contracts, legacy/version coverage, image return and licensing independence. |
| Carestream CS Imaging / legacy Trophy-Kodak paths | [CS Imaging documentation](https://help.carestreamdental.com/rh/web/server/CS_Imaging/projects_responsive/SMA23/Overview.htm) describes standalone/PMS use, import/export and older image access. Qualify current integration rights, context matching and return formats. |
| Dentsply Sirona Sidexis / Schick CDR / Patterson Imaging | [Sidexis interface documentation](https://www.dentsplysirona.com/en-za/discover/discover-by-brand/sidexis-4.html) identifies PMS interfaces. Schick CDR and Patterson appear separately in the bridge catalog below: do not assume they share Sidexis contracts. Confirm US versions and independent licensing. |
| Planmeca Romexis | [Manufacturer compatibility page](https://www.planmeca.com/system-requirements) documents PMBridge/VDDS patient-and-image exchange and DICOM capabilities. Qualify actual versions, licensed modules and supported device/OS combinations. |
| Vatech EzDent-i / Ez3D-i | [Manufacturer integration FAQ](https://vatechamerica.com/index.php/faq/twain/integration) describes bridge/TWAIN/SDK paths and version-specific limitations. Historical documentation requires current confirmation. |
| Apteryx XrayVision / XV Capture / XVWeb and associated products | [Open Dental bridge catalog](https://www.opendental.com/site/programbridges.html) lists several products using Apteryx setup. Investigate whether shared interfaces provide reusable adapters; do not treat rebadged products as identical or count them as independent market share. |
| Acteon/Sopro, Air Techniques ScanX/Visix, Durr DBSwin, Gendex VixWin, SOTA/ClioSoft, XDR, Jazz, DentiMax, MiPACS | Catalog-derived long-tail investigation queue. Confirm manufacturers' current supported interfaces and select order using actual demand, rights and testability. A bridge in another PMS proves neither our rights nor our compatibility. |
| Other panoramic/CBCT/scanner systems | Identify installed combinations through the inventory study; evaluate DICOM and supported original viewers. 3D diagnosis and CAD/CAM are separate capabilities from a 2D claim attachment. |

The [Open Dental catalog](https://www.opendental.com/site/programbridges.html) is evidence that numerous imaging ecosystems have integration paths, not an installed-base survey. The [Jazz compatibility chart, dated November 2024](https://www.jazzimaging.com/wp-content/uploads/2024/11/JAZZ-Sensor-Software-Integration-Template-11_12_24.pdf), distinguishes TWAIN from direct integration and shows version-dependent support. Treat it as historical evidence for version-sensitive testing, not a current compatibility certification.

## How to establish 90% rather than assume it

1. Assemble a consented, non-PHI practice inventory sample through practice recruitment and dental IT/distributor partners. Capture region, practice size/location structure, supported specialty scope, OS, sensor/imaging software versions, modalities, licenses, incumbent PMS/export constraints and required payer services. No patient records or credentials are needed.
2. Establish sampling frame, sample size and weighting with statistical review before claiming population coverage. Include independent practices and groups, rural/urban locations, legacy/current equipment and different regions. A convenience sample or a handful of pilots cannot establish national coverage.
3. Deduplicate locations and software families. Count a location as hardware-qualified only when every essential imaging workflow has a validated supported path, acceptable historical access, usable licensing and a staff-approved workflow. Track manual-workaround sites separately; do not inflate integrated coverage with nominal file import.
4. Measure claims coverage by required payer/service routes and enrollment, plus claim-volume-weighted coverage where legitimate aggregated data exists. Claim submission, attachments, eligibility, status and ERA are separate capabilities. Provider participation in a network is not universal service support.
5. Measure full suitability as the intersection of qualified hardware, required insurance workflows, migration, prescribing where needed, daily clinical/financial workflows, security, deployment and affordable operating costs. Separate 90% hardware and 90% claims figures do not establish 90% joint suitability.
6. Publish denominator, sampling date, weighted estimate, uncertainty, supported versions and exclusions. Proposed evidence gate for a national 90% claim: an appropriately designed study whose one-sided 95% lower confidence bound is at least 90%, with design/weighting effects accounted for. Statistical method and feasibility require review; no sample count is invented here.

Observed cohort coverage = qualified locations divided by assessed in-scope locations, with weighting only when justified. Unassessed/unverified required configurations remain unknown, not successes. Report unknowns and response bias; do not drop incompatible locations from the denominator after seeing results. Recalculate on vendor updates and support retirement.

## Insurance breadth

Keep DentalXChange as the first qualification candidate and compare another independent candidate when coverage, continuity or terms justify it. Use current payer/service matrices, not advertised payer counts. [DentalXChange guidance](https://help.dentalxchange.com/ProductFAQs.htm) distinguishes attachment-payer availability and per-payer ERA enrollment. Obtain authoritative current matrices during onboarding; public lists may be incomplete or stale.

One qualified clearinghouse can be enough for a supported pilot. Add a second only for demonstrated gaps or resilience with valid enrollment and contracts. Switching routes after an uncertain submission risks duplicates: reconcile the first route before resubmission. Never silently send the same claim through two clearinghouses.

## Delivery and ownership

- Coverage planning now: maintain the research matrix, interface questions and inventory questionnaire. Product/integration owner is not yet named; outreach is drafted, not authorized or sent.
- Before adapter implementation: obtain current vendor contracts and lawful interfaces; rank candidates by evidenced practice reach, clinical importance, rights, cost and maintenance burden. Do not use unsupported numeric market shares.
- After explicit build authorization: implement shared adapter contracts and synthetic tests, then qualify exact ecosystems in successive batches with clinical/IT reviewers. Complete both acquisition-context and image-return tests.
- Before first replacement release: all needs of each participating pilot must be qualified, even while national coverage is below target. Label pilot versus broad release accurately.
- Before advertising 90% suitability: pass the population evidence gate and full-practice intersection test above. If not met, publish measured scope and remaining blockers rather than promising universal hardware support.

This broadens the [hardware and claims qualification plan](HARDWARE-AND-CLAIMS-QUALIFICATION.md). The first pilot provides test evidence; it no longer defines the entire compatibility roadmap. The 90% target does not authorize application implementation, UI design, purchases or vendor outreach.
