# Build plan: CRM — GoHighLevel → RouteFlow lead handoff

> **Stage S5 — "how".** Authored by Fable 5 on `2026-09-11` (ruling `ruling.md`); this file is
> the S5-transcription of that ruling's §B–§E into the full template.
> Status: `IMPLEMENTED` (2026-09-12; WP1–WP5 landed in 939c7e44, fix rounds 1–2 in fix-plan.md)
> Inputs: [discovery.md](./discovery.md), [spec.md](./spec.md) (`R1`–`R33`),
> [ux-spec.md](./ux-spec.md), [test-plan.md](./test-plan.md) (`T1`–`T54`).

**Gate to pass before S6:** every work package declares `satisfies:` and `provenBy:`. Verified
below (§ Package map).

**Base:** `83af7853` (origin/master) · **branch:** `feat/crm-gohighlevel-handoff` · **worktree:**
`C:\ClaudeCode\routeflow\.claude\worktrees\rf-crm` · **scale:** major · **ui:** true (uiVerify
omitted this run — see § UI verification).

---

## Objective

RouteFlow clients running GoHighLevel (GHL) for lead generation currently re-type every won lead
into RouteFlow's customer form by hand (discovery.md). This change adds a per-tenant CRM
connector (`apps/api/src/crm/**`) that polls a tenant's GHL opportunities on a leader-elected
cron, matches each converted lead to an existing RouteFlow customer or creates a new one, writes
identifying fields back to the GHL contact, and surfaces the whole pipeline (connect, configure,
review, retry) in a new Settings tab plus an operator-bell notification.

**In scope:** connection management (save/test/disconnect a Private Integration Token), polling
with cutoff + idempotent ledger (`CrmHandoff`), match-before-create identity logic, write-back to
GHL custom fields/tags/notes/won-status, dry-run preview, a manual retry/dismiss/import-existing
surface, the Settings tab, the bell notification, an add-on gate shipped `dark`.

**Explicitly out of scope (spec.md non-goals):** two-way field sync, RouteFlow → GHL operational
events, an OAuth marketplace app / webhooks, GHL workflows/SMS/marketing automation,
invoices/payments/calendar in GHL, more than one GHL location per tenant, a field-mapping UI,
mobile app changes, deleting RouteFlow customers on GHL contact deletion, `salesAgentId`
assignment from GHL `assignedTo`.

---

## Constraints & conventions

- **Stack:** NestJS 11 + Prisma 7/PostgreSQL (`apps/api`); Next.js 14 App Router + TanStack Query
  (`apps/web`).
- **Test runner and layout:** `apps/api` Jest config is inline in `package.json`
  (`rootDir: "src"`, `testRegex: ".*\\.spec\\.ts$"`, reporter
  `scripts/jest-campaign-reporter.cjs`) — spec files live beside their source under
  `apps/api/src/crm/`. `apps/web` uses `apps/web/jest.config.js` (Jest + RTL,
  `*.test.tsx`/`*.test.ts`). On Windows, run scoped: `cd apps/api && npx jest crm/...` — the root
  `npx jest --selectProjects api` does not resolve (no root project config).
- **Lint / format:** ESLint flat config per workspace (`npm run lint -w apps/api|web`); Prettier
  root `prettier.config.js`, run via `npx prettier --write`.
- **Existing patterns to copy:**
  `apps/api/src/authorizations/authorization-expiry.service.ts` (LeaderCron tenant-loop shape:
  `@LeaderCron(...)`, `tenantCtx.run(tenant.id, async () => {...})`, `loadOperators`, `notify`);
  `apps/api/src/billing/addon-gate-registry.ts`'s `ocr` entry (registry-entry shape);
  `apps/api/src/gateways/routeflow.gateway.ts:213-214` (`emitUrgentOrder` — mirror for
  `emitCrmHandoff`); `apps/web/app/(dashboard)/settings/_components/StripeConnectCard.tsx`
  (status-badge card pattern) and `AIIntegrationsTab` at `settings/page.tsx:843` (save/toast
  pattern).
- **Design system source:** [design-system.md](../design-system.md) (repo cache, 7 headings) —
  the web package cites it; it does not invent tokens. ux-spec.md's own primitives list (Card,
  Badge, Button, Input, Select, Switch, Table, toast) already exist in the repo.
- **Must NOT change:** `packages/pricing` (money math untouched by this feature);
  `CustomersService.create`'s existing signature/behavior for non-CRM callers; any existing
  `addon-gate-registry.ts` entry other than the new `crm_gohighlevel` one.
- **Do-not-introduce list:** Vitest, Biome, Supabase, Vercel, a second HTTP client, zod on the
  API side for GHL responses (hand-written type guards per ruling), a root-level test runner.
