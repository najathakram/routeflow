# Spec — what CRM core Phase 1 must do

**Stage:** S2 · **Author:** Fable 5.1 · 2026-09-15 · **Prev:** [discovery.md](./discovery.md) · **Next:**
[ux-spec.md](./ux-spec.md) · `#n` = Frappe §7 case

## 1. Core capability (G2·Q1)

A distributor's sales rep records a business before it is a customer, logs every contact, sets a
dated next step, and converts it into a real customer in one action, on web and phone.

## 2. Core use cases (G2·Q2)

| # | Use case | Pri | ★ |
|---|---|---|---|
| U1 | OPERATOR creates a lead, adds a note and a due task, so the follow-up is never lost | must | ★ |
| U2 | OPERATOR converts a lead into a Customer in one action, keeping its history | must | |
| U3 | OPERATOR on the phone taps to call a lead, then logs the outcome | must | |
| U4 | TENANT_ADMIN sees every lead and task in the tenant, and only that tenant | must | |
| U5 | OPERATOR is warned of a duplicate, imports CSV, reads a customer timeline | should | |

## 3. Completeness sweep (G2·Q3)

| Step | Lead | Task · Activity | Decision · R# |
|---|---|---|---|
| Create | form, quick-add, import, dedup warn | task on lead/customer; NOTE/CALL by users, machine kinds by system | keep · R1-3, R13-14, R16, R22 |
| Read / list | detail; search, status, stage, source, mine | mine, due buckets; timeline, paged | keep · R4-5, R13, R14, R16-18 |
| Edit | fields, stage, owner, assignees | task fields; NOTE edit **defer** Ph 3 | keep · R6-10, R14 |
| Delete | archive, never CONVERTED | cancel; activities immutable, NOTE delete **defer** Ph 3 | keep · R11, R15 |
| Undo | restore; un-lose = open stage; convert irreversible | reopen; n/a | keep · R11, R15, R20 |
| Permissions | ADMIN/OPERATOR all rows; DRIVER/CUSTOMER 403; other tenant 404 | same | keep · R23-25 |
| Audit | interceptor + STATUS_CHANGE/SYSTEM rows | + TASK_DONE | keep · R17, R26 |
| Notification | | push to task assignee | **defer** Ph 3 |
| Export / bulk | | | **defer** Ph 3 |
| Import | CSV via `import` module | n/a | keep · R22 |

## 4. States, per surface (G2·Q4)

Web = `/crm/leads`, `/crm/leads/[id]`, `/crm/tasks`, Customer timeline tab · M = Expo `(operator)`.

| State | Web | M | API | R# |
|---|---|---|---|---|
| Empty | lists: "No leads yet" / "No tasks due" + Create, filtered: "No leads match" + clear; timeline: "No activity yet" + Add note | as web | `data:[]`, `nextCursor:null` | R30 |
| Loading | skeleton in place | native skeleton | | R30 |
| Partial | timeline source failed: rows + inline warning | same | `warnings[]` | R18 |
| Error | inline error + Retry; mutation: toast + rollback | same | 4xx `{statusCode,message}` | R30 |
| Offline | writes blocked + toast, no queue | cached reads, blocked writes | | R30 |
| Unauthorized | DRIVER/CUSTOMER: no nav, URL gives 403 page; ungranted: nav and tab hidden | no route | 403 role · 404 tenant | R23-25, R27 |
| Too much data | 50/page, cursor load-more | 50/page | `limit ≤ 100` | R5, R18 |
| Stale | refetch on focus | pull to refresh | | R30 |
| Concurrent | last-write-wins; stage change on CONVERTED 409 | same | convert lock | R7, R19 |

## 5. Non-functional

| Area | Rule | R# |
|---|---|---|
| Performance | ≤ 100 rows/request; bounded queries, no N+1 | R5, R18 |
| Authz | every CRM route `@Roles(TENANT_ADMIN, OPERATOR)` + `@RequireAddon("crm_core")` | R23-24, R26 |
| Tenancy | Crm* `tenantId` NOT NULL, `(tenantId,…)` index, `forTenant()` only; cross-tenant 404 | R25, R32 |
| Observability | convert logs both ids; post-create failure at `error`; dark would-deny warn | R19-20 |
| A11y | keyboard-reachable stage picker and convert, labelled inputs, visible focus | R29 |
| Idempotency | convert twice = same customer; dedup check read-only | R19, R21 |

## 6. Overlap and scope fence (G2·Q6)

