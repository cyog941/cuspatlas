# Practice export format (`cuspatlas-practice-export/1`)

Status: implemented and tested on synthetic data (M1). A real incumbent export stays blocked on M-S1;
nothing here is a compliance or completeness claim for a production practice.

## Purpose

The easy-exit commitment (MG-03): a practice can take every record it owns out of CuspAtlas in one
documented, versioned package without a feature key, and the package can be checked and re-imported.

## Operations

| Operation | Surface | Who |
|---|---|---|
| `practice.export.create` | `POST /v1/practice/exports`, MCP `practice_export_create` | tenant-wide human administrator (`admin.configure`) |
| `practice.export.grant` | `POST /v1/practice/exports/grants`, MCP `practice_export_grant` | same |
| `practice.export.download` | `POST /v1/practice/exports/package`, MCP `practice_export_download` | holder of a live grant |
| `practice.export.verify` | `GET /v1/practice/exports/verification`, MCP `practice_export_verify` | same |

Creation composes the five domain exports as the same caller (each re-authorizes and records its own
sensitive read), checks every table's row count against the live tenant and refuses a partial package
(`409 export_incomplete`, naming each table). The package is stored privately, content-addressed; the
storage key never leaves the service. Delivery is a separate grant of at most 300 seconds bound to the
caller and the export; the token is never stored or logged. Every download is sensitive-read logged.

## Package

```
{ "manifest": Manifest, "documents": [S17, I9, C18, E9, B10] }
```

Documents appear in the platform import order (scheduling, imaging, clinical, engagement, billing).
B10 carries the migration opening chain (opening items, the staged records they repeat, their
package and profile). Imaging bytes are not inline: they travel as I9 blob bundles
(`GET /v1/imaging/export/blobs`), each verified against the digest the manifest lists.

Manifest fields:

- `format`: `cuspatlas-practice-export/1`. An unknown version is refused, never best-effort parsed; a
  format change is a new version and never reinterprets an old package.
- `exportRef`: tenant-free identifier of the export. No tenant identifier appears anywhere in the
  package (rows carry no `tenant_id`; the importer supplies the target tenant).
- `exportedAt`: server time of creation.
- `documents[]`: `format`, `digestSha256` (SHA-256 of the canonical JSON of `{format, tables}`, keys
  sorted at every depth; the export time is not content) and `tables` (row count per table).
- `blobs[]`: `digestSha256` and `byteLength` of every available imaging object's bytes.
- `terminology`: `system` (`cuspatlas-synthetic-provisional`), `licensed: false`, and the code
  versions referenced by exported rows. No licensed terminology dataset is exported or required.
- `provenance`: generator and import order.

## Completeness validation

`validatePracticeExport(package, { tenantId? })` (domain) accepts a package only when the version is
known, every document and every table of each format is present, every count and digest matches, the
blob list matches the I9 document and no tenant identifier appears. The first failure is returned
with the entity named: `unknown_version`, `empty_manifest`, `missing_entity` (`<format>` or
`<format>:<table>`), `count_mismatch`, `digest_mismatch`, `tenant_mismatch`.

`practice.export.verify` re-reads the stored bytes (verified against their digest), runs the
validator (`failed` otherwise), then exports the live tenant again and names every table whose count
or document whose digest differs (`drifted`); `verified` only when nothing differs.

## Re-import

`importExports(adminClient, targetTenant, package.documents)` and `importImagingBlobs` load a package
into a fresh synthetic database and object store (superuser, synthetic-only). The round-trip test
re-exports the target and obtains the same manifest apart from `exportRef` and `exportedAt`.

## Not in the package

Read and delivery grants, ingress sessions, bridge devices and jobs, the migration workspace (review
items, applied records, reports, sign-offs; see the migration export), and tenancy (tenants,
principals, memberships: the operator provisions those on the target).

# Export surface (`exports.*`, A15) and the scoped format (`cuspatlas-export/1`)

Status: synthetic implementation (workstream A batch 4); what "complete" means (A-D8) is
recommended-pending-approval, and no external receiver has reviewed the format (A-S4).

## Operations and authorization

