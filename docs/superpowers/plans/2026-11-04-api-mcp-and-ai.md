# API, MCP and AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a future execution plan, not authorization to start.

**Goal:** Publish one versioned, contract-first REST surface and one MCP surface that expose the same business operations under the same authorization path, prove that a forbidden call is refused identically through the UI, REST, MCP and a job worker, keep agent access inside a named scope set, budget and audit trail, ship AI assistance as an optional draft-only capability behind an evaluation gate, and provide webhook delivery, a complete machine-readable export and the operational read surfaces a practice works from, with none of it behind a special tier.

**Architecture:** Contract artifacts are the source. JSON Schema owns input and result shapes; OpenAPI, generated types and a generated client derive from them; the MCP tool surface derives from the same operation catalog as the REST routes. Every operation is registered exactly once in that catalog, which names its scope, resource policy, idempotency requirement, audit class, per-call budget and both transports. One domain command and query layer serves every transport, so no adapter holds business logic, and the catalog plus the policy layer is the place a refusal is decided rather than each surface. Agent access is a principal, not a credential sweep: an agent carries its own identity, named sponsor, scope set, budget and audit record, separate from the human principal on whose behalf it acts. AI is a provider-neutral port with an egress policy in front of it and a human sign-off gate behind it, and an AI outage removes a convenience rather than a care workflow.

**Tech Stack:** Inherits the platform foundation: supported Node LTS, TypeScript, Fastify, PostgreSQL/Supabase, JSON Schema/OpenAPI, Vitest and SQL integration tests. This plan adds no runtime dependency of its own until A-S2 identifies a model provider, and no model client is pinned before that arrangement exists. Generated artifacts (OpenAPI, client, tool schemas) are build outputs, not hand-maintained copies.

**Spec:** [Product design](../specs/2026-11-03-dental-pms-design.md), [API and MCP design contract](../../API-AND-MCP.md), [capability matrix](../../CAPABILITIES.md), [security gates](../../SECURITY-AND-READINESS.md), [shared contracts](../../SHARED-CONTRACTS.md).

**Depends on:** [platform foundation](2026-11-03-platform-foundation.md) Tasks 1–8, especially versioned transports (3), atomic audit and outbox (4), idempotency (5), the durable worker with fresh authorization (6), MCP parity on the synthetic domain (7) and the restore proof (8). Consumes the contracts published by [scheduling](2026-11-04-scheduling-and-patients.md), [clinical](2026-11-04-clinical-record.md), [billing](2026-11-04-billing-and-rcm.md), [imaging](2026-11-04-imaging-and-devices.md), [portal](2026-11-04-portal-and-communications.md) and [migration](2026-11-04-migration-and-operations.md); it defines no aggregate that one of those plans owns.

**Task numbering:** tasks carry the prefix `A`, discovery spikes `A-S`, and open decisions `A-D`. A reference to another plan names it: `foundation Task 5` is [platform foundation](2026-11-03-platform-foundation.md), `migration Task 1` is [migration and operations](2026-11-04-migration-and-operations.md). A reference to a scope or a shared type is resolved through [shared contracts](../../SHARED-CONTRACTS.md), which remains the authority for money, identifiers and scope naming.

## Global Constraints

- This is a reviewed proposal. Nothing here is implemented, tested, validated or authorized.
- Starts only after the platform foundation plan is complete and reviewed. This plan generalizes the foundation's synthetic-domain parity work; it does not replace it.
- Synthetic tenants, patients, staff, providers, resources, messages and provider responses only, in fixtures, examples, logs, issues and demonstrations.
- One application policy layer. UI, REST, MCP, workers and integration adapters all call the same command and query handlers; row-level security and constraints remain independent enforcement rather than a substitute for policy.
- No direct agent SQL. No MCP tool may execute arbitrary SQL, shell, filesystem access or unrestricted outbound HTTP. The MCP runtime connects with the same non-owner, non-BYPASSRLS role as the API, and no transport holds a service-role credential.
- Tenant and actor are derived from authenticated context. A client-supplied tenant value is at most a selection hint and is rejected when it does not match the authenticated scope; user-editable auth metadata never establishes authority.
- `Money` is `{ currency: string, minor: integer }` and an entity reference is an opaque `<entity>Ref`. A scalar amount or a bare `patientId`-style field in a contract is a defect rejected by the contract gate, not a permitted variant.
- Scope names are `noun.verb` in lower case and must exist in the registry published by A3. A camel-case scope name, a wildcard scope or a scope used but not registered is a defect.
- Every operation has a cross-tenant negative case, a missing-scope case and a revoked-access case. Stating it once in the shared harness is not an exemption from running it.
- No vendor capability, MCP authorization revision, model-provider arrangement or certification is asserted. Unverified items are blocked-on-discovery with a named owner and a probe.
- No UI layout, component or interaction design appears here. When this plan claims parity, it means the refusal path and the operation set, not screens.
- No promised dates. Sequences and dependencies are stated; calendar commitments are not.

## Research and evidence gate before executing this plan

Two authorities are external and unstable. The MCP authorization specification changes between revisions, and the design document requires validating the then-current revision during implementation rather than assuming one; A-S1 records the revision in force and the resource and audience checks it demands. Model providers differ on retention, training use, subprocessors, region and whether they will accept an agreement covering patient data at all; A-S2 records what is actually available before any client is written.

The repository holds no measurement of what an outside integrator needs from this API. The claim that a local integrator can automate supported workflows without purchasing a special tier is a roadmap hypothesis, not a finding, and A-S4 is the probe that tests it. Until that probe reports, the export and webhook contracts are designed against internal needs only and are labeled as such.

MCP parity is partly evidenced: the foundation plan builds parity on a non-clinical synthetic domain. That establishes a mechanism, not coverage of the business operations in the capability matrix. A19 counts what is actually covered and names what is not.

## Discovery spikes (resolve before the tasks they gate)

### A-S1: MCP authorization revision and transport qualification — blocked-on-discovery

Determine, from the current published specification and from the client software an operator would actually deploy: the authorization flow and discovery requirements, how resource and audience validation is expressed, what consent is required per deployment, whether the remote transport the specification now defines is what our target clients implement, and what a local stdio client may use in place of a session. Record the revision identity and the date it was read. Blocks A6 for the remote transport, A9 and A10. Stop condition: a written qualification note naming the revision, the client set, and the resource and audience checks we will implement, or the decision that only the local transport is supported at pilot and the remote transport is not claimed.

### A-S2: Model provider and data-processing arrangement qualification — blocked-on-discovery

For each candidate provider, determine from a contract and a sandbox rather than from documentation marketing: whether an agreement covering patient data is offered at all and on what terms, retention and training use and how the configured behavior is verified rather than assumed, region and subprocessor list, whether prompts and outputs leave the deployment, request and response logging on the provider side, rate and cost model, availability and deprecation history, and what a local model option would require operationally. Blocks A11 and A12. Stop condition: a written capability summary naming one approved provider configuration with verified retention settings, or an explicit decision that AI operates local-only and no provider egress occurs at pilot.

### A-S3: Evaluation acceptance criteria and reviewer authority — blocked-on-discovery

Agree what an AI draft must satisfy to be offered at all, who judges it, and which failures are blocking rather than noted. The harness in A12 is machinery; the threshold is a human decision, and a score is not clinical validation. Blocks A12 and the sign-off path in A11. Stop condition: a written rubric naming the case classes, the pass threshold per class, the blocking failure set, and the named reviewer role, or AI drafts are not offered in the first supported release.

### A-S4: External consumer and portability requirements qualification — blocked-on-discovery