- **Overlaps:** reuse `customers.service.create()`, never a raw insert; `CustomerComment` read only; GHL `apps/api/src/crm/` untouched, new `apps/api/src/crm/core/` (`CrmCoreModule`), routes `crm/leads`, `crm/tasks`, `crm/activities`; CSV extends `import`.
- **In scope:** `CrmLead`, `CrmLeadSource`, `CrmPipeline`, `CrmPipelineStage`, `CrmActivity`, `CrmTask`, `CrmSettings`; `ContactPerson.title`, `MessageThread.leadId`.
- **Non-goals:** deals, kanban, saved views, weighted pipeline, lost reasons, SLA, dashboard, assignment rules, sales hierarchy, multi-contact leads, stage/source editor, custom fields, territory tree, Frappe's `Qualified` magic string, client-side roll-up money (`total`, `net_total`, `annual_revenue`), web-to-lead, email/telephony/WhatsApp, comment backfill, bulk/export, `crm.prisma`, GHL/SKU changes, prod actions, seeds off test tenants, a second gate (Q3). **No money column.**
- **Do-not-introduce:** no new dependency, HTTP client, test runner, token, or Frappe look.

## 7. Deploy day (G2·Q7)

- **Existing users:** nothing changes; all seven models are **new and empty**, nav hidden until `crm_core` is active, the dark gate allows API calls but nothing links there.
- **Existing data:** none; both new columns nullable; pipeline, stages, sources seed lazily per tenant on first CRM write (R16): **no backfill script exists or is needed**.
- **Migration:** additive (7 tables, 2 nullable columns), Squawk-clean, tolerated by old code; owner applies via `prod-migrate.mjs`; drift gate exit 0.

| Gate | Key read | Grant path | Key written | Match? | Existing users |
|---|---|---|---|---|---|
| `AddonGuard`, `@RequireAddon("crm_core")` | `TenantAddon.addonKey="crm_core"`, `active` | `POST /platform-admin/tenants/:id/addons/enable {addonKey}`; web panel `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx` (fixed `AVAILABLE_ADDONS`: **needs a `crm_core` entry, R28**) | raw `addonKey` upsert, no SKU check (not in `LEGACY_ADDON_KEY_TO_SKU`) | **yes** | manual grant, hq first; dark till flipped |

## 8. Rollback (G2·Q9)

- **Code rollback:** revert is safe; nothing old reads the new tables or columns.
- **Data rollback:** a revert leaves Crm* rows, `TenantAddon(crm_core)` rows and **Customers + Users minted by conversion**: real customers, never auto-deleted.
- **Blast radius:** tenancy leak (R25) or duplicate/blocked conversion (R19-20); no money path.
- **Detection:** `post-deploy-check` unchanged; would-deny warns; convert error log (R20). No kill switch.

## 9. Requirements

Verify: `unit`/`db` api Jest, `rtl` web, `e2e` Playwright, `jm` mobile Jest.

