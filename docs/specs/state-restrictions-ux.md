# State portal limits: vital-few design (apple-ux PLAN, apple-design co-sign)

Pinned at `origin/master` a6bd2a8a6 (2026-10-12). Job: "Don't offer these 12 products, or this category, to my Texas
customers in the portal" (or to anyone). It must be fast, work in bulk, and be easy to undo. Owner rulings (1) to (3) bind.

## 0. Ground truth that shapes the design
- One store and one engine already exist: `SellingRestriction` (`apps/api/prisma/schema/compliance.prisma:435`) with
  `surface ALL | BUYER_PORTAL`, and `evaluate()` (`selling-restrictions.service.ts:325`), which delegates to the pure `evaluateRestrictions` (`selling-restrictions.core.ts:322`).
- Gap 1: the portal never hides anything. All ~13 visibility call sites pass `noBuyerRestrictions()`:
  `buyer-catalog.service.ts:110/181/315/369/393/461/495/562`, `buyer-dashboard.service.ts:24/134/144/206/332`,
  `buyer.controller.ts:501` (scan), `replenishment.service.ts:66/122`, `stock-alerts/stock-alert.service.ts:42`.
  `restrictedProductIdsFor` does **not exist yet**; it is named only in a comment (`buyer-product-visibility.ts:14`).
- Gap 2: the switch gates everything. `evaluate()` returns OFF when `selling_restrictions.enabled` is off (`:332`),
  and so do two order paths (`orders/change-request-restrictions.ts:32` and `orders/order-edit-restrictions.ts:84`). Turning it on 409s unless
  every customer resolves a state (`restrictions-settings.service.ts:132` → `assertReadyToEnable`). That breaks ruling (3).
- Gap 3: unknown state fails closed. A STATE rule plus an unresolved state gives INDETERMINATE, which blocks (`core.ts:415-424`). That breaks ruling (2).
- Gap 4: rules are created one at a time (`selling-restrictions-admin.service.ts:156`), lifting needs a typed reason, and
  `/settings/restrictions/rules` is linked from nowhere.

## 1. Placement
**Primary: the products list bulk bar.** Select rows, then **"Limit in portal…"**, placed right after "Show in portal"
(`products/page.tsx:1419`, beside `PortalBulkButtons`).
- A1 (right place): the admin's eye is already on the 12 products. The bar sits on the selection it acts on, next to the
  sibling "Hide from portal", which teaches the meaning by proximity.
- A2 (right moment): the bar appears only once rows are selected (reach = 1, no scroll). It needs no new navigation.
- apple-design co-sign: keep one verb family in one place ("Hide / Show / Limit in portal"). The new control is
  `secondary`, the same weight as its siblings, so Delete stays the only `danger`. At 390 px the bar's buttons wrap to a
  second row (flex-wrap) and nothing goes into a kebab.

**Secondary 1: the category row** in `/settings/product-categories`. Each label row gets a **"Limit in portal…"** text
button next to Rename/Archive. It opens the same dialog, scoped to the category, which covers products added to it later. A1: the
category is the object acted on.

**Secondary 2: the product page.** It is where limits are *seen* and *lifted*, but not created. A **"Portal limits"** row in `ProductLabelsCard`
shows chips such as `Not offered in TX` and `Hidden from all portal customers`, each with `via Vapes` when the limit is inherited
from a category or parent, plus **Lift**.

**Seeing and undoing everything:** `/settings/restrictions/rules`, renamed **"Portal limits & rules"** and linked
from the Settings hub card, the `/settings/restrictions` page, and every success toast. Rows get checkboxes so the admin can
**"Lift N"** in one action. Not chosen: settings as the primary entry. It fails A1 because the admin would have to remember 12 products by
name inside a picker.

## 2. Flow: "hide 12 products from Texas portal customers"
Expert path N = **5 actions** after the rows are ticked (Select, tick ×12, then 1 to 5 below). One primary action per state.

| # | State | Control and exact copy |
|---|---|---|
| 0 | Products list | `Select` (existing), tick 12 rows. Bar: `12 items selected` |
| 1 | Bulk bar | Click **`Limit in portal…`** |
| 2 | Dialog open | Title **`Limit 12 products in your portal`**. Radio group (default first): `Hide from customers in certain states` / `Hide from all portal customers`. State field `Which states?` uses the existing `StatePicker`, placeholder `Search states`. Click the field |
| 3 | Picker | Type `tex`, choose **Texas**. A chip `Texas ×` appears |
| 4 | Ready | Live line: `Customers in Texas won't see these 12 products in the portal. Your staff can still sell them.` When applicable: `4 customers have no state on file, so they'll still see them.` with link `Review` (opens the short list, see §3). `Note (optional)` field, placeholder `Why, e.g. not licensed in TX`. Checkbox off: `Legal ban — also block staff orders and invoices`. Buttons: `Cancel` · primary **`Hide from Texas`** (label tracks the choice: `Hide from 3 states`, `Hide from everyone`) |
| 5 | Done | Dialog closes. Toast `12 products hidden from Texas portal customers` with actions **`Undo`** and `View limits`. If some were skipped: `10 products hidden from Texas portal customers. 2 already were.` |

