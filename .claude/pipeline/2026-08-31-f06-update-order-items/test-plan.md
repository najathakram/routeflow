# Test plan: F06 — updateOrderItems authorization + line build

> **Stage S4.** Authored by Fable 5 on 2026-08-31. Status: `APPROVED`
> Requirement IDs `R#` from [spec.md](./spec.md). Written before any implementation exists.
> Repo conventions: Jest in `apps/api` (`*.spec.ts` beside source, `Test.createTestingModule`,
> mock at the module boundary, deep Prisma mocks — copy the harness style from
> `apps/api/src/orders/orders.service.spec.ts`'s `updateOrderItems` describes and
> `apps/api/src/orders/orders.scan-hardening.spec.ts`). Playwright in `apps/web/e2e/*.spec.ts`
> (numbered specs, per-spec `projects[]` entry in `apps/web/playwright.config.ts`).
> **Campaign proof tokens:** every regression test title MUST contain its exact `REG-B##`
> token (`REG-B47`, `REG-B51`, `REG-B60`, `REG-B62`, `REG-B63`, `REG-B78`) — the campaign
> gate greps passing jest/playwright JSON titles for exact-match tokens. Describe-titles
> follow the house convention `(T-B## / REG-B##)`.

---

## 1. Strategy for this change

Bug-fix batch on the hottest money/auth method in the API plus one web race. Proof =
(a) pure unit tests on the extracted merge fold (the money math is hand-derivable),
(b) service-level integration tests on `updateOrderItems` with the established mocked-Prisma
harness (authorization gates, line persistence, snapshot preservation), (c) controller-level
tests that the buyer merge now emits the folded payload and header fields, (d) one Playwright
e2e (spec 24) for the web race — campaign decision D1: web logic has no unit runner and is
proven post-deploy.

| Level | Used? | Why |
|---|---|---|
| unit | yes | fold math + snapshot normalization is pure, hand-derivable |
| property | no | the fold cases are few and discrete; hand-derived table beats a generator here (money touched, but each case's oracle is a specific worked example) |
| contract | no | no wire-shape change |
| integration | yes | the guards live mid-method behind a Serializable tx; the existing harness mocks the tx boundary |
| e2e | yes | one journey: B62's race, made deterministic by route interception |
| manual | no | — |

**Deliberately NOT tested:** the P5-04 invariant itself (staff promos `[]` — pre-existing,
pinned elsewhere); staff POST /orders merge behavior (already pinned by
`orders.scan-hardening.spec.ts` REG-B199 — the extraction must keep that suite green with
ZERO edits to it); invoice recomputation internals (F07-owned; we assert only what
updateOrderItems persists).

**Risk driving depth:** money wrong (B47/B60), fraud-shaped authorization holes (B51/B63) —
blast radius = billed invoices on live tenants. Depth: mutation probes on every guard.

**Characterization first?** No — desired behavior differs from today's (that's the point);
the no-regress set is the existing pinned suites (below).

**Pinned tests that MUST stay green (no edits to them):**
- `orders.service.spec.ts` :491 F10-002 (CUSTOMER edits CONFIRMED → PENDING), :4212 (SELLING-UNIT
  boxed line no re-prorate), :4278 (new boxed line splits), :4420/:4644 (merge/consolidate proration)
- `orders.scan-hardening.spec.ts` all (REG-B197/B198/B199), esp. :586-923 staff fold pins
- `orders-promo-bogo.spec.ts` all (qty-edit rescale, invoice snapshot carry)

---

## 2. Test table