Establish what a local integrator, a practice's own analyst and a receiving system need in order to replace an incumbent without a special tier: which operations they call, which authentication models they can implement, what event volume and ordering they can consume, which export formats they can ingest, and what they cannot verify without help. Include at least one consumer that is not us. Blocks A14, A15 and the formulation of A-D7 and A-D8. Stop condition: a written requirements summary from at least one named external consumer class, with the unsupported items listed explicitly.

## Open decisions (human required)

| Decision | Options | Recommended | Blocks | What settles it |
|---|---|---|---|---|
| A-D1 Version identity and deprecation window | URL major version only; header-negotiated version; date-based versioning | Path major version (`/v1`) with additive-only change inside a major, a deprecation marker plus a sunset announcement, and a stated minimum support window measured in published releases rather than dates | A5 | Maintainer and integrator agreement recorded in an ADR |
| A-D2 Scope granularity and the human-only set | Coarse domain write scopes; separate read, draft, commit, sign and execute scopes | Separate read and write per domain, plus explicit draft, commit, sign and execute scopes; `clinical.sign`, `access.manage` and controlled-substance submission are human-only and non-delegable | A3, A7 | Safety review with the clinician and security reviewers |
| A-D3 Which MCP write tools a deployment enables | All supported tools enabled; read and draft only by default; per-deployment operator choice | Read and draft enabled by default; commit, sign and execute enabled per deployment only by a named operator with a recorded purpose | A6, A9 | Operator agreement and A-S1 qualification |
| A-D4 Approval model for high-impact operations | Direct execution with a scope; prepare and commit with a named approver; out-of-band staff approval | Prepare and commit proposals approved by a human principal distinct from the proposal's creator, with no self-approval and an expiry on every proposal | A10, A13 | Safety and financial review; recorded in the operation catalog |
| A-D5 Patient-data egress boundary for AI | Any provider under a general terms-of-service agreement; only providers with an agreement covering patient data; local models only | Only providers with a written arrangement covering patient data, verified configuration and a recorded egress decision per capability; otherwise local-only or no AI | A11 | A-S2 outcome |
| A-D6 Which AI capabilities ship in the first supported release | Draft notes, summaries and narratives plus interpretation features; administrative and drafting features only; none | Administrative explanation, source-linked summary of records the caller may already read, and draft note or claim narrative; no diagnosis, no radiograph interpretation, no autonomous coding | A11, A12 | Clinical reviewer and A-S3 threshold |
| A-D7 Webhook endpoint registration and egress | Self-service endpoint registration; operator-approved allowlist | Operator-approved allowlist entry per endpoint with a pinned secret, an explicit host allowlist and no arbitrary outbound destination | A14 | Security review |
| A-D8 What "complete" means for export | Entity tables only; entities plus attachments; entities, attachments, derived projections, history and checksums | Entities, attachments with checksums, version references, transition and amendment history, and allocation provenance, verifiable by the receiver without our help | A15 | A-S4 requirements and migration Task 1 format review |
| A-D9 Agent principal lifecycle | Shared integration account per tenant; one principal per agent with a named sponsor | One principal per agent, one named human sponsor, a stated purpose, an expiry, immediate revocation, and a recorded maximum scope set no agent may exceed | A8, A19 | Security review and operator agreement |

## Implementation review focus

- A tool registered on the MCP surface with no catalog entry must fail startup rather than fall back to a generic handler; A6 must prove startup refusal, not just a runtime error.
- A refusal that differs between REST and MCP by status class, reason code or whether the record's existence leaks fails A7; the comparison is on the fingerprint, not on prose.
- An agent whose credential was revoked while a job sat queued must be denied at execution time; A8 must test the queued case, not only the inline call.
- A model request that would send patient data to an unapproved destination must be refused before the request leaves the process; A11 must prove the refusal by observing that no outbound request occurred.
- An export that omits a registered entity class must fail its own completeness check rather than deliver a shorter file; A15 must be able to detect a deliberately truncated export.
- A webhook consumer that receives one event twice must be able to deduplicate on event identity while a legitimately replayed delivery still verifies; A14 must distinguish redelivery from forgery.
- A huddle section the caller may not read must be absent or marked unavailable, never rendered as zero; A18 must test the difference between no items and no permission.
- A deprecated operation must keep working, keep being audited and carry its sunset marker; A5 must prove that deprecation is not silent removal.

## Proposed file structure (create only during authorized execution)

`packages/contracts/src/` owns JSON Schema per operation, the generated OpenAPI document and the generated client; `packages/contracts/src/scopes.json` owns the scope registry from A3 and is the only place a scope name is defined. `packages/domain/src/operations/` owns the operation catalog, the shared executor and the refusal taxonomy. `packages/domain/src/authorization/` owns scope and resource policy evaluation over the foundation's `authorize`. `apps/api/src/routes/` holds thin transports only. `apps/mcp/src/` owns tool registration generated from the catalog, transport authentication and budget enforcement. `packages/ai/` owns the provider port, egress policy, draft records and the evaluation harness. `packages/domain/src/webhooks/` owns subscriptions, signing, delivery records and replay. `packages/domain/src/export/` owns export requests and delivery, consuming the format owned by `migration Task 1`. `packages/domain/src/reporting/` owns measure definitions and projections. `packages/domain/src/administration/` owns audit search, access review and revocation propagation. `packages/domain/src/huddle/` owns the daily projection. Documentation lands in `docs/api/`, `docs/scopes.md`, `docs/ai/` and `docs/adr/`. Tests live in `tests/integration/api-*.test.ts`, `mcp-*.test.ts`, `automation-*.test.ts`, `ai-*.test.ts` and `parity-matrix.test.ts`; fixtures under `tests/fixtures/api/` and `tests/fixtures/ai/` are generated and synthetic. No UI package, model SDK client or vendor connector is added here.

## Shared interfaces

Proposed contract definitions to create during execution, not code already present:

