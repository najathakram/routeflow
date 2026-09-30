# Fable ruling — S4 test plan + S5 build plan (compact; the transcriber expands into the templates)

Run: `2026-09-11-crm-gohighlevel-handoff` · scale major · ui true · base `83af7853` · branch `feat/crm-gohighlevel-handoff`
· worktree `C:\ClaudeCode\routeflow\.claude\worktrees\rf-crm`. Requirements in `spec.md` (R1–R33), UI in `ux-spec.md`.
Hard repo facts: ts-jest **type-checks** (`apps/api` jest config inline in package.json, `rootDir: src`, `testRegex .*\.spec\.ts$`,
reporter `scripts/jest-campaign-reporter.cjs`); web tests are `apps/web/app/(dashboard)/settings/*.test.tsx` (Jest+RTL,
`apps/web/jest.config.js`); `config.urls.web` = `WEB_URL` (`apps/api/src/config/configuration.ts:120`); `libphonenumber-js@1.12.39`
is in `node_modules`; no `CONTEXT.md`, no `scripts/validate-code-map.mjs` on master.

## Risk classes

HIGH: `apps/api/src/crm/**` (secrets, tenancy, customer creation, external writes), `apps/api/prisma/schema/*.prisma`, migration,
`apps/api/src/billing/addon-gate-registry.ts`, `apps/api/src/gateways/routeflow.gateway.ts`. LOW: web, docs, types package.

## A. Test packages (authored before implementation; RED on assertions)

**Skeleton rule (so suites load and every test fails on its own value):** each test package also creates the module files it
imports as _skeletons_ — exported classes/functions with the agreed signatures whose bodies are `return undefined as never;`
(no logic, no TODO comments), and `apps/api/src/crm/crm.types.ts` with the plain-string unions `CrmHandoffStatus`,
`CrmConnectionStatus`, `CrmTriggerMode` (string literals, NOT `@prisma/client` — those enums do not exist until WP1). Tests
never import `@prisma/client` CRM enums; Prisma access is through hand-built `jest.fn()` model mocks
(`{crmConnection:{findUnique,findMany,update,upsert}, crmHandoff:{findUnique,create,update,findMany,count}, customer:{findFirst},
user:{findFirst,findMany}, importExternalRef:{...}}`) passed where `PrismaService` is injected, plus `forTenant: () => models`.
HTTP is mocked with `global.fetch = jest.fn()` (restore in `afterEach`).

