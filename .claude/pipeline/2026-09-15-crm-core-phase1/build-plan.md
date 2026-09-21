# Build plan — CRM core Phase 1

> S5 · written inline (no planning subagent — budget) · 2026-09-21 · Prev [test-plan.md](./test-plan.md)
> R# = [spec.md](./spec.md) §9 (R1–R34) · T# = [test-plan.md](./test-plan.md) §2 (T1–T50)
> Branch `feat/crm-phase1-core` off `origin/master`. **Build has NOT started.**

## 0. Two blockers before any code

| # | Blocker | Effect |
|---|---|---|
| **B-ENV** | This container cannot run **any** gate. CI pins `NODE_VERSION: "24"`, `package.json` requires `node >=24`, `.npmrc` sets `engine-strict=true`; the highest Node here is **v22.22.2**, so `npm install` refuses (`EBADENGINE`) and there is no `node_modules`. No `check-types`, no `lint`, no Jest, no `verify`. | **Every package below is unbuildable here.** Not "slower" — unverifiable. Forcing `--engine-strict=false` would resolve a tree CI never uses, so a green `verify` from it would be a false assurance. Needs a Node ≥24 host. |
| **#13** | `withAdvisoryLock` throws on an unregistered family; `LOCK_FAMILIES = ["order-merge","cron","billing","tenant-mirror"]` (`common/db-locks.ts:105`, enforced `:225`). | **P5 (convert) cannot ship.** Either borrow `order-merge` keyed on lead id (precedent: `customers.service.ts:1374` uses it for advance payments) or add a `crm` family. Lead's call. |