- **Landmines:** the Prisma schema is a FOLDER (`apps/api/prisma/schema/*.prisma`) — add models
  to `platform.prisma` AND to `MODEL_DOMAIN` in `split-prisma-schema.mjs`, or `--check` fails;
  `no-bare-cron.spec.ts` hard-codes both a `@LeaderCron(` count and a job-name list — bump both;
  `enum-parity.spec.ts` hard-codes `PINNED_PRISMA_ENUM_COUNT` — bump by 3; a fresh worktree
  carries a stale generated Prisma client — run `npx prisma generate` from `apps/api` after WP1's
  migration lands, before any other package's tests run.

---

## Test packages

Full detail — files, brief, oracle — lives in [test-plan.md](./test-plan.md) §2/§3 (TP1–TP7,
T1–T54). Summary:

| TP  | Title                                 | Tests             |
| --- | ------------------------------------- | ----------------- |
| TP1 | Identity helpers                      | T1–T5             |
| TP2 | GoHighLevel HTTP client               | T6–T12            |
| TP3 | Poll service                          | T13–T21, T52, T54 |
| TP4 | Handoff/match service                 | T22–T31, T51      |
| TP5 | Write-back service                    | T32–T38           |
| TP6 | Connection service + controller       | T39–T44, T50, T53 |
| TP7 | Web: settings tab + bell notification | T45–T49           |

**Red gate command** (both must fail on assertions only, none may pass):

```bash
cd apps/api && npx jest src/crm --maxWorkers=2
cd apps/web && npx jest settings-gohighlevel useNotifications.crm
```

---

## Work packages

### WP1 — Schema + types

- **files:** `apps/api/prisma/schema/platform.prisma`, `apps/api/prisma/schema/tenancy.prisma`
  (Tenant back-relation only), `apps/api/prisma/migrations/20260911120000_crm_lead_handoff/migration.sql`
  **(new)**, `apps/api/scripts/split-prisma-schema.mjs` (MODEL_DOMAIN, two lines),
  `packages/types/api/enums.ts`, `packages/types/api/crm.ts` **(new)**,
  `packages/types/index.ts` (export line), `apps/api/src/common/enum-parity.spec.ts` (3 rows +
  count 83), `apps/api/src/testing/prisma-mock.ts` (2 models), `apps/api/package.json` +
  `apps/api/package-lock.json` (`libphonenumber-js@1.12.39` direct dep — run
  `npm i libphonenumber-js@1.12.39 -w apps/api --no-audit --no-fund`),
  `apps/api/src/crm/crm.types.ts` **(re-export the Prisma enums, replacing the TP2 skeleton's
  plain-string unions now that the real enums exist)**
- **satisfies:** R26, R27, R28
- **provenBy:** repo regression pins — `enum-parity.spec.ts`, `split-prisma-schema.mjs --check`,
  `npm run validate-lock`, `npm run lint:migrations` (not a `T#`; see test-plan.md §4)
- **dependsOn:** none
- **effort:** medium (mechanical, but touches a HIGH-risk file — the Prisma schema — so review
  still applies full depth)
- **model:** `claude-sonnet-5`
- **risk class:** HIGH (`apps/api/prisma/schema/*.prisma`, migration)
- **brief:** Append the two models and three enums below to `platform.prisma` exactly as
  written; add the `Tenant.crmConnection` back-relation to `tenancy.prisma`. Generate the
  migration with the no-database diff command below (never `prisma migrate dev` against a live
  DB for this package). Map both new models to `"platform"` in `MODEL_DOMAIN`. Add the enum
  mirror constants to `packages/types/api/enums.ts` (the `X_VALUES` + derived-type pattern used
  by every other pinned enum) and the DTO interfaces to `packages/types/api/crm.ts`. Add 3 rows
  to `enum-parity.spec.ts`'s `ENUM_TABLE` and bump `PINNED_PRISMA_ENUM_COUNT` from 80 to 83. Add
  `crmConnection`/`crmHandoff` to `prisma-mock.ts`'s `allModels()`. Add `libphonenumber-js` as a
  direct `apps/api` dependency at the version already resolved in the lockfile. Run
  `npx prisma generate` from `apps/api` after the migration is written, before any other package
  runs its tests against Prisma types.

**Exact code — Prisma (append to `platform.prisma`, enums beside the models):**

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

`Tenant` (tenancy.prisma) gains `crmConnection CrmConnection?`.

**Exact code — migration generation (no database needed):**

```bash
cd apps/api && mkdir -p /tmp/crm-base && git show 83af7853:apps/api/prisma/schema/_base.prisma > /tmp/crm-base/_base.prisma && for f in tenancy catalog sales finance platform compliance; do git show 83af7853:apps/api/prisma/schema/$f.prisma > /tmp/crm-base/$f.prisma; done && npx prisma migrate diff --from-schema-datamodel /tmp/crm-base --to-schema-datamodel prisma/schema --script > prisma/migrations/20260911120000_crm_lead_handoff/migration.sql && npx prisma generate
```

Then `node scripts/split-prisma-schema.mjs --check` from `apps/api`, and `npm run lint:migrations`
from the root.