| TP  | File (creates)                                                                                                                                                                                                                                                                                                              | Tests → R                           | Oracles (concrete)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TP1 | `apps/api/src/crm/crm-identity.spec.ts` (+ skeleton `crm-identity.ts`)                                                                                                                                                                                                                                                      | T1–T5 → R25                         | `normalizeEmail(" Foo@Bar.COM ")==="foo@bar.com"`; `normalizeEmail("nope")===null`; `normalizePhoneE164("(416) 555-0134","CA")==="+14165550134"`; `normalizePhoneE164("12","CA")===null`; `slugUsername("Acme Foods & Co.")==="acme_foods_co"`; `slugUsername("A")==="a_crm"` (pad)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| TP2 | `apps/api/src/crm/gohighlevel/gohighlevel.client.spec.ts` (+ skeleton `gohighlevel.client.ts` exporting `GoHighLevelClient`, `CrmAuthError`, `CrmRateLimitError`, `CrmHttpError`)                                                                                                                                           | T6–T12 → R1,R2,R3,R9,R13,R19        | every call sends headers `Authorization: Bearer tok`, `Version: 2021-07-28`, `Accept: application/json`; `getLocation()` hits `https://services.leadconnectorhq.com/locations/loc1`; 401 → throws `CrmAuthError`; 429 with `Retry-After: 30` → `CrmRateLimitError` with `retryAfterSec===30`; `searchOpportunities({page:2, pipelineId:"p", stageId:"s"})` URL contains `page=2&limit=100&pipeline_id=p&pipeline_stage_id=s&location_id=loc1`; `updateContactCustomFields("c1",[{id:"f1",field_value:"x"}])` PUT body deep-equals `{customFields:[{id:"f1",field_value:"x"}]}` (no `tags` key); `createCustomField("RouteFlow Link")` POST body equals `{name:"RouteFlow Link",dataType:"TEXT",model:"contact"}`; `AbortSignal` passed (timeout) — a fetch that rejects with `AbortError` surfaces as `CrmHttpError` with `code==="timeout"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TP3 | `apps/api/src/crm/gohighlevel/gohighlevel-poll.service.spec.ts` (+ skeleton `gohighlevel-poll.service.ts` exporting `GoHighLevelPollService` with `pollTenant(tenantId, opts?)`, `pollAll()`)                                                                                                                               | T13–T21 → R8,R9,R10,R11,R12,R13,R21 | 2 pages (`meta.nextPage:2` then none) → `searchOpportunities` called twice with page 1,2; opportunity with `lastStageChangeAt` 1 h before `startFrom` → not handed off; `ignoreCutoff:true` → handed off; existing `CREATED` row → skipped (handoff service not called); `crmHandoff.create` rejecting with `{code:"P2002"}` → skipped, no throw; `pollAll()` with two connections where tenant A's poll throws → tenant B still processed, A's `lastError` set; 401 mid-poll → connection updated `status:"NEEDS_ATTENTION"`, `EmailService.send` called once with `to` = the two operator emails (second poll in NEEDS_ATTENTION → not called again); 429 → `lastError` contains "rate limit", no status change; dry-run → `crmHandoff` row created with `status:"DRY_RUN"` and `payload.action==="create"`, `CustomersService.create` never called                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| TP4 | `apps/api/src/crm/gohighlevel/gohighlevel-handoff.service.spec.ts` (+ skeleton `gohighlevel-handoff.service.ts` exporting `GoHighLevelHandoffService` with `handle(connection, opportunity, opts)` and `matchExistingCustomer(contact, region)`)                                                                            | T22–T31 → R14–R18,R24               | precedence: ref hit → `{customerId:"c-ref",how:"ref"}` even when email also matches; email match `Customer.email` `"FOO@x.com"` vs contact `"foo@x.com"` → `how:"email"`; phone `"416-555-0134"` vs stored `"+14165550134"` → `how:"phone"`; companyName `"acme foods"` vs `businessName` `"Acme Foods"` → `how:"name"`; no match → `CustomersService.create` called with `{username:"acme_foods", businessName:"Acme Foods", contactName:"Jane Doe", email:"jane@acme.test", phone:"+14165550134", customerType:"BUSINESS", addresses:[{label:"Billing",line1:"1 Main St",city:"Toronto",state:"ON",zip:"M5V 1A1",isDefault:true,addressType:"BILLING"}]}` and `notes` starting `"From GoHighLevel · deal: Big Order · value: 1200"`; username collision (`user.findFirst` returns a row for `acme_foods`, null for `acme_foods_1`) → `username:"acme_foods_1"`; contact without email+phone → row `NEEDS_REVIEW` reason `"no-identity"`, create not called; `create` throwing `BadRequestException` → `NEEDS_REVIEW` reason `"identity-conflict"`; the resolved value `tempPassword:"abc123"` never appears in any `logger` call argument or in `crmHandoff.update` payloads; on CREATED: tags `GoHighLevel` + `Needs onboarding` assigned (createTag called only for the missing one), `ExternalRefService.record("CUSTOMER", id, "gohighlevel", contactId)` called, `gateway.emitCrmHandoff("t1", {customerId, customerName:"Acme Foods", status:"CREATED", source:"gohighlevel"})`, `audit.log` called with `action:"crm.handoff.created"`; on LINKED: `assignTag` for `GoHighLevel` only |
| TP5 | `apps/api/src/crm/gohighlevel/gohighlevel-writeback.service.spec.ts` (+ skeleton `gohighlevel-writeback.service.ts` exporting `GoHighLevelWritebackService` with `ensureCustomFields(connection)`, `writeBack(connection, handoff, customer)`, `nextAttemptAt(attempts, now)`)                                              | T32–T38 → R19,R20                   | `ensureCustomFields` with `listCustomFields` returning only `contact.routeflow_link` → `createCustomField` called exactly twice (`"RouteFlow Customer ID"`, `"RouteFlow Status"`) and `crmConnection.update` stores `customFieldIds` with all three keys; `writeBack` order: `updateContactCustomFields` → `addTags(["routeflow-customer"])` → `createNote` (only when `noteWritten===false`) → `updateOpportunityStatus` only when `markWon===true`; PUT payload values `[{id:"f-id",field_value:"cust-1"},{id:"f-link",field_value:"https://web.test/customers/cust-1"},{id:"f-status",field_value:"Customer"}]`; toggles off → corresponding call absent; `addTags` rejecting → row `status:"WRITEBACK_PENDING"`, `attempts:1`; `nextAttemptAt(1, now)` = now+1 min, `(3, now)` = now+15 min, `(5, now)` = now+240 min; attempts already 5 and failing → `status:"FAILED"` with reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TP6 | `apps/api/src/crm/crm.controller.spec.ts` (+ skeleton `crm.controller.ts`, `crm-connection.service.ts` exporting `CrmConnectionService` with `getStatus(tenantId)`, `saveConnection(tenantId, dto, userId)`, `testConnection(tenantId)`, `disconnect(tenantId, userId)`, `updateConfig(tenantId, dto, userId)`, `dto/*.ts`) | T39–T44 → R1,R2,R4,R5,R6,R7         | `Reflect.getMetadata("__guards__", CrmController)` includes `JwtAuthGuard`, `RolesGuard`; every handler carries `AddonGuard` + `RequireAddon` metadata key `"crm_gohighlevel"` (read via the same metadata key `require-addon.decorator.ts` sets); `saveConnection` stores `secretCipher` = `EncryptionService.encrypt` output and the stored row never contains the raw `"pit-secret"`; `getStatus` returns `tokenLast4:"cret"` and has no `secretCipher`/`token` key; `updateConfig({enabled:true, triggerMode:"STAGE"})` with no stage → `BadRequestException`; `disconnect` → `update` called with `{secretCipher:null, status:"DISCONNECTED", enabled:false}` and `audit.log` `action:"crm.connection.removed"`; `testConnection` on `CrmAuthError` → status `NEEDS_ATTENTION`, result `{ok:false}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TP7 | `apps/web/app/(dashboard)/settings/settings-gohighlevel.test.tsx` (+ skeleton `settings/_components/GoHighLevelSettingsTab.tsx` rendering `null`, skeleton `apps/web/lib/api/crm.ts` exporting the hooks listed in the plan as `() => undefined as never`) and `apps/web/lib/hooks/useNotifications.crm.test.ts`            | T45–T49 → R29,R30                   | with status `null` → inputs labelled "Connection key" and "GoHighLevel account ID" and a button "Save & test" render; with status `CONNECTED` and `locationName:"Acme HQ"` → text "Connected to Acme HQ" present (via `getByRole("status")` or the badge text "Connected"); `dryRun:true` → banner containing "Preview mode"; a handoff row with `status:"NEEDS_REVIEW", reason:"no-identity"` → cell text "No email or phone on the contact"; a `crm.lead.handoff` socket event `{customerId:"c1", customerName:"Acme"}` → `useNotifications()` state has an entry `{type:"crm", title:"New customer from GoHighLevel", href:"/customers/c1"}` (mock the socket the way the hook's existing tests/mocks do; if none exist, mock `socket.io-client` with an `on/off` emitter)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Regression pins that stay OUT of the red gate (they turn red until WP1 lands, by design): `common/enum-parity.spec.ts`,
`common/no-bare-cron.spec.ts`, `billing/addon-gate-registry.spec.ts`.

**Red gate:** `cd apps/api && npx jest src/crm --maxWorkers=2` and `cd apps/web && npx jest settings-gohighlevel useNotifications.crm` — expect fail.

## B. Work packages (implementation)

| WP               | Owns (files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | dependsOn | satisfies      | provenBy                                                         | model/effort              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | ---------------------------------------------------------------- | ------------------------- |
| WP1 schema+types | `apps/api/prisma/schema/platform.prisma`, `apps/api/prisma/schema/tenancy.prisma` (Tenant back-relation only), `apps/api/prisma/migrations/20260911120000_crm_lead_handoff/migration.sql`, `apps/api/scripts/split-prisma-schema.mjs` (MODEL_DOMAIN two lines), `packages/types/api/enums.ts`, `packages/types/api/crm.ts`, `packages/types/index.ts` (export line), `apps/api/src/common/enum-parity.spec.ts` (3 rows + count 83), `apps/api/src/testing/prisma-mock.ts` (2 models), `apps/api/package.json` + `package-lock.json` (`libphonenumber-js` `1.12.39` direct dep — run `npm i libphonenumber-js@1.12.39 -w apps/api --no-audit --no-fund`), `apps/api/src/crm/crm.types.ts` (re-export the Prisma enums now that they exist) | —         | R26,R27,R28    | pins: enum-parity, split --check, validate-lock, lint:migrations | sonnet medium             |
| WP2 api core     | `apps/api/src/crm/crm-identity.ts`, `crm/gohighlevel/gohighlevel.client.ts`, `crm/crm-connection.service.ts`, `crm/dto/save-crm-connection.dto.ts`, `crm/dto/update-crm-config.dto.ts`, `crm/dto/list-handoffs.dto.ts`, `crm/crm.controller.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | WP1       | R1–R7,R22,R25  | T1–T12, T39–T44                                                  | sonnet **high** (secrets) |
| WP3 api handoff  | `crm/gohighlevel/gohighlevel-poll.service.ts`, `gohighlevel-handoff.service.ts`, `gohighlevel-writeback.service.ts`, `crm/crm.module.ts`, `apps/api/src/app.module.ts` (import + register), `apps/api/src/gateways/routeflow.gateway.ts` (`CrmHandoffPayload` + `emitCrmHandoff`), `apps/api/src/billing/addon-gate-registry.ts` (entry), `apps/api/src/common/no-bare-cron.spec.ts` (count 14 + name)                                                                                                                                                                                                                                                                                                                                    | WP1, WP2  | R8–R21,R23,R24 | T13–T38                                                          | sonnet **high**           |
| WP4 web          | `apps/web/lib/api/crm.ts`, `apps/web/app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx`, `SettingsHub.tsx` (item), `settings/page.tsx` (SECTIONS entry + import), `apps/web/lib/hooks/useNotifications.ts` (`href`, `crm` type, handler), `apps/web/app/(dashboard)/layout.tsx` (link when `href`), `apps/web/app/(dashboard)/customers/page.tsx` (`useSearchParams` seed of `tagFilter`)                                                                                                                                                                                                                                                                                                                                   | WP1       | R29,R30,R31    | T45–T49                                                          | sonnet medium             |
| WP5 docs+tooling | `docs/adr/0004-crm-lead-handoff.md`, `docs/runbooks/gohighlevel-client-setup.md`, `apps/api/scripts/crm-gohighlevel-check.mjs`, `.claude/code-map/api.md` + `web.md` (append rows for the new files only) + `.claude/code-map/_meta.json` (bump)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | WP3, WP4  | R32,R33        | manual                                                           | sonnet low                |

### Hard lines (exact; executors do not improvise)

**WP1 — Prisma (append to `platform.prisma`, enums beside the models):**

```prisma
enum CrmConnectionStatus { CONNECTED NEEDS_ATTENTION DISCONNECTED }
enum CrmTriggerMode { STAGE WON }
enum CrmHandoffStatus { PENDING CREATED LINKED WRITEBACK_PENDING NEEDS_REVIEW DRY_RUN SKIPPED FAILED }

model CrmConnection {
  id                  String              @id @default(uuid())
  tenantId            String              @unique
  provider            String              @default("gohighlevel")
  locationId          String
  locationName        String?
  secretCipher        String?
  tokenLast4          String?
  status              CrmConnectionStatus @default(DISCONNECTED)
  enabled             Boolean             @default(false)
  dryRun              Boolean             @default(true)
  triggerMode         CrmTriggerMode      @default(STAGE)
  pipelineId          String?
  stageId             String?
  stageName           String?
  startFrom           DateTime            @default(now())
  writeBackFields     Boolean             @default(true)
  writeBackTag        Boolean             @default(true)
  writeBackNote       Boolean             @default(true)
  markWon             Boolean             @default(false)
  customFieldIds      Json?
  defaultRegion       String              @default("US")
  lastPollAt          DateTime?
  lastSuccessAt       DateTime?
  lastError           String?
  attentionNotifiedAt DateTime?
  connectedById       String?
  createdAt           DateTime            @default(now())
  updatedAt           DateTime            @updatedAt
  tenant              Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([enabled, status])
}

model CrmHandoff {
  id              String           @id @default(uuid())
  tenantId        String
  provider        String           @default("gohighlevel")
  opportunityId   String
  contactId       String
  opportunityName String?
  contactName     String?
  status          CrmHandoffStatus @default(PENDING)
  customerId      String?
  matchedBy       String?
  reason          String?
  payload         Json?
  attempts        Int              @default(0)
  nextAttemptAt   DateTime?
  noteWritten     Boolean          @default(false)
  createdAt       DateTime         @default(now())
  processedAt     DateTime?
  @@unique([tenantId, provider, opportunityId])
  @@index([tenantId, status, createdAt])
}
```

`Tenant` (tenancy.prisma) gains `crmConnection CrmConnection?`. Migration **without a database**:

```bash
cd apps/api && mkdir -p /tmp/crm-base && git show 83af7853:apps/api/prisma/schema/_base.prisma > /tmp/crm-base/_base.prisma && for f in tenancy catalog sales finance platform compliance; do git show 83af7853:apps/api/prisma/schema/$f.prisma > /tmp/crm-base/$f.prisma; done && npx prisma migrate diff --from-schema-datamodel /tmp/crm-base --to-schema-datamodel prisma/schema --script > prisma/migrations/20260911120000_crm_lead_handoff/migration.sql && npx prisma generate
```

(then `node scripts/split-prisma-schema.mjs --check` from `apps/api`, and `npm run lint:migrations` from the root).
Enum mirrors: `export const CRM_CONNECTION_STATUS_VALUES = ["CONNECTED","NEEDS_ATTENTION","DISCONNECTED"] as const;` (same pattern
for the other two) in `packages/types/api/enums.ts`; `packages/types/api/crm.ts` holds the DTO interfaces from spec R7/R22
(`CrmStatusResponse`, `CrmConfigPatch`, `CrmHandoffRow`, `CrmSyncCounts`, `CrmPipeline`).

**WP2 — client (`gohighlevel.client.ts`):**

```ts
const BASE = "https://services.leadconnectorhq.com"; const VERSION = "2021-07-28"; const TIMEOUT_MS = 10_000;
export class CrmAuthError extends Error {} export class CrmRateLimitError extends Error { constructor(public retryAfterSec: number | null) { super("rate limit"); } }
export class CrmHttpError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }
private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${this.token}`, Version: VERSION, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw new CrmHttpError(0, (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError" ? "timeout" : "network", String((e as Error).message)); }
  if (res.status === 401) throw new CrmAuthError("GoHighLevel rejected the token");
  if (res.status === 429) { const ra = Number(res.headers.get("retry-after")); throw new CrmRateLimitError(Number.isFinite(ra) && ra > 0 ? ra : null); }
  if (!res.ok) throw new CrmHttpError(res.status, "http", `GoHighLevel ${res.status}`);
  return (await res.json()) as T;
}
```

Never log `this.token`; the class exposes no getter for it. `searchOpportunities` builds `URLSearchParams` with `location_id`,
`limit=100`, `page`, and either `pipeline_id`+`pipeline_stage_id` or `status`. Response type guards are hand-written
(`isOpportunityPage`, `isContact`) — no zod in the API.

**WP2 — connection service:** `saveConnection` = `encryptionService.encrypt(token)` → upsert `{locationId, secretCipher,
tokenLast4: token.slice(-4), status: "DISCONNECTED"}` (Test flips it to CONNECTED) → `audit.log({action:"crm.connection.saved"})`.
`getStatus` selects explicit columns and never `secretCipher`. `decryptToken(row)` is the only place `decrypt` is called.

**WP3 — poll (`gohighlevel-poll.service.ts`):**

```ts
@LeaderCron("*/3 * * * *", "crm-gohighlevel.poll")
async pollAll(): Promise<void> {
  const conns = await this.prisma.crmConnection.findMany({ where: { enabled: true, status: "CONNECTED" }, select: { tenantId: true } });
  for (const c of conns) { try { await this.tenantCtx.run(c.tenantId, () => this.pollTenant(c.tenantId)); } catch (e) { this.logger.warn(`crm poll failed tenant=${c.tenantId}: ${(e as Error).message}`); } }
}
```

`pollTenant(tenantId, { ignoreCutoff = false, budgetMs = 120_000 } = {})`: load connection (`findUnique` by tenantId, must be
`enabled||opts.force` and have `secretCipher`); page loop `for (let page = 1; page <= 50; page++)` breaking when `!meta.nextPage`
or the budget elapsed; per opportunity: cutoff check (`triggerAt = mode==="STAGE" ? lastStageChangeAt : lastStatusChangeAt`,
fallback `updatedAt`; skip when `!ignoreCutoff && triggerAt < startFrom`); existing row check (`findUnique` on the unique triple):
terminal → skip; `WRITEBACK_PENDING`/`PENDING` with `nextAttemptAt <= now` → re-handle; none → `create({status:"PENDING"})` inside
`try/catch` mapping `P2002` → skip. Catch `CrmAuthError` → `update({status:"NEEDS_ATTENTION", lastError})` + `notifyAttention()`
(email once, guarded by `attentionNotifiedAt`) and return; `CrmRateLimitError` → `lastError:"rate limit; retry after Ns"` and return;
other → `lastError`, return. On completion `lastPollAt`, and `lastSuccessAt` when no error. Returns `CrmSyncCounts`.

**WP3 — handoff match (`matchExistingCustomer`)** — exact Prisma shapes, tenant-scoped via `forTenant()`:
ref: `externalRefService.findLocalId("CUSTOMER","gohighlevel",contact.id)`; email: `customer.findFirst({ where: { deletedAt: null,
email: { equals: email, mode: "insensitive" } }, select: { id: true } })`; phone: fetch `customer.findMany({ where: { deletedAt: null,
OR: [{ phone: { not: null } }, { mobile: { not: null } }] }, select: { id: true, phone: true, mobile: true } })` **only when** the
email path missed, then compare `normalizePhoneE164(row.phone|mobile, region) === e164` in memory (there is no normalized column —
document this as O(n) per handoff, acceptable at pilot scale, and cap the scan at 5 000 rows); name: `customer.findFirst({ where:
{ deletedAt: null, businessName: { equals: name, mode: "insensitive" } } })`. Username: `slugUsername(businessName)`, then
`user.findFirst({ where: { username }, select: { id: true } })` loop with `_1.._20`, then `_${randomBytes(3).toString("hex")}`.

**WP3 — write-back:** field names/keys per spec R19; `nextAttemptAt(attempts, now) = now + [1,5,15,60,240][min(attempts,5)-1] min`;
`webBase = config.get("urls.web")`; link `${webBase}/customers/${customerId}`; PUT body exactly `{ customFields }`.

**WP3 — registry entry:**

```ts
crm_gohighlevel: { state: "dark", added: "2026-09-11", routes: ["GET /crm/gohighlevel", "PATCH /crm/gohighlevel/connection", "POST /crm/gohighlevel/connection/test", "DELETE /crm/gohighlevel/connection", "GET /crm/gohighlevel/pipelines", "PATCH /crm/gohighlevel/config", "POST /crm/gohighlevel/sync", "GET /crm/gohighlevel/handoffs", "POST /crm/gohighlevel/handoffs/:id/retry", "POST /crm/gohighlevel/handoffs/:id/dismiss", "POST /crm/gohighlevel/import-existing/preview", "POST /crm/gohighlevel/import-existing"], grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "crm_gohighlevel")', backfill: "New feature 2026-09-11: no tenant has a connection; gate stays dark through the pilot; flip after the blast-radius report", reviewBy: "2027-03-11" },
```

**WP3 — gateway:** `export interface CrmHandoffPayload { customerId: string; customerName: string; status: "CREATED" | "LINKED"; source: "gohighlevel"; }`
and `emitCrmHandoff(tenantId: string | null, payload: CrmHandoffPayload) { this.server.to(this.tenantRoom(tenantId, "operators")).emit("crm.lead.handoff", payload); }`.

**WP4 — web:** hooks with `apiClient` + TanStack (`queryKey ["crm","gohighlevel"]`, invalidate on every mutation); the tab is a real
component file following `StripeConnectCard.tsx` for the badge/card shape and `AIIntegrationsTab` (`settings/page.tsx:843`) for
save/toast; copy from `ux-spec.md` verbatim; reason → text map in one object `HANDOFF_REASON_TEXT`. `useNotifications`: add
`"crm"` to `NotificationType`, optional `href?: string` on `AppNotification`, handler
`onCrmHandoff = (d: {customerId: string; customerName: string}) => push({ type: "crm", title: "New customer from GoHighLevel", description: `${d.customerName} — finish onboarding`, href: `/customers/${d.customerId}` })`
with matching `socket.on/off("crm.lead.handoff", …)`; `layout.tsx` wraps the item body in `<Link href>` when `href` is set.
`customers/page.tsx`: `const params = useSearchParams(); useEffect(() => { const t = params.get("tag"); if (t) setTagFilter(t); }, [params]);`.

**WP5 — ADR/runbook** per spec R32; check script per R33 (`assertTestTenant` from `scripts/lib/test-tenants.cjs`, env
`SMOKE_BASE_URL`, `SMOKE_TENANT_SLUG=test`, `SMOKE_USER`, `SMOKE_PASS`, `GHL_SANDBOX_TOKEN`, `GHL_SANDBOX_LOCATION_ID`; prints the
resolved host before any call — L-074).

## C. Verification commands

- **perRound:** `npm run check-types -w apps/api`, `npm run check-types -w apps/web`, `npm run check-types -w @routeflow/types`, `npm run lint -w apps/api`
- **final:** `npm test -w apps/api -- --maxWorkers=2` (one invocation, campaign reporter — L-063), `npm run test:repo-truth -w apps/api`, `npm test -w apps/web`, `npm run lint -w apps/web`, `node apps/api/scripts/split-prisma-schema.mjs --check` (run from `apps/api`: `cd apps/api && node scripts/split-prisma-schema.mjs --check`), `npm run validate-lock`, `npm run lint:migrations`, `npm run format:check`
- **formatCommand:** `npx prettier --write`
- **Not in any gate:** the sandbox check script; `local:validate`; e2e.

## D. Mutation probe targets (HIGH-risk)

1. `gohighlevel-poll.service.ts` — remove the cutoff comparison → T15 must go red. 2. `gohighlevel-handoff.service.ts` — swap match
   order (name before ref) → T22 red. 3. `gohighlevel-writeback.service.ts` — add `tags: []` to the PUT body → T34 red.
2. `crm-connection.service.ts` — return `secretCipher` from `getStatus` → T41 red. 5. `gohighlevel.client.ts` — drop the `Version`
   header → T6 red. 6. `crm-identity.ts` — return raw phone instead of E.164 → T3 red.

## E. UI verify

`uiVerify` omitted this run (the settings tab needs a live GHL location to reach most states; RTL tests cover the states, and the
pilot's browser pass is the manual gate). `designSystemPath` still passed so the `design-system` lens reviews the tab.

## F. Open items the transcriber must NOT decide (raise if blocking)

None known. If the template demands a field this ruling lacks, fill it from `spec.md`; if the value is a decision, raise it.