- `OperationDescriptor = { operation: string; domain: string; kind: 'query' | 'command'; scope: string; resourcePolicy: string; idempotency: 'none' | 'required' | 'prepareCommit'; auditClass: string; budgetRef: string; approval: 'none' | 'distinctHuman'; restRoute: string; mcpTool?: string; status: 'supported' | 'deprecated' | 'internal' }`.
- `ScopeDefinition = { name: string; domain: string; verb: string; sensitivity: 'read' | 'write' | 'draft' | 'sign' | 'execute' | 'configure'; principalClasses: readonly ('human' | 'service' | 'agent')[]; requiresStepUp: boolean; auditClass: string; deprecatedAt?: string; replacedBy?: string }`.
- `PrincipalContext` extends the foundation's `ActorContext` with `{ principalKind: 'human' | 'agent' | 'service'; agentRef?: string; sponsorRef?: string; budgetRef: string }` — it extends that type and does not replace it.
- `CallBudget = { wallClockMs: number; payloadBytes: number; resultRows: number; resultBytes: number; externalCalls: number }` with a per-principal-class override and a hard ceiling no override may exceed.
- `Refusal = { outcomeClass: 'denied' | 'notFound' | 'conflict' | 'invalid' | 'budgetExceeded'; reasonCode: string; retryable: boolean; disclosesExistence: boolean }` and `RefusalFingerprint` as its surface-independent projection used by the parity harness.
- `Proposal = { proposalRef: string; operation: string; payloadDigest: string; createdByRef: string; affectedRefs: readonly { ref: string; version: number }[]; expiresAt: string; policyVersion: string; approvalRef?: string; approvalKind?: 'human' | 'operator' }`.
- `AgentPrincipal = { agentRef: string; sponsorRef: string; purpose: string; scopes: readonly string[]; createdAt: string; expiresAt: string; state: 'active' | 'suspended' | 'revoked' }` — no credential material and no tenant field in the shape; the tenant is the authenticated context that creates the principal.
- `AiDraft = { draftRef: string; kind: 'noteDraft' | 'claimNarrativeDraft' | 'summary' | 'explanation'; sourceRefs: readonly string[]; modelRef: string; promptVersionRef: string; egressDecision: 'localOnly' | 'approvedProvider' | 'refused'; state: 'draft' | 'reviewed' | 'discarded' | 'signed'; signedByRef?: string; signedAt?: string }`.
- `EvalCase` and `EvalRun = { runId: string; modelRef: string; promptVersionRef: string; caseSetVersion: string; runs: number; passesByCase: Record<string, number>; failures: readonly { caseRef: string; class: string }[]; thresholdRef: string; verdict: 'pass' | 'fail' | 'inconclusive' }`.
- `WebhookSubscription = { subscriptionRef: string; endpointRef: string; allowlistEntryRef: string; eventVersions: readonly string[]; secretRef: string; state: 'active' | 'paused' | 'revoked' }` and `WebhookDelivery = { deliveryId: string; eventId: string; eventVersion: string; subscriptionRef: string; attempt: number; state: 'delivered' | 'retrying' | 'deadLettered'; responseClass?: string }`; neither carries a tenant field, because the subscription is created in an authenticated context and deliveries are authorized from it.
- `ExportRequest = { exportRef: string; scope: 'tenant' | 'patient'; subjectRef?: string; formatVersion: string; state: 'requested' | 'building' | 'delivered' | 'failed' | 'expired' }` — the export manifest and format document are owned by `migration Task 1` and are referenced, never redefined.
- `MeasureDefinition = { measureKey: string; version: string; numerator: string; denominator: string; timeBasis: 'locationZone' | 'tenantZone'; dateBasis: 'serviceDate' | 'postedAt' | 'scheduledStart'; filters: readonly string[]; freshness: string; suppressionFloorRef: string }`.
- `HuddleSection = { sectionKey: string; requiredScope: string; asOf: string; availability: 'available' | 'notPermitted' | 'stale'; itemCount?: number; items?: readonly unknown[] }`.

### A1: Contract-first pipeline, generated client and shared-representation conformance

**Dependencies:** foundation Tasks 1 and 3. **Status:** implementation.
**Files (proposed):** `packages/contracts/src/` schema tree, `packages/contracts/tools/generate.ts`, `packages/contracts/src/generated/`, `docs/api/openapi.yaml` (generated), `tests/integration/api-contract-gate.test.ts`, `docs/adr/0007-contract-pipeline.md`.
**Contract:** `generateContracts(schemaTree)` producing OpenAPI, types and a client; `validateContractChange(previous, next)` classifying a diff as additive, deprecating or breaking; the shared `CommandEnvelope`, `CommandResult` and error body shapes; a lint rule set enforcing `Money` and `<entity>Ref` in every schema.

**Acceptance cases:** a schema declaring a scalar `amountMinor` beside a `currency` is rejected by the lint gate rather than accepted as a variant; a schema declaring `patientId` instead of `patientRef` is rejected with the field named; a request body carrying a tenant field is rejected; an unknown property is rejected at runtime, not stripped silently; the generated client compiles against the generated types and a contract test proves the same payload passes schema validation and type checking; regenerating from an unchanged schema produces no diff; a hand-edited generated file is overwritten by the build rather than respected.

**Failure and recovery:** a schema tree that fails to compile fails the build with the failing operation named and produces no partial artifact; a generator crash leaves the previous generated artifacts in place rather than a half-written file; a schema change that cannot be classified by the diff tool stops the pipeline instead of defaulting to additive.

**Observable completion condition:** the contract gate rejects scalar money, bare entity identifiers and client-supplied tenants in a synthetic schema set while regenerating the OpenAPI document and client from an unchanged tree produces an empty diff.

- [ ] Encode the synthetic violation set and the clean set, then run `pnpm test:integration -- api-contract-gate` and confirm the violations currently pass through.
- [ ] Implement schema linting, generation and diff classification with no hand-maintained OpenAPI copy.
- [ ] Re-run the gate and confirm an unchanged schema tree regenerates byte-identically.
- [ ] Record the pipeline decision and the diff classes in the ADR, then commit.

### A2: Versioned REST surface with honest status, conflict and pagination semantics

Use the authoritative REST/MCP mapping and two audit paths in [shared contracts](../../SHARED-CONTRACTS.md). Test that typed policy denials normalize correctly, domain refusals never become HTTP 2xx, MCP tool refusals carry `isError: true`, and saved results are reauthorized before replay. Audit a refused attempt independently from any rolled-back mutation.

**Dependencies:** A1; foundation Task 3. **Status:** implementation.
**Files (proposed):** `packages/domain/src/operations/refusals.ts`, `apps/api/src/routes/` transport helpers, `apps/api/src/errors.ts` extensions, `tests/integration/api-surface.test.ts`.
**Contract:** the mapping from `Refusal` to a response with an honest status class, a stable `reasonCode`, a correlation identifier and safe field detail; a conflict response carrying reconciliation guidance but no competing record content; cursor pagination with a bounded lifetime; caller-selected projection limited to fields the caller's scopes permit; per-principal rate limits.

**Acceptance cases:** a request for a record that exists in another tenant returns the same status, code and shape as a record that does not exist, and the timing difference is not measurable beyond the configured tolerance; a stale expected version returns a conflict with a safe reconciliation hint and no copy of the newer record; a cursor from another tenant is rejected; an expired cursor is refused with a retryable reason rather than silently restarting at the beginning; a projection requesting a field outside the caller's scopes is refused rather than silently dropped; a response carrying a failure inside a success status is impossible because the transport builds status and body together; an error body contains no patient identifier, note text, credential or query body.

**Failure and recovery:** a transport that cannot classify a domain fault fails closed as an internal error with a correlation identifier and no detail from the underlying exception; a rate-limited caller receives a retryable refusal and no partial write; a truncated result stream is reported as truncated with a resume cursor rather than as a complete page.

**Observable completion condition:** the surface suite shows an indistinguishable not-found and cross-tenant denial, a conflict that reveals nothing about the newer version, and a rejection of every attempt to keep failing inside a success status.

- [ ] Write the existence-leak, conflict, cursor, projection and PHI-in-error cases and confirm failure.
- [ ] Implement refusal mapping, cursor lifetime, projection limits and rate limits in the transport layer only.
- [ ] Run the suite under the restricted runtime role and confirm every denial fails closed.
- [ ] Commit with the status-and-code table published in `docs/api/`.

### A3: Scope registry publication and the new-operation procedure

**Dependencies:** A1; A-D2. **Status:** implementation of the registry and procedure; the granularity decision requires a human.
**Files (proposed):** `packages/contracts/src/scopes.json`, `packages/domain/src/authorization/scopes.ts`, `docs/scopes.md`, `tests/integration/api-scopes.test.ts`.
**Contract:** `ScopeDefinition` as above; `loadRegistry()` rejecting duplicate names, camel-case names, wildcards and unknown `replacedBy` targets; `assertScopeRegistered(name)` called by the catalog loader; the published procedure by which a new operation receives a scope.

The procedure this plan publishes: name the operation in the catalog; select a scope, and if none exists add one to the registry in the same change with its sensitivity, permitted principal classes, step-up requirement and audit class; bind the resource policy, because a scope alone never authorizes; register the cross-tenant, missing-scope and revoked-access cases; then regenerate contracts, the client and the MCP tool and cite the operation in the capability row that now has an owner.

**Acceptance cases:** a scope written `receivablesRead` is rejected as a defect naming the correct form; a wildcard, prefix wildcard or empty scope is rejected; an operation citing an unregistered scope fails the catalog build; a registry entry whose `replacedBy` names a missing scope is rejected; a scope marked human-only cannot be granted to an agent principal, and the grant attempt is refused and audited; a scope added without an audit class is rejected; a retired scope remains readable in the registry with its replacement so historical audit rows still resolve.