- Errors keep the input (A4). A server error shows inline in the dialog footer, `Couldn't save. Nothing was changed. Try again.`, and the
  form stays filled. Selecting more than 200 rows shows `Select up to 200 products, or limit a whole category instead.` (the same cap as `BULK_PORTAL_MAX`).
- Category variant: title **`Limit “Vapes” in your portal`**, live line `…won't see the 38 products labelled Vapes, or
  any you label later.`
- Checking "Legal ban" with the enforcement switch off adds this helper line: `Staff orders are blocked once enforcement is on.` with
  link `Turn on`. The portal still hides the products immediately (see §3).
- **Undo path:** (a) toast `Undo`, one tap, visible 10 s. It lifts this batch with the reason `Undone right after creating`, and its
  toast reads `Texas limit removed from 12 products`. (b) Later, from the product page chip: `Lift` → confirm `Lift this limit?` with the
  `Note (optional)` field and primary `Lift`. (c) In bulk, on the list: tick rows → `Lift 12` → the same confirm. Lifted rows stay in
  the list under the `Lifted` filter (lift-only audit trail).

## 3. Enforcement UX (smallest model change)
**Model: surface picks the channels. The switch only adds staff enforcement.**
1. **The portal channel always applies rules.** With the switch off, `evaluate(channel=BUYER_PORTAL)` and
   `restrictedProductIdsFor` still run. The switch now gates only the STAFF channel. One helper,
   `restrictionsApply(policy, channel)` in `core.ts`, replaces the three `!policy.enabled` short-circuits
   (`service.ts:332`, `change-request-restrictions.ts:32`, `order-edit-restrictions.ts:84`). Reason: portal limits are
   a commercial choice that the admin expects to work the moment they press Hide. Staff-channel blocking touches orders,
   invoices, recurring jobs and imports, so it stays opt-in.
2. **Unknown state:** when every matched STATE rule is `surface BUYER_PORTAL`, an unresolved state gives **ALLOW**
   (ruling 2). This is about 6 lines at `core.ts:415`. `ALL` rules (legal bans) keep INDETERMINATE (fail closed) on every channel.
