# Test plan: CRM core Phase 1

> S4 · Fable 5.1 · 2026-09-15 · **DRAFT** · R# = [spec.md](./spec.md) §9 · [ux-spec.md](./ux-spec.md) ·
> `#n` = `../2026-09-15-crm-phase1/spec-leads-deals.md` §7. **Tier** `B` = bare checkout (this session) · `H` =
> Docker on the lead's host (`local:up` → `local:migrate` → `local:seed` first).

## 1. Strategy

New surface, 7 empty tables, one dark gate. Blast radius: **tenancy leak (R25), auth widening (R23),
duplicate/blocked Customer+User minting (R19-20)** — no money. Lead rules at **unit**; every Prisma call site in
the **db lane** (L-113: a unit `where`/`data` assertion uses a typed `Prisma.CrmLead…Input` literal, never
`any`); one **e2e** file. No property tests (no money math). Not tested:
framework internals, `customers.service.create()` itself, Frappe-only #11-14, #19-31, #42-44 (deals, money).

## 2. Test table

Tier: `u`/`rtl`/`jm` = **B**; `db`/`compose`/`e2e`/`uv`/`review` = **H**. **Fails today:** every symbol/route/table
is absent; guarded `require` + first assertion `typeof x === "function"` (`db-locks.db.spec.ts`) so each test reds
on its own oracle. **New files:** `apps/api/src/crm/core/{lead-rules,crm-core.module,
crm-repo-truth}.spec.ts` + `{leads,tasks,activities,convert,authz}.db.spec.ts`, `apps/api/src/import/lead-import.service.spec.ts`,
`apps/web/app/(dashboard)/layout.crm-nav.test.tsx`, `…/(dashboard)/crm/_lib/group-tasks.test.ts`,
`…/(platform-admin)/admin/tenants/[id]/page.addons.test.tsx`, `apps/web/e2e/48-crm-core.spec.ts`,
`apps/mobile/__tests__/{crm-call-log,crm-offline-replay}.test.ts`. **Extended:** `apps/api/src/common/enum-parity.spec.ts`.