**Failure and recovery:** a registry that fails validation stops the service from starting rather than running with a partial set; an operation removed from the code while its scope remains is reported as an orphan for review rather than deleted automatically; a grant of a scope that no registered operation uses is reported, not silently retained.

**Observable completion condition:** the registry loads with every entry valid, the catalog refuses to build with an unregistered scope, and a documented five-step procedure is cited by the capability rows this plan owns.

- [ ] Write the camel-case, wildcard, unregistered, human-only and orphan cases and confirm failure.
- [ ] Implement the registry, validation and catalog-time assertion.
- [ ] Publish `docs/scopes.md` with the canonical entries and the grants each default role receives, marking every entry whose grant requires A-D2 sign-off.
- [ ] Run the suite and commit the registry as the sole source of scope names.

### A4: Operation catalog and the single authorization path

**Dependencies:** A2, A3; foundation Task 2. **Status:** implementation.
**Files (proposed):** `packages/domain/src/operations/catalog.ts`, `packages/domain/src/operations/execute.ts`, `docs/api/operation-catalog.md`, `tests/integration/api-catalog.test.ts`.
**Contract:** `OperationDescriptor` as above; `executeOperation(ctx, operation, payload)` performing schema validation, scope check, resource policy, idempotency handling, audit recording and budget enforcement in one place; `describeOperationSet()` for documentation and parity checks.

**Acceptance cases:** a route existing without a catalog entry fails the build; a catalog entry with no handler fails startup; two entries declaring the same REST path or the same MCP tool name fail; an operation reachable from a transport that bypasses `executeOperation` fails the architecture check; a descriptor naming a resource policy that does not exist fails; a query descriptor declared with `idempotency: 'required'` is rejected as inconsistent; the descriptor set rendered as documentation matches the generated OpenAPI paths.

**Failure and recovery:** a handler that throws a raw database error is converted to a refusal or an internal fault by the executor, never surfaced; a catalog load failure prevents startup rather than degrading to whatever registered; a descriptor whose scope was retired mid-flight refuses with a reason naming the replacement.

**Observable completion condition:** the architecture check proves no path reaches a domain handler without passing the shared executor, and the descriptor set and the generated OpenAPI paths agree exactly.

- [ ] Write the orphan-route, missing-handler, duplicate-name and bypass cases and confirm the bypass case currently succeeds.
- [ ] Implement the catalog, the executor pipeline and the architecture check.
- [ ] Render the catalog as documentation and compare it against the generated OpenAPI paths.
- [ ] Commit with the executor as the only mutation entry point.

### A5: Change control, deprecation and the sunset record

**Dependencies:** A1, A4; A-D1. **Status:** implementation; the window length requires a human decision.
**Files (proposed):** `packages/contracts/tools/change-control.ts`, `docs/api/deprecation.md`, `docs/api/sunset-register.md`, `tests/integration/api-change-control.test.ts`.
**Contract:** `classifyChange(previous, next)` returning additive, deprecating or breaking with the offending field paths; `markDeprecated(operation, { replacedBy, announcedIn })`; `evaluateSunset(operation, publishedReleases)` returning `supported` or `removable`; the requirement that a deprecated operation still answers, still audits and carries its deprecation and sunset markers in the response metadata.

**Acceptance cases:** removing a required field without a major version change fails the gate and names the field; adding an optional field passes as additive; narrowing an accepted enum or a maximum length is classified breaking rather than additive; making a previously nullable field non-null is breaking; a deprecated operation still returns a result, still writes its audit row and carries the marker; removing an operation before the window elapses fails; the sunset register lists every deprecated operation with its replacement or an explicit statement that none exists; an operation deprecated but never removed does not silently disappear from the documentation.

**Failure and recovery:** a schema change that fails classification blocks the merge rather than being treated as additive by default; an operation removed while a contract test still references it fails that test with the replacement named; a sunset register that disagrees with the descriptor set fails the documentation build.

**Observable completion condition:** the change-control suite classifies a synthesized set of additive, deprecating and breaking diffs correctly, and the sunset register is generated from the descriptors rather than maintained by hand.

- [ ] Write the additive, breaking, deprecated-still-works and early-removal cases and confirm failure.
- [ ] Implement classification against the published schema rather than a second copy.
- [ ] Generate the sunset register from descriptors and prove the two agree.
- [ ] Commit; the window length remains open under A-D1.

### A6: MCP parity from the catalog

**Dependencies:** A4; foundation Task 7; A-S1 for transport; A-D3. **Status:** implementation for the local transport; remote transport blocked-on-discovery.
**Files (proposed):** `apps/mcp/src/registry.ts`, `apps/mcp/src/tools/generated.ts`, `apps/mcp/src/transport.ts`, `docs/api/mcp-surface.md`, `tests/integration/mcp-parity.test.ts`.
**Contract:** `registerTools(catalog)` emitting one tool per supported operation with a schema generated from the same JSON Schema; `McpToolDescriptor = { toolName: string; operation: string; enabledBy: 'default' | 'operator'; budgetRef: string }`; a startup refusal for any tool that cannot be derived from a descriptor; a registration API that accepts only `query` and `command` kinds and has no `raw`, `sql`, `shell`, `http` or `filesystem` kind to select.

**Acceptance cases:** the tool set equals the catalog's supported operations with an MCP surface enabled, and a tool added by hand fails startup; a tool naming an operation that does not exist fails startup; a tool kind outside query and command cannot be registered and the attempt is refused at build time; the same command invoked through REST and through MCP produces the same result, the same audit row shape and the same version; an insufficient-scope call is refused identically on both surfaces; a malformed or wrong-audience credential is refused before any handler runs; a tool error contains no credential, record content or stack detail.

**Failure and recovery:** a catalog entry whose schema fails validation disables that tool and reports it rather than starting with an unvalidated tool; a tool execution that exceeds its budget returns a typed refusal with a correlation identifier and no partial mutation; a transport failure mid-call leaves the idempotency record intact so a corrected retry replays rather than repeats.

**Observable completion condition:** the parity suite shows an identical result and an identical refusal for the same operation through REST and MCP, and startup fails for every synthetic hand-added or off-catalog tool.

- [ ] Write the hand-added-tool, off-catalog, identical-refusal and identical-result cases and confirm the parity cases fail.
- [ ] Generate the tool surface from descriptors and delete any hand-maintained tool schema.
- [ ] Run the parity suite with a local synthetic client and confirm no tool exists that lacks a descriptor.
- [ ] Publish the surface document, including the tools a deployment may disable under A-D3, and commit.

### A7: Forbidden-operation matrix across UI, REST, MCP and worker

**Dependencies:** A4, A6; foundation Tasks 2 and 6. **Status:** implementation.
**Files (proposed):** `tests/integration/parity-matrix.test.ts`, `tests/fixtures/api/forbidden-cases.ts`, `packages/domain/src/operations/refusals.ts` additions, `docs/api/forbidden-matrix.md`.
**Contract:** `ForbiddenCase = { caseRef: string; operation: string; principal: PrincipalContext; resource: { tenantId: string; ref: string }; expected: Refusal }`; `runAcrossSurfaces(caseRef)` returning one `RefusalFingerprint` per surface; `assertIdentical(fingerprints)` failing when any two differ in outcome class, reason code, retryability or existence disclosure.

The matrix covers at least: a cross-tenant read; a cross-tenant write; a role that lacks the operation's scope; a membership revoked after the credential was issued; a membership revoked while a job was queued; an agent attempting a human-only scope; an agent attempting export creation; a worker attempting clinical signing; a portal principal attempting a staff scope; a service account attempting access administration; an operation attempted through the UI path with a downgraded role; an operation attempted with a policy override and no recorded reason.

