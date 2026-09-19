# PLAN — Multi-category labels + jurisdiction-based selling restrictions

Date 2026-09-18 · Author Fable 5.1 (planning only) · Base **origin/master @ 6f49cbf5** (local checkout
06752f88 is 30 commits stale; every file:line below was read from origin/master).

**Honest total: 13 lane-days build + 2 days independent review/landing = 15.** A floor of ~11 is
reachable by cutting the four items marked *(cuttable)* in §7. Nothing else is padding.

Two owner clarifications received mid-plan are folded in (§2.4 governing address is a tenant
setting; §2.6 three feature states; §1.3 variant opt-out is a positive+negative override).

Legend: **[REPORT]** = what exists on origin/master, cited. **[PROPOSE]** = the design.

---

## 0. Investigation findings [REPORT]

### 0.1 The regulated module already models
- **`TrackedCategory`** (`apps/api/prisma/schema/compliance.prisma:110-158`) — a tenant-defined
  regulated class with tax type/rate, `requiresLicense`, `requiresAgeCheck`/`requiresIdCheck`,
  `invoiceTreatment`, `reportTemplate`, an `appliesScope` JSON (`{cities:[…]}`) and an `active`
  flag. **A product points at at most ONE** (`Product.trackedCategoryId`, `catalog.prisma:76`) plus
  an optional `TrackedSubcategory` (`compliance.prisma:167-186`, "REPORTING/CLASSIFICATION ONLY").
- **`CustomerAuthorization`** (`:191-226`) — per (customer, category) license state with an
  immutable actor snapshot (`verifiedById`/`verifiedByName`). **`AuthorizationOverride`** (`:231-254`)
  — append-only "sold under my responsibility" record. Both are the house pattern for a compliance
  audit trail: FK-less actor id + display name, never mutated.
- **`AuthorizationGuardService`** (`apps/api/src/authorizations/authorization-guard.service.ts:33-89`)
  — the sale-time guard. `checkAuthorized()` returns `{blocked[]}`; `assertAuthorizedOrThrow()`
  throws a structured `409 {code:"REGULATED_AUTH_REQUIRED", blockedCategories[]}` that web/mobile
  already turn into a modal. It is READ-ONLY and has a `deliveryCity` parameter that **no caller
  passes** (grep of `orders.service.ts` finds no `deliveryCity`).
- **`scopeApplies()`** (`authorizations/authorization-scope.ts:35-43`) — the existing geo check,
  documented **FAIL-CLOSED**: unknown city ⇒ gate. This is the precedent the new engine follows.
- **`RegulatedVisibilityService.computeGate()`** (`apps/api/src/buyer/regulated-visibility.service.ts:31-58`)
  — the ONE buyer-side hide predicate shared by catalog and dashboard, whose header comment states
  the exact principle this feature needs: hiding "over-hides", the guard is authoritative.
- **Ledger + filings** — `RegulatedSalesLedger`/`RegulatedFiling` (`compliance.prisma:261+`),
  `tx-report.ts` buckets per product `regItemType`/`regUom*` and receives the customer's full
  `addresses[]` with `addressType`/`isDefault` (`regulated/tx-report.ts:84-101`). Reporting only —
  it never blocks a sale.
- Nothing in the module knows a **state**, a **federal** scope, an **effective date**, or a
  **product-level** (vs category-level) restriction. It gates on *licence*, not on *legality*.

### 0.2 Product categories and variants today
- `Product.category String?` — **one free-text label** (`catalog.prisma:51`), autocompleted from
  distinct strings (`products/products.service.ts:357-371`); the web form is a
  `CategoryCombobox` ("Select or type a category", `apps/web/app/(dashboard)/products/[id]/page.tsx:1770-1786`).
- One regulated section `trackedCategoryId` + one `trackedSubcategoryId`. The "one-category-axis"
  rule overwrites `category` with the subcategory name for regulated products
  (`products.service.ts:666-676, 689`). So today a product has **at most two labels, one of them
  free text**. Multi-label does not exist.
- Variants: `parentProductId` self-relation + `variantName` (`catalog.prisma:72-73, 117-118`), name
  uniqueness via partial indexes (`:125-133`). Web: `VariantSplitModal.tsx`, `GroupAsVariantsModal.tsx`,
  `POST /products/bulk-assign-parent` (`products.controller.ts:78`).
- **Variant creation SNAPSHOTS the parent's category/section** at create time
  (`products.service.ts:575-632`: "DTO-explicit values always win", inherit `category`,
  `trackedCategoryId`, `trackedSubcategoryId`). Nothing propagates a later parent change. This is
  precisely the model the owner ruled out (§1.3 decision 1).

### 0.3 Customer address model
- `CustomerAddress` (`sales.prisma:266-290`): `line1/line2/city/state/zip/lat/lng`, `isDefault`,
  `addressType String @default("BILLING")`. Values in use: `"BILLING"` and `"SHIPPING"` only
  (`customers.service.ts:909`, `import.service.ts:357-486`). **`state` is free text** — no enum, no
  normalizer anywhere (`tx-report.ts:115` caps it at 2 chars and merely warns).