| ID | proves | level | Given / When / Then | Oracle | File | Fails today because |
|---|---|---|---|---|---|---|
| T1 | R1 | unit | **G** existing box-split line {boxes:2, pieces:0, qty:24, upb:12} · **W** fold incoming buyer add {productId same, qty:12, boxes:1, pieces:0} · **T** one line {boxes:3, pieces:0, qty:36}, no unitPrice (derived price re-prices) | hand: 2 boxes + 1 box = 3 boxes; 3x12=36 pieces | `apps/api/src/orders/merge-items.spec.ts` (NEW) | module does not exist → guarded-import assertion fails |
| T2 | R1 | unit | **G** existing box-UNAWARE line {boxes:null, pieces:null, qty:2} of a boxed product, live upb=12 supplied via the normalization map · **W** normalize snapshots then fold incoming {qty:12, boxes:1} · **T** one line {boxes:3, pieces:0, qty:36} | register worked example: box-unaware qty on a boxed product counts SELLING UNITS ⇒ 2 boxes + 1 box = 3 boxes | `apps/api/src/orders/merge-items.spec.ts` | normalization helper does not exist; raw fold gives {boxes:1, pieces:2, qty:14} |
| T3 | R1 | integration | **G** CUSTOMER edit, order has box-unaware line qty=2 (boxed product, upb 12, box price 10.00) · **W** updateOrderItems with folded item {qty:36, boxes:3, pieces:0} · **T** persisted line boxes=3/pieces=0/qty=36, subtotal **30.00** | hand: 3 x 10.00; never 14x10=140 (today) nor 360 (36 raw x 10) | `apps/api/src/orders/orders.update-items-guards.spec.ts` (NEW) | shouldSplit ignores client boxes/pieces for existing productIds → qty=36 stored raw, subtotal 360.00 |
| T4 | R2 | integration | **G** order holds an operator-added unlisted line (id U1, name "Setup fee", qty 1, unitPrice 25.00) · **W** CUSTOMER full-replace edit sending only catalog items · **T** U1 survives: same id, name, qty, price, notes; totals include it | preservation-by-design: the row is never deleted | same file | deleteMany wipes ALL lines; nothing recreates unlisted from a catalog-only payload |
| T5 | R3 | integration (neg) | **G** any CUSTOMER edit · **W** payload includes {name:"X", qty:1, unitPrice:99999} (no productId) · **T** no such line exists after; no orderItem.create with productId:null issued | create()'s rule (:1714-1716) mirrored | same file | today creates it as MANUAL at 99999 |
| T6 | R3, R6 | integration | **G** DRIVER non-diff edit with an unlisted item in payload · **W** updateOrderItems · **T** unlisted line created exactly as today (driver authoring unchanged) | pre-existing driver path :2956-2978 | same file | passes today — guards must NOT break it (regression pin, no REG token) |
| T7 | R4 | integration (neg) | **G** CUSTOMER-owned order in each of OUT_FOR_DELIVERY / PARTIALLY_DELIVERED / DELIVERED · **W** updateOrderItems as CUSTOMER · **T** ForbiddenException; AND zero side effects: no `revertLinkedInvoicesForOrderEdit`, no deleteMany/create, no `appendOrderRevision`, no status event | changeStatus's CUSTOMER gate :2347-2358 as the parallel; side-effect spies stay uncalled | same file | only CANCELLED is blocked today |
| T8 | R5 | integration | **G** CUSTOMER-owned CONFIRMED order · **W** valid items edit · **T** succeeds; order reverts to PENDING (existing semantics) | pinned F10-002 behavior | same file | passes today — pin against over-blocking |
| T9 | R6 | integration | **G** DRIVER edit on an OUT_FOR_DELIVERY order · **W** updateOrderItems (non-diff) · **T** succeeds as today | R1-relaxation comment scopes post-dispatch to operator+driver | same file | passes today — pin against over-blocking |
| T10 | R7 | integration | **G** staff replaceAll; order line: PROMO, promoFreeUnits=2, qty=10, stored unitPrice 5.00; active BUY_N_GET_M promo in `bogoPromos` context · **W** replaceAll payload for that product qty=20, **no unitPrice** · **T** created line keeps stored price 5.00 + priceType PROMO, promoFreeUnits rescaled per `rescaleBogoFreeUnits` for qty 20, subtotal = computeLineSubtotal with those freeUnits | the qty-edit branch (:3529-3675) is the semantic oracle: replace-all must land where a qty edit of the same line lands | same file | replace-all re-creates with promoFreeUnits unset, full-price subtotal |
| T11 | R7 | integration | same as T10 but payload **echoes** unitPrice 5.00 (= stored) · **T** treated as unchanged: same outcome as T10, no MANUAL flip | echoed price is not an override decision | same file | echo ≠ catalog price → isManualOverride flips MANUAL, snapshot dead |
| T12 | R8 | integration (neg) | same order, payload unitPrice 4.20 (≠ stored) · **T** MANUAL flip, promoFreeUnits null/0, subtotal 20 x 4.20 = 84.00 | the qty-edit MANUAL rule (:3609-3612) made uniform | same file | passes-ish today (MANUAL flip happens) — pins that preservation does NOT over-reach |
| T13 | R9 | integration (structural) | **G** staff diff-add of a catalog product · **W** updateOrderItems · **T** the orderItem.create data object CONTAINS the `promoFreeUnits` key (null when no snapshot) and the computeLineSubtotal input carried `freeUnits` | structural: today the key is absent from create data entirely | same file | create data has no `promoFreeUnits` key on the add paths |
| T14 | R10 | integration | **G** buyer with an active PENDING order, `BuyerController.createOrder` merge branch (mocked OrdersService) · **W** dto {items, notes:"ring bell", urgent:true, requestedDeliveryDate:"2026-09-05"} · **T** updateOrderItems called with folded catalog-only items + replaceAll:true (NO orderNotes — the helper owns all three header fields); `applyBuyerMergeHeader` called with {notes:"ring bell", urgent:true, requestedDeliveryDate:"2026-09-05"} on activeOrder.id BEFORE mergeAllPendingForCustomer; urgent:false payload leaves urgent untouched (helper semantics: notes append, urgent only-sets-true, date set-if-provided — proven service-side in the guards spec or here via the real service method with mocked prisma) | fresh-create branch (:565-577) forwards the same three — merge must too, with OR/append/set semantics | `apps/api/src/buyer/buyer.controller.merge.spec.ts` (NEW) | merge branch forwards `{items}` only |
| T15 | R11 | e2e | **G** operator logged in, DRAFT order for a tier-2 customer on `e2e-routeflow`; `page.route` HOLDS `/api/v1/customers/:id` · **W** open the order page (auto-enters edit) · **T** add-product control disabled + "Loading customer pricing…" visible; release route → control enables; add tier-priced product → shown unit price = tier price, not list | route interception makes the race deterministic; tier price seeded/known via API fixture | `apps/web/e2e/24-order-edit-pricing.spec.ts` (NEW) + projects entry in `apps/web/playwright.config.ts` | no gate exists; control is enabled instantly and prices at list |
| T16 | R13 | integration | **G** buyer with NO active order · **W** createOrder · **T** ordersService.create called with same dto mapping as today (items+notes+urgent+requestedDeliveryDate+status) | fresh-create branch is out of scope — pin it | `apps/api/src/buyer/buyer.controller.merge.spec.ts` | passes today — regression pin |

