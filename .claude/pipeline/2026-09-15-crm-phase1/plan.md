# Plan: absorbing Frappe CRM into RouteFlow

Planner: Fable 5.1, 2026-09-15. Input: `context-pack.md` (same folder). Verified this pass:
`Customer` carries `tenantId String?` **and a required `userId @unique`** (every Customer is a
login) — a lead can therefore never be a Customer row; conversion must go through the existing
customer-create path. No `Lead`/`Deal`/`Task`/`Activity` model exists; the name space is free.

## 1. Recommendation in 5 lines

1. **Clean-room native rebuild (option c)**: build a first-class CRM in RouteFlow's own stack, using Frappe CRM only as a product/UX blueprint (docs, demo, screenshots, doctype *names*) — never its source.
2. **Why**: Frappe CRM is AGPL-3.0 (network copyleft) and a Frappe-bench Python/Vue/MariaDB app; copying code would make a proprietary hosted SaaS's source disclosable to every user, and running it beside RouteFlow breaks tenancy, auth and the "mobile mirrors web" rule. Counsel must confirm the license reading — I am not a lawyer.
3. **Shape**: `CrmLead` → `Customer` conversion, `CrmDeal` typed for distributors (new account / standing order / expansion), one `CrmActivity` timeline that unifies notes, tasks, calls and the existing Message threads, owners = Users with a `SalesAgent` link so commissions keep working.
4. **Ship in 5 dark-gated phases**; Phase 1 (leads + pipeline + timeline + tasks + convert) is the smallest slice a distributor's sales rep will use tomorrow, dogfooded on `routeflow-hq`.
5. **GoHighLevel stays as an inbound connector** (handoffs become leads), not the CRM; no Frappe code, assets or trademarks enter the repo.

## 2. Options weighed

**License facts (all options).** AGPL-3.0 §13: if you *modify* the program and let users interact with it over a network, you must offer those users the Corresponding Source of your modified version. §5/§6 + derivative-work doctrine: code copied, linked or translated from an AGPL work makes the combined work AGPL as a whole when conveyed or network-served. Clean edges: an *unmodified* AGPL program run as a separate process behind an arm's-length API does not pull the caller under AGPL; facts, feature lists, doctype names and UI ideas are not copyrightable expression, so a clean-room reimplementation from docs is the standard safe path. "Frappe" is a trademark; it never appears in the product. **Owner's counsel gives the final view; this is engineering's reading.**

| | (a) Copy/port Frappe code | (b) Separate hosted Frappe CRM + API/SSO | (c) Clean-room native rebuild (**recommended**) | (d) Extend GoHighLevel |
|---|---|---|---|---|
| License | Derivative → RouteFlow (api+web+mobile) becomes AGPL; source offer to every tenant user; ends the private repo. A Python→TS port keeping structure is still a derivative. **Fatal.** | Safe only while Frappe CRM stays *unmodified*; any hook/patch triggers §13 for that service. Real integration needs modification → the glue is disclosable. | No Frappe expression enters the repo. **Clean.** | Commercial API, no issue. |
| Stack fit | Python/Vue/MariaDB — nothing reusable. | Second runtime (bench, MariaDB, Python workers), second auth realm, second deploy pipeline. | Native Nest/Prisma/Next/Expo; every house rule applies unchanged. | GHL owns model and UI. |
| Tenancy / data | Re-tenant everything. | Frappe sites ≠ RouteFlow tenants: one site per tenant (ops explosion) or shared site with weak isolation; customers duplicated across two DBs with two-way sync. | Every model tenant-scoped; Customer stays the single account record; no sync. | Tenant data lives in GHL (per-tenant $97+/mo); RouteFlow never owns it. |
| Cost build / run | High + legal exposure. | Low build, **high run** (second product, sync bugs, SSO, support). | Medium-high build (5 phases, Sonnet volume), ~zero extra run cost. | Low build; GHL fees; unowned support surface. |
| Time to value | Slow. | Fast demo, slow trust (two logins, duplicates). | Phase 1 in weeks; each phase shippable. | Fast for GHL tenants only. |
| Distributor fit | Generic. | Generic; no order/invoice/route context without deep sync. | Deals typed to distributor reality; timeline shows orders/invoices; field-sales mobile beside routes. **Best.** | Agency/marketing CRM shape — wrong for route sales. |

