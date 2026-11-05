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
