# Tab32 HTTP surface: shapes and conventions

Status: read-only observation, 2026-11-03 evening ET, authenticated session in a dedicated Chrome profile. Method: intercepted XHR/fetch request metadata while navigating 12 authenticated routes.

Retained: HTTP method, normalized path, request body **key names**, response top-level **key names**, status codes. Not retained: headers, cookies, body values, response values, or any record content. Raw local capture is in the ignored `.research-local/` folder. No request was replayed, modified or re-sent.

All 96 observed responses were `200`. Error behaviour is therefore **unobserved** and must not be assumed.

## Envelope and conventions

- Every business response uses a two-key envelope: `{ status, data }`. `status` is carried in the body even though HTTP also returned 200, so callers must check both.
- Base path is `/api/tab32ac/`.
- **The session token is a URL path segment**, and the clinic id is usually the next one: `/api/tab32ac/<resource>/{token}/{clinicId}`.
- Verbs are inconsistent: the same path shape answers `GET`, `POST` and `PUT` for different operations (`/api/tab32ac/{token}/{clinicId}` accepts all three with different meanings).
- Several endpoints put the token in a body field or omit the clinic id entirely, for example `POST /api/tab32ac/claims/getAppealStatus` with `{clinic_id}` and `POST /api/tab32ac/patients/findPatientsByIds` with `{patient_ids, projection}`.
- `paginationContext` appears in the claims filter body, implying cursor-style paging rather than offset paging.
- `projection` appears on the patient bulk-fetch, implying caller-selected field sets.
- `subjectIds` recurs across claims, custom fields and x-ray calls, implying a shared "subject" abstraction reused across domains.

## Endpoint inventory

### Session and identity

| Method | Path | Purpose |
|---|---|---|
| GET | `/loggedIn` | session check |
| GET | `/api/app/info` | client bootstrap |
| POST | `/api/tab32ac/user/{token}` | user resolution; body `userEmail, clinicIds` |
| POST | `/api/tab32ac/security/check2faStatus/{clinicId}` | 2FA state |
| GET | `/api/tab32ac/clinicUsers/isPinSet/{clinicId}/{email}` | per-user PIN state |
| PUT | `/api/tab32ac/clinicUsers/getClinicUsers/{clinicId}` | staff roster |
| GET | `/api/tab32ac/resourceAccess/{token}/{clinicId}` | access/role data |
| POST | `/api/tab32ac/userPreferences/getUserPreferences` | body `clinic_id, userEmail` |
| POST | `/api/tab32ac/environment` | body `keys` |

### Scheduling

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/api/tab32ac/scheduler/{token}/{clinicId}` | read and mutate scheduling state; POST body was not JSON |
| POST | `/api/tab32ac/scheduler/getClinicSlots/{clinicId}` | slot availability; body not JSON |
| GET | `/api/tab32ac/getAppointmentTypes/{clinicId}` | appointment type catalog |
| GET | `/api/tab32ac/chairProviderGroups/{token}/{clinicId}` | chair/provider grouping |
| PUT | `/api/tab32ac/dashboard/{token}/{clinicId}` | huddle data |
| POST | `/api/tab32ac/landing/{token}` | body `date, start, end, type, countTypes, clinic_id` |

### Patients and clinical records

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tab32ac/patients/findPatientsByIds` | bulk fetch; body `patient_ids, projection` |
| POST | `/api/tab32ac/customFields/{token}/{clinicId}` | body `schemaName, subjectIds` |
| POST | `/api/tab32ac/xray/{token}/{clinicId}` | imaging; bodies `patientIdList` and `indexedXraysCount, failedXraysCount, patientCount, machine_id` |
| POST | `/api/templates/list/{clinicId}` | note templates; body `userEmail` |
| GET | `/api/tab32ac/careTeam/getCareTeams/{clinicId}` | care team |

### Financial

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tab32ac/ledger/{token}/{clinicId}/all` | ledger read |
| GET | `/api/tab32ac/billingStatus/{token}/{clinicId}` | billing status |
| POST | `/api/tab32ac/paymentplan/{token}/{clinicId}` | body `planStatus, selectedLocationId, isOrtho` |
| PUT | `/api/tab32ac/clinicFees/getClinicFeeTypes/{clinicId}` | fee schedule |

### Claims

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tab32ac/claims/{token}` | claim search; body includes `clinic_id, locationId, billing_dentist, treating_dentist, provider, agingType, claimStatusCodes, completed, startDate, endDate, paginationContext, searchStr, insuranceCarriers, claimProcessor, usersOfClaimGroups, isOrthoClaims, dateType, resourceUniqueKey` |
| POST | `/api/tab32ac/claims/{token}/{clinicId}` | claim detail by `subjectIds` |
| GET | `/api/tab32ac/claims/getClaimStatus/{clinicId}` | status catalog |
| GET | `/api/tab32ac/claims/getDenialCodes/{clinicId}/undefined` | denial codes |
| POST | `/api/tab32ac/claims/getAppealStatus` | appeal statuses; body `clinic_id` |
| POST | `/api/tab32ac/insurance/{token}/{clinicId}` | insurance |
| POST | `/api/tab32ac/bo/{token}/{clinicId}/DrFirstAccount` | prescribing/benefits integration; body `query` |