- `Customer` (`sales.prisma:132-245`) has **no address fields of its own** and no "registered
  address" concept; `TenantConfig` holds the *tenant's* address (`tenancy.prisma:227-232`).
- **`Order` carries no address** (`sales.prisma:576-663`); a delivery address only becomes known
  when a stop exists (`RouteRunStop.addressId`). The buyer/staff create DTOs have no `addressId`.
- Which address legally governs is therefore genuinely undetermined by the data model — folded
  into §2.4 as the tenant setting the owner asked for.

### 0.4 Buyer portal catalog path
`BuyerCatalogService.getCatalog()` (`apps/api/src/buyer/buyer-catalog.service.ts:107-140+`) →
`visibility.computeGate(customerId)` → `productsService.list(query, {excludeTrackedCategoryIds,
andWhere})` (`products.service.ts:212-276`, AND-pushed so it composes with pagination and the `ids`
cart-pricing filter). `BuyerDashboardService` uses the same gate. The web cart is client-side
(`apps/web/lib/buyer-cart.ts`) and prices lines from the `ids` query — the header comment at
`buyer-catalog.service.ts:124-126` warns a missing id "silently prices the missing lines at 0".

### 0.5 Every server path that puts a line on a sale (file:line)
| # | Path | Guarded today? |
|---|------|----------------|
| 1 | `OrdersService.create` (`orders/orders.service.ts:1950`) — funnel for `POST /orders` (staff web+mobile, **scan-to-order**), `POST /orders/sell` (`:2759` → `create`), `POST /buyer/orders` (`buyer/buyer.controller.ts:712`), change-request NEXT_DELIVERY draft (`orders/change-requests.service.ts:350`) | licence guard `:2517` (non-draft only); archived-product reject `:2191` |
| 2 | `OrdersService.changeStatus` (`:2825`) — DRAFT promote re-runs the guard | `:2908-2930` |
| 3 | `OrdersService.updateOrderItems` (`:3459`) — `PATCH /orders/:id/items` (staff/mobile edit-items + scan FAB), `PATCH /buyer/orders/:id/items` (`buyer.controller.ts:747`), buyer merge-into-active (`:617`); line creates at `:3735,3801,4032,4217,4322,4434` | guard `:3585`; archived-add reject `:4308` |
| 4 | `OrdersService.approveChangeRequestAtStop` (`:5810`) — driver-approved at-door add; line create `:6231` | guard `:5875` |
| 5 | `OrdersService.mergeAllPendingForCustomer` (`:890`, creates `:1116,1143`) / `forceConsolidateCustomer` (`:1255`, `:1438,1463`) — copies EXISTING lines between the same customer's orders | none; no new product enters (§3 exempt) |
| 6 | `OrderTemplatesService.createOrderFromTemplate` (`order-templates/order-templates.service.ts:377`, direct `order.create` `:494`) — cron `generateDailyOrders` `:298`, operator/buyer `generateOrderForUser` `:293`; `addItem` `:232` | guard `:395` — **skip-and-notify**, never hard-fails |
| 7 | `RecurringInvoicesService.generateInvoiceFromTemplate` (`recurring-invoices/recurring-invoices.service.ts:223` → `invoicesService.create` `:269`) | via #8; a throw triggers REG-B106 rollback + nightly retry (`:284-300`) |
| 8 | `InvoicesService.create` (`invoices/invoices.service.ts:350` → `createSplitInvoices` `:1129`) | guard `:1146` |
| 9 | `InvoicesService.update` (`:3404`, items rewritten `:3567`) and `duplicate` (`:4629`, `:4717`) | **none** |
| 10 | `EstimatesService.convertToInvoice` (`estimates/estimates.service.ts:343`, direct `tx.invoice.create` `:410`) | **none** |
| 11 | `ImportService.importInvoices` (`import/import.service.ts:530`, `:941-956`) — historical documents with their original dates | none (§3 exempt, point-in-time) |
| 12 | `RoutesService.completeStop`/`completeWithPayment` (`routes/routes.service.ts:2311/2542`) — `DeliveryMutation` rows reference EXISTING order items only (`:2398-2403`; `complete-stop.dto.ts:23-31` says `productId` is advisory, FK copied from the item) | cannot add a product — verified not an entry point |
| 13 | `SaleDraft` (`drafts/drafts.service.ts:27`) — a JSON cart, not an order | evaluated when submitted via #1 |
| — | `inline-returns.service.ts:300`, `inventory.service.ts:1065` (purchase orders), `invoices.service.ts:2431` (`recomputeOrderFromInvoices` back-sync), `:6015` (check-fee line) | not sales — exempt |