Also open, each with a carried default that one assertion flips: **Q4** owner-on-unassign (T27), **Q5** cap-403 scope (flow 9 — lead ruled: existing plain upgrade copy, follow-up row), **Q6** CALL outcome enum (T5 — lead ruled: reuse mobile's three), **#12** phone-normaliser placement (T6).

## 1. Packages (disjoint by file ownership)

| P | Owns (files) | satisfies | provenBy | risk / effort |
|---|---|---|---|---|
| **P1 schema** | `apps/api/prisma/schema/sales.prisma` (+`platform.prisma` for `MessageThread.leadId`), one additive migration, `apps/api/scripts/split-prisma-schema.mjs` `MODEL_DOMAIN`, `packages/types/api/enums.ts`, `apps/api/src/common/enum-parity.spec.ts` | R32, R33 | T12, T13 | **HIGH** — tenancy invariant + irreversible migration · `high` |
| **P2 module+gate+rules** | `apps/api/src/crm/core/crm-core.module.ts`, `dto/*`, `lead-rules.ts`, `apps/api/src/billing/addon-gate-registry.ts` | R26, R29, R2, R21(rules) | T1–T3, T6, T10, T11 | **HIGH** (boot wiring, gate) · `high` |
| **P3 leads** | `crm/core/leads.{service,controller}.ts` | R1, R3–R12, R17, R23–R25 | T8, T9, T19, T21–T29, T39–T42 | **HIGH** — authz + tenancy · `high` |
| **P4 activities+tasks+timeline** | `crm/core/{activities,tasks,timeline}.{service,controller}.ts` | R13–R15, R18, R34 | T5, T30–T33, T43–T45 | medium |
| **P5 convert** | `crm/core/convert.service.ts` | R19, R20 | T34–T37 | **HIGHEST** — mints Customer+User, money-adjacent · `high` · **blocked on #13** |
| **P6 seeder** | `crm/core/crm-seed.service.ts` | R16 | T20 | medium |
| **P7 import** | `apps/api/src/import/lead-import.service.ts` (+ controller route) | R22 | T7 | medium |
| **P8 web** | `apps/web/app/(dashboard)/crm/**`, `lib/api/crm.ts`, `layout.tsx` nav splice, `(platform-admin)/…/page.tsx` addon row, Customer timeline tab | R27, R28, R30 | T14–T16, T48, T49 | medium |
| **P9 mobile** | `apps/mobile/app/(operator)/crm/**`, `lib/api/crm.ts`, `more.tsx` row | R31 | T17, T18, T50 | medium |

**Disjointness:** no two packages write the same file. `layout.tsx` and the platform-admin page belong to **P8 alone**; `enum-parity.spec.ts` to **P1 alone**; `addon-gate-registry.ts` to **P2 alone**.

## 2. Waves (lean method — ≤ 2 Sonnet `medium` per wave, `high` on tenant-data writers)

```
W1: P1                 (alone — every other package imports its types)
W2: P2, P6
W3: P3, P4
W4: P5, P7             (P5 only once #13 is ruled)
W5: P8, P9
then: ONE Opus refute-first review of the whole slice diff → one Sonnet fix round
```
`dependsOn`: P2←P1 · P3←P2 · P4←P2 · P5←P3 · P6←P1 · P7←P2 · P8←P3,P4 · P9←P3,P4.

## 3. Hard lines (the parts worth stating exactly)

- **Every Crm* model**: `tenantId String` — **NOT NULL**, no `?` — plus `@@index([tenantId, …])`, and an entry in `MODEL_DOMAIN` as `"sales"`. `--check` fails on an unmapped model. `Customer.tenantId` is nullable; **do not copy that shape.**
- **Conversion calls `customers.service.create(dto: CreateCustomerDto)` (`:487`) — never a raw insert.** Required fields are only `username`, `businessName`, `contactName`; derive `username` server-side the way `CustomerFormModal` does. The cap gate **can throw 403** (`assertCustomerCapNotExceeded` `:625-664`) — pass its plan-gate body through unchanged, mint no `User`, leave the lead untouched.
- **One lock, keyed on lead id**, family per #13. **Never a second in-process lock** on top of `withAdvisoryLock` (CLAUDE.md).
- **`CrmCoreModule` imports `BillingModule`, `CustomersModule`, `ImportModule`.** A guarded controller in a module that does not import `BillingModule` crash-boots the API (`UnknownDependenciesException`); guard is `common/addon-guard-module-import.spec.ts`. This is lesson **L-115**, not L-113 — the brief's id is wrong and is corrected in `s0-triage.md`.
- **Every new Prisma call site** asserts its `where`/`data` against a typed `Prisma.<Model>…Input` literal, or lives in the db lane. An `any`-typed mock proves nothing about columns — lesson **L-113**.
- **No money column.** CRM writes none in Phase 1. No `qty * unitPrice` anywhere; `@routeflow/pricing` is the only math.
- **`@Roles(TENANT_ADMIN, OPERATOR)`** on every CRM handler. DRIVER and CUSTOMER are **absent from the list** so they 403 — never granted-and-filtered to an empty 200.
- **UI reuses only what `design-system.md` lists.** `Badge` has no OPEN/QUALIFIED/LOST/DONE `status` key → pass `variant`+`label`. No shared Pagination/Load-more/Checkbox exists — copy the neighbour screen's local markup, do not build shared components.
- **Nav (R27)** holds the existing `{kind:"skeleton"}` placeholder while the addons query is in flight or errored — a gated entry must never pop in or out.

## 4. Verification (tiered)

| Tier | Command | Where |
|---|---|---|
| perRound | `npm run check-types` + `npm run lint` (touched workspaces) + `npx jest src/crm/core src/import/lead-import.service.spec.ts src/common/enum-parity.spec.ts` (api), `npx jest crm-nav group-tasks page.addons` (web), `npx jest crm-` (mobile) | **Node ≥24 host — not this container** |
| final | `npm run verify` | same |
| HOST-only | `local:up` → `local:migrate` → `local:seed` → `local:test:db -- src/crm/core` → `local:validate` → `local:e2e --project=crm-core` → the T49 screenshot matrix (1440/768/390) | lead's machine |

`split-prisma-schema.mjs --check` and `npm run lint:migrations` (Squawk) run with P1.

## 5. Pipeline args

```jsonc
{ "mode": "feature", "scale": "major", "ui": true, "uiVerify": true, "profile": "standard",
  "runDir": ".claude/pipeline/2026-09-15-crm-core-phase1",
  "specPath": "./spec.md", "uxSpecPath": "./ux-spec.md",
  "designSystemPath": "../design-system.md", "testPlanPath": "./test-plan.md",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "branch": "feat/crm-phase1-core" }
```
Per the lead's 2026-09-15 pause: **the engine is not launched.** The lean method replaces it — ≤ 2 Sonnet `medium` per wave, targeted Jest per wave, ONE Opus refute-first review of the whole slice diff, one Sonnet fix round, no Fable in the build.

## 6. Definition of done for the slice

All 34 R# implemented; T1–T18 green on a Node ≥24 host; T19–T47 green on the lead's compose stack; T48–T49 Playwright + screenshot matrix with an independent visual review; T50 Expo tests + design review **stated as not browser-proven**. Code-map rows and the lesson land in the **same PR** (CLOUD-BRIEF overrides Bookkeeping Option B). HEAD carries `Bookkeeping-Follow-Up: pending`. Draft PR only; never merge, never flip visibility, never migrate prod.
