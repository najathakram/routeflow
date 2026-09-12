# Spec — GoHighLevel → RouteFlow lead handoff

- **Status:** IMPLEMENTED (2026-09-12; rebased onto master `d6e0e9e5`) · **Scale:** major · **ui:** true · **Base:** `83af7853`
- Companion artifacts in this dir: `discovery.md`, `ux-spec.md`, `test-plan.md`, `build-plan.md`, `context-pack.md`.
- External contracts (GHL API v2, header `Version: 2021-07-28`, base `https://services.leadconnectorhq.com`,
  `Authorization: Bearer <PIT>`) are fixed in §GHL below; the build must not invent endpoints beyond them.

## Priorities

P0 = pilot cannot ship without it · P1 = required for "no glitches" · P2 = polish inside this run.
Verification: U = unit spec (Jest, `apps/api`), W = web unit (Jest+RTL), C = contract script (sandbox, manual), M = manual in browser.

## Requirements

### Connection & configuration

- **R1 (P0, U)** An operator saves a Private Integration Token + Location ID for their tenant via
  `PATCH /crm/gohighlevel/connection {token, locationId}`. The token is stored AES-256-GCM encrypted
  (`EncryptionService.encrypt`) in `CrmConnection.secretCipher`; it is never returned by any endpoint (status
  exposes `tokenLast4` only) and never logged. Saving audits `crm.connection.saved`.
- **R2 (P0, U/C)** `POST /crm/gohighlevel/connection/test` calls `GET /locations/{locationId}`; on 2xx it stores
  `locationName`, sets `defaultRegion` from the location's `country` when present, sets status `CONNECTED`,
  clears `lastError`, returns `{ok:true, locationName}`. On 401 it sets `NEEDS_ATTENTION` with `lastError`
  "GoHighLevel rejected the token" and returns `{ok:false, reason}`. Other errors return `{ok:false, reason}`
  without changing status.
- **R3 (P0, U)** `GET /crm/gohighlevel/pipelines` proxies `GET /opportunities/pipelines?locationId=` and returns
  `[{id, name, stages:[{id, name, position}]}]`; stage objects missing `id`/`name` are dropped.
- **R4 (P0, U)** `PATCH /crm/gohighlevel/config` accepts `enabled`, `dryRun`, `triggerMode` (`STAGE`|`WON`),
  `pipelineId`, `stageId`, `stageName`, `startFrom` (ISO), `writeBackFields`, `writeBackTag`, `writeBackNote`,
  `markWon`, `defaultRegion` (ISO-3166 alpha-2). Defaults on first save: `enabled=false`, `dryRun=true`,
  `triggerMode=STAGE`, `startFrom=now`, write-back fields/tag/note `true`, `markWon=false`, `defaultRegion="US"` (owner ruling 2026-09-12: client region is USA).
  Enabling with `triggerMode=STAGE` and no `pipelineId`/`stageId` → 400. Audits `crm.config.updated`.
- **R5 (P1, U)** `DELETE /crm/gohighlevel/connection` wipes `secretCipher`, sets status `DISCONNECTED`,
  `enabled=false`; handoff history and `ImportExternalRef` links are kept. Audits `crm.connection.removed`.
- **R6 (P0, U)** Every tenant route is guarded `JwtAuthGuard, RolesGuard` + `@Roles(UserRole.OPERATOR)` and
  `AddonGuard` + `@RequireAddon("crm_gohighlevel")`; the key is registered in `addon-gate-registry.ts` with
  `state: "dark"`, today's `added`, the route list, the Platform-Admin grant path, and `reviewBy` = +6 months.
- **R7 (P1, U)** `GET /crm/gohighlevel` returns `{connection: {status, enabled, dryRun, triggerMode, pipelineId,
stageId, stageName, locationId, locationName, tokenLast4, startFrom, writeBackFields, writeBackTag,
writeBackNote, markWon, defaultRegion, lastPollAt, lastSuccessAt, lastError} | null, counts: {pending,
needsReview, created, linked, dryRun, failed}}`.