### 0.6 Tenant configuration today
- `TenantFeatureConfig` (`platform.prisma:201-216`) holds a per-feature `mode` + `settings` JSON,
  but it is **written only by platform-admin** (`billing/feature-config.controller.ts:34-70`,
  `SuperAdminGuard`) and **read through `FeatureConfigStore`, which fails OPEN** to the registry
  default on any DB error and caches 30 s (`billing/feature-config.store.ts:43-83`). Wrong home for
  a tenant-owned, fail-closed compliance switch (see §6 for why the *pattern* is reused, not the row).
- Tenant-facing settings live in `SystemConfig` key/value rows (`platform.prisma:333-343`) behind
  `settings.controller.ts` (`@Controller(["settings","tenant/settings"])`, `@Roles(OPERATOR)` reads,
  `@Roles(TENANT_ADMIN)` writes, e.g. `/settings/route :447/:488`, `/settings/invoice :505/:524`).
- Audit: `AuditService.log({tenantId,userId,action,entityType,entityId,meta})`
  (`audit/audit.service.ts:4-35`, never throws).
- `FEATURE_REGISTRY` (`billing/feature-registry.ts`) is the entitlement/plan registry; nothing here
  is plan-gated in Phase 1, so no registry row is needed (Phase 2 if billing wants an add-on).

### 0.7 Related registry context
B519 (`.claude/campaign/bugs/B519.md`) / B524 (#913 "enforce feature requires on addon-enable"): the
console warned, the endpoint accepted. Same class of defect this plan refuses to repeat: **no hide-
only enforcement anywhere in §3**.

---

## 1. Data model [PROPOSE] — three tables, no changes to `Product`

### 1.1 `ProductCategory` (catalog.prisma) — the label
```
id, tenantId, name, archivedAt?, createdAt, updatedAt      @@unique([tenantId, name])
```
A plain label ("THC", "Nicotine", "Kratom", "Vape hardware"). Deliberately **separate from
`TrackedCategory`**: that model carries tax/licence/report semantics and a one-per-product FK; lifting
that constraint ripples into the ledger, filings and invoice splitting. A label carries no semantics
of its own; a rule (§2) gives it force. `Product.category` (free text) is untouched in Phase 1.

### 1.2 `ProductCategoryLabel` (catalog.prisma) — the assignment
```
id, tenantId, productId, categoryId, mode LabelMode {INCLUDE|EXCLUDE},
reason?, createdById?, createdByName?, createdAt              @@unique([productId, categoryId])
```
`EXCLUDE` is the variant opt-out. Rejected at write when the product has no `parentProductId`
(guard: an opt-out on a standalone product is meaningless and would read as a phantom bypass).
`reason` is REQUIRED for `EXCLUDE` (owner: an opt-out is a ban-bypass vector).

### 1.3 Effective label set — dynamic, never snapshotted
```
effective(P) = P.parent ? (INCLUDE(P.parent) − EXCLUDE(P)) ∪ INCLUDE(P)  :  INCLUDE(P)
```
Computed at read time by ONE batched resolver `ProductLabelsService.effectiveLabels(productIds[])`
(two `findMany`s: labels of the products + labels of their parents) that every consumer uses —
product read, eligibility engine, buyer visibility (L-167: one predicate builder, no per-site copies).
Decisions the owner forced, each explicit:
1. **Inheritance is dynamic.** Adding a label to a parent tomorrow labels every variant created
   yesterday. No copy is written on the variant, so there is nothing to go stale — this also means
   `VariantSplitModal`, `GroupAsVariantsModal` and `bulk-assign-parent` need **zero changes**.
   Re-parenting a variant re-derives its set from the new parent automatically.
2. **Opt-out is audited and reviewable.** Every `EXCLUDE` write logs `AuditLog` (action
   `product.label.opt_out`, meta `{categoryId, reason}`) and stores the actor snapshot on the row.
   `GET /selling-restrictions/opt-outs` lists every variant whose `EXCLUDE` names a category with an
   active rule — "show me every variant that dropped a restricted category".
3. **Opt-out ≠ indeterminate.** An `EXCLUDE` row is a signed tenant assertion and is honoured; the
   engine treats the variant as simply not carrying that label. Fail-closed applies only to the
   `INDETERMINATE` branch of address/state resolution (§2.5) — a different type, not a flag.
4. **Parent label removed ⇒ the variant's `EXCLUDE` persists** (inert while the parent lacks the
   label, re-applies if it returns). Chosen because the row records a fact about the variant's
   contents ("no THC"), which the parent's labelling does not change, and because clearing it
   would silently re-ban a legal SKU and erase an audited decision. The opt-outs list shows inert
   rows greyed ("parent no longer carries this label").
5. Only the **direct parent** is consulted (matches how `create()` inherits today,
   `products.service.ts:579`). Nested variants are out of scope (Phase 2).