**Acceptance cases:** every case yields four fingerprints that compare equal; a deliberately altered surface — for example a worker that returns a different reason code — fails the matrix with the diverging surface named; a case where one surface reveals existence by status or by a differing retryability flag fails; the UI path is exercised through the same command layer as REST rather than asserted by inspection; adding a new operation without a matrix row fails the coverage check; a case whose expected refusal is itself wrong is caught by an independent assertion that the operation is refused at all.

**Failure and recovery:** a matrix run that cannot reach a surface reports the surface as unverified rather than passing by default; a surface that times out is reported distinctly from a refusal so a timeout is never recorded as a correct deny; a divergence is preserved as a failing artifact with all four fingerprints attached rather than summarized.

**Observable completion condition:** the matrix runs every listed case through four surfaces, every fingerprint set compares equal, and a single injected divergence is detected and attributed to its surface.

- [ ] Write the case fixture set and the equality assertion, then confirm the matrix fails before the shared executor exists.
- [ ] Implement the harness so it calls each surface through its real transport rather than a shared shortcut.
- [ ] Inject one divergence deliberately and confirm the harness names the surface and the differing field.
- [ ] Publish the matrix and commit; the capability row for integrations cites this suite as its negative evidence.

### A8: Agent principals, sponsorship, revocation and separated audit

**Dependencies:** foundation Tasks 2 and 4; A3; A-D9. **Status:** implementation; the lifecycle limits require a human decision.
**Files (proposed):** `packages/domain/src/authorization/agent-principals.ts`, migration via `supabase migration new agent_principals`, `packages/domain/src/operations/execute.ts` additions, `tests/integration/api-agent-identity.test.ts`.
**Contract:** `createAgentPrincipal`, `suspendAgentPrincipal`, `revokeAgentPrincipal`, `readAgentPrincipal`, and `describeAgentGrants(agentRef)`; the executor records `actorRef` (the agent), `sponsorRef` (the human) and `principalKind` as separate audit fields; revocation takes effect on the next authorization evaluation, including for work already queued.

**Acceptance cases:** an audit row for an agent action names the agent as actor and the sponsor as sponsor, and never records the sponsor as the actor; an agent cannot be created without a sponsor, a purpose and an expiry; an agent's scope set cannot include a human-only scope and the attempt is refused; an agent cannot create or sponsor another agent; a revoked agent is refused at the next call while the sponsor's own human session stays valid; a queued job enqueued by an agent before revocation is refused when it executes; a suspended agent is refused for mutations but permitted for the reads its scopes allow; a sponsor whose own membership is revoked causes their agents to fail authorization rather than continue; two agents of one sponsor perform the same operation and their audit rows remain distinguishable.

**Failure and recovery:** a revocation that fails to persist leaves the agent active and raises a visible failure rather than appearing to succeed; an agent credential presented after its principal record is gone is refused as unauthenticated rather than as unauthorized; a sponsor change is recorded as a new sponsorship event, not an overwrite, so prior actions still resolve to the sponsor of record.

**Observable completion condition:** the suite produces audit rows that distinguish agent and sponsor for every agent action, and a revoked agent whose work was already queued is refused at execution.

- [ ] Write the sponsor-as-actor, human-only-grant, queued-revocation and sponsor-revocation cases and confirm failure.
- [ ] Implement principal records, sponsorship and revocation with execution-time reauthorization.
- [ ] Run the suite including the queued-job case, and confirm the audit shape separates actor from sponsor.
- [ ] Commit; the maximum lifetime and scope ceiling remain open under A-D9.

### A9: Remote MCP transport, consent and per-call budgets

**Dependencies:** A6, A8; A-S1; A-D3. **Status:** blocked-on-discovery for the remote transport; budget enforcement is implementation.
**Files (proposed):** `apps/mcp/src/transport-remote.ts`, `apps/mcp/src/budget.ts`, `packages/domain/src/operations/budget.ts`, `docs/api/mcp-budgets.md`, `tests/integration/mcp-budgets.test.ts`.
**Contract:** `CallBudget` as above with a per-principal-class table; `consumeBudget(principal, operation, consumption)`; `enforcePreCall(ctx, operation, payload)` refusing oversized requests before execution; `truncateResult(result, budget)` returning an explicit truncation marker and a resume cursor; remote authorization performing resource and audience validation per the revision recorded in A-S1.

**Acceptance cases:** a payload above the byte budget is refused before any handler runs and no state changes; a result larger than the row budget is truncated with an explicit marker and a cursor rather than silently shortened; a discovery call that would enqueue an action is refused; an audience value that does not match this deployment is refused; an expired or revoked credential is refused before handler execution; a budget override above the hard ceiling is refused at configuration load; a call exceeding the wall-clock budget returns a typed refusal with a correlation identifier and a statement that the outcome is unknown if a mutation had started; an agent's budget is never larger than the human-equivalent budget for the same operation.

**Failure and recovery:** a budget accounting write that fails aborts the call rather than allowing unbudgeted work; an unknown outcome after a wall-clock expiry is recorded as unknown with the idempotency key preserved so a retry replays or conflicts rather than repeating; a truncated result that the caller never resumes expires rather than accumulating; a transport revision change forces a new qualification note before the remote surface is re-enabled.

**Observable completion condition:** the budget suite refuses an oversized request before execution, truncates an oversized result with an explicit marker, and records a wall-clock expiry as unknown rather than failed.

- [ ] Write the pre-call refusal, truncation, audience, unknown-outcome and override-ceiling cases and confirm failure.
- [ ] Implement budgets at the executor boundary so every transport inherits them.
- [ ] Run the suite and confirm no path produces an unbudgeted result or silently short page.
- [ ] Mark the remote transport blocked until A-S1 closes and commit the budget mechanism.

### A10: Idempotency, prepare and commit, and non-self approval

**Dependencies:** A4; foundation Task 5; A-D4. **Status:** implementation; the approval identity rule requires a human decision.
**Files (proposed):** `packages/domain/src/operations/proposals.ts`, migration via `supabase migration new operation_proposals`, `apps/mcp/src/tools/proposals.ts`, `tests/integration/api-proposals.test.ts`.
**Contract:** `createProposal(ctx, operation, payload)` returning a `Proposal` bound to a payload digest, the creating principal, affected references and their versions, a policy version and an expiry; `approveProposal(ctx, { proposalRef })` refusing self-approval; `commitProposal(ctx, { proposalRef, idempotencyKey })` rechecking scopes, membership and versions before acting; `abandonProposal`.

**Acceptance cases:** the same idempotency key with the same payload returns the recorded result and a replay marker; the same key with a different payload conflicts rather than returning the earlier result; a commit after the affected record's version changed fails with a stale-proposal refusal; a proposal created by an agent and approved by that agent's own sponsor is refused, because the sponsor is the principal the agent acts for and approving it is self-approval by proxy; an expired proposal cannot be committed; a proposal created for one tenant cannot be committed under another; a commit after the approving principal's scope was revoked fails; a proposal whose operation was deprecated between creation and commit is refused with the replacement named; a commit whose payload digest differs from the approved digest is refused even with a valid key.

**Failure and recovery:** a crash between approval and commit leaves the proposal approved and committable exactly once, not twice; a commit that fails after the external effect but before local recording leaves an unknown outcome reconciled by idempotency key, never retried as a new operation; an abandoned proposal remains readable for audit and cannot be revived.

**Observable completion condition:** the suite shows one committed effect for repeated commits of one proposal, a refusal for self-approval and a refusal for a stale or expired proposal, with every outcome audited.