**Enum mirrors** in `packages/types/api/enums.ts`:
`export const CRM_CONNECTION_STATUS_VALUES = ["CONNECTED","NEEDS_ATTENTION","DISCONNECTED"] as const;`
(same `X_VALUES` + derived-type pattern for `CrmTriggerMode` and `CrmHandoffStatus`).
`packages/types/api/crm.ts` holds the DTO interfaces from spec R7/R22: `CrmStatusResponse`,
`CrmConfigPatch`, `CrmHandoffRow`, `CrmSyncCounts`, `CrmPipeline`.

---

### WP2 — API core (connection + client)

- **files:** `apps/api/src/crm/crm-identity.ts`, `apps/api/src/crm/gohighlevel/gohighlevel.client.ts`,
  `apps/api/src/crm/crm-connection.service.ts`, `apps/api/src/crm/dto/save-crm-connection.dto.ts`,
  `apps/api/src/crm/dto/update-crm-config.dto.ts`, `apps/api/src/crm/dto/list-handoffs.dto.ts`,
  `apps/api/src/crm/crm.controller.ts`
- **satisfies:** R1–R7, R22, R25
- **provenBy:** T1–T12, T39–T44, T50, T53
- **dependsOn:** WP1
- **effort:** high (secrets handling — the PIT token and its encrypted storage)
- **model:** `claude-sonnet-5`
- **risk class:** HIGH (`apps/api/src/crm/**`)
- **brief:** Implement the identity helpers (`normalizeEmail`, `normalizePhoneE164` via
  `libphonenumber-js`, `slugUsername`) to the exact behavior in test-plan.md TP1. Implement
  `GoHighLevelClient` with the `request<T>` method below (never log `this.token`; no getter for
  it), `getLocation`, `listPipelines`, `searchOpportunities` (URLSearchParams per spec R9),
  `updateContactCustomFields`, `createCustomField`, `listCustomFields`, `addTags`, `createNote`,
  `updateOpportunityStatus`, and hand-written type guards (`isOpportunityPage`, `isContact`) — no
  zod. Implement `CrmConnectionService` (`saveConnection`, `getStatus`, `testConnection`,
  `disconnect`, `updateConfig`, `listPipelines` — proxies the client and drops any pipeline stage
  missing `id`/`name` per spec R3/T50, `listHandoffs` — paginated per spec R22/T53: `where` by
  optional `status`, `orderBy:{createdAt:"desc"}`, `take` clamped to ≤100, `skip = (page-1)*limit`)
  per the connection-service hard line below. Implement `CrmController` with every route from
  spec R1–R7, R22 guarded `JwtAuthGuard, RolesGuard, @Roles(UserRole.OPERATOR)`,
  `AddonGuard, @RequireAddon("crm_gohighlevel")`.

**Exact code — client (`gohighlevel.client.ts`):**

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

`searchOpportunities` builds `URLSearchParams` with `location_id`, `limit=100`, `page`, and
either `pipeline_id`+`pipeline_stage_id` or `status`.

**Exact code — connection service:** `saveConnection` = `encryptionService.encrypt(token)` →
upsert `{locationId, secretCipher, tokenLast4: token.slice(-4), status: "DISCONNECTED"}` (Test
flips it to CONNECTED) → `audit.log({action:"crm.connection.saved"})`. `getStatus` selects
explicit columns and never `secretCipher`. `decryptToken(row)` is the only place `decrypt` is
called.

---

### WP3 — API handoff pipeline

- **files:** `apps/api/src/crm/gohighlevel/gohighlevel-poll.service.ts`,
  `apps/api/src/crm/gohighlevel/gohighlevel-handoff.service.ts`,
  `apps/api/src/crm/gohighlevel/gohighlevel-writeback.service.ts`,
  `apps/api/src/crm/crm.module.ts`, `apps/api/src/app.module.ts` (import + register),
  `apps/api/src/gateways/routeflow.gateway.ts` (`CrmHandoffPayload` + `emitCrmHandoff`),
  `apps/api/src/billing/addon-gate-registry.ts` (entry),
  `apps/api/src/common/no-bare-cron.spec.ts` (count 14 + name)