### 2.1 Expanded cases

**T3 fixture note** — the mocked tx must implement: `orderItem.deleteMany`, `orderItem.create`
(capture data), product lookup returning `{unitsPerBox: 12, pricePerUnit: 10.00}` (box price),
customer tier context. Copy the harness of `orders.service.spec.ts` "customer ADD of a NEW
boxed line" (:4278) and adapt. Money asserted with `toBe(30)` after `roundMoney` — never
recomputed via the implementation's own helper chain in the test.

**T7 side-effect proof** — spy on `revertLinkedInvoicesForOrderEdit` (private → spy via
`(service as any)`), the tx `orderItem.deleteMany/create`, `appendOrderRevision`; all
`.not.toHaveBeenCalled()`. The throw must be `ForbiddenException` (403), not BadRequest —
and thrown before `prisma.tenantTransaction` is entered.

**T10/T11/T12 shared fixture** — `bogoPromos` context loads only when a line has
`promoFreeUnits>0` (:2855-2857) — the fixture order line must carry `promoFreeUnits: 2` so
the context load fires; mock `promotionsService.activeForCatalog` to return the matching
BUY_N_GET_M rule. Expected rescaled value derived by hand from `rescaleBogoFreeUnits`'s
documented contract (buy N get M on the new qty), independently of the code path under test.