- [ ] Write the replay, conflicting-payload, stale-version, self-approval, expiry and cross-tenant cases and confirm failure.
- [ ] Implement proposals, approval identity and commit revalidation on top of the foundation's idempotency layer.
- [ ] Run the suite with two concurrent commits of one proposal and confirm one committed effect.
- [ ] Commit; the approval identity rule remains open under A-D4.

### A11: AI boundary with a draft-only pipeline and explicit human sign-off

**Dependencies:** A4; A-S2; A-D5 and A-D6. **Status:** blocked-on-discovery for any provider egress; port, policy and draft records are implementation.
**Files (proposed):** `packages/ai/port.ts`, `packages/ai/synthetic.ts`, `packages/ai/egress-policy.ts`, `packages/domain/src/clinical/ai-drafts.ts` as a consumer only, migration via `supabase migration new ai_drafts`, `tests/integration/ai-boundary.test.ts`.
**Contract:** `AiPort` accepting a minimized request and returning a draft or an explicit unavailability; `evaluateEgress(purpose, payloadClassification)` returning `localOnly`, `approvedProvider` or `refused` with a reason; `createDraft`, `readDraft`, `discardDraft`; and the rule that a draft reaches a signed note, a submitted claim or a posted financial fact only through the owning workstream's human command (`clinical Task 10`, `billing Task 6`), which records the signer separately from the model.

**Acceptance cases:** a request classified as containing patient data with no approved arrangement is refused and no outbound request is attempted, verified by observing the transport; a draft returned by the model is stored as a draft and cannot be signed by the AI principal, only by a human with `clinical.sign`; a signed note records the human signer and the draft reference plus model and prompt version, and the draft remains readable as a draft; a model timeout returns an explicit unavailable state with no partial draft persisted; a model response that fabricates a tooth, procedure or date not present in the source references is flagged by the reference check before the draft is offered; a hostile instruction embedded in an imported note does not change the tool destination, the scope set or the egress decision; disabling the AI port leaves every care workflow usable, proven by running the ordinary-day scenario with the port removed; an AI draft never appears as a completed clinical or financial fact without a human command.

**Failure and recovery:** a provider error is recorded as an availability failure on the draft record, not as a clinical event; a draft whose sources were later amended is marked stale rather than silently re-offered; a retry after an unknown provider outcome is bound to the same request identity so a duplicate draft is detectable; an egress policy evaluation that cannot classify the payload refuses by default.

**Observable completion condition:** the boundary suite proves a refused egress attempt with no outbound request, a draft that cannot be signed without a human command, and a complete care workflow with the AI port absent.

- [ ] Write the egress-refusal, no-human-signature, unavailability, fabrication and injection cases and confirm failure.
- [ ] Implement the port, the egress policy in front of it, draft records and the reference check against the synthetic provider.
- [ ] Run the scenario suite twice, once with the port available and once removed, and confirm care workflows are unaffected.
- [ ] Record the arrangement status honestly in `docs/ai/` and commit; provider egress remains blocked on A-S2.

### A12: Evaluation harness, red-team corpus and failure handling

**Dependencies:** A11; A-S3. **Status:** implementation of the harness; the acceptance threshold requires a human decision.
**Files (proposed):** `packages/ai/eval/runner.ts`, `packages/ai/eval/cases/`, `packages/ai/eval/red-team/`, `docs/ai/evaluation.md`, `tests/integration/ai-eval-gate.test.ts`.
**Contract:** `EvalCase = { caseRef: string; class: 'faithfulness' | 'refusal' | 'minimization' | 'injection' | 'availability' | 'latency' | 'cost'; input: unknown; expectations: readonly string[] }`; `runEval({ modelRef, promptVersionRef, caseSetVersion })` returning an `EvalRun`; `evaluateGate(run)` returning pass, fail or inconclusive against the recorded threshold; the rule that a change to a prompt version or model reference requires a new run identity before the capability is offered.

**Acceptance cases:** a prompt version that regresses one refusal case fails the gate rather than passing on aggregate; a fabricated detail absent from the source references is detected and attributed to its case; an output containing more patient detail than the purpose requires is detected as a minimization failure; a run with fewer repetitions than the recorded minimum is inconclusive rather than pass, because a non-deterministic model cannot be judged on one sample; a provider outage during a run is classified as availability and never aggregated into a quality verdict; a run against a case set whose version differs from the recorded one is refused; the harness records prompt version, model reference and case set version for every run and refuses to compare runs across versions; no eval result is presented as clinical validation.

**Failure and recovery:** a partially completed run reports per-case incompleteness rather than an aggregate score; a harness crash leaves the previous accepted run as the gate of record rather than clearing it; a case whose expectation cannot be evaluated automatically is marked manual and blocks the gate until a recorded human verdict exists.

**Observable completion condition:** the gate blocks a deliberately regressed prompt version, marks an under-repeated run inconclusive, and produces a run record that names the model, prompt version and case set version it judged.

- [ ] Write the regressed-prompt, fabrication, minimization, under-repetition and outage cases against the synthetic provider and confirm the gate currently passes them.
- [ ] Implement the runner, case classes and the gate with explicit inconclusive handling.
- [ ] Run the gate against a deliberately weakened prompt and confirm it fails with the case named.
- [ ] Publish the evaluation method and the honest limits in `docs/ai/evaluation.md`, then commit.

### A13: Prescribing operation envelope and refusal semantics

**Dependencies:** A4, A10; `clinical Task 8` for the medication review record. **Status:** blocked-on-discovery for any real partner; the envelope and refusal semantics are implementation.
**Files (proposed):** `packages/contracts/src/prescriptions/`, `packages/domain/src/prescribing/envelope.ts`, `packages/adapters/prescribing/port.ts`, `packages/adapters/prescribing/synthetic.ts`, `docs/integrations/prescribing-qualification.md`, `tests/integration/prescribing-envelope.test.ts`.
**Contract:** `PrescriberIdentity = { prescriberRef: string; credentialRef: string; verifiedAt: string; verificationSource: string }`; `createPrescriptionDraft`, `submitPrescription(ctx, envelope, { draftRef, proposalRef })`; `PrescribingPort` with an explicit `unsupported` outcome so an unqualified partner produces a refusal rather than an invented success; scopes `prescriptions.read`, `prescriptions.draft` and `prescriptions.submit`, with controlled-substance submission restricted to a human prescriber and never to an agent.

**Acceptance cases:** a submission without a verified prescriber identity is refused with the missing fact named; an agent cannot submit a prescription and the refusal is identical on REST and MCP; a controlled-substance path is refused when the partner does not report the capability, rather than proceeding; a partner returning `unsupported` leaves the draft intact and visible as unsubmitted; a prescription draft created by AI requires a human prescriber's command before submission; a submission without an approved proposal is refused; a partner timeout is recorded as unknown and reconciled by request identity, never retried as a new prescription; a cross-tenant prescriber reference is refused indistinguishably from a missing one.

**Failure and recovery:** an unqualified partner disables the submission operation for that deployment with a visible reason instead of failing per request; a verification that cannot be completed leaves the prescriber unverified rather than provisionally verified; a draft whose medication review record was superseded is marked stale and cannot be submitted.

**Observable completion condition:** the suite proves that no path submits a prescription without a verified human prescriber and an approved proposal, and that an unqualified partner yields a refusal naming the missing capability rather than a fabricated success.

- [ ] Write the unverified-prescriber, agent-submission, unsupported-partner and unknown-outcome cases and confirm failure.
- [ ] Implement the envelope, identity record and port with an explicit unsupported outcome.
- [ ] Run the suite with the synthetic partner reporting the capability absent and present.
- [ ] Record the partner status and the explicit non-claim in the qualification note, then commit.