| ID | Requirement | Pri | Verify |
|---|---|---|---|
| R1 | `POST /crm/leads` creates a lead from `businessName, salutation, firstName, lastName, title, email, phone, mobile, website, customerType, city, zone, sourceId, stageId, ownerUserId, salesAgentId`, all optional; 201 | must | db |
| R2 | None of `businessName/firstName/lastName/email`: 400 (#6); malformed email: 400 (#3); `website` without scheme gets `https://`; `displayName` = `businessName`, else "first last", else email local-part (#1, #4, #5) | must | unit |
| R3 | No `stageId`: default pipeline's first open stage, `status=OPEN`; setting `ownerUserId` also adds that user to the assignees (#39) | must | db |
| R4 | `GET /crm/leads/:id` returns lead + stage, source, owner, assignees, open-task count, last activity; `GET /crm/leads` filters `q`, `status[]`, `stageId`, `sourceId`, `mine=1` (owner or assignee), `archived=1`; default OPEN+QUALIFIED, `updatedAt desc` | must | db |
| R5 | Lists and timeline are cursor-paged, default 50, `limit ≤ 100` else 400; query count independent of row count | must | db |
| R6 | `PATCH /crm/leads/:id` edits R1 fields, last-write-wins; `status`, `convertedCustomerId`, `tenantId` not writable | must | unit |
| R7 | Stage change re-derives `status`: `isLost` LOST, `isQualified` QUALIFIED, else OPEN; on a CONVERTED lead 409 | must | db |
| R8 | `POST /crm/leads/:id/assign {userId}` appends the assignee and sets owner = that user (newest wins, #33) | must | db |
| R9 | Unassigning a non-owner leaves `ownerUserId` untouched; test named `"case #35 upstream wrinkle: non-owner unassign must not clear owner"` | must | db |
| R10 | Unassigning the owner re-derives owner = newest remaining assignee, else `null` (#34; Q4) | must | db |
| R11 | `DELETE /crm/leads/:id` archives (`archivedAt`), CONVERTED 409; `POST …/restore` un-archives; its tasks/activities leave lists | must | db |
| R12 | Owner/assignee must be a same-tenant TENANT_ADMIN/OPERATOR, else 400 | must | db |
| R13 | `POST /crm/activities` creates NOTE or CALL (`body ≤ 4000`; CALL has `outcome`) on exactly one of `leadId`/`customerId`, else 400; machine kinds 400; no PATCH/DELETE; `GET /crm/activities?leadId=` or `?customerId=` lists newest first, paged | must | unit + db |
| R14 | `POST /crm/tasks` needs `title`, `assigneeUserId` (R12 rule), exactly one subject, `dueAt?`; `PATCH` edits `title, dueAt, assigneeUserId, priority`; task assignment never touches the lead owner (#38); `GET /crm/tasks` filters `mine=1` (default), `status[]`, `leadId`, `customerId`, `due` in overdue, today, upcoming, none | must | db |
| R15 | Task `cancel` CANCELLED; `complete` DONE + `completedAt` + one TASK_DONE activity; `reopen` OPEN + SYSTEM activity; all idempotent | must | db |
| R16 | First CRM write in a tenant seeds pipeline "Default" (New, Contacted; Qualified `isQualified`; Converted `isWon`; Lost `isLost`), sources REFERRAL, WALK_IN, WEBSITE, TRADE_SHOW, COLD_CALL, IMPORT, one `CrmSettings` row, idempotent; `GET /crm/leads/stages` and `/sources` list them | must | db |
| R17 | Every stage change writes one STATUS_CHANGE activity `{fromStageId, fromLabel, fromType, toStageId, toLabel, toType}`, `type` resolved from `CrmPipelineStage` (never a deal table, §2.4); test asserts `toType` non-null | must | db |
| R18 | `GET /crm/leads/:id/timeline` and `GET /crm/activities/timeline?customerId=` return the union of `CrmActivity`, `CustomerComment` and `Message` (via `MessageThread.leadId`/`.customerId`), newest first, cursor `(occurredAt,id)`, 50/page ≤ 100, **read-only, nothing copied or migrated**; a failing source is named in `warnings[]`, the others still return | must | db |
| R19 | `POST /crm/leads/:id/convert` creates the Customer **through `customers.service.create()`** (server-derived unique `username`; `businessName ?? displayName`; `contactName` = person name, else business; contact fields + `salesAgentId`; no body); then `status=CONVERTED`, `convertedCustomerId`, stage `isWon`, `customerId` stamped on its activities and tasks, primary `ContactPerson` with `title`, SYSTEM activity; response mirrors `POST /customers`. Serialised under **one registered advisory-lock family (name pending #13)** keyed on lead id; any second call, concurrent or later, returns 200 with the same `customerId`, no second Customer/User | must | db |
| R20 | Convert on an `isLost` stage 409; when the customer soft-cap gate throws (over cap past `GRACE_DAYS`) its 403 plan-gate body is returned unchanged, no User minted, lead untouched; no un-convert route; body `{existingCustomerId}` links instead of creating; a create-then-lead-update failure logs `error` with both ids and that body completes the retry | must | db |
| R21 | `GET /crm/leads/duplicates?email=&phone=` returns tenant-scoped matches among non-converted leads and non-`supplierOnly` customers on email (trimmed, case-insensitive) **or** phone (digits only, **both sides normalised at query time**; stored `Customer.phone/mobile` are raw); phone-only match tested; create never blocks or auto-merges; form shows matches pre-submit | must | db + e2e |
| R22 | `POST /import/leads` (CSV: businessName, firstName, lastName, email, phone, mobile, source, note) creates leads with source IMPORT, skips and reports rows matching R21 unless `allowDuplicates=1`, reports row errors, no customer cap gate | should | unit |
| R23 | A DRIVER token and a CUSTOMER token each get **403** on every `crm/*` route, never an empty 200 (one test per role) | must | unit + db |
| R24 | TENANT_ADMIN and OPERATOR read every non-archived row in their tenant regardless of owner | must | db |
| R25 | Read/edit/convert/delete of another tenant's lead, task or activity gets **404**, one test per entity | must | db |
| R26 | `crm_core` registered `state:"dark"` in `addon-gate-registry.ts` with a live `@RequireAddon("crm_core")` on the CRM controllers; `crm_gohighlevel` untouched; every CRM mutation lands in `AuditLog` via the existing mutation interceptor | must | unit |
| R27 | Web nav shows the CRM group only when `crm_core` is active; never for DRIVER/CUSTOMER. Uses the existing `useHasAddon`, and **holds the established skeleton placeholder while the addons query is in flight or errored** (`layout.tsx:83`, `:320`, `:553`) — a gated entry must never pop in or out | must | rtl + e2e |
| R28 | Platform-admin Addons panel lists `crm_core` ("CRM core") so it is grantable from the UI | must | rtl |
| R29 | `CrmCoreModule` imports `BillingModule`, `CustomersModule`, `ImportModule`; API boots under compose; screens use only existing `@routeflow/ui`/app components, no new token or asset | must | unit, compose, design lens |
| R30 | Web `/crm/leads`, `/crm/leads/[id]`, `/crm/tasks`, Customer timeline tab render distinct empty, loading, error and populated states at 1440/768/390; failed mutation: toast, rollback, retry; `/crm/tasks` defaults to mine, groups Overdue/Today/Upcoming/No date, inline complete/reopen | must | e2e + rtl |
| R31 | Expo `(operator)` has leads list, detail (timeline, tasks), add note, add/complete task, convert; `tel:` tap then "Log this call?" creates a CALL activity with outcome | must | jm + design review |
| R32 | `CRM_LEAD_STATUS_VALUES` / `CRM_TASK_STATUS_VALUES` in `packages/types/api/enums.ts`, pinned in `enum-parity.spec.ts`; every Crm* model has `tenantId` NOT NULL + `(tenantId, …)` index and a `sales` entry in `MODEL_DOMAIN`; `split-prisma-schema.mjs --check` and Squawk pass | must | unit |
| R33 | Fixtures, seeds, tests, copy use only approved test tenants and `acme`-style placeholders | must | review lens |

## 10. Open questions

| # | Question | Assumption carried |
|---|---|---|
| Q1-3 | hq merged? prospect count N? second gate `flag.crm`? | yes, hq first (D-A2); recorded at flip (D-A1); addon only (D-A7) |
| #12 | Phone normaliser placement | one `digitsOnly` helper where the lead rules; R21 normalises both sides either way |
| #13 | CRM advisory-lock family name | R19 uses one registered family, named at S5; `withAdvisoryLock` rejects an unregistered one, so it cannot ship unnamed |
| Q4 | Owner's own unassign, others remaining: re-derive (R10) or null? | re-derive; one assertion flips if ruled null |

## 11. Assumptions (unverified)

| # | Claim | Basis / confirm | R#s | If wrong | Status |
|---|---|---|---|---|---|
| A3 | `CreateCustomerDto` requires only `username`, `businessName`, `contactName`; a lead fills all three, no modal | `customers/dto/create-customer.dto.ts` | R19 | modal + body | **confirmed** |
| A4 | soft-cap gate fails open | `customers.service.ts` `assertCustomerCapNotExceeded` | R20 | | **REFUTED**: 403 `meter.customers` over cap past `GRACE_DAYS` (R20); customer-only, R22 runs none |
| A8 | guard reads raw `TenantAddon.addonKey`, `enableAddon` writes it raw, no SKU check | `billing/addon.guard.ts`, `addon.service.ts` | R26-28 | un-grantable | confirmed |
| A9 | web NAV reads active addons | `app/(dashboard)/layout.tsx` | R27 | new fetch | **KILLED**: `useHasAddon` imported `:73-74`, used `:1060`; react-query dedupes, no extra fetch |
| A10 | two-role `@Roles` works | `auth/guards/roles.guard.ts` (note the `guards/` subdir) | R23-24 | admins 403 | **KILLED**: `:50` `requiredRoles.some(...)`; `users.controller.ts:34` already ships it |

## STOP GATE — S2 → S3 / S4

| Stop condition | Evaluated? | Answer | Evidence | Verdict |
|---|---|---|---|---|
| Sweep decision on every row | yes | keep/defer on all 10 | §3 | pass |
| Nine states per surface | yes | 9 × 3 surfaces | §4 | pass |
| Gate key read = key written | yes | raw `crm_core` both sides; UI entry R28 | §7 | pass |
| Rollback, blast radius, detection | yes | additive; converted Customers survive | §8 | pass |
| Every R# has priority + verification; negative R#s | yes | 33 rows; R2, R6, R13, R20, R23, R25 negative | §9 | pass |

- **Gate outcome:** PASS, S3 (UI) then S4 · **Carried into S4:** Q4, #12, #13 (A9 and A10 killed at S2 review — see §11) · **Approved by:** pending lead