### 1.4 `SellingRestriction` (compliance.prisma) — the rule (see §2)
```
id, tenantId,
categoryId? (FK ProductCategory) | productId? (FK Product)   -- exactly one, CHECK constraint
jurisdiction RestrictionJurisdiction {FEDERAL|STATE}, states String[] (2-letter USPS; empty iff FEDERAL)
surface RestrictionSurface {ALL|BUYER_PORTAL}
effectiveFrom DateTime @default(now()), effectiveTo DateTime?      -- null = open-ended
reason String, createdById?, createdByName?, createdAt
liftedById?, liftedByName?, liftedAt?, liftReason?
@@index([tenantId, effectiveTo]) @@index([categoryId]) @@index([productId])
```
Rows are **never deleted**; lifting sets `effectiveTo`/`lifted*`. Point-in-time and audit come from
this alone plus `AuditLog` rows on create/lift.

### 1.5 Tenant policy — two `SystemConfig` keys, no new table
`selling_restrictions.enabled` (`"true"`/`"false"`, **absent = ON**) and
`selling_restrictions.governing_address` (JSON precedence array, e.g. `["DELIVERY","BILLING"]`).
Why absent = ON: a rule created by a tenant must work without a second hidden switch — a rule that
silently does nothing is the trap this feature exists to close. OFF is the deliberate, audited opt-out.

Enums (`LabelMode`, `RestrictionJurisdiction`, `RestrictionSurface`) mirror into
`packages/types/api/enums.ts` as `*_VALUES` const arrays pinned by `enum-parity.spec.ts` (L-072).
Models go in `MODEL_DOMAIN` of `scripts/split-prisma-schema.mjs` (catalog / catalog / compliance).
Migration is additive (Squawk-clean); lands per L-184 (applied to prod + drift 0 before "landed").

**Data model in three sentences:** a tenant-scoped label table plus a product↔label join whose rows
are either INCLUDE or (variant-only, reasoned, audited) EXCLUDE, with the effective set derived at
read time as `(parent INCLUDE − own EXCLUDE) ∪ own INCLUDE`; an append-only `SellingRestriction`
rule table keyed to a label or a product with jurisdiction FEDERAL|STATE(+states[]), surface
ALL|BUYER_PORTAL and effectiveFrom/To; and two `SystemConfig` keys for the tenant's on/off switch and
governing-address precedence.

---

## 2. The rule model [PROPOSE]

### 2.1 What a restriction is
Deny-only. Scope = one label OR one product. Jurisdiction = `FEDERAL` (everyone, address never
consulted) or `STATE` + `states[]`. Surface = `ALL` (every path incl. cron) or `BUYER_PORTAL`
(self-serve only; staff may still sell — the owner's "stop making available only on the buyer
portal" case). Active iff `effectiveFrom <= now < (effectiveTo ?? ∞)`.

### 2.2 Precedence — there is none to resolve
With deny-only rules, "conflict" cannot occur: **any** active matching rule blocks. This is the
simplest model the owner's four cases allow, and it removes the whole "which rule wins" surface.
Allow-rules/exemptions (a licensed customer exempt from a state rule) are Phase 2.

### 2.3 Evaluation per line (the whole algorithm)
```
policy = read enabled + precedence (1 indexed point read; a DB error THROWS — never treated as OFF)
if policy.enabled === false  → return {mode:"OFF"}                 (state A: nothing else runs)
labels = effectiveLabels(productIds)                                 (2 reads, batched)
rules  = active rules where (categoryId ∈ labels ∪ productId ∈ lines) and surface applies to actor
if rules.length === 0        → return {mode:"ON", blocked:[]}       (state B: sellable)
for each line:
  if any FEDERAL rule matches      → blocked FEDERAL_BAN
  if any STATE rule matches:
      st = resolveGoverningState(customer, policy.precedence, ctx)   (§2.5; reads addresses once)
      if st.kind === "INDETERMINATE"  → blocked INDETERMINATE_ADDRESS (state C: fail closed)
      if st.state ∈ rule.states       → blocked STATE_BAN
```
Note the fail-closed branch triggers **only when a STATE rule is a candidate** for the line. A
tenant with only federal rules never needs an address; a product with no restricted label is never
blocked by a bad address. "Ambiguous rule" cannot exist with deny-only rules; the one data-level
ambiguity — a `STATE` row with empty `states[]` — is rejected at write and, if it ever exists,
**blocks everywhere** and is flagged red in the rules list (fail closed, never ignored).

### 2.4 Governing address — a tenant setting, not a design assumption
`selling_restrictions.governing_address` is an ordered precedence over three sources:
- `DELIVERY` — the stop's address when the order is already on a stop (`RouteRunStop.addressId`,
  at-door add path), else the customer's `addressType="SHIPPING"` rows;
- `BILLING` — `addressType="BILLING"` rows;
- `DEFAULT` — the `isDefault=true` row ("the customer's registered/primary address on file" — the
  closest thing the model has; see Open Question 1).
The enable modal forces the tenant to pick (no silent default); the API rejects `enabled=true`
without a precedence. The resolver takes the precedence as an input parameter, so the choice is
data, not code.

