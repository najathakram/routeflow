# Context Pack — CRM Phase 1

Branch `feat/crm-phase1-core`, base `origin/master`=`7b8bf085`. Fable reads no source; claims cite
paths. Engine in use: `02d58b81` (224,133 B) — NOT the brief's `b71f6c8e`.

## 1. Code-map rows to update
`api.md` index — add row for `crm/core/`. GHL is at `api/auth-hardening-sec-3-sec-4.md:177`
(heading `2026-09-11/12 — CRM: GoHighLevel lead-handoff connector`). `api/bootstrap-cross-cutting.md` (add `CrmCoreModule` to
app.module.ts row); `web.md`→`routes-1/2.md`+`api-hooks.md`; `mobile.md`→`screens-by-role.md`;
`packages.md` if a `Crm*` enum mirrored. Map+lesson edits land in the SAME PR as the code (CLOUD-BRIEF
overrides CLAUDE.md's Bookkeeping Option B).

## 2. `apps/api/src/crm/` (GoHighLevel) — do not collide
Files: `crm.module.ts,crm.controller.ts,crm-connection.service.ts,crm-identity.ts,crm.types.ts,
dto/*,gohighlevel/*`. Module imports `[EmailModule,CustomersModule,ImportModule,GatewaysModule,
BillingModule]`, class `CrmModule`, `@LeaderCron("*/3 * * * *","crm-gohighlevel.poll")`.
Controller `@Controller("crm/gohighlevel")` class `CrmController`, class `@UseGuards(
JwtAuthGuard,RolesGuard) @Roles(UserRole.OPERATOR)`, per-handler ALSO `@UseGuards(AddonGuard)
@RequireAddon("crm_gohighlevel")`. Connection service: connect/disconnect/test/status, one
`CrmConnection` row. **Collision:** prefixes `crm/leads,crm/tasks,crm/activities` (never bare
`crm`/`crm/gohighlevel`); class `CrmCoreModule`≠`CrmModule`; own `app.module.ts` entry; no
provider-token reuse; addon key `crm_core`≠`crm_gohighlevel` (`^[a-z][a-z0-9_]*$`, no dots).

## 3. Nest module wiring pattern
`estimates/estimates.module.ts`: imports `[PrismaModule,EntitlementsModule,NumberingModule]`,
controllers `[EstimatesController]`, providers/exports `[EstimatesService]`. Registered
`app.module.ts:58` + `imports:[...]`~line173 (`CrmModule,`). `CrmCoreModule` needs same 2 edits +
`BillingModule` (any `AddonGuard` controller's module must import it, else boot throws — guard
`common/addon-guard-module-import.spec.ts`) + `CustomersModule`.

## 4. Prisma schema facts
`apps/api/prisma/schema/{_base,tenancy,catalog,sales,finance,platform,compliance}.prisma`.
- `Customer`(sales.prisma:123): `userId String @unique` required, `tenantId String?` nullable;
  ~24 more scalars; rel `messageThreads[]`,`agentAssignments[]`.
- `ContactPerson`(sales.prisma:915): salutation?,firstName,lastName?,email?,phone?,mobile?,
  isPrimary — **no `title`**; adds `title String?`.
- `CustomerComment`(sales.prisma:965): flat — content,userId, no `type`; not a `CrmActivity`
  template.
- `SalesAgent`(1175)/`AgentAssignment`(1239): standard id/status/tenantId? shape;
  `effectiveTo?` null=current, 1-open-row/customer (raw SQL unique).
- `MessageThread`(platform.prisma:303): lastChannel?,lastMessageAt?,status — adds `leadId
  String?`+relation to `CrmLead`.
- `AuditLog`(platform.prisma:422): action,entityType,entityId?,meta Json?.
- GHL-only `CrmConnection`/`CrmHandoff`(721/756): 3 own enums — do not reuse.
`MODEL_DOMAIN`(`split-prisma-schema.mjs:112`, e.g. `Tenant:"tenancy",`): new Crm* models need
entries (likely `"sales"`); `--check` fails on unmapped models. Migration dirs:
`<UTC-ts>_<snake_case desc>` (newest `20260822000000_add_supplier_statement_scan`).

## 5. Customers create path
`customers/customers.service.ts:487` `create(dto: CreateCustomerDto)`, one `tenantTransaction`:
soft-cap gate (fails open); email/username uniqueness check; mints `User` (role CUSTOMER,
placeholder-email fallback, bcrypt temp password); creates `Customer`; if `dto.salesAgentId`
opens an `AgentAssignment`; geocodes+creates `CustomerAddress[]`; post-tx
`maybeStartCustomerGrace()`; returns `{customer,user,tempPassword}`. DTO:
`customers/dto/create-customer.dto.ts` `CreateCustomerDto`. **Conversion calls this `create()`,
never a raw insert.**

## 6. Entitlement gating
`AddonGateEntry` (`billing/addon-gate-registry.ts:19-33`): `{state:"dark"|"enforced"; added;
routes; grantPath; backfill; reviewBy?}`. `crm_gohighlevel` row(~100): `state:"dark",
added:"2026-09-11",routes:[11 GHL routes],grantPath:'Platform Admin → Tenants → add-ons',
reviewBy:"2027-03-11"`. New **`crm_core`** key needs own `state:"dark"` row — spec fails on any
unregistered key. `DARK_PLAN_FLAGS`(`plan-flag.guard.ts:21-29`, 7 flags) allows unless
`PLAN_FLAG_ENFORCEMENT==="on"` — N/A here. Decorators (`billing/*.decorator.ts`):
`require-addon`, `require-plan-flag`.

## 7. Shared enums
`packages/types/api/enums.ts:15-23`: `export const ESTIMATE_STATUS_VALUES =
["DRAFT","SENT","ACCEPTED","DECLINED","CONVERTED"] as const; export type EstimateStatus =
(typeof ESTIMATE_STATUS_VALUES)[number];`. Pin (`common/enum-parity.spec.ts` `ENUM_TABLE`):
`["ESTIMATE_STATUS_VALUES","EstimateStatus"],`. New lead-status enum needs both (L-072).

## 8. Web patterns (suppliers = closest list+detail)
`apps/web/app/(dashboard)/suppliers/{page.tsx,[id]/page.tsx}`; imports
`{PageHeader,Badge,Button,cn}`+`useToast` (`@routeflow/ui/web`); search via `useUrlSearch`
(debounced URL-synced; `web/app-shell-lib.md:457`). `lib/api/suppliers.ts`: key
`["suppliers",params]`/`["suppliers",id]`; fetcher `apiClient.get(url,{params}).then(r=>
r.data)`; `apiClient`=axios instance (`lib/api-client.ts:18`). UNVERIFIED: no RHF/zod in
suppliers/sales-agents forms — check `estimates/` first. Nav: `layout.tsx` `NAV` array
(`NavLeaf`/`NavGroup`, 81-147), e.g. `{kind:"leaf",label:"Suppliers",href:"/suppliers",
icon:Building2}` in `"Warehouse"` — add CRM leaves addon-gated (`web/app-shell-lib.md:76`).

## 9. Mobile patterns
`apps/mobile/app/(operator)/customers/{index.tsx,[id]/,[id].tsx,new.tsx,create.tsx,_layout.tsx}`.
`lib/api/customers.ts:16-27` `useCustomers(search?)`: key `["customers","list",search??""]`,
fetcher `apiClient.get("/customers",{params:{search,limit:100}}).then(r=>r.data)`. UNVERIFIED:
no `lib/api/suppliers.ts`. Nav: via `(tabs)/more.tsx:73` `router.push("/(operator)/customers")`,
no tab-bar entry.

## 10. Test + verification
api `"test":"jest"`, `"test:db":"jest --config jest.db.config.js"` (`.*\.db\.spec\.ts$`),
`"test:repo-truth"`. web `"test":"jest"` (RTL), `"test:e2e":"playwright test"`. mobile
`"test":"jest --config jest.config.js"` (`__tests__/*.test.ts`, pure-logic only).
`playwright.config.ts` `projects:[{name:...}]` (20+, e.g. `setup,critical-paths,
sales-agents-gate`); `local:e2e` allow-list = inline `--project=` flags there; doc
`apps/web/e2e/LOCAL-LANE.md`. Root (bare-checkout): `"check-types"`,`"lint"`,`"test"`,`"verify"`.
**Docker required:** `"local:up"`,`"local:migrate"`,`"local:seed"`,`"local:validate"`,
`"local:e2e"`,`"db:drift -w apps/api"`.

## 11. Applicable lessons
- **L-072**: no hand-declared enum mirrors; derive `X_VALUES`, pin in enum-parity spec.
- **L-115**/**L-113** (archived): `AddonGuard` module must import `BillingModule`; a mocked
  Prisma spec ≠ schema proof — DB-lane/typed-`WhereInput` spec per new Crm* call.
- **L-119**: one figure, one filtered collection; never re-derive.
- **L-124**: cron/bootstrap has no ambient tenant — group by `tenantId`, `tenantCtx.run()`.
- **L-133**: grep touched files for prior task markers.
- **L-134**: `*.db.spec.ts` creates every row it reads in its own `beforeAll`.
- **L-146**: `@Roles`=authz, never row-scoping.
- **L-147**/**L-148**: per-row state keyed per-id; use `mutateAsync(id)`, never shared `.mutate()`.
- **L-151**: `tsc` green ≠ safe runtime import; run FULL suite once/round.
- **L-160**: config-sourced options filter to server's validated set.

## 12. Repo facts
npm 10.8, Node ≥18 (CI pins 20). Workspaces `apps/*`,`packages/*` (npm+Turbo). Commitlint types: `feat,fix,test,ci,refactor,docs,chore,perf,revert,build,style`; subject
≤72 chars.

## 13. Unknowns
- New Crm* field shapes — insert near sales.prisma:1239 once `MODEL_DOMAIN` picked.
- Web CRM form pattern (RHF+zod vs plain) — check `estimates/`.
- Mobile suppliers client location — check `apps/mobile/lib/api/admin.ts`.
- Whether `crm_core` also needs `@RequirePlanFlag` — ask the lead.
- No shared phone normaliser exists (verified) — dedup must normalise BOTH sides at query time.