**Clean-room rules (binding for option c).**
- Builders (Sonnet/Opus/Fable sessions and humans) MAY read: `docs.frappe.io/crm`, `frappe.io/crm`, the hosted demo UI, screenshots, this plan, the context pack, the doctype *name* list (A4).
- Builders MAY NOT open, clone, fetch, vendor, or paste anything from `github.com/frappe/*` source trees (`.py`, `.vue`, `.js`, `.json` doctype definitions, CSS, images, translations). No `frontend/src/images` assets; no field-list JSONs; no Frappe UI components.
- Every CRM PR description carries a `Provenance: clean-room; sources = Frappe CRM public docs/demo only; no Frappe source consulted` line; the S0 spec lists the exact URLs used. `context-pack.md` is the only Frappe-derived artefact and it contains names and prose, not code.
- The existing Sonnet research session that produced the pack fetched directory listings only (names) — record that in the S0 spec as the provenance baseline.

## 3. Domain mapping

Models go in `apps/api/prisma/schema/sales.prisma` + `MODEL_DOMAIN` (a new `crm.prisma` would change the split script's file-set invariant — owner decision #7; not for Phase 1). Every model: `tenantId String` (NOT nullable — new models get the invariant hard), `createdAt/updatedAt`, indexes on `(tenantId, …)`.

| Frappe | RouteFlow | Notes |
|---|---|---|
| Organization | **`Customer` (reuse)** | No separate Org model. Customer = account = billing entity, as today. `supplierOnly` rows are excluded from CRM lists. |
| Lead | **`CrmLead`** (new) | Pre-customer record: org fields (`businessName`, `customerType`, address fields), primary-contact fields inline (`firstName/lastName/email/phone/mobile/title`), `sourceId`, `stageId`, `ownerUserId?`, `salesAgentId?`, `status` (`OPEN/QUALIFIED/CONVERTED/LOST`), `lostReasonId?`, `convertedCustomerId? @unique`, `convertedDealId?`, `externalRef?` (GHL contact id), `firstRespondedAt?`. |
| Contact | **`ContactPerson` (reuse, extend)** | Add `title String?`. Phase 3: make `customerId` nullable + add `leadId?` so a lead can hold several contacts; Phase 1 keeps one inline contact on the lead (a store buyer is one person). |
| Deal | **`CrmDeal`** (new) | `dealType` (`NEW_ACCOUNT / STANDING_ORDER / EXPANSION / REACTIVATION`), `customerId?` (required once won), `leadId?`, `pipelineId`, `stageId`, `value Decimal(12,2)`, `expectedCloseAt?`, `ownerUserId`, `salesAgentId?`, `status` (`OPEN/WON/LOST`), `lostReasonId?`, `estimateId?` (line items = an `Estimate`, money math untouched), `orderTemplateId?` (a standing-order opportunity becomes an `OrderTemplate` on win), `wonAt?`. |
| Lead status / Deal status | **`CrmPipeline` + `CrmPipelineStage`** | Tenant-configurable, ordered, `probability Int`, `isWon/isLost`; one default pipeline seeded per tenant on first CRM use (idempotent seed, test tenants only in scripts). |
| Lead source | **`CrmLeadSource`** | Tenant table, defaults seeded: REFERRAL, WALK_IN, WEBSITE, TRADE_SHOW, COLD_CALL, GOHIGHLEVEL, IMPORT, BUYER_PORTAL. |
| Lost reason | **`CrmLostReason`** | Small tenant table; used by lead and deal. |
| Note / Activity / Status change log / Communication status | **`CrmActivity`** (one timeline table) | `kind` (`NOTE / STATUS_CHANGE / TASK_DONE / CALL / EMAIL / WHATSAPP / SMS / VISIT / SYSTEM`), polymorphic subject: `leadId?`, `dealId?`, `customerId?` (an activity may carry lead **and** customer after conversion — conversion sets `customerId` on the lead's activities, nothing is re-parented). `messageId?`, `callLogId?`, `taskId?`, `authorUserId?`, `body`, `meta Json?`. Also writes `AuditLog` as today. |
| Task | **`CrmTask`** | Own lifecycle: `title`, `dueAt?`, `assigneeUserId`, `priority`, `status (OPEN/DONE/CANCELLED)`, `completedAt?`, same polymorphic subject. Completing emits a `CrmActivity`. |
| Call log | **`CrmCallLog`** (Phase 4) | `provider`, `providerCallId`, `direction`, `fromNumber/toNumber`, `durationSec`, `recordingKey?` (storage module), `outcome`; emits an activity. |
| Email / templates / threads | **`Message` + `MessageThread` (reuse)** | Add `MessageThread.leadId?`. Timeline reads Messages by thread. Templates = `MessageTemplate`. Depends on P6-3/P6-4 provider wiring. |
| SLA / rolling response time / service days / holidays | **`CrmSlaPolicy`** (Phase 5) | `firstResponseMinutes`, `businessHoursOnly`, breach notification via `NotificationRule`. Holiday lists NOT copied — a tenant-level closed-days setting is enough. |
| Assignment rule / sales hierarchy | **`CrmAssignmentRule`** (Phase 3) | `strategy (ROUND_ROBIN / BY_ZONE / MANUAL)`, `memberUserIds`, `conditions Json`. Owner = `User`; `SalesAgent.userId` links commissions: on WON/convert, create `AgentAssignment(customerId, agentId)` so `CommissionAccrual` works unchanged. |
| Territory / industry | Not a model | `zone`/`industry` are string fields on lead + customer tag; routes already carry geography. |
| View settings | **`CrmSavedView`** (Phase 2) | Per user: `entity`, `filters Json`, `sort`, `columns`, `layout (LIST/KANBAN)`. |
| Products on deal | **`Estimate`** | A priced deal is an Estimate (existing money math, convert→invoice path). No `crm_product` mirror. |
| Custom fields, form scripts, field layouts, dropdown items, dashboard doctype, invitations, global settings, ERPNext settings | **Not copied** | RouteFlow is fixed Prisma models + `SystemConfig`. Stage/source/lost-reason tables give the configurability distributors need; a `CrmSettings` row (one per tenant) holds the few knobs; users/invites are the existing users module; analytics is the existing `analytics` module; notifications are `NotificationRule`. A bounded `attributes Json?` on lead/deal is the only escape hatch, and only if a pilot asks (owner decision #6). |

**Lead → Customer conversion** (`POST /crm/leads/:id/convert`, idempotent, one transaction, advisory-locked on the lead id): create `User` (CUSTOMER role) + `Customer` through the `customers.service` create path (never a raw insert — it owns tier, terms, consent, address), create `ContactPerson(isPrimary)`, set `status=CONVERTED` + `convertedCustomerId`, stamp `customerId` onto the lead's activities/tasks, create `AgentAssignment` if `salesAgentId`, optionally open a `CrmDeal(NEW_ACCOUNT)`. A lead whose email/phone matches an existing Customer offers "link to existing" (dedup, no auto-merge).

**Deal ↔ orders/estimates/invoices.** A deal is a *forecast*, never revenue. "Weighted pipeline" = `computeWeightedPipeline(value, probability)` in `@routeflow/pricing`. Realized revenue for a won deal is the customer's **accrual net sales** from invoices (owner ruling), read from `analytics`, never from `CrmDeal.value`. `NEW_ACCOUNT` win requires a customer; `STANDING_ORDER` win links an `OrderTemplate`; `EXPANSION` links an Estimate. CRM writes no money fields.

## 4. What RouteFlow already has — retire or merge

- **GoHighLevel `crm` module (#702, addon `crm_gohighlevel`, dark)**: **keep as a connector, demote in name.** Phase 2 turns each `CrmHandoff` into a `CrmLead(source=GOHIGHLEVEL, externalRef)`; the existing match-to-Customer logic becomes the lead's "link to existing" step; write-back stays. Native code lives beside it as `CrmCoreModule` in `apps/api/src/crm/core/` (controller prefixes `crm/leads`, `crm/deals`, `crm/tasks`, `crm/activities`); `crm/gohighlevel/*` untouched. The $9.99 SKU ruling stands until the owner repackages (decision #4). Retire only after the pilot tenant has moved to native leads.
- **`CustomerComment` → timeline**: Phase 1 timeline *reads* `CustomerComment` rows as `NOTE` activities (union in the service, no migration); new notes write `CrmActivity`. Phase 3 runs an idempotent backfill (approved test tenants first, dry-run flag, owner runs prod) copying comments into `CrmActivity(kind=NOTE, meta.legacyCommentId)`, then the old write path is switched; the table stays (never destructive). `Customer.notes` stays as the pinned note.
- **`Message`/`MessageThread` → conversation timeline**: no change to models beyond `leadId?`; the timeline merges Messages by thread. Live email/WhatsApp threads arrive with P6-3/P6-4 (Phase 4 dependency).
- **`SalesAgent` → CRM owner/assignment**: not merged. Owner is a `User`; `SalesAgent.userId` is the bridge; assignment rules pick among agents that have users. Commission tables untouched.
- **`AuditLog`**: keep writing it; `STATUS_CHANGE` activities are the user-facing view of it.
- **Zoho remnant** (`Customer.zohoContactId`): leave; never build Zoho sync.
- **Code map**: CORRECTION (lead, verified by the registry minter 2026-09-15): the pack's B1 claim was wrong. apps/api/src/crm/* (GHL) IS mapped in `.claude/code-map/api/auth-hardening-sec-3-sec-4.md`. The Phase 1 PR adds the `crm/core` rows beside it.

## 5. Phased roadmap

**Entitlement shape (all phases).** One addon key **`crm`** (FLAT, per tenant) in `ADDON_GATE_REGISTRY`, `state: "dark"`, `reviewBy` +6 months, `grantPath` Platform Admin → Tenants → add-ons, `backfill` text per precedent; plus plan flag `flag.crm` in `DARK_PLAN_FLAGS` for screen visibility. Packaging recommendation: included (`includedAtPlan`) on Pro/Enterprise, purchasable add-on on Standard, **excluded from LITE** (LITE is invite-only lean; a LITE tenant sees an upsell card, not the module). Phase 4 telephony is a second key `crm_telephony` (metered minutes are a real cost). Publishing SKUs into a `PlanVersion` is a separate catalog diff after the LITE work lands (decision #3). Every phase ships `dark` and flips per the blast-radius routine.

**REG strategy (all phases).** Jest: tenant isolation (cross-tenant read = 404), conversion idempotency + dedup, gate registry row, enum parity for new enums (`packages/types/api/enums.ts` `*_VALUES`), `no-bare-cron`. Web RTL for forms. Playwright project `crm` added to the `local:e2e` allow-list from Phase 1; T2 rows need Playwright REG proofs. `local:validate` untouched (no existing endpoint changes). Seeds only on `test`/`e2e-routeflow`/`routeflow-demo`; `routeflow-hq` is the live dogfood tenant.

| Phase | Scope | Models (additive) | Web | Mobile (mirrors web) | Size / deps |
|---|---|---|---|---|---|
| **1 — Leads & follow-up** | Leads list + detail, stages, sources, unified timeline (notes + CustomerComment + Messages read-only), tasks with "My tasks", convert-to-customer, lead dedup, CSV import via `import` module, gate + code-map rows | `CrmLead`, `CrmLeadSource`, `CrmPipeline`, `CrmPipelineStage`, `CrmActivity`, `CrmTask`, `CrmSettings`; `ContactPerson.title`; `MessageThread.leadId` | `/crm/leads` (list, filters, quick-add), `/crm/leads/[id]` (timeline, tasks, convert), `/crm/tasks`, Customer page gets the timeline tab | **(operator)** leads list + detail, add note, add/complete task, tap-to-call (`tel:`) then "log outcome" prompt, convert. This is the field-sales core. | **M**. Depends on nothing in flight; lands after routeflow-hq T12–T15 so hq is the first tenant. |
| **2 — Deals & pipeline** | Deals, kanban with drag stage change, lost reasons, deal↔Estimate/OrderTemplate, weighted pipeline in `@routeflow/pricing`, saved views (list/kanban), GHL handoff→lead adapter | `CrmDeal`, `CrmLostReason`, `CrmSavedView` | `/crm/deals` kanban + list, `/crm/deals/[id]`, "create estimate from deal" | deals list, deal detail, stage picker (no drag), notes/tasks | **M**. Needs Phase 1. |
| **3 — Team & ownership** | Owners, assignment rules (round-robin/by zone), "my leads/deals", multi-contact leads, CustomerComment backfill, bulk actions, export | `CrmAssignmentRule`; `ContactPerson.customerId` nullable + `leadId?` | settings → CRM (stages, sources, lost reasons, rules), reassignment, bulk edit | "mine" filter, reassign | **M**. Needs 1–2. |
| **4 — Communications** | Email in/out on lead/deal/customer (threads, templates), WhatsApp/SMS on records, click-to-call + call log + recordings (Twilio) | `CrmCallLog`, `CrmTelephonySettings` (secrets via existing cipher pattern from `CrmConnection`) | composer on the timeline, inbox filters, call panel | WhatsApp deep link, log call, read threads | **L**. **Blocked on P6-3/P6-4 provider wiring**; Exotel deferred. |
| **5 — SLA, insight, field mode** | first-response SLA + breach notifications, CRM dashboard in `analytics` (funnel, win rate, won value vs realized accrual net sales, rep leaderboard), field-sales mode: today's visits, leads near my route, `VISIT` activity with check-in | `CrmSlaPolicy` | `/crm/dashboard`, SLA settings | **primary surface**: visit planner, nearby leads, check-in | **M**. Needs 1–3; dashboard needs 2. |
| **6 — Capture (optional)** | web-to-lead public endpoint (rate-limited, per-tenant token), buyer-portal signup request → lead, calendar export (ICS) for tasks | none | settings → capture forms | none | **S**. Defer until a tenant asks. |

## 6. Integrations

- **Email**: Phase 4, on the existing `email` service + `Message(channel=EMAIL)`; inbound threading keyed by `MessageThread` + `In-Reply-To`/tenant address; **not before P6-3**. Templates = `MessageTemplate`.
- **Calls**: Phase 4, Twilio only (US market — USD default, tobacco licence fields); Exotel **deferred** indefinitely. Mobile Phase 1 already gives tap-to-call + manual log, which covers 80 % of field use.
- **WhatsApp**: Phase 4 via P6-4's provider; until then deep links + a logged `WHATSAPP` activity (Phase 1 mobile).
- **Calendar**: Phase 6 ICS export; two-way Google/Microsoft sync **deferred** (OAuth scope + support cost > value).
- **GoHighLevel**: Phase 2 adapter (handoff → lead), write-back unchanged.
- **Buyer portal**: Phase 6 (signup request → lead). **ERPNext/Zoho**: never.

## 7. Risks and owner decisions

1. **License & counsel** — Rec: engage counsel with the exact question "clean-room reimplementation from public docs of an AGPL-3.0 app; no source consulted; confirm no obligation" and get the §13 reading in writing before Phase 2 (Phase 1 can start on the clean-room rules, which are safe under every reading). Risk if skipped: a contributor "borrowing" a Vue component contaminates the repo.
2. **Build vs integrate** — Rec: (c) native. Reject (a) outright; reject (b) (two products to run, tenancy mismatch); (d) stays as a connector.
3. **Pricing/packaging** — Rec: `crm` FLAT addon, included Pro/Enterprise, add-on on Standard, excluded from LITE; `crm_telephony` separate, metered; SKU publish only after the LITE catalog lands. Owner sets prices.
4. **GHL future** — Rec: keep as connector, fold its $9.99 SKU into `crm` as a "sync connector" line at the next catalog version; retire the standalone handoff UI after the pilot migrates. Owner decides whether the pilot tenant is told now or at Phase 2.
5. **Data migration for existing tenants** — Rec: none forced. Timeline reads legacy comments live (Phase 1); the Phase 3 backfill is opt-in per tenant, dry-run first, owner-run on prod. No customer becomes a lead retroactively.
6. **Scope cuts** — Rec: cut custom fields/form scripts (fixed models + `attributes Json?` escape hatch only on pilot request), holiday lists, Exotel, two-way calendar, org-vs-customer split, ERPNext-style product sync. Say no to each unless a paying tenant asks.
7. **Schema placement** — Rec: `sales.prisma`; approve a `crm.prisma` file (split-script invariant edit) only if the owner prefers a domain file — decide before Phase 1 S3.
8. **Dogfood tenant** — Rec: `routeflow-hq` (class INTERNAL, Phase 0 T12–T15) is the first CRM tenant: RouteFlow's own pipeline of distributors runs in it, and hq's "accrual net sales" ruling is the realized-revenue metric. Requires T12–T15 to land first.
9. **Mobile depth per phase** — Rec: Phase 1 and Phase 5 are mobile-heavy (field sales); Phases 2–4 mobile is read + light write. Owner confirms mobile is in the Phase 1 definition of done (it is, per "mobile mirrors web").
10. **Naming** — Rec: product name "Sales" / "CRM" in nav; never "Frappe". Module `CrmCoreModule` beside the GHL module.

Risks beyond decisions: P6-3/P6-4 slip blocks Phase 4 only; addon-gate `reviewBy` discipline; `Customer.userId` coupling makes conversion heavier than Frappe's (mitigated by reusing the create path); kanban drag on web needs a REG proof; Phase 1 adds `crm/core` code-map rows next to the existing GHL entries.

## 8. Next step

**Launch now (lead):** dev-pipeline **S0 for Phase 1 — "CRM core: leads, timeline, tasks, convert"**, `mode: feature`; Fable plans S1–S5, Sonnet builds, Opus reviews. S0 inputs: this `plan.md`; `context-pack.md` Parts B–C (Part A is the provenance record); a Sonnet-written **product blueprint** (≤ 15 KB) from `docs.frappe.io/crm` + the hosted demo only — screens, fields, flows in RouteFlow terms, with the provenance line; `billing/addon-gate-registry.ts` + `plan-flag.guard.ts`; `apps/api/src/crm/*` (GHL, to coexist with); `sales.prisma` (`Customer`, `ContactPerson`, `CustomerComment`, `SalesAgent`), `platform.prisma` (`MessageThread`); the `customers.service` create path; `packages/types/api/enums.ts` + `enum-parity.spec.ts`; `LESSONS-DIGEST.md` (L-072 enum mirrors, L-113 compose boot gate, L-119 in-lane seams). Branch `feature/crm-core-phase1` off fresh master after routeflow-hq T12–T15 merge.

**Must NOT start until the owner rules:** any fetch of `github.com/frappe/crm` source (never, under every option); the Phase 2 GHL migration or any `crm_gohighlevel` SKU change (#4); publishing the `crm` SKU or prices (#3); the CustomerComment prod backfill (#5); a `crm.prisma` file (#7); telephony vendor contracts. Counsel (#1) is required before Phase 2 opens, not before Phase 1 S0.

## Owner rulings after this plan (2026-09-15)
- **Approach:** behaviour translation FROM SOURCE (supersedes "clean-room from docs only"). The owner has authorized reading Frappe CRM source and covers licensing. Per domain: a Sonnet source-to-spec pass, then a native build. First spec: `spec-leads-deals.md`.
- **Design system (binding):** every CRM screen uses RouteFlow's existing design system (colours, fonts, spacing, components, look and feel) on web and mobile. No UI change, no Frappe visual language, no frappe-ui components. Specs describe behaviour and patterns; builders map patterns to existing RouteFlow components; UI review checks consistency with neighbouring RouteFlow screens.
- **UI proof (binding, owner 2026-09-15):** every CRM screen is proven with Playwright on the local stack with an approved test tenant: 1440/768/390 screenshots, empty/loading/error/populated states, key interactions driven, and a side-by-side against neighbouring RouteFlow screens. An independent visual review (Opus UI judge / impeccable finish-reviewer) follows before merge. Each phase plan includes `ui-verify` tasks. Native Expo screens get tests + design review, stated as such.