### A14: Webhook subscriptions with signing, retries, replay and dead-letter

**Dependencies:** foundation Tasks 4 and 6; A-S4; A-D7. **Status:** implementation; the registration model requires a human decision.
**Files (proposed):** `packages/domain/src/webhooks/subscriptions.ts`, `packages/domain/src/webhooks/signing.ts`, `packages/domain/src/webhooks/delivery.ts`, migration via `supabase migration new webhook_subscriptions`, `docs/api/webhooks.md`, `tests/integration/automation-webhooks.test.ts`.
**Contract:** `WebhookSubscription` and `WebhookDelivery` as above; `signDelivery({ bodyBytes, timestamp, secret })` producing a signature over the exact transmitted bytes including the timestamp; `recordDeliveryOutcome`; `replayDelivery({ deliveryId })` issuing a new delivery identity for the same event; `assertAllowlisted(endpointRef)`; a documented deduplication key of event identity with a stated retention window.

**Acceptance cases:** a signature computed over re-serialized bytes rather than the transmitted bytes fails verification, and the suite proves the verifier uses the received bytes; a delivery with a timestamp outside the replay window is refused; two subscriptions with the same endpoint and event version are rejected; an event whose payload changed shape produces a new event version while the previous version still delivers to consumers that selected it; a duplicated provider callback reusing one event identity is deduplicated and recorded as a repeat; a replayed delivery keeps the event identity and receives a fresh signature timestamp so a consumer can distinguish replay from forgery; an endpoint outside the allowlist cannot be registered; a secret rotation is supported with an overlap period in which both verify; the delivery payload carries no patient name, note text or credential by default; a dead-lettered delivery is listed with its attempt count and last response class.

**Failure and recovery:** a consumer that returns a success status for a body it did not process cannot be detected, which is documented as a consumer obligation rather than claimed as handled; a delivery interrupted after the consumer acted but before the acknowledgement is retried with the same event identity and the consumer's deduplication must absorb it; an endpoint that fails repeatedly is dead-lettered after the bounded attempt set rather than retried indefinitely; an allowlist entry removed while deliveries are queued pauses those deliveries instead of sending to a now-unlisted host.

**Observable completion condition:** the suite verifies a delivery from its received bytes, refuses an out-of-window timestamp, deduplicates a repeated event identity, and lists a dead-lettered delivery with its attempts.

- [ ] Write the byte-signing, window, duplicate, version, allowlist and dead-letter cases and confirm failure.
- [ ] Implement subscription registration, signing, delivery records and the replay command over the foundation's durable worker.
- [ ] Run the suite with a deliberately re-serialized body and confirm verification fails.
- [ ] Publish the consumer contract, including the deduplication key and its retention, then commit.

### A15: Export surface, complete and machine-readable without a special tier

**Dependencies:** A4; `migration Task 1` for the format and manifest; A-S4; A-D8. **Status:** implementation of the request, build and delivery path; the format document and manifest validation remain owned by `migration Task 1`.
**Files (proposed):** `packages/domain/src/export/requests.ts`, `packages/domain/src/export/build.ts`, `packages/domain/src/export/delivery.ts`, `apps/worker/src/export-build.ts`, `docs/api/export.md`, `tests/integration/automation-export.test.ts`.
**Contract:** `ExportRequest` as above; `requestExport(ctx, envelope, { scope, subjectRef, formatVersion })`; `buildExport(requestRef)` producing an artifact set with checksums and a manifest validated by `migration Task 1`; `deliverExport` issuing a short-lived scoped location; `assertExportCompleteness(requestRef)` comparing delivered entity classes against the audit registry so an omission fails rather than shortens. Export is granted by the ordinary scope `exports.create`, which every deployment includes; there is no entitlement check on this path and the suite proves it.

**Acceptance cases:** a tenant-scope export includes every registered auditable entity class with at least one synthetic row; an export missing one entity class fails its own completeness check and is not delivered; a patient-scope export of another tenant's patient is refused indistinguishably from a missing patient; the artifact carries checksums the receiver can verify without our tooling; a delivery location expires and a second use after expiry is refused; a user whose access was revoked during a build cannot download the completed artifact; the build resumes after a worker restart without duplicating or truncating an entity class; the export path contains no entitlement, plan or feature-key evaluation, proven by the operation descriptor and by a test that runs with entitlements disabled; the format version is stated in the manifest and an unknown format version is refused.

**Failure and recovery:** a build that fails partway leaves a failed request with its diagnostic and no partial artifact presented as complete; a delivery interrupted mid-download is resumable or restartable with the same artifact identity; an entity class that cannot be read reports the gap in the manifest rather than omitting it silently.

**Observable completion condition:** a complete synthetic tenant export passes its own completeness check and verifies from its checksums, an export with one entity class removed fails, and the operation descriptor shows no entitlement gate.

- [ ] Write the missing-class, cross-tenant, expired-location, revoked-mid-build and entitlements-disabled cases and confirm failure.
- [ ] Implement the request, build and delivery path consuming the format owned by `migration Task 1`.
- [ ] Run the suite with a deliberately truncated artifact and confirm the completeness check blocks delivery.
- [ ] Publish the export procedure for an operator and a receiver, then commit.

### A16: Analytics read contracts with declared measures, freshness and suppression

**Dependencies:** A4; `billing Task 9` for report scopes and `scheduling Task 16` for recall; A-S4 for consumer needs. **Status:** implementation; measure definitions require business review.
**Files (proposed):** `packages/domain/src/reporting/measures.ts`, `packages/domain/src/reporting/projections.ts`, migration via `supabase migration new reporting_measures`, `docs/api/analytics.md`, `tests/integration/automation-analytics.test.ts`.
**Contract:** `MeasureDefinition` as above; `registerMeasure`, `readMeasure(ctx, { measureKey, filters, asOf })` returning a value with its definition version, its as-of instant and its freshness; `assertMeasurable(measureKey)`; a suppression floor per tenant configuration so a measure over a population below the floor reports as suppressed with no precise value; report access guarded by the scope the measure declares, including `analytics.read` and the financial scopes owned by `billing Task 9`.

**Acceptance cases:** a measure without a registered definition cannot be served; a reported value resolves to one definition version and states its as-of instant and its date basis; a zero denominator reports an explicit undefined state rather than zero; a population below the suppression floor reports suppressed and provides no value that would allow the reader to derive it; a principal holding patient-read but not `analytics.read` is refused the measure identically whether or not the population is empty; a principal holding `analytics.read` but not `receivables.read` is refused a receivables measure, because aggregation is not authorization; a measure spanning two tenants returns a tenant-scoped result for the caller's tenant and never a combined figure; a definition change creates a new version and does not retroactively change a previously reported figure's meaning; a stale projection reports stale with its as-of instant rather than presenting as current.

**Failure and recovery:** a projection that cannot be rebuilt serves the last verified instant marked stale rather than a partial number; a rebuild that fails leaves the previous projection readable and raises a visible failure; a measure whose definition was retired cannot be read under an ambiguous name and must name its version.

**Observable completion condition:** every served value names its definition version, as-of instant and freshness, an undefined state is distinguished from zero, and a scope-denied measure is refused identically for empty and non-empty populations.

- [ ] Write the undefined, suppressed, mixed-scope, cross-tenant and stale cases and confirm failure.
- [ ] Implement measure definitions, projections and scope-guarded reads.
- [ ] Run the suite and confirm no measure is served without a definition version.
- [ ] Publish the measure catalog with owners and commit.

### A17: Administration surface for audit search, access review and revocation

