# Context pack — CRM GoHighLevel handoff (S0.5)

Plan: `C:\Users\nakram\.claude\plans\a-client-asked-us-lively-nautilus.md`. Base sha `83af7853`=origin/master, worktree `rf-crm`, branch `feat/crm-gohighlevel-handoff`.

## 1. Code map rows (paths `ls`-verified in this worktree)

**MAP STALE/BLOATED**: INDEX.md 572KB, api.md 602KB, web.md 309KB — violates global ≤20KB cap; INDEX's own table duplicates itself. Consult via grep only.

- `customers/customers.service.ts` `create(dto)` **:469** confirmed. 2991 lines.
- `import/external-ref.service.ts` (72L) `ExternalRefService`; `ImportExternalRef` model `platform.prisma:492`.
- `import/duplicate-match.service.ts` (396L) `findVendorBillDuplicate`; own module (avoids `ImportModule` cycle).
- `system-config/settings.controller.ts` GET/PATCH pairs confirmed: 43/120(root),200/214(anthropic),573/578(remittance). Class `@Roles(OPERATOR)`:34, per-route override exists (remittance PATCH=TENANT_ADMIN).
- `billing/addon-gate-registry.ts` entry shape L1-53: `AddonGateEntry{state,added,routes,grantPath,backfill,reviewBy?}`.
- `gateways/routeflow.gateway.ts` `emitUrgentOrder(tenantId,payload)`**:213-214** confirmed: `this.server.to(this.tenantRoom(tenantId,"operators")).emit(event,payload)`.
- `common/cron-lock.ts` — `LeaderCron(cronTime,name,options?)`, `CRON_LOCK_FAMILY="cron"`.
- `common/encryption.service.ts` `encrypt`:49,`decrypt`:65, AES-256-GCM `iv:tag:b64`.
- `common/geocode.util.ts` `geocodeAddress(addr,apiKey,logger?)`:32, never throws.
- `tenant/tenant-context.service.ts` `run<T>(tenantId,fn):T`:18; `get()`/`getOrNull()`/`isSuperAdmin()`.
- `audit/` — **map row is STALE** (describes old positional `log(userId,action,resource,resourceId,...)`); real source signature confirmed: `log(dto: CreateAuditLogDto)` = `{tenantId,userId,action,entityType,entityId?,ip?,meta?,impersonatedBy?}`. Matches plan — trust source.
- `email/` `EmailService.send(params)→{delivered,transport,id?,error?}`, never throws.
- `testing/prisma-mock.ts` `allModels()`**:58**; add `crmConnection`/`crmHandoff`.
- `lib/hooks/useNotifications.ts` (194L): `NotificationType` union:12; `AppNotification`:14-21 **has no `href` today** (plan correct); socket on/off pairs:161-174.
- `customers/page.tsx` (1150L): `tagFilter` state exists+wired to query (:256,282,302,318) but no `useSearchParams` import — not URL-seeded (plan's gap confirmed).
- `settings/_components/SettingsHub.tsx` Integrations group**:123-134** (one item today).
- `settings/page.tsx`: `SECTIONS`**:2795**, `integrations` entry**:2807**, `AIIntegrationsTab`**:843**, `profileSchema`**:94**.

## 2. Lessons applying (from digest)

- **L-072** hand-typed enum mirror shipped 3 bugs → use `packages/types/api/enums.ts` `X_VALUES` arrays only.
- **L-096** grep existing schema/primitive before a new store — confirm nothing fits before adding `CrmHandoff`.
- **L-100** mutations need an explicit `tenantId`, never fall through an unscoped client on null tenant.
- Also relevant (map, not digest-confirmed): tenant-scoped `findUnique` w/ exclusive `select` must include `tenantId:true`.
- L-071/035/047/077/074/063/010/055/062/078/027 **not verbatim-verified this pass** — re-check digest before citing (§7).

## 3. Prior run artifacts

- `2026-09-04-ocr-gate-observe-first/` — decisive: registered `ocr` as `dark` in `ADDON_GATE_REGISTRY`; spec fails verify on unregistered/expired/wrong-state row (build-plan.md:22,41-42,204-206). **No settings-tab UI in this run** — mirror `StripeConnectCard.tsx`/`AIIntegrationsTab` instead (§5).
- `2026-08-31-f17-import-robustness/` (build-plan.md only) — money-parsing hardening, reusable only as "grep before new helper" (→L-096).
- **Correction:** `fix-cards/` DOES exist (30 files, F02-F31, bug-campaign cards) — unrelated to this feature.
- No prior run touches `crm/`, addon-gate UI wiring, or a new settings tab.

## 4. Repo facts

- Root `verify` = campaign-check(freshness)→validate-lock-edges→validate-lessons→bug-hunt self-test+scan→`turbo run check-types lint test test:repo-truth --concurrency=2 --continue=dependencies-successful`→bugs.mjs self-test→campaign-check.
- `apps/api`: `test`→`jest`, `test:db`→`jest --config jest.db.config.js`, `test:repo-truth`→`jest -c jest.repo-truth.config.js` (structural specs only, excludes `.db.spec.ts`). Jest config INLINE in `package.json`, no `jest.config.js`; `rootDir:"src"`, `testRegex:".*\\.spec\\.ts$"`.
- `apps/web`: `test`→`jest`,`check-types`→`tsc --noEmit`,`lint`→`next lint`. `packages/types`: `check-types`/`lint`→`tsc --noEmit` only, no test script.
- Single spec (Windows): root `npx jest --selectProjects api` **does not resolve** (no root project config, `|| true` in CLAUDE.md = best-effort). Use `cd apps/api && npx jest crm/gohighlevel.client.spec.ts` or `npm test -w apps/api -- crm/gohighlevel`.
- Prettier: root `prettier.config.js`. Prisma: `apps/api/prisma.config.ts`; from `apps/api`: `npx prisma generate`, `npx prisma migrate dev`.
- `split-prisma-schema.mjs --check` (no `--from-ref` needed); `MODEL_DOMAIN` flat `{ModelName:"domain"}`; add `CrmConnection:"platform", CrmHandoff:"platform"`.
- `validate-lock-edges.mjs`→`npm run validate-lock`; `validate-lessons.mjs`→`npm run validate-lessons --digest`.
- **`scripts/validate-code-map.mjs` DOES NOT EXIST** (full-tree search) despite CLAUDE.md citing it in the verify chain — don't assume it runs.
- `.claude/pipeline/design-system.md` exists, 17,732 bytes, 7 headings (Tokens…A11y…Order-edit notes).
- `apps/api/Dockerfile`: `FROM node:20-alpine` (builder+runner).

## 5. Precedents (paths + lines only)

- `authorizations/authorization-expiry.service.ts`: `@LeaderCron(...)`**:57**, `runExpirySweep()`:58, `tenantCtx.run(tenant.id, async()=>{...})`**:74**, `processTenant`:93, `loadOperators`:183, `notify`:191.
- `stripe-connect/stripe-connect.service.ts` 365L — secret pattern present; encrypt call line NOT confirmed (§7).
- `billing/addon-gate-registry.ts` `ocr` entry ~L35-49 = shape to copy for `crm_gohighlevel`.
- `gateways/routeflow.gateway.ts:213-214` — mirror for `emitCrmHandoff`.
- `web/lib/hooks/useNotifications.ts:12-21,161-174` — extend type union + on/off pairs.
- `settings/_components/StripeConnectCard.tsx` 191L — status-badge pattern; `settings/page.tsx:94/843/2795/2807`; `SettingsHub.tsx:117-134` array to append to.
- `common/enum-parity.spec.ts` `ENUM_TABLE`**:45**; `PINNED_PRISMA_ENUM_COUNT=80`**:115** (CONFIRMED; bump→83).
- `common/no-bare-cron.spec.ts` "13 `@LeaderCron(`"**:110/114**, "13 job names"**:148** (CONFIRMED; bump→14).
- `testing/prisma-mock.ts` `allModels()`**:58**.
- `packages/types/api/enums.ts` convention: `export const X_VALUES=[...] as const; export type X=(typeof X_VALUES)[number]` (e.g. `ESTIMATE_STATUS_VALUES`:15-21). `packages/types/index.ts` barrel re-export of `./api/enums` NOT confirmed (§7).
- `uploads/upload-routes.security.spec.ts` 568L guard-override pattern; `common/cron-lock.spec.ts` 209L / `authorization-expiry.service.spec.ts` 213L cron-mock pattern (`../common/db-locks`).
- `customers/customers.service.spec.ts` 2452L — plan's `global.fetch=jest.fn()`:304 NOT re-verified (§7).

## 6. Glossary

**No `CONTEXT.md` found anywhere in this worktree** (full search incl. `docs/`), though main-repo CLAUDE.md links one. Define inline in the build brief: tenant, operator, buyer portal, add-on gate (dark/enforced), `LeaderCron`, `tenantTransaction`, `forTenant`, `ExternalRef`, `TenantContextService.run`, PIT (GHL Private Integration Token).

## 7. Unknowns

- `scripts/validate-code-map.mjs` (global CLAUDE.md) absent from this worktree.
- `CONTEXT.md` glossary (root CLAUDE.md) absent from this worktree.
- Lesson ids listed in §2's last line not verbatim-confirmed against `LESSONS-DIGEST.md`.
- `stripe-connect.service.ts` encrypt-call line not confirmed — grep before citing.
- `packages/types/index.ts` re-export of `./api/enums.ts` not confirmed.
- `customers.service.spec.ts:304` fetch-mock line not re-verified (2452L file, likely drifted).
- `libphonenumber-js@1.12.39` exact version in `package-lock.json` not verified.
