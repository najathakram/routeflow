# S2 cause refutation — OCR-1 / OCR-2

All citations `origin/master`. Read-only; nothing edited/checked out.

## 1. Guard walk for `POST /api/v1/vendor-bills/scan-invoice`

Effective order (globals first, then controller `@UseGuards`; no method-level `@UseGuards` on this route):

1. `ThrottlerGuard` — `app.module.ts:177` (429 only)
2. `TenantStatusGuard` — `app.module.ts:181` — **can 403**
3. `ImpersonationGuard` — `app.module.ts:184` — audit-only, `return true` (`impersonation.guard.ts:70,86`)
4. `JwtAuthGuard` (401) → 5. `RolesGuard` → 6. `PlanFlagGuard` → 7. `AddonGuard` — `vendor-bills.controller.ts:38`

`FilesInterceptor` (`:74-78`) is an _interceptor_: Nest runs it **after** all guards, so multer never parses the upload. That is why the 403s take 17–79 ms.

- **RolesGuard cannot 403 an OPERATOR**: `ROLE_SATISFIES[OPERATOR] = [OPERATOR]` and `@Roles(OPERATOR)` (`roles.guard.ts:22`, controller `:39`) → `true`.
- **PlanFlagGuard passes today**: `flag.ap_bills` ∈ `DARK_PLAN_FLAGS` (`plan-flag.guard.ts:23`) and `(process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on"` → `return true` at **`plan-flag.guard.ts:64-66`**. Confirmed.
- **Divergence line**: `addon.guard.ts:45` `if (keys.some((k) => active.includes(k))) return true;` is false, so control reaches the unconditional **`addon.guard.ts:49` `throw new ForbiddenException(...)`**. There is no env read, no allowlist, no logging in that file.

⚠️ **Correction to S1**: two _earlier_ guards can 403 an OPERATOR. `TenantStatusGuard.assertAllowed` throws `"Tenant account is suspended…"` for SUSPENDED/CANCELLED (`tenant-status.guard.ts:121`) and a structured `{code:"READ_ONLY", …}` for any non-allowlisted mutation on a READ_ONLY (expired-trial) tenant (`tenant-status.guard.ts:139-144`). S1's walk starts at JwtAuthGuard and omits all three APP_GUARDs. Both alternatives 403 **every** POST tenant-wide; the observed pattern (this route only, zero 200s) still points at AddonGuard, but the prod log's response **body** is the discriminator and was not captured.

## 2. `@RequireAddon` blast radius, by KEY

| key set                                                | count | sites                                                                                                                                     |
| ------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `"ocr"`                                                | **4** | `vendor-bills.controller.ts:73`, `bookkeeping.controller.ts:194`, `import/batch.controller.ts:55`, `supplier-statements.controller.ts:52` |
| `"tobacco_dealer"`                                     | **8** | `regulated.controller.ts:34,51,57,74,80,86,92`; `tobacco.controller.ts:19` (class)                                                        |
| `"recurring_routes","order_delivery","developer_mode"` | **6** | `drivers.controller.ts:37`; `route-optimization.controller.ts:28,60`; `routes.controller.ts:48,140`; `trips.controller.ts:51`             |
| `"order_delivery","developer_mode"`                    | **1** | `trips.controller.ts:28` (class)                                                                                                          |

19 sites, 4 key sets. Note for any generalized reflection test: **bookkeeping and import/batch attach `AddonGuard` at the METHOD** (`bookkeeping.controller.ts:193`, `batch.controller.ts:54`), not the class — S1 implied a uniform class stack.

## 3. The two "ocr" primitives — and a third mismatch S1 missed

- `AddonGuard` matches the literal row `TenantAddon.addonKey === "ocr"` (`addon.service.ts:52-57`).
- `EntitlementsService.compute` seeds `const flags = new Set<string>(def.featureFlags)` (`entitlements.service.ts:167`) — SCALE's `featureFlags` contain `"addon.ocr"`. Its `addons: { where: { active: true } }` (`:124-126`) is an `include`, i.e. read-only.
- **Every** `TenantAddon` writer: `prisma/seed.ts:110`, `demo-seed.js:421/439/459/474`, `e2e-seed.js:54`, `addon.service.ts:143/191`, `billing-cron.service.ts:255`, `subscription-mutation.service.ts:183/197/395/448`. **None creates a row from a plan's `featureFlags`.**