3. **Readiness is advice, never a gate** (ruling 3). Drop the `assertReadyToEnable` call
   (`restrictions-settings.service.ts:132`) and the web `notReadyReadiness` refusal path. The "Is your customer data
   ready?" panel becomes **`Customers we can't place in a state (4)`**: the first 10 names, each linking to the
   customer's address, plus `Show all`, with the line `They still see products you've limited by state.`
4. Switch copy changes from "Enforce selling restrictions" to **`Also block restricted products on staff orders and invoices`**, with helper text
   `Portal limits always apply. Turn this on for legal bans your staff must not sell.`

**Compliance risks (flagged)**
- R1: a portal limit fails open for no-state customers, by ruling. If the Texas reason is legal (hemp, kratom or vape type), the admin
  must tick "Legal ban". That creates an `ALL` rule, which fails closed and stays hidden from no-state buyers. Its copy says exactly this.
- R2: change 1 makes *existing* `ALL` rules start binding the portal at tenants whose switch is off. **Before deploy:** the owner runs a
  read-only count of active rules per switch-off tenant. If any exist, ship a one-line guard: switch off means `BUYER_PORTAL` rules only.
- R3: `restrictedProductIdsFor` must hide **BLOCK and INDETERMINATE**. This changes the comment at
  `buyer-product-visibility.ts:9-14`, so a legal-ban product is never shown and then refused at checkout.

## 4. Portal: what a buyer in Texas sees
- **Hidden everywhere.** It is absent from shop and search, category rail counts (`getCatalogCounts`), product detail (404,
  existing copy `Product not found`), scan (`not found`), dashboard featured, recent and "buy again", favorites (row dropped),
  replenishment and shelf, and stock-alert sign-up. Past orders and invoices still show the line, as with any hidden product.
  The restriction reason never reaches buyers (staff-only, as today).
- **Cart** (localStorage, `buyer-cart.ts`): the cart's `ids` fetch already returns only visible products. After a
  *successful* load, the cart removes unresolved lines and shows a calm, non-error notice above the lines:
  `Some items are no longer available to you, so we took them out of your cart: Kratom 50ct, Vape Pod Mint.` Its
  only action is `OK`. No toast and no red. If the fetch fails, the cart removes nothing.
- **Reorder** (`POST /buyer/templates/:id/reorder`): for the buyer channel, drop restricted lines before
  `assertLinesSellable` (`order-templates.service.ts:626`) and return `skipped`. The UI shows `2 items aren't available
  to you and were left out.` When every line is restricted, it shows `None of these items are available to you right now.`
- **Checkout** keeps the 409 `SELLING_RESTRICTED` as the server's authority (race: a rule created mid-session).
  The existing blocked-lines dialog handles it.
- **No state on file:** the buyer sees products under portal limits (ALLOW, flagged to the admin in §3). They do not see products under legal bans.
- Mobile customer app: covered by the same API, with no client change.

## 5. Server work (reuse, one engine, no second store)
1. **`restrictedProductIdsFor(tenantId, customerId, at)`** in `selling-restrictions.service.ts`:
   - load active rules binding BUYER_PORTAL (return early with an empty set when there are none, which is the common case and costs one indexed query);
   - resolve the governing state once (the same code as `evaluate()`), keep the rules that block or are indeterminate for this buyer, then expand
     them: product rules → the id plus descendants (≤ 5 levels); category rules → products with an INCLUDE label (`@@index([tenantId, categoryId])`)
     plus descendants;
   - filter through `ProductLabelsService.effectiveLabels` so EXCLUDE opt-outs hold, and memoise per request.

   Expose it as `buyerVisibilityFor(tenantId, customerId): Promise<BuyerVisibilityContext>`. Every `buyerVisibility()` helper (catalog,
   dashboard, replenishment) and the scan and stock-alert sites call it. `noBuyerRestrictions` stays only inside
   `isBuyerVisibleBase` (the order gate, where the engine is the authority).
2. **`POST /selling-restrictions/bulk`** (same role as `create`, TENANT_ADMIN). The body takes `productIds[1..200]` XOR `categoryId`,
   plus `jurisdiction`, `states[]`, `surface` (default `BUYER_PORTAL` here), `reason?` (default `Portal limit`) and dates.
   - Behaviour: one `tenantTransaction`, one `createMany`, one audit row `selling_restriction.bulk_created {ids, scope, states}`.
     Products that already have an identical active rule are skipped.
   - Response: `{created, skipped, unknownStateCustomerCount}`. Refactor `create()` into a bulk of one, so one validation path covers both (`normalizeStates`
     and the archived-category check).
3. **`POST /selling-restrictions/lift-batch {ids[], reason}`**: one transaction, each lift guarded on `liftedAt IS NULL`, one audit row.
4. **`GET /selling-restrictions?productId=`** returns the rules binding the product, `via: PRODUCT|PARENT|CATEGORY`, for the chips. Add a `cursor`
   param (the seam for the 10k-SKU tier). `LIST_CAP` stays.
5. **`GET /settings/restrictions/unknown-state-customers?take=10`** returns `{count, customers[{id,name}], truncated}`. It uses the
   same `resolveGoverningState` and paging as `getEnableReadiness`, and the readiness endpoint stays.
6. Contracts go in `packages/types/api/restrictions-admin.ts` (`BulkRestrictionRequest/Response`, `LiftBatchRequest`, `ProductLimitDto`).
   No migration and no new table. `portalVisible` stays as catalog curation and is not a second restriction store.

## 6. Build split (3 parallel branches; C codes against the §5 types, frozen here)
**A `feat/portal-limits-engine`** (api: `selling-restrictions/*`, `buyer/*`, `stock-alerts`, `order-templates`, `orders/*-restrictions.ts`)
- Red tests:
  - (a) a buyer in TX with a BUYER_PORTAL TX product rule: list, search, counts, detail, scan, dashboard, favorites and replenishment all exclude the product (fails today: it is visible);
  - (b) a category rule hides a variant through its parent label, and an EXCLUDE opt-out keeps it visible;
  - (c) a no-state buyer and a BUYER_PORTAL rule: visible, and checkout ALLOWs;
  - (d) a no-state buyer and an ALL rule: hidden, and checkout 409s;
  - (e) switch off with a BUYER_PORTAL rule: portal checkout 409s and staff ALLOWs;
  - (f) an inventory pin spec: no `noBuyerRestrictions(` outside `buyer-product-visibility.ts`, and no `.enabled` short-circuit outside `restrictionsApply`;
  - (g) a rule with a future `effectiveFrom` does not hide yet, and hides at `at ≥ effectiveFrom`;
  - (h) buyer reorder skips restricted lines and returns `skipped`;
  - (i) zero active rules cost one query (a spy on prisma).
- Acceptance: all 13 sites use `buyerVisibilityFor`; the a–i specs are green; `npm run verify`; `local:validate`.

**B `feat/portal-limits-admin-api`** (api: `selling-restrictions-admin/*`, `restrictions-settings/*`, `packages/types`)
- Red tests:
  - (a) bulk with 12 products creates 12 rows in one transaction and writes 1 audit row;
  - (b) a failing row rolls the whole batch back (0 rows);
  - (c) an identical active rule is skipped and reported;
  - (d) 201 ids → 400;
  - (e) the XOR and state validation match `create`;
  - (f) lift-batch lifts N, and a second call → 409 with no overwrite;
  - (g) enabling the switch with indeterminate customers → 200 (fails today with 409);
  - (h) unknown-state list: count and first 10 sorted by name, walk-in excluded;
  - (i) `?productId=` returns the `via` values CATEGORY and PARENT;
  - (j) a CUSTOMER or OPERATOR token gets 403 on writes.
- Acceptance: contract types exported, Swagger lists the routes, `npm run verify`, `local:validate:features`.

**C `feat/portal-limits-web`** (web: products bulk bar, `LimitInPortalDialog` shared by products and categories, `ProductLabelsCard`
chips, rules page rename, checkboxes and Lift N, settings switch copy and short list, cart notice, reorder note, hub link)
- Red tests (RTL):
  - (a) the dialog title and button track the count and choice (`Hide from Texas`, `Hide from everyone`);
  - (b) the primary is disabled until a state is chosen;
  - (c) on a server error the input is kept and the footer copy shows;
  - (d) toast Undo calls lift-batch with the created ids;
  - (e) the cart removes unresolved lines only after a successful fetch and lists their names;
  - (f) chips render `via Vapes`;
  - (g) with the switch on, the settings page shows no refusal path;
  - (h) the rules page is reachable from the Settings hub.
- **Playwright at 1440 and 390** (`test` tenant, seeded buyers in TX, NY and with no state):
  - select 12 → `Limit in portal…` → Texas → `Hide from Texas`. The toast shows. As the TX buyer, the shop count drops by 12, search misses, the cart line
    is removed with the notice. The NY and no-state buyers still see the products. Undo → the TX buyer sees them again.
  - At 390 the bulk bar wraps with no horizontal scroll, and the dialog fits without page scroll with the primary visible.
  - Proof shots go to `local-assets/proofs/`.

The merge order is A, then B, then C (C rebases on B's types). Each branch is independently green. C's E2E runs on the A+B+C train tree.

## 7. Design Gate (Lite)
- **G1 Fit:** one store (`SellingRestriction`), one engine (`evaluate` / `restrictedProductIdsFor` share rule loading and
  `resolveGoverningState`), one visibility builder (`buyerVisibleProductWhere`). It adds no table, flag or mirror. The open sibling
  item in the same files is the dead rules-page link, fixed in C.
- **G2 Variation map:**

  | Case | BUILD NOW | SEAM NOW | LATER |
  |---|---|---|---|
  | Single-state wholesaler | rules for other states are no-ops, at a cost of one query | | |
  | Multi-state distributor | multi-state picker; the button reads `Hide from 3 states` | | |
  | Jobber, delivery | (none) | | |
  | Counter/POS | staff channel untouched unless a legal ban and the switch | | |
  | 10k SKUs | 200 cap per call and a category nudge | `cursor` on the list | if a buyer's blocked set > 5k ids, swap `notIn` for a SQL predicate on labels (**S**) |
  | Super admin | (none) | | |
  | Mobile | via the API | | |
- **G4 Class, not instance:** `restrictionsApply(policy, channel)` is the single switch gate. `buyerVisibilityFor` is the single context source.
  An inventory spec (A-f) fails the build on a new bare call site. `create` is a bulk of one.
- **G5 Data and time:**
  - Effective dates are honoured live through `activeRuleWhere(at)`, with no cache beyond the request, so a scheduled rule appears on time.
  - Existing localStorage carts are cleaned on the next cart view.
  - Open orders keep held lines (`heldProductIds`), so staff decide.
  - Standing-order cron already suspends banned lines (`order-templates.service.ts:633`).
  - A customer who moves is evaluated live. Lift takes effect on the next request.
  - Lifted rows are kept for the audit trail.
- **G8 Change-friendliness:** contracts live in `packages/types`. A future "limit by customer group" is a new scope column plus the
  engine's matcher (**M**: migration). A per-rule end date in the dialog is a UI-only `Schedule…` disclosure (**S**). A batch id for
  grouped rows in the list is an additive nullable column (**M**, deferred: Lift N covers it now).
- **Owner questions (batched, non-blocking):**
  - Q1: may OPERATORs create portal limits (the 10-07 operator ≈ admin ruling)? Default: TENANT_ADMIN, the same as today.
  - Q2: confirm R2's pre-deploy count.

## Census (10-12, read-only, owner-approved)
Active SellingRestriction rules in prod: NONE. R2 risk is zero; the switch-off guard is not needed.
## Owner rulings (10-12)
Hide completely in the portal; no-state customers allowed and flagged; readiness is advisory; operators may create limits (owner 10-07: operators are near-admins).