- **satisfies:** R8–R21, R23, R24
- **provenBy:** T13–T38, T51, T52, T54
- **dependsOn:** WP1, WP2
- **effort:** high (secrets/tenancy/external-write surface — matching logic and write-back)
- **model:** `claude-sonnet-5`
- **risk class:** HIGH (`apps/api/src/crm/**`, `addon-gate-registry.ts`, `routeflow.gateway.ts`)
- **brief:** Implement `pollAll`/`pollTenant` exactly per the cron hard line below (leader-cron,
  per-tenant try/catch isolation, page loop capped at 50/120s budget, cutoff check, idempotency
  via the unique-triple lookup, P2002-as-skip). Implement `matchExistingCustomer` with the exact
  Prisma shapes below (ref → email → phone → name, in that order; the phone path scans in memory
  capped at 5,000 rows, documented as O(n) at pilot scale) and `handle()` wiring
  create/link/NEEDS_REVIEW per spec R14–R18, including the `getContact` 404 →
  `NEEDS_REVIEW reason:"contact-not-found"` branch (spec R14/T51). Implement write-back
  ordering/backoff per the hard line below. Implement `retryHandoff(id)` (reopens
  `DRY_RUN`/`NEEDS_REVIEW`/`FAILED`/`WRITEBACK_PENDING` rows → `PENDING`/`WRITEBACK_PENDING`,
  `attempts:0`, `nextAttemptAt:now`, then calls `handle` immediately; a `CREATED`/`LINKED` row
  throws `ConflictException`) and `dismissHandoff(id)` (→ `SKIPPED reason:"dismissed"` on
  `NEEDS_REVIEW`/`FAILED`/`DRY_RUN`; else throws `ConflictException`) per spec R22/T52.
  Implement `previewImportExisting(tenantId)` (read-only, `ignoreCutoff` semantics, no writes,
  returns `{count, sample}` capped at 20) and `importExisting(tenantId)` (calls `pollTenant` with
  `{ignoreCutoff:true}`) per spec R23/T54. Wire `crm.module.ts` into `app.module.ts`. Add
  `emitCrmHandoff` to the gateway per the snippet below. Add the `crm_gohighlevel` registry entry
  (`state: "dark"`) below. Bump `no-bare-cron.spec.ts`'s count and name list for the new
  `@LeaderCron`.

**Exact code — poll (`gohighlevel-poll.service.ts`):**

```ts
@LeaderCron("*/3 * * * *", "crm-gohighlevel.poll")
async pollAll(): Promise<void> {
  const conns = await this.prisma.crmConnection.findMany({ where: { enabled: true, status: "CONNECTED" }, select: { tenantId: true } });
  for (const c of conns) { try { await this.tenantCtx.run(c.tenantId, () => this.pollTenant(c.tenantId)); } catch (e) { this.logger.warn(`crm poll failed tenant=${c.tenantId}: ${(e as Error).message}`); } }
}
```

`pollTenant(tenantId, { ignoreCutoff = false, budgetMs = 120_000 } = {})`: load connection
(`findUnique` by tenantId, must be `enabled||opts.force` and have `secretCipher`); page loop
`for (let page = 1; page <= 50; page++)` breaking when `!meta.nextPage` or the budget elapsed;
per opportunity: cutoff check (`triggerAt = mode==="STAGE" ? lastStageChangeAt :
lastStatusChangeAt`, fallback `updatedAt`; skip when `!ignoreCutoff && triggerAt < startFrom`);
existing row check (`findUnique` on the unique triple): terminal → skip;
`WRITEBACK_PENDING`/`PENDING` with `nextAttemptAt <= now` → re-handle; none →
`create({status:"PENDING"})` inside `try/catch` mapping `P2002` → skip. Catch `CrmAuthError` →
`update({status:"NEEDS_ATTENTION", lastError})` + `notifyAttention()` (email once, guarded by
`attentionNotifiedAt`) and return; `CrmRateLimitError` → `lastError:"rate limit; retry after
Ns"` and return; other → `lastError`, return. On completion `lastPollAt`, and `lastSuccessAt`
when no error. Returns `CrmSyncCounts`.

**Exact code — handoff match (`matchExistingCustomer`)**, exact Prisma shapes, tenant-scoped via
`forTenant()`: ref: `externalRefService.findLocalId("CUSTOMER","gohighlevel",contact.id)`; email:
`customer.findFirst({ where: { deletedAt: null, email: { equals: email, mode: "insensitive" } },
select: { id: true } })`; phone: fetch `customer.findMany({ where: { deletedAt: null, OR: [{
phone: { not: null } }, { mobile: { not: null } }] }, select: { id: true, phone: true, mobile:
true } })` **only when** the email path missed, then compare
`normalizePhoneE164(row.phone|mobile, region) === e164` in memory (capped at 5,000 rows); name:
`customer.findFirst({ where: { deletedAt: null, businessName: { equals: name, mode: "insensitive"
} } })`. Username: `slugUsername(businessName)`, then `user.findFirst({ where: { username },
select: { id: true } })` loop with `_1.._20`, then `_${randomBytes(3).toString("hex")}`.

**Exact code — write-back:** field names/keys per spec R19; `nextAttemptAt(attempts, now) = now +
[1,5,15,60,240][min(attempts,5)-1] min`; `webBase = config.get("urls.web")`; link
`${webBase}/customers/${customerId}`; PUT body exactly `{ customFields }`.

**Exact code — registry entry (`addon-gate-registry.ts`):**

```ts
crm_gohighlevel: { state: "dark", added: "2026-09-11", routes: ["GET /crm/gohighlevel", "PATCH /crm/gohighlevel/connection", "POST /crm/gohighlevel/connection/test", "DELETE /crm/gohighlevel/connection", "GET /crm/gohighlevel/pipelines", "PATCH /crm/gohighlevel/config", "POST /crm/gohighlevel/sync", "GET /crm/gohighlevel/handoffs", "POST /crm/gohighlevel/handoffs/:id/retry", "POST /crm/gohighlevel/handoffs/:id/dismiss", "POST /crm/gohighlevel/import-existing/preview", "POST /crm/gohighlevel/import-existing"], grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "crm_gohighlevel")', backfill: "New feature 2026-09-11: no tenant has a connection; gate stays dark through the pilot; flip after the blast-radius report", reviewBy: "2027-03-11" },
```