| ID | R# | Lvl | Given / When / Then — **oracle** |
|---|---|---|---|
| T1 | R2 | u | `deriveDisplayName`: `{firstName:"John",lastName:"Doe"}`→`"John Doe"` (#1); `{salutation:"Mr",firstName:"John",lastName:"Doe"}`→`"John Doe"` (R2 drops salutation, #2 diverges); `{businessName:"acme Traders",firstName:"John"}`→`"acme Traders"` (#4, #8); `{email:"buyer@acme.test"}`→`"buyer"` (#5) |
| T2 | R2 | u | `{city:"Springfield"}` → 400 `message === "Add a business name, a contact name or an email."` (#6); `{email:"not-an-email"}` → 400 `"Enter a valid email address."` (#3) |
| T3 | R2 | u | `normalizeWebsite("acme.test")`→`"https://acme.test"`; `"http://acme.test"` unchanged |
| T4 | R6 | u | `toLeadUpdateData({status:"CONVERTED",tenantId:"t2",convertedCustomerId:"c1",city:"Springfield"})` `toStrictEqual` typed `Prisma.CrmLeadUpdateInput` literal `{city:"Springfield"}` |
| T5 | R13 | u | `CreateActivityDto` error counts: `leadId`+`customerId` 1; neither 1; `kind:"STATUS_CHANGE"` 1; `body` 4001 chars 1, 4000 0; CALL sans `outcome` 1; outcomes `["REACHED","NO_ANSWER","LEFT_VOICEMAIL"]` (**Q6**) |
| T6 | R21 | u | `digitsOnly("+1 (555) 010-0100")`→`"15550100100"`; `"555.010.0100"`→`"5550100100"`; `""`→`""` (**#12**: assumed `lead-rules.ts`) |
| T7 | R22 | u | 3-row CSV (valid / existing customer's email / nameless) → `{created:1,skipped:1,errors:[{row:3,…}]}`, source `IMPORT`; `allowDuplicates=1` → `created:2`; cap gate mocked to throw, still `created:1` |
| T8 | R23 | u | `Reflector.get(ROLES_KEY, h)` on every handler of the 3 CRM controllers: sorted `toEqual(["OPERATOR","TENANT_ADMIN"])` |
| T9 | R23 | u | real `RolesGuard.canActivate` on `CrmLeadsController.prototype.list`: `"DRIVER"` → `false`; separate `it` `"CUSTOMER"` → `false`; control `"OPERATOR"` → `true` |
| T10 | R26 | u | `ADDON_GATE_REGISTRY.crm_core.state === "dark"`, `routes.length ≥ 20`; `crm_gohighlevel` row pinned `toStrictEqual` |
| T11 | R29 | u | `Reflect.getMetadata("imports", CrmCoreModule)` contains `BillingModule, CustomersModule, ImportModule` |
| T12 | R32 | u | `ENUM_TABLE` += `["CRM_LEAD_STATUS_VALUES","CrmLeadStatus"]`, `["CRM_TASK_STATUS_VALUES","CrmTaskStatus"]`, set-equal to Prisma (L-072): `{OPEN,QUALIFIED,LOST,CONVERTED}`, `{OPEN,DONE,CANCELLED}` |
| T13 | R32,R33 | u | `sales.prisma`: exactly 7 `model Crm…`, each `tenantId String` (no `?`) + `@@index([tenantId`; `split-prisma-schema.mjs`: 7 `Crm…: "sales"`; every `crm/core/*.db.spec.ts` has `assertTestTenant(` + `qa-crm-` (== file count ≥ 5) |
| T14 | R28 | rtl | admin tenant page, mocked queries → `getByText("CRM core")` in Addons; modal `"Enable CRM core"` |
| T15 | R27 | rtl | mock `@/lib/api/tobacco`: `{isLoading:true}` → `[data-nav-skeleton="crm-skeleton"]`, no "CRM"; `{addons:["crm_core"]}` → group "CRM" (`/crm/leads`, `/crm/tasks`); `{addons:[]}` → neither; CUSTOMER role → neither |
| T16 | R30 | rtl | `groupTasksByDue(tasks, now=2026-09-15T12:00Z)`, dues `[09-14, 09-15T23:59, 09-16, null]` → `{overdue:1,today:1,upcoming:1,none:1}` |
| T17 | R31 | jm | `buildCallActivity("lead1", i)`: 0→`{kind:"CALL",leadId:"lead1",outcome:"REACHED"}`, 1→`NO_ANSWER`, 2→`LEFT_VOICEMAIL`, 3 (Cancel)→`null`; title `"Log this call?"` |
| T18 | R34 | jm | interceptor `rejected` (as `api-client-timeout.test.ts`): `POST /crm/activities`, `Idempotency-Key:"idem-abc"`, no response → `enqueue` ×1 carrying that header; `buildReplayRequestConfig` keeps it; `POST /crm/tasks` sans key → `/^crm-/` |
| T19 | R1,R3 | db | POST `{businessName:"acme Traders",ownerUserId:opA}`, no `stageId` → 201, stage "New", `status:"OPEN"` (#10), `assignees` `[opA]` (#39) |
| T20 | R16 | db | fresh tenant, 2 POSTs → 1 pipeline `"Default"`; 5 stages `[New,Contacted,Qualified(isQualified),Converted(isWon),Lost(isLost)]`; 6 sources `[REFERRAL,WALK_IN,WEBSITE,TRADE_SHOW,COLD_CALL,IMPORT]`; 1 settings; `GET …/stages` → 5 |
| T21 | R4 | db | leads OPEN/QUALIFIED/LOST/CONVERTED/OPEN-archived: default → 2, `updatedAt desc`; `status[]=LOST` → 1; `archived=1` → 3; `q=acme` → 1; `mine=1` as opB (assignee of one) → 1; detail `openTaskCount:2`, `lastActivityAt` = newest of 3 |
| T22 | R5 | db | 60 leads: page 1 `50` + cursor, page 2 `10`, `nextCursor:null`; `limit=100` 200, `limit=101` 400; `spyOn(prisma.crmLead,"findMany")` call count at 60 rows == at 5 |
| T23 | R7 | db | →Qualified ⇒ `QUALIFIED`; →Lost ⇒ `LOST`; →New ⇒ `OPEN`; on CONVERTED ⇒ 409, stage unchanged |
| T24 | R17 | db | New→Qualified ⇒ +1 `STATUS_CHANGE` `{fromLabel:"New",fromType:"OPEN",toLabel:"Qualified",toType:"QUALIFIED"}` — `toType` non-null (upstream §2.4 nulls it) |
| T25 | R8 | db | owner A; assign B ⇒ assignees `[A,B]`, `ownerUserId:B` (#32, #33) |
| T26 | R9 | db | **`it("case #35 upstream wrinkle: non-owner unassign must not clear owner")`**: owner A, `[A,B]`; unassign B ⇒ `ownerUserId` **`A`**, assignees `[A]` |
| T27 | R10 | db | owner A, `[A,B,C]` (B before C); unassign A ⇒ `ownerUserId` **`C`** — **Q4:** if ruled null, flip that one `toBe(userC.id)` to `toBeNull()`; sole assignee A unassigned ⇒ `null` (#34) |
| T28 | R11 | db | DELETE ⇒ `archivedAt` set; its task/activity leave `GET /crm/tasks` and timeline; restore ⇒ back; on CONVERTED ⇒ 409 |
| T29 | R12 | db | owner = CUSTOMER / DRIVER / other-tenant OPERATOR ⇒ 400 each; same for task `assigneeUserId` |
| T30 | R13 | db | 3 NOTEs `occurredAt` t1<t2<t3 ⇒ `GET ?leadId=` ids `[c3,c2,c1]`; controller has no PATCH/DELETE handler |
| T31 | R14 | db | no `title` ⇒ 400; both subjects ⇒ 400; task to B on A's lead ⇒ owner still A (#38); default `mine` as opA ⇒ 2 of 3; `due=overdue/today/upcoming/none` ⇒ `[1,1,1,1]` (fixed `now`) |
| T32 | R15 | db | `complete` ×2 ⇒ `DONE`, `completedAt`, 1 TASK_DONE; `reopen` ×2 ⇒ `OPEN`, 1 SYSTEM; `cancel` ⇒ `CANCELLED` |
| T33 | R18 | db | 1 `CrmActivity` + 1 `CustomerComment` + 1 `Message` (thread `leadId`), t3>t2>t1 ⇒ `[activity,comment,message]`; `limit=2` → 2 then 1; `customerComment.findMany` rejected once ⇒ 200, 2 rows, `warnings:["CustomerComment"]`; sources unchanged |
| T34 | R19 | db | convert `{businessName:"acme Traders",firstName:"John",lastName:"Doe",title:"Buyer",salesAgentId}` ⇒ 201; `Customer` +1 (`businessName:"acme Traders"`, `contactName:"John Doe"`); `User` +1 CUSTOMER; lead `CONVERTED` + `convertedCustomerId`, stage `isWon`; its 2 activities + 1 task get `customerId`; primary `ContactPerson` `title:"Buyer"`; 1 SYSTEM activity; `AgentAssignment` open |
| T35 | R19 | db | second convert ⇒ 200, same `customerId`; `Customer` count N+1, not N+2; `User` +1 total |
| T36 | R19 | db | `Promise.all([convert,convert])` ⇒ both 2xx, same `customerId`, count N+1 (**#13**: names no family until one is in `LOCK_FAMILIES`) |
| T37 | R20 | db | Lost stage ⇒ 409; over-cap tenant past `GRACE_DAYS` ⇒ 403 body `toStrictEqual(buildPlanGateBody("meter.customers", upgrade))`, `User` count same, lead `status:"OPEN"`, `convertedCustomerId:null`; `{existingCustomerId}` ⇒ linked, no new `Customer` |
| T38 | R21 | db | `?email=Buyer@ACME.test ` matches `buyer@acme.test`; **#16 phone-only (deliberate divergence):** customer `phone:"(555) 010-0100"` raw, email `other@acme.test`; `?phone=555.010.0100&email=x@acme.test` ⇒ 1 match `{type:"customer"}`; converted / `supplierOnly` / other tenant excluded; nothing written |
| T39 | R23 | db | compiled app, DRIVER token `GET /crm/leads` ⇒ 403 `{statusCode:403}` — a filtered `[]` 200 fails |
| T40 | R23 | db | CUSTOMER token ⇒ 403; `POST /crm/tasks` ⇒ 403, `CrmTask` count same |
| T41 | R24 | db | 3 leads, 3 owners ⇒ TENANT_ADMIN lists 3; non-owner OPERATOR lists 3 |
| T42 | R25 | db | tenant-A token on B's lead: GET/PATCH/DELETE/convert/assign ⇒ 404 each; lead unchanged |
| T43 | R25 | db | B's task: GET/PATCH/complete ⇒ 404 |
| T44 | R25 | db | `GET /crm/activities?leadId=<B's>` ⇒ 404 (not `[]`); POST NOTE ⇒ 404, count same |
| T45 | R34 | db | `POST /crm/activities` ×2, same `Idempotency-Key` (or identical `(tenantId,leadId,authorUserId,body,occurredAt)`) ⇒ 2nd 2xx, same id, `CrmActivity` count 1; same for tasks |
| T46 | R26 | db | POST lead ⇒ `AuditLog` +1 `entityType:"CrmLead"` |
| T47 | R29 | compose | `npm run local:up && npm run smoke` ⇒ health 200 |
| T48 | R5,7,14,15,17-21,23,27,29,30 | e2e | `48-crm-core.spec.ts`, §8 |
| T49 | R29,R30 | uv | §8 screenshot matrix + visual review |
| T50 | R31,R33 | review | Expo: T17-18 + design review vs DS §Mobile — **not browser-proven, no screenshots** |

## 3. Coverage

R1 T19 · R2 T1-3 · R3 T19 · R4 T21 · R5 T22,48 · R6 T4 · R7 T23,48 · R8 T25 · R9 T26 · R10 T27 · R11 T28 ·
R12 T29 · R13 T5,30 · R14 T31,48 · R15 T32,48 · R16 T20 · R17 T24,48 · R18 T33,48 · R19 T34-36,48 · R20 T37,48 ·
R21 T6,38,48 · R22 T7 · R23 T8,9,39,40,48 · R24 T41 · R25 T42-44 · R26 T10,46 · R27 T15,48 · R28 T14 ·
R29 T11,47,49 · R30 T16,48,49 · R31 T17,50 · R32 T12,13 · R33 T13,50 · R34 T18,45. Reverse: every T names its R#;
none survives feature removal. **Deliberately untested:** none (R33's identifier half = review
lens). **§4 Negative:** T2, T4, T5, T9, T22, T23/T28, T29, T35-38, T39-45.
**§5 Property:** permissions only; no `fast-check`/new dep (R29) → table-driven T8, T41/T42.

## 6. Red gate (scoped)

```bash
cd apps/api && npx jest src/crm/core src/import/lead-import.service.spec.ts src/common/enum-parity.spec.ts --verbose # B
cd apps/web && npx jest crm-nav group-tasks page.addons; cd ../mobile && npx jest crm-                         # B
npm run local:test:db -- src/crm/core                                                                          # H
npm --prefix apps/web run test:e2e -- --project=setup --project=crm-core --reporter=list                       # H
```

T1 `Expected "John Doe", received undefined` · T8 `expected ["OPERATOR","TENANT_ADMIN"], received undefined` ·
T24 `expected "QUALIFIED", received undefined` · T35 `expected count 1, received 0` ·
T39 `expected 403, received 404`. Assertion-only reds; one remediation round; a test green before code is
deleted or strengthened.

## 7. Fixtures (L-134: a db spec creates **everything** it reads, reference data included, in its own
`beforeAll`, and deletes only that, FK order, in `afterAll`)

- Tenants A/B `qa-crm-<run8>-a/b` after `assertTestTenant` (`scripts/lib/test-tenants.cjs`), `run8 =
  randomUUID().slice(0,8)`; users per role `qa-crm-<run8>-<role>`. Cleanup FK order:
  `crmActivity→crmTask→crmLead→stages→pipeline→sources→settings→contactPerson→agentAssignment→customer→user→tenant`.
- Pipeline/stages/sources **never pre-seeded** — the first write triggers R16 (T20). Customers via real
  `CustomersService.create()` on a real `PrismaService` (as `estimates.issue-date.db.spec.ts`).
- Over-cap tenant (T37): plan + customers over cap, grace start = now − (`GRACE_DAYS`+1)d; the spec **publishes the
  catalog it reads** (never assumes `local:seed`). `now` injected, UTC.
- e2e: `e2e-routeflow` (`TENANT_SLUG`), `operator.json`; leads `qa-crm-<ts>-…` deleted via API `afterEach`; `crm_core`
  toggled via the platform-admin enable route (SA creds), restored in `finally`. Role deny uses `customer.json` —
  **no DRIVER storageState or seed identity exists**.

## 8. UI flows — project `crm-core` → `48-crm-core.spec.ts`; Desktop Chrome, viewport per test via
`page.setViewportSize` (`e2e/47:67`). **A new `projects[]` entry is genuinely needed** (one project per spec,
`playwright.config.ts:65-300`); `local:e2e`'s allow-list is the inline `--project=` list in root `package.json:38` —
add `--project=crm-core` there (+ `e2e/LOCAL-LANE.md`). 1440 unless noted.

1. addon off; `/crm/leads` → no nav "CRM"; "CRM isn't enabled for this workspace."
2. addon on, reload → `[data-nav-skeleton]` then "CRM"; rail height same.
3. no leads; `?q=zzz` → "No leads yet"+"New lead"; "No leads match"+"Clear filters" — **1440/768/390**.
4. `route.abort()`, unroute → "Couldn't load leads." + "Try again" → rows.
5. 60 seeded leads → 50 rows; "Load more" → 60.
6. New lead, a customer's email, blur → `role=alert` "Possible duplicate — 1 existing customer…"; submit ⇒ "Lead created" — **1440/390**.
7. Tab to Stage, ArrowDown → Badge "Qualified"; row "Stage change".
8. Convert, confirm → URL `/customers/{id}`, "Converted to customer"; revisit: Stage disabled, "Open customer".
9. fulfil convert 403 `{code:"PLAN_GATE",message:"This feature is not available on your current plan."}` → warning toast with that title + "Choose a plan" (**Q5**).
10. fulfil timeline `warnings:["Message"]` → rows + alert "Couldn't load messages — the rest of the timeline is shown." — **1440/768**.
11. `/crm/tasks` → 4 `.overline` groups, Mine checked; check ⇒ "Task completed"+Undo; Reopen; fulfil 500 ⇒ rollback + error toast — **1440/390**.
12. `customer.json` at `/crm/leads` → URL `/dashboard`.
13. `/customers/{id}` → "Timeline" tab after "Comments"; "No activity yet"+"Add note" — **1440/768**.

Checks: `console-errors`, `network-failures`, `a11y`, `design-system`; role/label locators; web-first asserts.
**T49** — local stack, `e2e-routeflow`, one screenshot per state at **1440 / 768 / 390**, then an independent visual
review beside the ux-spec §Screen-inventory neighbour: `/crm/leads` empty-unfiltered · empty-filtered · loading ·
error · populated(60) · duplicate alert; `/crm/leads/[id]` loading · not-found · populated ·
CONVERTED · convert dialog · partial; `/crm/tasks` empty · loading · error · 4 groups · DONE+Reopen;
`/customers/[id]?tab=timeline` empty · loading · populated · partial; nav rail skeleton · CRM · hidden (customer).

## 9. Mutation probes (file → behaviour → defect → red)

`leads.service.ts` reads carry `tenantId` → drop → T42 · same, non-owner unassign keeps owner → re-derive → T26 ·
`convert.service.ts` 2nd call returns existing → skip short-circuit → T35 · `dedup.service.ts` phone normalised both
sides → raw compare → T38.

## 10-11. Flake · regression

Fixed `now`; `occurredAt` ms apart; concurrent convert asserts end state only; addon toggle serial (`--workers=1`),
`finally` restore; toasts by `getByRole("status")` text. Push: T1-18; HOST pre-PR: T19-48; post-deploy unchanged (no CRM
probe). Drift: gate silently `enforced` → T10; enum → T12; Crm model without `tenantId` → T13.

## 12. Carried, not guessed — **Q4** T27 · **Q5** flow 9 · **Q6** T5 · **#12** T6 · **#13** T36 · no DRIVER e2e
identity · no post-deploy CRM probe.