### Reporting and audit

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tab32ac/t32Report/getReports/{clinicId}` | report catalog; body `reportScope` |
| PUT | `/api/tab32ac/customReport/getCustomReports/{clinicId}/clinic` | custom reports |
| GET | `/api/tab32ac/audit/{token}` | audit read |
| PUT | `/api/tab32ac/dashboard/getFinancialData/{clinicId}` | financial dashboard |

### Collaboration and add-ons

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tab32ac/im/{token}/{clinicId}` | instant messaging |
| PUT | `/api/tab32ac/todoTask/{token}/{clinicId}` | tasks |
| POST | `/api/communication/get_unread_count` | body `clinic_id, location_id` |
| POST | `/api/tab32ac/hellopatient/config/{clinicId}` | HelloPatient config |
| PUT | `/api/tab32ac/helloPatient/{token}/{clinicId}` | HelloPatient settings |
| GET | `/api/tab32ac/sidekick/subscription/getSubscriptionInfo/{clinicId}` | add-on subscription |
| POST | `/api/prompts/list/{clinicId}`, `/api/prompts/get/{clinicId}` | prompt library; bodies `userEmail`, `prompt_ids` |
| POST | `/api/fileUpload/getFileUploadType` | body `clinic_id, category` |
| PUT | `/api/tab32ac/customReport/...`, `POST /api/tab32ac/color/getColorState` | misc config |

## Observations that shape our design

These are engineering judgements from observed shape, not claims about vendor internals.

1. **The session token travels in the URL path.** That puts a bearer credential into access logs, proxy logs, browser history, `Referer` values and any support screenshot. Our API must take credentials in an `Authorization` header and keep them out of paths, and our own gateway must scrub query/path tokens from logs as a rule, not as an afterthought.

2. **Tenant is addressed by the client, not implied by the credential.** Every call names a clinic id, and the token is not obviously bound to one. Whether the server rejects a clinic id the token does not cover is an enforcement question we **cannot test here** — and it is exactly the negative cross-tenant test our readiness gates already require.

3. **Verb overload on one path.** Using `GET`/`POST`/`PUT` on `/api/tab32ac/{token}/{clinicId}` for unrelated operations makes an API contract hard to describe, hard to scope and hard to audit. Our versioned contract should map one operation to one explicit resource path, with verbs that match intent.

4. **`paginationContext` implies opaque cursors.** Good choice; adopt it explicitly rather than inheriting offset paging, and document that cursors are opaque and short-lived.

5. **`projection` on bulk patient fetch is a real capability we should match.** It is the difference between a usable integration surface and one that dump-pipes whole charts. Our API needs caller-selected field sets with a safe default and an explicit maximum.

6. **`subjectIds` is a generic subject abstraction.** Claims, custom fields and imaging all address records by subject. Our model should name this concept rather than inventing per-domain id lists.

7. **Feature areas are visible in namespaces.** `sidekick/subscription`, `hellopatient`, `prompts`, `bo/DrFirstAccount` show that AI prompts, patient communication, e-prescribing and an add-on subscription live behind their own endpoints. For us these are modules with their own contracts and their own failure modes — not flags inside the core.

8. **Bootstrap exposes build and payment configuration.** `/api/app/info` returns `ver, commit, codeMinify, captchaPublicKey, stripePublicKey, stripeConnectClientId, stripeCallbackUrl, xdataUrl`. Exposing a `codeMinify` flag to the client is a debugging convenience that also advertises whether production code is minified. We should not expose build-mode flags to clients.

9. **`{status, data}` inside HTTP 200** means failure is not signalled by the transport. Any client we write — human UI, API consumer or agent — must branch on the body status, and our own API should use HTTP status codes honestly so that generic clients can retry and alert correctly.

## Unknowns

- Error semantics: validation failures, permission denials, conflicts and rate limits are all unobserved, because no failing request was made.
- Whether CSRF or origin checks protect state-changing calls (cookie-vs-bearer scheme was not determined).
- Payload schemas: only key names were retained, not types or cardinality.
- Pagination cursor format and page-size limits.
- Rate limiting, idempotency keys and concurrency/versioning fields.
- Whether the audit endpoint supports complete history or only recent activity.

Settling any of these requires an authorized sandbox and a written test plan; none of it should be probed against production.