→ **Stated precisely: a tenant on a plan that includes `addon.ocr` is still 403'd by `AddonGuard`.** The plan flag and the guard key are disjoint data.

**New finding (refutes a claim in #475's own commit message).** The two writers disagree on the key:

- `AddonService.enableAddon` (platform-admin toggle) writes `addonKey: addonKey` → `"ocr"` (`addon.service.ts:143-152`).
- `SubscriptionMutationService` writes `addonKey: code` / `addonKey: sku` → `"OCR_PACK_250"` (`subscription-mutation.service.ts:184-186`, `396-398`).

`LEGACY_ADDON_KEY_TO_SKU` (`plan-catalog.constants.ts:239-247`) and `addonSkuCode()` (`:250-252`) map **key → SKU** only; there is no SKU → key map, and `AddonGuard` compares raw strings (`addon.guard.ts:44-45`). So the commit message's "SKU billing and the admin toggle converge on the same TenantAddon key" is **false**. It is latent, not live: `OCR_PACK_250` ∉ `SELF_SERVICE_ADDON_SKUS` (`plan-catalog.constants.ts:258-261`), so `enableAddon` (`subscription-mutation.service.ts:385`) and `changePlan` (`:128`) both 403 it today. It detonates the moment OCR becomes self-service.

`"ocr"` **is** grantable from Platform Admin: `AVAILABLE_ADDONS` entry `key: OCR_ADDON` at `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx:147`.

## 4. Caching of `getActiveAddons`

**Not cached.** `addon.service.ts:51-58` is a bare `prisma.tenantAddon.findMany`; `AddonGuard` holds no state. A Platform-Admin grant is visible on the **very next request**. `this.entitlements.invalidate(tenantId)` (`addon.service.ts:154`) clears a different cache. (Unrelated 60 s cache: `tenant-status.guard.ts:16`.)

## 5. OCR-2 asymmetry

`ScanInvoiceModal.tsx` `scanOne`, one catch for both flows. `msg` is read at `:707`, then:

- single (`:711-717`): `description: isApiKeyError ? "Go to Settings → AI & Integrations…" : "Please check the file and try again."` — **`msg` discarded at `:715`**.
- batch (`:720-724`): `error: isApiKeyError ? … : msg || "Scan failed. Retry, or check the file."` — `msg` surfaced.

Asymmetry **confirmed**. Mobile surfaces the message: `apps/mobile/app/(operator)/vendor-bills/scan.tsx:99-105`. `parsePlanGate` (`apps/web/lib/plan-gate.ts:23-28`) returns non-null only for `code === "PLAN_GATE" | "PLAN_GATE_UNAVAILABLE"`, and `api-client.ts:169-172` additionally requires `method === "get"`. A bare-string `ForbiddenException` on a POST has no `code`, so the untouched axios error reaches `scanOne`'s catch. Confirmed.

## 6. Local repro

`local:seed` (root `package.json:29`) → `apps/api db:seed` → `prisma/seed.ts:108-116`, which grants exactly `["order_delivery","recurring_routes"]`. **No `ocr`.** (`e2e-seed.js:44-50` grants `developer_mode`/`recurring_routes`/`order_delivery` — also no `ocr`.) So `POST /api/v1/vendor-bills/scan-invoice` on the local stack as the `test` tenant **reproduces the 403 today, no extra setup.**

**Post-fix expected value** (addon present, no Anthropic key): reaches `VendorBillsService.scanInvoice`, throws at `vendor-bills.service.ts:1450-1453` → **HTTP 400**, body `{"statusCode":400,"error":"Bad Request","message":"AI invoice scanning is not available. Please contact your system administrator to configure the ANTHROPIC_API_KEY."}`. Send a real file — `vendor-bills.controller.ts:80-82` throws 400 `"No file provided"` first otherwise. That message matches the `/api key|anthropic/i` test at `ScanInvoiceModal.tsx:709`, so web renders the correct API-key toast.

## 7. Reflection-test pattern

`apps/api/src/routes/dispatch-addon-gate.spec.ts` exists. Two `it.each` blocks: `expect(Reflect.getMetadata(REQUIRE_ADDON_KEY, controller)).toEqual(expectedKeys)` (`:36`) and guard order via `Reflect.getMetadata("__guards__", controller)` → `expect(guardNames.indexOf(AddonGuard.name)).toBeGreaterThan(guardNames.indexOf("JwtAuthGuard"))` (`:47-54`); plus a handler-override case reading `Reflect.getMetadata(REQUIRE_ADDON_KEY, TripsController.prototype.updatePlanning)` (`:60-62`). **Generalizing caveat**: for all four ocr sites the key is on `Ctrl.prototype.<method>`, and for bookkeeping/import-batch the guard is on the method too — a class-only `__guards__` read finds no `AddonGuard` there.

## 8. `addon.guard.spec.ts` today

9 tests: no-metadata pass; SUPER_ADMIN (null tenantId) pass; legacy-string allow; legacy-string Forbidden; any-of allow; any-of Forbidden; `developer_mode` never named; single-key wording fallback; reads tenantId from `req.user`. Single construction at `:22-25`: `new AddonGuard(reflector, addonService)` with `reflector = { getAllAndOverride: jest.fn() }` (`:17,21`).

**Breakage**: a **constructor-injected** Logger or registry/config provider becomes an `undefined` 3rd arg in all 9 tests — any `this.<dep>.…` call throws `TypeError` and every test reaching the guard body fails. A **property-initialized** `private readonly logger = new Logger(AddonGuard.name)`, a module-level constant (like `INTERNAL_ADDON_KEYS`, `:13`), or a `process.env` read breaks **zero** tests.

---

## Verdicts

- **OCR-1 — confirmed.** Diverging line **`apps/api/src/billing/addon.guard.ts:49`**, reached because `active` (`addon.service.ts:52-57`) never contains `"ocr"` for a tenant with no explicit toggle. **C1 holds but understates it**: the gate is not merely un-grandfathered and outside the observe-first pattern — the enforced key has _no automatic writer at all_ (§3), so it also denies SCALE-plan tenants whose plan nominally includes OCR, and would deny a tenant who bought `OCR_PACK_250` via the SKU path. Any fix that only grandfathers pre-2026-08-29 tenants leaves the plan-flag and SKU cohorts broken. Residual uncertainty: the prod 403 body was never captured, so a `TenantStatusGuard` READ_ONLY/SUSPENDED 403 (§1) is not formally excluded — cheap to settle by reading `code`/`message` from one logged response, or by the local repro in §6.
- **OCR-2 — confirmed.** Diverging line **`apps/web/components/ScanInvoiceModal.tsx:715`**. C2 holds, with the S1 nuance intact: it is the **single-scan branch only**; the batch branch at `:720-724` and mobile at `scan.tsx:99-105` already thread the message.

## S1 brief statements found wrong or incomplete

1. **Guard walk omits the three `APP_GUARD`s** (`app.module.ts:177-184`). `TenantStatusGuard` _can_ 403 an OPERATOR before any controller guard (`tenant-status.guard.ts:121`, `:139-144`).
2. **Open unknown #1 is answered, and worse than posed**: no flag→row bridge exists, _and_ the SKU writer stores a different `addonKey` — #475's "converge on the same TenantAddon key" claim is false (§3).
3. **Open unknown #4 is answered**: all five e2e touches of the route are `page.route()` mocks (`apps/web/e2e/02-operator.spec.ts:388,566,645,724,817`), so the suite cannot go red on OCR-1.
4. **Guard attachment is not uniform** across the four ocr sites — two are method-level `@UseGuards(AddonGuard)` (§2), which S1 presented as one class-level pattern.
5. S1 notes AddonGuard has no cache but not that `TenantStatusGuard` has a 60 s one (`tenant-status.guard.ts:16`) — relevant when probing status-related 403s.