**Exact code — gateway (`routeflow.gateway.ts`):**

```ts
export interface CrmHandoffPayload { customerId: string; customerName: string; status: "CREATED" | "LINKED"; source: "gohighlevel"; }
emitCrmHandoff(tenantId: string | null, payload: CrmHandoffPayload) { this.server.to(this.tenantRoom(tenantId, "operators")).emit("crm.lead.handoff", payload); }
```

---

### WP4 — Web (Settings tab + bell)

- **files:** `apps/web/lib/api/crm.ts`,
  `apps/web/app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx`,
  `apps/web/app/(dashboard)/settings/_components/SettingsHub.tsx` (item),
  `apps/web/app/(dashboard)/settings/page.tsx` (SECTIONS entry + import),
  `apps/web/lib/hooks/useNotifications.ts` (`href`, `crm` type, handler),
  `apps/web/app/(dashboard)/layout.tsx` (link when `href`),
  `apps/web/app/(dashboard)/customers/page.tsx` (`useSearchParams` seed of `tagFilter`)
- **satisfies:** R29, R30, R31
- **provenBy:** T45–T49
- **dependsOn:** WP1
- **effort:** medium
- **model:** `claude-sonnet-5`
- **risk class:** LOW (web)
- **brief:** Build `apps/web/lib/api/crm.ts` hooks with `apiClient` + TanStack Query
  (`queryKey: ["crm","gohighlevel"]`, invalidate on every mutation). Build
  `GoHighLevelSettingsTab.tsx` as a real component following `StripeConnectCard.tsx` for the
  badge/card shape and `AIIntegrationsTab` (`settings/page.tsx:843`) for save/toast — copy from
  `ux-spec.md` **verbatim**, including the pinned strings ("Connection", "Save & test",
  "Connected to ", "Needs attention", "Preview mode", "Check now", "Import existing leads"). Add
  the reason→text map as one object `HANDOFF_REASON_TEXT`. Wire the Settings hub item and
  `settings/page.tsx` SECTIONS entry per ux-spec's Entry points §1–2. Extend `useNotifications.ts`:
  add `"crm"` to `NotificationType`, optional `href?: string` on `AppNotification`, handler
  `onCrmHandoff = (d: {customerId: string; customerName: string}) => push({ type: "crm", title:
"New customer from GoHighLevel", description: \`${d.customerName} — finish onboarding\`, href:
  \`/customers/${d.customerId}\` })`with matching`socket.on/off("crm.lead.handoff", …)`.
`layout.tsx`wraps the notification item body in`<Link href>`when`href`is set.`customers/page.tsx`: `const params = useSearchParams(); useEffect(() => { const t =
  params.get("tag"); if (t) setTagFilter(t); }, [params]);`.

---

### WP5 — Docs + tooling

- **files:** `docs/adr/0004-crm-lead-handoff.md` **(new)**,
  `docs/runbooks/gohighlevel-client-setup.md` **(new)**,
  `apps/api/scripts/crm-gohighlevel-check.mjs` **(new)**,
  `.claude/code-map/api.md` (append rows for the new files only),
  `.claude/code-map/web.md` (append rows for the new files only),
  `.claude/code-map/_meta.json` (bump)
- **satisfies:** R32, R33
- **provenBy:** manual (not a `T#` — see test-plan.md §1 "manual: yes")
- **dependsOn:** WP3, WP4
- **effort:** low
- **model:** `claude-sonnet-5`
- **risk class:** LOW (docs, tooling script)
- **brief:** `docs/adr/0004-crm-lead-handoff.md` follows the `0003` header template and records:
  polling on PIT over OAuth/webhooks, ledger idempotency, field ownership (GHL owns identity,
  RouteFlow owns the three custom fields + tag + notes), and the not-now list (spec R32).
  `docs/runbooks/gohighlevel-client-setup.md` is the client-facing one-pager (token click-path,
  scopes, paste, pick stage, test, dry-run review, enable). `crm-gohighlevel-check.mjs` is
  env-driven (`SMOKE_BASE_URL`, operator creds, `GHL_SANDBOX_TOKEN`, `GHL_SANDBOX_LOCATION_ID`),
  calls `assertTestTenant` from `scripts/lib/test-tenants.cjs` with `SMOKE_TENANT_SLUG=test`,
  connects, syncs, asserts a handoff row, and prints the resolved host before any call (lesson
  L-074). It is a manual tool, never added to any Jest suite. Append one row per new file to
  `.claude/code-map/api.md` and `.claude/code-map/web.md` (purpose + exported signatures only,
  no bodies) and bump `.claude/code-map/_meta.json`'s `mappedSha`/timestamp.

### Package map