**T14 title tokens** — REG-B78 on the header-forwarding case; REG-B47 on a companion case in
the same file asserting the folded payload shape ({qty:36, boxes:3} for the T2 scenario)
reaches `updateOrderItems`, with the unlisted entries filtered out of the controller payload.

---

## 3. Coverage matrix

| R# | Requirement (short) | Priority | Covered by | Deepest level |
|---|---|---|---|---|
| R1 | denomination-aware buyer merge | must | T1, T2, T3, T14(companion) | integration |
| R2 | unlisted lines survive buyer edits | must | T4 | integration |
| R3 | CUSTOMER cannot author/reprice unlisted | must | T5, T6 | integration |
| R4 | CUSTOMER post-dispatch 403, zero side effects | must | T7 | integration |
| R5 | DRAFT/PENDING/CONFIRMED unchanged | must | T8 + existing F10-002 | integration |
| R6 | DRIVER byte-identical | must | T6, T9 | integration |
| R7 | replaceAll preserves+rescales BOGO snapshot | must | T10, T11 | integration |
| R8 | changed price → MANUAL, snapshot dead | must | T12 | integration |
| R9 | freeUnits plumbing on add paths | should | T13 | integration (structural) |
| R10 | merge forwards notes/urgent/date | must | T14 | integration |
| R11 | web pricing-ready gate | must | T15 | e2e |
| R12 | staff merge byte-identical post-extraction | must | existing `orders.scan-hardening.spec.ts` (zero edits) | integration |
| R13 | fresh-create unchanged | must | T16 | integration |

**Reverse check:** every T# above names its R#; none would pass with the feature removed
except the deliberate regression pins T6/T8/T9/T12/T16, which pin against over-blocking —
they pass today by design and are excluded from the red gate's must-fail set.

**Deliberately untested:** R12 by new tests (existing suite is the proof; adding a second
pin would fork it).

---

## 4. Negative tests — what must NOT happen

| ID | Must NOT happen | Assertion |
|---|---|---|
| T5 | buyer-authored unlisted line created | no create with productId:null from CUSTOMER payload |
| T7 | post-dispatch buyer edit mutates anything | ForbiddenException + all side-effect spies uncalled |
| T12 | snapshot preservation over-reaches onto genuinely repriced lines | MANUAL flip + no promoFreeUnits |
| T4 | buyer edit drops operator's unlisted line | row id stable |

## 5. Property-based invariants

Touched: money, quantities, permissions. Handled as hand-derived worked examples (T1-T3,
T10-T12) rather than generators: each case's oracle is a specific register example, and the
underlying kernels (`normalizeBoxesPieces`, `computeLineSubtotal`, `roundMoney`) already have
their own regression suites in `apps/api/src/common/pricing.spec.ts`. No new generator.

## 6. Red gate

```bash
cd apps/api && npx jest merge-items orders.update-items-guards buyer.controller.merge --silent
```

| T# | Expected failure | Kind |
|---|---|---|
| T1, T2 | guarded import: "merge-items exports foldMergeItems/normalizeBoxUnawareSnapshots" → expected true, received false | assertion |
| T3 | expected subtotal 30, received 360 | assertion |
| T4 | expected unlisted row present, received absent | assertion |
| T5 | expected no unlisted create — today one IS created → assertion on captured creates fails | assertion |
| T7 | expected ForbiddenException — today resolves → `rejects.toThrow` fails | assertion |
| T10/T11 | expected promoFreeUnits 4, received undefined/null | assertion |
| T13 | expected create data to contain key promoFreeUnits, received absent | assertion |
| T14 | expected applyBuyerMergeHeader to be called with the three header fields — method/spy absent or uncalled today; expected folded {boxes:3}, received {qty:14} | assertion |

Red-gate rules: T6/T8/T9/T12/T16 are regression pins expected GREEN pre-implementation —
mark them clearly and EXCLUDE them from the red-gate must-fail expectation by placing them in
`describe` blocks whose titles say `(pin — green pre-fix)`; the red-gate auditor must see
every non-pin test fail on an assertion. T15 (e2e) is NOT in the red gate — it runs
post-deploy only (campaign D1).