### 2.5 `resolveGoverningState()` — returns a discriminated union, never null
```
for source in precedence:
  candidates = addresses for that source (per §2.4)
  if none → next source
  codes = unique(normalizeUsState(a.state))          -- null for anything not a USPS code/full name (+DC, territories)
  if codes contains null   → INDETERMINATE("unparseable state on <source> address")
  if codes.size === 1      → DETERMINATE(code, source)
  if exactly one isDefault → DETERMINATE(that code, source)
  → INDETERMINATE("multiple <source> addresses in different states")
→ INDETERMINATE("no <precedence> address on file")
```
Type `{kind:"DETERMINATE",state,source} | {kind:"INDETERMINATE",why}` — TS exhaustiveness means a
new branch cannot fall through to "allowed". `normalizeUsState` is a pure function with the list in
`packages/types/api/us-states.ts` (web needs it for the rule editor).

### 2.6 Three feature states — kept apart in the type system
| State | Condition | Result | Cost when no rule involved |
|---|---|---|---|
| **A · OFF** | `enabled === "false"` | `{mode:"OFF"}` — nothing evaluated, nothing blocked | 1 indexed point read |
| **B · ON, no match** | no active rule touches the lines | `{mode:"ON", blocked:[]}` | +1 batched rule read (+2 label reads) |
| **C · ON, indeterminate** | a STATE rule is a candidate and §2.5 is INDETERMINATE | blocked, reason `INDETERMINATE_ADDRESS` | — |
A and C never share a code path: OFF returns before the resolver is constructed; C is produced only
inside the resolver's union. Pinned by the test in §10.2. On "no extra queries" when OFF: the honest
minimum is the one point read (~1 ms, unique index) per sale write / catalog page; the only way to
reach literally zero is a cache, which opens a staleness window on the OFF→ON flip the owner asked
to be safe. Phase 1 takes the point read; a 30 s cache is a Phase 2 knob if measured.

### 2.7 Point-in-time
Rules are evaluated at request time against `now`. Nothing ever re-evaluates persisted orders,
invoices, ledger rows or filings; a lifted rule keeps its `effectiveFrom/To` so "was this legal on
date D" is answerable from the row. Staff-backdated `orderDate` (`orders.service.ts` `parseOrderDate`)
is NOT honoured in Phase 1 (evasion vector; Phase 2 with an audit flag).

---

## 3. Enforcement points [PROPOSE] — one service, one call per path

`SellingRestrictionsService` (`apps/api/src/restrictions/`): `checkSellable(params)` (non-throwing)
and `assertSellable(params)` → `409 ConflictException({code:"SELLING_RESTRICTED", blockedLines:[
{productId, productName, categoryName?, ruleId, reason: FEDERAL_BAN|STATE_BAN|BUYER_PORTAL_ONLY|
INDETERMINATE_ADDRESS, state?, message}]})`. `params = {customerId, actor: STAFF|BUYER|SYSTEM,
lines:[{productId, qtyDelta?}], orderId?, stopAddressId?}`. Actor from the JWT role
(`CUSTOMER`/buyer JWT ⇒ BUYER; cron ⇒ SYSTEM, treated as staff surface). The shape mirrors
`REGULATED_AUTH_REQUIRED` so the existing modal plumbing gets a sibling, not a rewrite.

User-readable messages (never a bare 403): *"Cannot sell **Geek Bar Mango**: **THC** products are
restricted in **TX** (rule added by J. Doe on 2026-09-01: 'HB 1234'). Remove the line to
continue."* / *"…is federally restricted…"* / *"…cannot be sold through the buyer portal — contact
your rep."* / *"Cannot confirm **Acme Mart**'s delivery state: no shipping address on file with a
valid US state. Add one, or change Settings → Restrictions → Governing address."*