| WP  | satisfies        | provenBy                                                                     | dependsOn | Wave |
| --- | ---------------- | ---------------------------------------------------------------------------- | --------- | ---- |
| WP1 | R26, R27, R28    | regression pins (enum-parity, split --check, validate-lock, lint:migrations) | —         | 1    |
| WP2 | R1–R7, R22, R25  | T1–T12, T39–T44, T50, T53                                                    | WP1       | 2    |
| WP3 | R8–R21, R23, R24 | T13–T38, T51, T52, T54                                                       | WP1, WP2  | 3    |
| WP4 | R29, R30, R31    | T45–T49                                                                      | WP1       | 2    |
| WP5 | R32, R33         | manual                                                                       | WP3, WP4  | 4    |

Cross-check: every `R#` in spec.md appears in some package's `satisfies:` above (R1–R33 all
present) or is out of scope (none is). Every `T#` in test-plan.md appears in some package's
`provenBy:` (T1–T54 all present across WP2–WP4; `R31` is verified manually, no `T#`).

---

## Acceptance criteria

1. `R1` — Saving a connection stores an AES-256-GCM cipher, never the raw token; no endpoint
   returns it.
2. `R2` — Testing a connection reports the location name on success and flips status to
   `NEEDS_ATTENTION` on a rejected token.
3. `R6` — Every CRM route 403s without the `crm_gohighlevel` add-on grant, independent of role.
4. `R10`/`R11` — A poll run never hands off an opportunity twice and never hands off one older
   than the connection's `startFrom` unless explicitly told to ignore the cutoff.
5. `R15`/`R16` — A converted lead links to an existing customer when one matches (ref > email >
   phone > name) and otherwise creates exactly one new customer with a unique username.
6. `R19`/`R20` — A created/linked lead's GHL contact gains the three custom fields, the
   `routeflow-customer` tag, and a note, retried with the ruled backoff on transient failure.
7. `R21` — With `dryRun` on, no RouteFlow customer and no GHL write occurs; a preview row is
   recorded instead.
8. `R29` — The Settings → GoHighLevel tab renders every state in ux-spec.md's checklist with the
   pinned copy.
9. Negative case: an unauthorized role or a tenant without the add-on grant reaches no CRM
   route's business logic (guard rejects first).
10. Deploy day: with zero existing `CrmConnection` rows, the cron loop is a no-op and no existing
    tenant behavior changes (gate `dark`, additive migration).

---

## Verification commands

Per round (after every implementation wave):

```bash
npm run check-types -w apps/api
npm run check-types -w apps/web
npm run check-types -w @routeflow/types
npm run lint -w apps/api
```

Final (once, deciding the result):

```bash
npm test -w apps/api -- --maxWorkers=2
npm run test:repo-truth -w apps/api
npm test -w apps/web
npm run lint -w apps/web
cd apps/api && node scripts/split-prisma-schema.mjs --check
npm run validate-lock
npm run lint:migrations
npm run format:check
```

**formatCommand:** `npx prettier --write`

**Not in any gate:** `apps/api/scripts/crm-gohighlevel-check.mjs` (manual, needs a live GHL
sandbox); `npm run local:validate`; Playwright e2e.

---

## UI verification

Omitted this run (ruling §E): the settings tab needs a live GHL location to reach most states;
RTL tests (T45–T49) cover the states, and a manual browser pass against the pilot tenant before
enabling the add-on is the compensating gate. `designSystemPath` is still passed so the
`design-system` review lens reads the tab's diff against `.claude/pipeline/design-system.md`.

---

## Risks & rollback

| Risk                                                               | Likelihood | Blast radius                                                  | Mitigation / what the reviewer should watch                                                                                                                                                |
| ------------------------------------------------------------------ | ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wrong customer match (cross-identity collision)                    | low        | data integrity — a lead linked to the wrong existing customer | match precedence is ref→email→phone→name with exact equality (case-insensitive only where spec says); T22–T25 pin the precedence order; mutation probe #2 proves T22 catches an order swap |
| Token exposure                                                     | low        | secret leak — a client's GHL PIT visible in logs/responses    | `secretCipher` never selected in `getStatus`; `this.token` has no getter on the client; T30/T41 assert non-exposure; mutation probe #4 proves T41 catches a `getStatus` regression         |
| Poll runs away / rate-limits the client's GHL account              | low        | external — GHL 429s, client's own usage throttled             | 50-page/120s budget cap per tenant per tick, 10s per-call timeout, 429 backs off via `lastError` until next tick (R13)                                                                     |
| Write-back partially succeeds then a replica restarts mid-sequence | medium     | duplicate tag/note on next retry                              | each write-back step is idempotent by design (`noteWritten` guard, tag assignment is idempotent, custom-field PUT is a full overwrite) — T33/T35 assert the order and toggles              |
| Migration drift in prod                                            | low        | schema mismatch                                               | additive-only migration (two new tables, three new enums, one new relation column is nullable); `local:drift` / CI replay is the standing guard, not a byte diff                           |