New-module imports (merge-items.ts does not exist yet): use the playbook's guarded dynamic
import so absence fails as an assertion, not an import error.

## 7. Test data and fixtures

| Need | How | Isolation |
|---|---|---|
| Service harness (jest) | copy `orders.service.spec.ts` `updateOrderItems` describe harness: `Test.createTestingModule` with mocked PrismaService (`forTenant`, `tenantTransaction` executing the callback with a mock tx), mocked PromotionsService etc. | pure mocks, no DB |
| Controller harness (jest) | copy `buyer.controller.spec.ts` module setup; mock OrdersService (`findActiveOrder`, `updateOrderItems`, `mergeAllPendingForCustomer`, `create`, header helper), mock PrismaService product findMany for the upb map | pure mocks |
| e2e fixtures | API-create a DRAFT order + tier-2 customer on `e2e-routeflow` via `e2e/helpers/api.ts` (`apiBase`, `operatorAccessToken`); NEVER click first rows (E2E first-row trap, #556 lesson); tenant guard via `e2e/helpers/constants.ts` TENANT_SLUG | seeded per-run records with unique suffix |
| Auth (e2e) | `dependencies: ["setup"]` + operator storageState (`e2e/setup/.auth/operator.json`), `setTenantCookie` in beforeEach | shared setup project |

## 8. UI flows to drive (Playwright — these lines ARE spec 24's tests)

| # | Flow | Assertion | Viewport |
|---|---|---|---|
| 1 | route-hold `/customers/:id`, open DRAFT order (auto-edit) | add control disabled + "Loading customer pricing…" visible; substitute trigger disabled | desktop |
| 2 | release route | add control enabled, hint gone | desktop |
| 3 | add tier-priced product | shown unit price equals the seeded tier price, not list | desktop |

- URL: deployed web (PLAYWRIGHT_BASE_URL, default the Railway prod URL — same as specs 21/22).
- Wire the `projects[]` entry (name `order-edit-pricing`, testMatch `/24-order-edit-pricing\.spec\.ts/`,
  `dependencies: ["setup"]`, operator storageState) with the house banner comment — WITHOUT
  THE ENTRY THE SPEC NEVER RUNS (08's precedent).

## 9. Mutation probe targets

| # | File | Behavior to protect | Test that MUST go red |
|---|---|---|---|
| 1 | `apps/api/src/orders/orders.service.ts` | a CUSTOMER items-edit on a post-dispatch order is refused before any side effect | T7 |
| 2 | `apps/api/src/orders/orders.service.ts` | a CUSTOMER payload can never create or touch an unlisted line; stored unlisted rows survive buyer edits | T4/T5 |
| 3 | `apps/api/src/orders/orders.service.ts` | staff replaceAll preserves + rescales an existing BOGO snapshot at unchanged price | T10 |
| 4 | `apps/api/src/orders/merge-items.ts` | box-unaware selling-unit snapshots normalize before folding; boxes fold with boxes | T2 |
| 5 | `apps/api/src/buyer/buyer.controller.ts` | the merge hands updateOrderItems the FOLDED payload (never the naive qty sum) with replaceAll:true | T14 companion (REG-B47) |
| 6 | `apps/api/src/buyer/buyer.controller.ts` | the merge applies notes/urgent/date to the merged order | T14 |

## 10. Flake risks

| Risk | Where | Removed by |
|---|---|---|
| race timing | T15 | route interception holds the response — no timing window, no waits |
| shared fixture rows | T15 | per-run API-created order/customer with unique suffix; never first-row selection |
| tx mock ordering | T3-T13 | each test builds its own harness; no shared mutable state between tests |
| e2e auth expiry | T15 | standard setup project storageState (fresh per run) |

## 11. Regression watch

- **Every push:** all three new API spec files run inside `turbo run test` (standard `verify`).
- **Post-deploy:** spec 24 runs in the deploy-triggered e2e suite; discharges REG-B62.
- **Six-month regression risk:** someone re-inlines a naive merge in a new buyer endpoint —
  the merge-items module header + code-map entry name the rule; REG-B47 tokens make the
  campaign gate scream if the tests vanish.