| Operation | Principal | Scope | Effect |
| --- | --- | --- | --- |
| `exports.create` | human | `exports.create` | Request and build one export (a job: `building`, then `ready` or `failed`). |
| `exports.list`, `exports.read` | human, service | `exports.read` | Request metadata, state, digests, diagnostics and the manifest; never contents. |
| `exports.grant` | human | `exports.create` | A delivery grant of at most 300 s bound to the caller and the export (token never stored). |
| `exports.download` | human | `exports.create` | The package to the holder of a live grant (sensitive-read logged). |

- **No special tier.** `exports.create` is an ordinary scope in the same registry as every other
  scope. No licence, plan, entitlement or feature key is evaluated anywhere on this path; the catalog
  descriptors carry none (proven in `tests/integration/automation-negative-harness.test.ts`), and
  every request and manifest states `licenceGate: "none"`.
- Each composed module export (S17, I9, C18, E9, B10) is called as the caller and re-authorizes for
  its own action, so a patient export respects every module's authorization (today each module export
  requires a tenant-wide human administrator). A module refusal fails the request (diagnostic = the
  refusal code) and returns that refusal; nothing partial is stored.
- Agents and services can never request, grant or download an export (human-only policy rows, REST
  and MCP alike). Another tenant's patient is refused exactly like a missing one (404).
- Access is checked again at grant and at download: a caller whose scope was removed after the build
  cannot download the finished artifact.

## Scopes

- `practice`: the whole tenant, delegated to M1 (`practice.export.create`) as the same caller; the
  artifact is the `cuspatlas-practice-export/1` package described above, linked by reference, and it
  downloads through the M1 grant and download. Purposes: `practiceExit`, `verification`,
  `archiveCopy`.
- `patient` (`subjectRef`): the right-of-access export of one patient across S, I, C, E and B.
- `domain` (`domain`: `scheduling`, `imaging`, `clinical`, `engagement` or `billing`): one module
  document.

## `cuspatlas-export/1` package

```text
{ manifest: {
    format: "cuspatlas-export/1", exportRef, exportedAt,
    scope: { kind: "patient", subjectRef } | { kind: "domain", domain },
    documents: [ { format, digestSha256, tables: { <table>: <row count> } } ],
    blobs: [ { digestSha256, byteLength } ],
    licenceGate: "none",
    completeness: { basis } },
  documents: [ <module export document: { format, exportedAt, tables: { <table>: [rows] }, blobs? }> ] }
```

- Documents are the module formats of the M1 registry in the platform import order (patient: all
  five; domain: exactly one). `digestSha256` is the M1 document digest: SHA-256 of the canonical JSON
  (keys sorted, no whitespace) of `{ format, tables }`, so a receiver verifies it with any JSON
  canonicalizer and SHA-256, without our tooling. The package and manifest digests are returned by
  `exports.create` and `exports.read`.
- No tenant identifier appears anywhere in a package.
- Patient filter: a row is in a patient package when it is the patient row, when one of its
  patient-link columns (`patient_id`, `subject_patient_id`, `survivor_patient_id`, ...) is the patient,
  or (rows without a patient link) when one of its `*_id` columns references a row already included. A
  row whose patient links name only other patients never enters, so a shared account or relationship
  cannot pull another patient's records in. Reference data (locations, fee schedules, templates) that
  references no included row is left out by design. Imaging blob digests are kept for the patient's
  own objects; the bytes travel as I9 blob bundles (`imaging.export.blobs`).

## Scoped completeness validation

`validateScopedExport(pkg, { subjectRef?, tenantId? })` (packages/domain/src/automation/exports.ts)
accepts a package only when the format version is known; the documents are exactly those of the scope
in order; every table of each format is present with the manifest's row count and no extra table;
each document digest matches; no tenant identifier appears; and, for a patient package, every row
belongs to the subject. Refusals name the entity: `unknown_version`, `empty_manifest`,
`missing_entity`, `count_mismatch`, `digest_mismatch`, `tenant_mismatch`, `foreign_patient`. The build
runs the same validator; a failing build is recorded `failed` with the reason as its diagnostic and no
artifact is ever delivered (`exports.grant` answers 409 `export_not_ready`).

## Not yet

- The build runs in the request (job rows and audit transitions exist; a worker-driven, resumable
  build is not implemented).
- The module exports read the whole tenant before the patient filter, and each records its own
  tenant-wide sensitive read; a patient-scoped read path per module is future work.
- Per-patient imaging bytes are named by digest only; a filtered blob bundle is future work.