### Polling

- **R8 (P0, U)** A `@LeaderCron("*/3 * * * *", "crm-gohighlevel.poll")` job loads every connection with
  `enabled=true` and status `CONNECTED`, and for each runs `pollTenant(tenantId)` inside
  `TenantContextService.run(tenantId, …)` with its own try/catch: one tenant's failure never stops the others.
  `POST /crm/gohighlevel/sync` runs `pollTenant` for the caller's tenant synchronously and returns
  `{fetched, new, created, linked, needsReview, dryRun, failed}`.
- **R9 (P0, U)** `pollTenant` calls `GET /opportunities/search` with `location_id`, `limit=100`, `page` from 1,
  and either `pipeline_id`+`pipeline_stage_id` (`STAGE`) or `status=won` (`WON`); it follows `meta.nextPage`
  until absent, capped at 50 pages and a 120 s wall-clock budget per tenant (stop, record `lastError`
  "budget", continue next tick). Every GHL call has a 10 s timeout.
- **R10 (P0, U)** Cutoff: an opportunity is ignored when its trigger timestamp (`lastStageChangeAt` for `STAGE`,
  `lastStatusChangeAt` for `WON`, falling back to `updatedAt`) is earlier than `startFrom` — unless the poll was
  invoked with `ignoreCutoff=true` (R21).
- **R11 (P0, U)** Idempotency: `CrmHandoff` is unique on `(tenantId, provider, opportunityId)`. A handoff is
  attempted only for opportunity ids with no row, or a row in `WRITEBACK_PENDING`/`PENDING` past `nextAttemptAt`.
  The row is inserted `PENDING` before any external write; a unique-violation on insert is treated as "already
  handled" and skipped. Rows in `CREATED`, `LINKED`, `SKIPPED`, `DRY_RUN`, `NEEDS_REVIEW`, `FAILED` are terminal
  for the poll (UI retry can reopen them, R22).