- **Rollback:** revert the deploy, or set every tenant's `CrmConnection.enabled = false` (the
  cron and controller both become no-ops per tenant); the add-on gate can also be turned off via
  Platform Admin without a deploy.
- **Migration reversibility:** additive only (two tables, three enums, one nullable
  back-relation) — a down migration would simply drop the two tables; no data loss for any
  existing model.
- **Feature flag / entitlement:** `crm_gohighlevel`, registered `dark` in
  `addon-gate-registry.ts` (WP3). Granting path: Platform Admin → Tenants → [tenant] → add-ons,
  which calls `AddonService.enableAddon` writing the exact key `AddonGuard`/`RequireAddon` reads
  — confirmed by the registry entry's `grantPath` field itself (R6).
- **Deploy day:** zero `CrmConnection` rows exist anywhere; the cron's `findMany` returns empty
  and returns immediately; no existing tenant sees any behavior change. No backfill.
- **Observability:** `lastError`/`status` on `CrmConnection` (visible in the Activity card and
  queryable via `GET /crm/gohighlevel`); a stuck `NEEDS_ATTENTION` connection triggers the
  once-per-transition operator email (R12); the stale-poll warning in the UI (ux-spec States
  checklist) surfaces a silently-dead cron to the client before support does.

---

## Pipeline args