**Dependencies:** A4; foundation Task 4; `imaging Task 8` for retention and legal hold; `portal Task 1` for portal principals. **Status:** implementation.
**Files (proposed):** `packages/domain/src/administration/audit-search.ts`, `packages/domain/src/administration/access-review.ts`, `packages/domain/src/administration/revocation.ts`, `docs/api/administration.md`, `tests/integration/automation-administration.test.ts`.
**Contract:** `searchAudit(ctx, filter)` over actor, principal kind, time range, operation and resource class, where the search itself writes an audit row; `recordAccessReview`, `listReviewObligations`; `revokeAccess(ctx, envelope, { principalRef, kind, reason })` propagating to sessions, agent principals, service accounts, portal grants and device credentials; `terminateSessions(ctx, { principalRef })` as an incident tool; retention and legal-hold commands consumed from `imaging Task 8` rather than redefined.

**Acceptance cases:** an audit search by a principal without `audit.read` is refused and the attempt is itself recorded; a search cannot modify, restore or delete any source record, proven by comparing table state before and after; a search filter naming another tenant returns nothing and does not reveal whether matches exist elsewhere; a revoked staff principal cannot call REST, cannot call MCP, cannot continue a queued job, cannot use an already-issued export location and cannot read storage through a previously signed reference; a revoked portal grant denies the portal projection without deleting the patient record; an access review recorded by a principal whose own membership was revoked is refused; a break-glass action is recorded with its reason and appears in the review obligations; a service account revocation prevents the next job execution rather than only future issuance.

**Failure and recovery:** a revocation that fails for one principal class reports per class and does not report success overall; an audit search that cannot complete reports the gap rather than an empty result implying no events; a session termination that partially completes lists the remaining sessions instead of claiming all ended.

**Observable completion condition:** a revoked principal is refused on every surface in one run, audit search leaves source records byte-identical, and the revocation attempt records one result per principal class.

- [ ] Write the audit-read, no-restore, cross-tenant, full-revocation and partial-failure cases and confirm failure.
- [ ] Implement audit search, access review records and revocation propagation across all principal classes.
- [ ] Run the revocation exercise against a principal holding sessions, a queued job, an export and a signed storage reference.
- [ ] Commit; the administration scope grants remain subject to A-D2.

### A18: Daily huddle projection under a shared-display privacy rule

**Dependencies:** A4, A16; `scheduling Tasks 10, 11 and 16`, `clinical Tasks 10, 14 and 16`, `billing Tasks 2 and 9`, `portal Task 3`. **Status:** implementation; the shared-display policy requires practice sign-off.
**Files (proposed):** `packages/domain/src/huddle/sections.ts`, `packages/domain/src/huddle/projection.ts`, `docs/api/huddle.md`, `tests/integration/automation-huddle.test.ts`.
**Contract:** `HuddleSection` as above; `readHuddle(ctx, { locationRef, onDate, display: 'staff' | 'shared' })` returning sections for today's bookings by resource, arrivals and exceptions, unconfirmed bookings, unsigned notes, prior-day unfinished care, lab cases due, recall due, pending portal requests, and open claims and undistributed funds — each section declaring its own required scope, its own as-of instant and its own freshness. A section the caller may not read returns `notPermitted` with no count and no items. In `shared` display mode patient identity is suppressed to an initial and a resource, and clinical detail is omitted entirely.

**Acceptance cases:** a caller lacking `receivables.read` sees the financial section as not permitted rather than as zero; a section whose projection is stale reports stale with its as-of instant and is not presented as current; a cross-tenant read is refused; the `shared` display mode exposes no patient name, no clinical detail and no financial detail, proven by inspecting the whole response for the fixture's identity markers; a huddle request writes an audit row for the clinical and financial sections read rather than for the page view alone; the section set a role can see matches the scopes granted to that role, proven per role rather than for one superuser; a section whose upstream workstream is unavailable reports unavailable rather than empty; the same date in two location zones produces different section contents, and the response names the zone used.

**Failure and recovery:** one upstream section that fails does not blank the whole projection; it reports unavailable with the upstream named. A projection rebuilt after an amendment shows the amendment rather than a cached item. A shared display left open across a session expiry stops refreshing rather than continuing to serve stale patient context.

**Observable completion condition:** the suite shows a per-role section set drawn from granted scopes, a not-permitted section carrying no count, and a shared-mode response containing no patient identity or clinical detail.

- [ ] Write the not-permitted-versus-zero, stale, shared-display, per-role and zone cases and confirm failure.
- [ ] Implement sections and the projection over each owning workstream's read contract without duplicating its rules.
- [ ] Run the per-role suite and confirm each role sees exactly its permitted sections.
- [ ] Record the shared-display policy and obtain practice sign-off, then commit.

### A19: Close-out — capability coverage, no-tier attestation and parity evidence

**Dependencies:** A1–A18; the operation descriptors published by `billing Tasks 1–9`, `imaging Tasks 1–8` and `portal Tasks 1–8`; the parity evidence from `scheduling Task 17` and `clinical Task 18` where those plans publish it; `migration Task 1` for the export format. **Status:** implementation of evidence; the release decision belongs to [supported release](2026-11-04-supported-release.md).
**Files (proposed):** `docs/api/capability-coverage.md`, `docs/api/no-tier-attestation.md`, `tests/integration/api-coverage.test.ts`, `tests/integration/api-no-tier.test.ts`.
**Contract:** `describeCoverage()` comparing the capability matrix rows this plan owns against the operation catalog and naming each row's owning operation or its gap; `assertNoEntitlementGate()` scanning every descriptor for entitlement, plan or feature-key evaluation and failing on any occurrence; `describeHiddenOperations()` comparing transport routes against the catalog so no UI-only business operation exists.

**Acceptance cases:** every capability row this plan owns — API and MCP parity, AI assistance, prescribing, analytics, administration and the daily huddle — resolves to at least one operation and one negative case; a row with no operation is reported as a gap rather than omitted; an operation reachable from a transport but absent from the catalog fails the hidden-operation check; an entitlement evaluation added to any descriptor fails the attestation; a scope used by an operation but absent from the published registry fails the coverage check; the count of supported operations with an MCP surface, and the count without, are both reported rather than only the favorable one.

**Failure and recovery:** a coverage run that cannot read one workstream's descriptor set reports that workstream as unknown rather than as covered; an attestation that cannot complete fails rather than passing by absence of findings; a gap found after publication is appended to the coverage document with its date rather than edited away.

**Observable completion condition:** the coverage document reports every owned capability row as covered by a named operation or as an explicit gap, and the no-tier attestation passes with a deliberately added entitlement check failing it.

- [ ] Write the coverage, hidden-operation, entitlement and unknown-workstream cases and confirm failure.
- [ ] Implement coverage description and both attestations over the descriptor set.
- [ ] Run the suite with a deliberately injected entitlement check and a hidden route and confirm both are detected.
- [ ] Publish the coverage document and the attestation, then hand both to the release gate registry in `R1`.

## Plan self-review and scope boundary

This plan publishes the operation surface, the scope registry, the parity and refusal matrix, agent identity, AI boundaries and evaluation, the prescribing envelope, webhook delivery, the export surface and the read surfaces for analytics, administration and the huddle. It does not define a patient, appointment, clinical, financial, imaging, portal or migration aggregate; those remain owned by their plans and are consumed by reference, per [shared contracts](../../SHARED-CONTRACTS.md).

It does not assert an MCP authorization revision, a model-provider arrangement, an evaluation threshold or any provider capability, because none has been verified. A11, A12, A13, A14 and A15 carry parts that are blocked-on-discovery, and the remote MCP transport in A9 is not claimed until A-S1 closes. A19 reports gaps as gaps.

No UI layout, screen design or interaction design is included. The huddle projection in A18 describes a contract and a privacy rule, not a display. Nothing in this document is implemented, tested, validated, deployed or certified.