- **R12 (P1, U)** Auth failure: any 401 from GHL during the poll sets the connection `NEEDS_ATTENTION` with
  `lastError`, aborts that tenant's poll, and — once per transition (`attentionNotifiedAt` null → set) — emails
  every active `OPERATOR`/`TENANT_ADMIN` user of the tenant via `EmailService.send` ("RouteFlow lost access to
  GoHighLevel — re-enter the token in Settings → GoHighLevel"). A successful Test (R2) resets the status and
  clears `attentionNotifiedAt`.
- **R13 (P1, U)** Transient failure: 429, 5xx, network error or timeout aborts that tenant's poll with
  `lastError` set; nothing else changes; the next tick retries. A 429 with `Retry-After` is recorded in
  `lastError` and the tenant is skipped until that time.

### Handoff (per new opportunity)

- **R14 (P0, U)** Fetch the contact with `GET /contacts/{contactId}`; a 404 marks the handoff `NEEDS_REVIEW`
  reason `contact-not-found`.
- **R15 (P0, U)** Match precedence, first hit wins: (a) `ImportExternalRef` (`CUSTOMER`, source `gohighlevel`,
  externalId = contactId); (b) `normalizeEmail(contact.email)` equals an existing non-deleted customer's
  `email` (case-insensitive, tenant-scoped); (c) `normalizePhoneE164(contact.phone, defaultRegion)` equals the
  normalized `phone` or `mobile` of an existing non-deleted customer; (d) `companyName` (or `name` when no
  company) equals `businessName` case-insensitively. A match → `LINKED`, `matchedBy` ∈ {ref, email, phone,
  name}: record the ExternalRef, assign the tag `GoHighLevel`, never change any customer field.
- **R16 (P0, U)** No match → `CREATED` via `CustomersService.create({ username, businessName: companyName ??
name, contactName: name, firstName, lastName, email: normalizeEmail(email) ?? undefined, phone: E.164 ??
raw, customerType: companyName ? "BUSINESS" : "INDIVIDUAL", notes, addresses })` where `username` =
  `slugUsername(businessName)` + `_n` suffix until no `User.username` collides (max 20 tries then a random
  6-hex suffix); `notes` = `From GoHighLevel · deal: <opportunity.name> · value: <monetaryValue> · source:
<opportunity.source | attributionSource.utmSource | attributionSource.campaign> · country: <country> ·
contact: <contact id>` trimmed to 2 000 chars; `addresses` = `[{label:"Billing", line1:address1,
city:city??"", state:state??"", zip:postalCode??"", isDefault:true, addressType:"BILLING"}]` only when
  `address1` is non-empty. The returned `tempPassword` is discarded and never logged. Then record the
  ExternalRef and assign tags `GoHighLevel` and `Needs onboarding`.
- **R17 (P0, U)** `NEEDS_REVIEW` (with `reason`) when: the contact has neither email nor phone
  (`no-identity`); `create()` throws `BadRequestException` (`identity-conflict`: email/username belongs to an
  existing user); the customer-cap error (`customer-cap`); any other exception from create (`create-failed`,
  message stored, no stack). Nothing was written to GHL in these cases.
- **R18 (P0, U)** Tags: `GoHighLevel` and `Needs onboarding` are looked up by exact name via `listTags()` and
  created with `createTag` only when absent (a P2002 on create is caught and the tag re-read); assignment uses
  `assignTag` (idempotent).
- **R19 (P0, U)** Write-back after `CREATED`/`LINKED`, each step skipped when its toggle is off, each idempotent:
  (1) ensure custom fields — `GET /locations/{id}/customFields?model=contact`; for each of
  `RouteFlow Customer ID` / `RouteFlow Link` / `RouteFlow Status` (fieldKeys `contact.routeflow_customer_id`,
  `contact.routeflow_link`, `contact.routeflow_status`) create with `dataType:"TEXT", model:"contact"` when
  missing; cache `{key: id}` in `customFieldIds`; (2) `PUT /contacts/{contactId}` with **only**
  `{customFields:[{id, field_value}]}` — values: customer id, `<webBaseUrl>/customers/<id>`, `Customer`;
  (3) `POST /contacts/{contactId}/tags {tags:["routeflow-customer"]}`; (4) if `noteWritten=false`,
  `POST /contacts/{contactId}/notes {body:"Customer created in RouteFlow: <link>"}` (or "linked to existing
  customer") then set `noteWritten=true`; (5) if `markWon`, `PUT /opportunities/{id}/status {status:"won"}`.
  The PUT body never contains `tags`, `firstName`, `lastName`, `email`, `phone` or `companyName`.
- **R20 (P1, U)** Write-back failure after the RouteFlow side succeeded → status `WRITEBACK_PENDING`,
  `attempts+1`, `nextAttemptAt = now + [1, 5, 15, 60, 240] min` by attempt; after 5 attempts → `FAILED` with
  reason. The poll retries `WRITEBACK_PENDING` rows whose `nextAttemptAt` has passed, resuming at the first
  incomplete step (the note is guarded by `noteWritten`).
- **R21 (P1, U)** Dry-run (`dryRun=true`): R14–R15 run (reads only); instead of R16–R19 the row becomes
  `DRY_RUN` with `payload = {action: "create"|"link", matchedBy?, preview: {businessName, contactName, email,
phone, address?}, writeBack: {fields, tag, note, markWon}}`; nothing is written to RouteFlow customers or to
  GHL; no tag, no notification, no audit row. Turning dry-run off later does **not** auto-replay `DRY_RUN`
  rows; the operator uses "Retry" (R22) or "Import existing" (R23).
- **R22 (P1, U)** `GET /crm/gohighlevel/handoffs?status&page&limit` (limit ≤ 100, newest first) returns rows
  with `{id, opportunityId, opportunityName, contactId, contactName, status, matchedBy, reason, customerId,
attempts, createdAt, processedAt}`. `POST /handoffs/:id/retry` reopens a `DRY_RUN`, `NEEDS_REVIEW`, `FAILED`
  or `WRITEBACK_PENDING` row (status → `PENDING` or `WRITEBACK_PENDING` when a `customerId` exists, `attempts=0`,
  `nextAttemptAt=now`) and processes it immediately, returning the new status. `POST /handoffs/:id/dismiss`
  sets `SKIPPED` with reason `dismissed` on `NEEDS_REVIEW`/`FAILED`/`DRY_RUN` rows only (else 409).
- **R23 (P1, U)** `POST /crm/gohighlevel/import-existing/preview` returns `{count, sample:[{opportunityName,
contactName, email, phone}] (≤ 20)}` of opportunities matching the trigger with no handoff row, ignoring the
  cutoff and without writing anything. `POST /crm/gohighlevel/import-existing` runs `pollTenant` with
  `ignoreCutoff=true` (dry-run still honoured) and returns the R8 counts.
- **R24 (P1, U)** Notification + audit on `CREATED`/`LINKED` (not dry-run): `RouteflowGateway.emitCrmHandoff
(tenantId, {customerId, customerName, status, source:"gohighlevel"})` to the tenant's `operators` room as
  event `crm.lead.handoff`; `AuditService.log({tenantId, userId:null, action:"crm.handoff.created"|
"crm.handoff.linked", entityType:"customer", entityId, meta:{opportunityId, contactId, matchedBy}})`.

### Identity helpers

- **R25 (P0, U)** `normalizeEmail(raw)` → trimmed, lower-cased, `null` when empty or without `@`.
  `normalizePhoneE164(raw, region)` → E.164 via `libphonenumber-js` `parsePhoneNumberFromString(raw, region)`
  when valid, else `null` (never throws). `slugUsername(name)` → lower-case, `[^a-z0-9]+`→`_`, trimmed of
  `_`, ≤ 30 chars, minimum 3 chars (pad with `crm`).

### Schema & repo invariants

- **R26 (P0, U)** `platform.prisma` gains `CrmConnection`, `CrmHandoff`, enums `CrmConnectionStatus
{CONNECTED, NEEDS_ATTENTION, DISCONNECTED}`, `CrmTriggerMode {STAGE, WON}`, `CrmHandoffStatus {PENDING,
CREATED, LINKED, WRITEBACK_PENDING, NEEDS_REVIEW, DRY_RUN, SKIPPED, FAILED}`; `Tenant` gets the back-relation;
  one migration; `MODEL_DOMAIN` maps both models to `platform`; `split-prisma-schema.mjs --check` passes.
- **R27 (P0, U)** Enum mirrors in `packages/types/api/enums.ts` (`CRM_CONNECTION_STATUS_VALUES`,
  `CRM_TRIGGER_MODE_VALUES`, `CRM_HANDOFF_STATUS_VALUES` + types), three `ENUM_TABLE` rows in
  `enum-parity.spec.ts`, `PINNED_PRISMA_ENUM_COUNT` +3; `no-bare-cron.spec.ts` count +1 with the new name;
  `prisma-mock.ts` `allModels()` gains `crmConnection`, `crmHandoff`; `addon-gate-registry.spec.ts` green.
- **R28 (P0, U)** `libphonenumber-js` is declared as a direct dependency of `apps/api` at the version already in
  the lockfile; `scripts/validate-lock-edges.mjs` stays green.

### Web

- **R29 (P0, W/M)** Settings → Integrations shows a "GoHighLevel" item (`/settings?tab=gohighlevel`); the tab
  renders per `ux-spec.md`: connect form, test, trigger picker, options, sync-now, handoff log with retry /
  dismiss, import-existing preview → confirm, status badge and banners; all states in ux-spec §States.
- **R30 (P1, W)** The operator bell handles `crm.lead.handoff` as type `crm` with title "New customer from
  GoHighLevel", description `<customerName> — finish onboarding`, and a link to `/customers/<customerId>`
  (new optional `href` on `AppNotification`, rendered as a link when present).
- **R31 (P2, M)** `/customers?tag=<tagId>` seeds the customers list tag filter on load.

### Docs & tooling

- **R32 (P1, M)** `docs/adr/0004-crm-lead-handoff.md` (0003 header template) records: polling on PIT over
  OAuth/webhooks, ledger idempotency, field ownership (GHL owns identity, RouteFlow owns the three fields +
  tag + notes), and the not-now list. `docs/runbooks/gohighlevel-client-setup.md` is the client one-pager
  (token click-path, scopes, paste, pick stage, test, dry-run review, enable).
- **R33 (P2, C)** `apps/api/scripts/crm-gohighlevel-check.mjs`: env-driven (`SMOKE_BASE_URL`, operator creds,
  `GHL_SANDBOX_TOKEN`, `GHL_SANDBOX_LOCATION_ID`), calls `assertTestTenant`, connects, syncs, asserts a
  handoff row and prints the result. Manual tool; not part of any Jest suite.

## Lifecycle sweep (core object = CrmHandoff; connection = CrmConnection)

create (poll / retry / import) · read (list, status counts) · edit (retry, dismiss) · delete (never; SKIPPED
instead) · permissions (operator + gate) · audit (R24, R1, R4, R5) · notification (R24, R12) · export
(non-goal) · reverse of create = dismiss / disconnect. Surfaces: empty (no connection, no handoffs), loading,
partial (write-back pending), error (needs attention), unauthorized (gate 403 → existing add-on message),
too-much-data (paginated log; 50-page poll cap), stale (last poll > 10 min ago while enabled → warning),
concurrent edit (last write wins on config; poll is single-leader).

## Non-goals (this run)

Two-way sync of any field · RouteFlow → GHL operational events (orders, deliveries, invoices) · OAuth
marketplace app / webhooks · GHL workflows, SMS or marketing automation · GHL invoices/payments/calendar ·
more than one GHL location per tenant · a custom field-mapping UI · mobile app changes · deleting RouteFlow
customers on GHL contact deletion · assigning `salesAgentId` from GHL `assignedTo`.

## Deploy day / entitlement / rollback

Additive migration only; no backfill. Gate `crm_gohighlevel` ships `dark`: routes allowed and logged; the
grant path is Platform Admin → Tenants → add-ons (`AddonService.enableAddon` writes the exact key the guard
reads). No connection rows exist on deploy day → the cron is a no-op. Rollback: disable the connection
(`enabled=false`) or revert; tables inert. Secrets: none at platform level (the PIT is per tenant, encrypted
with the existing `ENCRYPTION_KEY`).

## GHL — fixed external contract (from the official OpenAPI mirror)

- `GET /locations/{locationId}` → `{location:{id, name, timezone, country, …}}`
- `GET /opportunities/pipelines?locationId=` → `{pipelines:[{id, name, stages:[…]}]}`
- `GET /opportunities/search?location_id&pipeline_id&pipeline_stage_id&status&page&limit` →
  `{opportunities:[{id, name, monetaryValue, pipelineId, pipelineStageId, status, source, lastStageChangeAt,
lastStatusChangeAt, updatedAt, contactId, contact:{id, name, companyName, email, phone, tags}}],
meta:{total, nextPage, currentPage}}`
- `GET /contacts/{id}` → `{contact:{id, firstName, lastName, name, email, phone, companyName, address1, city,
state, country, postalCode, source, tags, customFields:[{id, value}], attributionSource:{utmSource, utmMedium,
campaign, referrer}}}`
- `GET /locations/{locationId}/customFields?model=contact` → `{customFields:[{id, name, fieldKey, dataType,
model}]}`; `POST /locations/{locationId}/customFields {name, dataType:"TEXT", model:"contact"}` →
  `{customField:{id, name, fieldKey}}`
- `PUT /contacts/{id} {customFields:[{id, field_value}]}` · `POST /contacts/{id}/tags {tags:[…]}` ·
  `POST /contacts/{id}/notes {body}` · `PUT /opportunities/{id}/status {status:"won"}`
- Errors: 401 `{statusCode:401, message, error:"Unauthorized"}`; 400/422 `{statusCode, message}`; 429 may carry
  `Retry-After`. Rate limit 100 req/10 s, 200 000/day per location.