| Path (§0.5 #) | Where the call goes | Blocked ⇒ |
|---|---|---|
| 1 `create` | directly after `:2517`, same `!isDraft` condition, before the stock transaction; `qtyDelta` = line qty | 409, nothing written |
| 2 `changeStatus` | after `:2921` (DRAFT promote is the moment of sale) | 409; draft stays a draft |
| 3 `updateOrderItems` | after `:3585`; NEW lines always; EXISTING restricted lines only when `qtyDelta > 0` (decrease/remove always allowed — a ban must never trap an operator into keeping stock on an order) | 409, transaction not opened |
| 4 `approveChangeRequestAtStop` | after `:5875`, `stopAddressId` from the stop so DELIVERY resolves exactly | 409 to the driver with the line named |
| 5 merges | **exempt** (same customer, existing lines, no new product); documented in the coverage spec's EXEMPT list | — |
| 6 templates | beside `:395`, same skip-and-notify pattern; reuse `notifySkippedRegulatedLines` with a second reason; all lines skipped ⇒ `null` as today | line dropped, both sides notified, template kept |
| 7 recurring invoices | pre-filter lines in `generateInvoiceFromTemplate` before `:269` (SYSTEM actor); blocked lines dropped + note appended like `buildArchivedItemsNote`; **zero lines left ⇒ `lastRunStatus:"FAILED"`, `lastError:"All lines restricted: …"` and the cycle is NOT given back** (one attempt per cycle, not a nightly hammer — the REG-B106 retry loop is for transient failures, a ban is not transient) | partial invoice or visible FAILED |
| 8 `createSplitInvoices` | after `:1146` (covers direct `POST /invoices`, and #7's remaining lines) | 409 |
| 9 `update` / `duplicate` | new product lines in `update` (mirror the B142 archived-add rule); every line in `duplicate` | 409 |
| 10 `convertToInvoice` | at conversion (the sale), not at estimate create (a quote is not a sale) | 409 with the estimate kept ACCEPTED |
| 11 import | **exempt** — historical documents at their original dates (point-in-time); the exemption is named in the coverage spec | — |
| buyer catalog/dashboard | `computeGate()` gains `restricted: {categoryIds, productIds}` for the buyer's resolved state (INDETERMINATE ⇒ every STATE rule applies — over-hide, as the file's own comment prescribes); `productsService.list` gets one AND clause per blocked category: `NOT(own INCLUDE c) AND NOT(parent INCLUDE c AND NOT own EXCLUDE c)` plus `id notIn productIds`; single-product detail uses the same gate | hidden; checkout (#1) remains authoritative |
| buyer cart pricing | the `ids` query now returns `unavailable:[ids]`; `buyer-cart.ts` marks those lines "no longer available" instead of pricing them 0 (the trap at `buyer-catalog.service.ts:124-126`) | line shown blocked with reason |

Coverage is **proved, not assumed** — §10.3.

---

## 4. Things already in flight [PROPOSE]

| Thing | On a new rule (or OFF→ON) | Detail |
|---|---|---|
| Past PENDING/CONFIRMED/DELIVERED orders, invoices, ledger, filings | untouched | point-in-time; no job, no status flip |
| **Draft order** with a now-restricted line | kept; blocked at promote (#2) with lines named; qty decrease/remove allowed; the order detail shows the chip "Restricted — remove to confirm" | no silent mutation of the draft |
| **Live order** (PENDING+) with a pre-ban line | kept and deliverable; adding qty blocked (#3); delivery proceeds (the sale already happened) | Open Question 3 if the owner prefers "allow increases" |
| **Standing order template** | kept, `isActive` unchanged; next generation skips the line, notifies operator + buyer (existing channel) | badge on the template list is Phase 2 |
| **Recurring invoice** | kept; next run bills the remaining lines with a note; all-restricted ⇒ visible FAILED once per cycle | §3 #7 |
| **Buyer cart** (client localStorage) | catalog hides the product; cart marks the line unavailable; checkout 409 names it | no server cart exists |
| **Saved staff draft** (`SaleDraft`) | evaluated on submit | — |
| **Estimate** with a restricted line | kept; convert blocked until the line is removed or the rule lifted | — |
| **OFF→ON toggle** | identical to "every stored rule just became active": all rows above apply at their next touch point; the enable modal shows the impact preview (§6) so the tenant sees counts before confirming | audited |
| **ON→OFF toggle** | nothing blocked from now on; rules stay stored (so ON again restores them); `AuditLog` `selling_restrictions.disabled` with required reason | audited |

---

## 5. Keeping the item [PROPOSE]
A restriction is a **separate rule row**; the `Product` row is never touched: `isActive` stays true,
`currentStock`/`averageCost`/lots/movements/counts/PO receiving/analytics/regulated ledger all
continue. The product list shows a "Restricted (TX, FL)" / "Restricted (federal)" chip from the same
resolver. **Restore = lift the rule** (`POST /selling-restrictions/:id/lift {reason}` sets
`effectiveTo`, stamps `lifted*`, logs audit) — instantly sellable again, history intact. Contrast with
today's blunt tool, `isActive=false` (archive): hides from lists, rejects new lines (B142 guard at
`orders.service.ts:2191/4308`), not jurisdiction-aware, and lets a recurring invoice bill the item
anyway (`recurring-invoices.service.ts:257-265` deliberately allows archived lines through). Tenants
who used archive for a federal ban can unarchive + add a FEDERAL rule; no migration needed.

---

## 6. Tenant configuration [PROPOSE]
- **Settings → Restrictions** (`GET/PATCH /settings/restrictions`, `@Roles(TENANT_ADMIN)` write,
  same file/pattern as `/settings/route`): `{enabled, governingAddress[], reason}`. Reason required
  on disable. Every write ⇒ `AuditLog` (`selling_restrictions.enabled|disabled|governing_address_changed`,
  meta `{previous, next, reason}`). Reuses the `SystemConfig` + `settings.controller` pattern rather
  than `TenantFeatureConfig` because that row's reader fails open and its writer is platform-admin
  only (§0.6) — both wrong for a tenant-owned compliance switch.
- **Compliance → Selling restrictions** (third card on `apps/web/app/(dashboard)/compliance/page.tsx`,
  beside "Regulated Types" `:93` and "Filings" `:158`): rules table (scope, jurisdiction, states,
  surface, effective window, who/when/why, status Active/Scheduled/Lifted/Invalid), "Add rule"
  modal, "Lift" with reason, and the **Opt-outs** tab (§1.3-2). Banner when the feature is OFF:
  "Rules are stored but not enforced".
- **Impact preview** *(cuttable)* — `GET /selling-restrictions/impact?rule=…` returns counts of
  draft orders / templates / recurring invoices / products affected; shown in the Add-rule and
  Enable modals so the tenant sees what a click does before it does it.
- **Product detail**: "Labels" chip multi-select (create-inline like `CategoryCombobox`) under the
  existing Category field; on a variant, inherited labels render greyed with "Opt out…" (reason
  required) and own labels editable. Product list: label filter + Restricted chip.
- Mobile: no management UI in Phase 1; server enforces and the existing 409 modal shows the message.

---

## 7. Build order [PROPOSE] — days are lane-days, Sonnet builders, Opus review

| Step | Ships | Days | What the owner can do after it |
|---|---|---|---|
| **1** Schema + labels API: migration (§1.1-1.2), `ProductLabelsService.effectiveLabels`, `/product-categories` CRUD, `PUT /products/:id/labels`, opt-out endpoints with audit, product read returns `{own, inherited, excluded, effective}`; enum mirrors; `MODEL_DOMAIN`; *(cuttable)* one-shot backfill turning each distinct `Product.category` string into a label + INCLUDE rows | 2.5 | label any product/variant with many categories via API; variants inherit live |
| **2** Web labels UI: chip picker on product detail, variant inherited view + opt-out modal, list filter | 1.5 | **owner sees and uses multi-labels + opt-outs** |
| **3** Rules + policy + engine: migration (§1.4), `SellingRestrictionsService` (§2 incl. resolver, normalizer, three-state result), `/selling-restrictions` CRUD+lift, `/settings/restrictions`, opt-outs list, audit; *(cuttable)* impact preview | 2.5 | create/lift rules and set policy via API |
| **4** Enforcement at every §3 point + structured 409 + buyer visibility/cart `unavailable` + the coverage spec (§10.3) + per-path no-write specs | 2.5 | **bans are enforced everywhere** |
| **5** Web: compliance card + modals, settings page, 409 handling in staff order create/edit, buyer cart blocked lines, Restricted chip | 2.5 | full tenant self-service |
| **6** Mobile: 409 `SELLING_RESTRICTED` handling in order create / edit-items / scan sheet *(cuttable — the modal already shows `error.message`)* | 0.5 | readable reason on mobile |
| **7** Proof: Playwright compliance + buyer-portal flow at 1440/768/390, feature-smoke rule loop on `test` tenant, `local:validate`, `local:e2e` | 1.0 | merge-ready evidence |
| | **Build total** | **13** | |
| | Independent pre-merge review + fix round + landing (bookkeeping PR) | 2 | |
| | **Total** | **15** | floor ≈ 11 with the four *(cuttable)* items removed |

Order rationale: steps 1-2 are independently shippable and visible in under a week; steps 3-4 are
one PR (rules without enforcement would be the B519 defect); 5 follows 4 so no UI ever ships ahead of
its server check. Every step is a `feat/*` branch through `dev-pipeline`; migrations per L-184.

---

## 8. Phase 2 — deliberately cut
- Finer jurisdictions (county/city/ZIP), non-US; unifying `TrackedCategory.appliesScope` cities with this engine.
- Allow-rules / per-customer exemptions (e.g. a licensed buyer exempt from a STATE rule); a §8-style "sold under my responsibility" override for restrictions (explicitly NOT — bans have no override).
- Linking `TrackedCategory` ↔ `ProductCategory` so a regulated section is automatically a label; migrating `Product.category` free text off the `Product` row.
- Blocked-attempt log + compliance report "sales into now-restricted states before/after date".
- Honouring staff-backdated `orderDate` for pre-ban entries (with an evasion audit flag).
- Platform-admin "federal rule templates" pushed to all tenants (policy decision: the platform asserting law).
- Cache for the policy read; template-list / recurring-list "restricted line" badges; buyer email on new restriction; CSV import of rules; nested (grandchild) variants; mobile management UI; plan/add-on gating in `FEATURE_REGISTRY`.

---

## 9. Open questions for the owner (only where the answer changes the build)
1. **"Registered address"** — is it the customer's `isDefault` address on file (what `DEFAULT` maps to), or the licensed-premises address on the licence/authorization (a new field on `CustomerAuthorization`, +0.5 d in step 3)?
2. **BUYER_PORTAL-only rules vs. mediated paths** — the 06:00 cron generating a standing order, and a staff-/driver-approved buyer change request, are treated as *staff surface* (allowed). Flip to "buyer surface" is one line; it is a policy call.
3. **Live orders** — block qty *increases* on a pre-ban line (chosen) or allow them?
4. **Who may write rules / toggle the feature** — `TENANT_ADMIN` only (chosen) or any `OPERATOR`?

(Variant opt-out and governing address were answered mid-plan and are specified in §1.3 / §2.4.)

---

## 10. Test strategy [PROPOSE]

### 10.1 Unit — the engine (`restrictions/selling-restrictions.service.spec.ts`, prisma-mock)
Table-driven matrix over {OFF, ON+no rule, FEDERAL, STATE match, STATE no-match, BUYER_PORTAL as
buyer / as staff / as SYSTEM, effectiveFrom future, lifted, product-scope vs label-scope, qtyDelta ≤ 0
on existing line}. Resolver matrix over {single address, multi same-state, multi differing with/without
isDefault, missing type, "Texas"/"tx"/"TX "/"Tejas"/"", precedence fallback}. Effective-labels
resolver: label added to parent after variant creation appears; EXCLUDE persists after parent label
removal and re-applies; EXCLUDE on a standalone product rejected; re-parent re-derives.

### 10.2 Proving fail-closed actually fails closed
- **The pinned three-state test**: one indeterminate address (blank state) + one STATE rule on the
  product's label — assert `assertSellable` **throws `INDETERMINATE_ADDRESS`** when
  `enabled=true` and **resolves** when `enabled="false"`; a third case asserts the *reason code*
  differs from a real `STATE_BAN` so the UI can never show "restricted" for "unknown".
- Policy read throws ⇒ `assertSellable` rejects (never resolves, never `{mode:"OFF"}`).
- Address read throws ⇒ rejects. Label read throws ⇒ rejects. (Each pinned separately — L-081:
  the gate lives inside the primitive, so a mock that short-circuits one read cannot let the
  others fall through.)
- Rule row `STATE` + `states=[]` ⇒ blocked for every state and for a determinate address.
- Type-level: the resolver's return is a discriminated union with an `assertNever` in the engine;
  `tsc` fails if a branch is added without a verdict.
- Normalizer property test: any string not in the USPS list ⇒ `null`; every list entry and full
  name round-trips.

### 10.3 Proving every enforcement path is covered, not assumed
- **`restrictions/enforcement-coverage.spec.ts`** — a source-scan spec modelled on
  `common/no-bare-cron.spec.ts:1-40`: walk `apps/api/src`, find every file containing
  `orderItem.create(`, `items: { create`, `invoice.create(` or `order.create(`; each must contain
  `assertSellable(`/`checkSellable(` **or** appear in an `EXEMPT` map with a reason string (merges,
  `recomputeOrderFromInvoices`, returns, purchase orders, import). A new line-writing site anywhere
  fails `npm run verify` until it is guarded or exempted with a reason. Zero scanned files ⇒ error,
  never pass (L-202).
- **Per-path no-write specs** (existing `REGULATED_AUTH_REQUIRED` specs as templates): for each of
  §3 #1-4, #6-10, a blocked line ⇒ 409 `SELLING_RESTRICTED` **and** `orderItem.create`/
  `invoice.create` **not called**; for #6/#7 the skip+notify/FAILED outcomes.
- Visibility ⇔ guard parity: one fixture, assert the set hidden by `computeGate` ⊆ the set the guard
  blocks for the same buyer (over-hide allowed, under-hide never).
- DB lane (`*.db.spec.ts`, `npm run local:test:db`): create rule → real `POST /orders` on the `test`
  tenant → 409; lift → 201. Migration through `local:migrate` + `local:drift` exit 0.
- Enum parity (`enum-parity.spec.ts`), `split-prisma-schema.mjs --check`, Squawk on the migration.

### 10.4 E2E + proof (house rules)
Playwright on the `test` tenant: add label → variant inherits → opt out with reason → rule TX on
label → buyer in TX sees product gone, cart line marked unavailable, checkout 409 text → lift →
visible again; settings OFF (reason) → sellable; ON → blocked again. Screenshots 1440/768/390 for
compliance card, settings, product detail, buyer cart. `feature-smoke` gains the rule create/enforce/
lift loop. `local:validate` + `local:e2e` before the public window.

### 10.5 Lessons carried into the plan
L-167 (one shared predicate: visibility + guard + product chip all call `effectiveLabels`/`checkSellable`),
L-081 (gate inside the primitive, exclude-list mocks), L-072 (enum mirrors), L-124 (cron paths run
inside `tenantCtx.run`), L-169/L-181 (grep every caller; `select` must fetch `parentProductId`),
L-184 (migration landed = applied + drift 0), L-202 (zero candidates = error), L-200 (before removing
the archive control later, grep every client of it — not touched here).