```js
{
  "planPath": ".claude/pipeline/2026-09-11-crm-gohighlevel-handoff/build-plan.md",
  "discoveryPath": ".claude/pipeline/2026-09-11-crm-gohighlevel-handoff/discovery.md",
  "specPath": ".claude/pipeline/2026-09-11-crm-gohighlevel-handoff/spec.md",
  "uxSpecPath": ".claude/pipeline/2026-09-11-crm-gohighlevel-handoff/ux-spec.md",
  "testPlanPath": ".claude/pipeline/2026-09-11-crm-gohighlevel-handoff/test-plan.md",
  "designSystemPath": ".claude/pipeline/design-system.md",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "startedAt": "__STARTED_AT__",
  "scale": "major",
  "workdir": "C:ClaudeCode\routeflow.claudeworktrees\rf-crm",
  "context": "GHL->RouteFlow CRM connector; dark-gated; no uiVerify.",
  "formatCommand": "npx prettier --write",
  "testPackages": [
    {
      "id": "TP1",
      "files": [
        "apps/api/src/crm/crm-identity.spec.ts"
      ],
      "brief": "see test-plan.md TP1 (T1-T5)"
    },
    {
      "id": "TP2",
      "files": [
        "apps/api/src/crm/gohighlevel/gohighlevel.client.spec.ts"
      ],
      "brief": "see test-plan.md TP2 (T6-T12)"
    },
    {
      "id": "TP3",
      "files": [
        "apps/api/src/crm/gohighlevel/gohighlevel-poll.service.spec.ts"
      ],
      "brief": "see test-plan.md TP3 (T13-T21,T52,T54)"
    },
    {
      "id": "TP4",
      "files": [
        "apps/api/src/crm/gohighlevel/gohighlevel-handoff.service.spec.ts"
      ],
      "brief": "see test-plan.md TP4 (T22-T31,T51)"
    },
    {
      "id": "TP5",
      "files": [
        "apps/api/src/crm/gohighlevel/gohighlevel-writeback.service.spec.ts"
      ],
      "brief": "see test-plan.md TP5 (T32-T38)"
    },
    {
      "id": "TP6",
      "files": [
        "apps/api/src/crm/crm.controller.spec.ts"
      ],
      "brief": "see test-plan.md TP6 (T39-T44,T50,T53)"
    },
    {
      "id": "TP7",
      "files": [
        "apps/web/app/(dashboard)/settings/settings-gohighlevel.test.tsx",
        "apps/web/lib/hooks/useNotifications.crm.test.ts"
      ],
      "brief": "see test-plan.md TP7 (T45-T49)"
    }
  ],
  "redGate": {
    "commands": [
      "cd apps/api && npx jest src/crm --maxWorkers=2",
      "cd apps/web && npx jest settings-gohighlevel useNotifications.crm"
    ]
  },
  "packages": [
    {
      "id": "WP1",
      "files": [
        "apps/api/prisma/schema/platform.prisma",
        "apps/api/prisma/schema/tenancy.prisma",
        "apps/api/prisma/migrations/20260911120000_crm_lead_handoff/migration.sql",
        "apps/api/scripts/split-prisma-schema.mjs",
        "packages/types/api/enums.ts",
        "packages/types/api/crm.ts",
        "packages/types/index.ts",
        "apps/api/src/common/enum-parity.spec.ts",
        "apps/api/src/testing/prisma-mock.ts",
        "apps/api/package.json",
        "apps/api/src/crm/crm.types.ts"
      ],
      "brief": "see build-plan.md WP1",
      "satisfies": [
        "R26-R28"
      ],
      "model": "claude-sonnet-5",
      "effort": "medium"
    },
    {
      "id": "WP2",
      "files": [
        "apps/api/src/crm/crm-identity.ts",
        "apps/api/src/crm/gohighlevel/gohighlevel.client.ts",
        "apps/api/src/crm/crm-connection.service.ts",
        "apps/api/src/crm/dto/save-crm-connection.dto.ts",
        "apps/api/src/crm/dto/update-crm-config.dto.ts",
        "apps/api/src/crm/dto/list-handoffs.dto.ts",
        "apps/api/src/crm/crm.controller.ts"
      ],
      "brief": "see build-plan.md WP2",
      "dependsOn": [
        "WP1"
      ],
      "satisfies": [
        "R1-R7",
        "R22",
        "R25"
      ],
      "provenBy": [
        "T1-T12",
        "T39-T44",
        "T50",
        "T53"
      ],
      "model": "claude-sonnet-5",
      "effort": "high"
    },
    {
      "id": "WP3",
      "files": [
        "apps/api/src/crm/gohighlevel/gohighlevel-poll.service.ts",
        "apps/api/src/crm/gohighlevel/gohighlevel-handoff.service.ts",
        "apps/api/src/crm/gohighlevel/gohighlevel-writeback.service.ts",
        "apps/api/src/crm/crm.module.ts",
        "apps/api/src/app.module.ts",
        "apps/api/src/gateways/routeflow.gateway.ts",
        "apps/api/src/billing/addon-gate-registry.ts",
        "apps/api/src/common/no-bare-cron.spec.ts"
      ],
      "brief": "see build-plan.md WP3",
      "dependsOn": [
        "WP1",
        "WP2"
      ],
      "satisfies": [
        "R8-R21",
        "R23",
        "R24"
      ],
      "provenBy": [
        "T13-T38",
        "T51",
        "T52",
        "T54"
      ],
      "model": "claude-sonnet-5",
      "effort": "high"
    },
    {
      "id": "WP4",
      "files": [
        "apps/web/lib/api/crm.ts",
        "apps/web/app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx",
        "apps/web/app/(dashboard)/settings/_components/SettingsHub.tsx",
        "apps/web/app/(dashboard)/settings/page.tsx",
        "apps/web/lib/hooks/useNotifications.ts",
        "apps/web/app/(dashboard)/layout.tsx",
        "apps/web/app/(dashboard)/customers/page.tsx"
      ],
      "brief": "see build-plan.md WP4",
      "dependsOn": [
        "WP1"
      ],
      "satisfies": [
        "R29-R31"
      ],
      "provenBy": [
        "T45-T49"
      ],
      "model": "claude-sonnet-5",
      "effort": "medium"
    },
    {
      "id": "WP5",
      "files": [
        "docs/adr/0004-crm-lead-handoff.md",
        "docs/runbooks/gohighlevel-client-setup.md",
        "apps/api/scripts/crm-gohighlevel-check.mjs",
        ".claude/code-map/api.md",
        ".claude/code-map/web.md",
        ".claude/code-map/_meta.json"
      ],
      "brief": "see build-plan.md WP5",
      "dependsOn": [
        "WP3",
        "WP4"
      ],
      "satisfies": [
        "R32-R33"
      ],
      "model": "claude-sonnet-5",
      "effort": "low"
    }
  ],
  "verifyCommands": {
    "perRound": [
      "npm run check-types -w apps/api",
      "npm run check-types -w apps/web",
      "npm run check-types -w @routeflow/types",
      "npm run lint -w apps/api"
    ],
    "final": [
      "npm test -w apps/api -- --maxWorkers=2",
      "npm run test:repo-truth -w apps/api",
      "npm test -w apps/web",
      "npm run lint -w apps/web",
      "cd apps/api && node scripts/split-prisma-schema.mjs --check",
      "npm run validate-lock",
      "npm run lint:migrations",
      "npm run format:check"
    ]
  },
  "mutationProbe": {
    "targets": [
      {
        "file": "apps/api/src/crm/gohighlevel/gohighlevel-poll.service.ts",
        "behavior": "cutoff blocks stale opps unless ignoreCutoff",
        "test": "T15"
      },
      {
        "file": "apps/api/src/crm/gohighlevel/gohighlevel-handoff.service.ts",
        "behavior": "match order ref>email>phone>name",
        "test": "T22"
      },
      {
        "file": "apps/api/src/crm/gohighlevel/gohighlevel-writeback.service.ts",
        "behavior": "PUT body has only customFields",
        "test": "T34"
      },
      {
        "file": "apps/api/src/crm/crm-connection.service.ts",
        "behavior": "getStatus never returns secretCipher",
        "test": "T41"
      },
      {
        "file": "apps/api/src/crm/gohighlevel/gohighlevel.client.ts",
        "behavior": "every request carries Version header",
        "test": "T6"
      },
      {
        "file": "apps/api/src/crm/crm-identity.ts",
        "behavior": "phones normalized to E.164, never raw",
        "test": "T3"
      }
    ]
  },
  "runDir": "C:ClaudeCode\routeflow.claudeworktrees\rf-crm.claudepipeline6-09-11-crm-gohighlevel-handoff"
}
```
