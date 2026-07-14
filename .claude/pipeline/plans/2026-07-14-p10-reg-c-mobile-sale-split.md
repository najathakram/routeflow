# P10-REG-C — Mobile sale-builder invoice-split preview (REG-4) + invoice sibling pairing (REG-5) + REG-8 verification

## Status

PLANNED — 2026-07-14

## Goal

Close the two remaining mobile regulated-items gaps that are cheap and low-risk:

1. **REG-4** — show the operator a live, DISPLAY-ONLY preview in the order builder of how
   their cart will split into invoices once submitted (mirrors web's `CreateOrderModal`
   `invoiceSplit` banner), reusing a new pure grouping helper that byte-mirrors the server's
   authoritative `groupOrderLinesForInvoicing`.
2. **REG-5** — a minimal "also billed on this order" sibling-invoice chip on the mobile invoice
   detail screen, using data the API already returns (no new endpoint).

...and verify REG-8 (buyer regulated visibility + Licenses) is already fully shipped on mobile,
planning nothing further for it beyond documenting one genuine-but-deferred gap (a buyer-cart
split preview that needs an API field that doesn't exist yet).

This plan stacks on **P10-REG-A** (`d4da6888`, merged to this branch — Tracked Categories manager

- product picker) and **P10-REG-B** (uncommitted on this branch — Regulated Items hub +
  `lib/api/regulated.ts` + the POD-gate refactor). It does not touch any file either of those
  plans owns, and does not require either to be committed first.

## Scope

**In scope (mobile only, reuse shipped API, no API/Prisma changes):**

1. **WP1** — `apps/mobile/lib/invoice-split.ts`: a pure function `groupLinesForInvoiceSplit`
   that mirrors `apps/api/src/invoices/invoices.service.ts#groupOrderLinesForInvoicing` and web's
   `CreateOrderModal` `invoiceSplit` memo exactly. Exhaustive Jest coverage — **this is the one
   money-adjacent WP in this plan.**
2. **WP2** — Wire WP1 into `apps/mobile/components/NewOrderScreen.tsx` (`NewOrderScreen` →
   `ProductPickView`/`CartModal`): a compact "Splits × N" footer badge + a detailed banner inside
   the cart-review sheet, both DISPLAY ONLY.
3. **WP3** — REG-5 sibling-invoice chip on `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`,
   backed by a new tiny pure helper `apps/mobile/lib/invoice-siblings.ts` + a small widen of
   `AdminInvoice`/`useAdminInvoices` in `apps/mobile/lib/api/admin.ts` (both fields/params it adds
   are already returned/accepted by the live API today — see "Key facts").
4. **WP4** — REG-8: no code. Documents what's already shipped (buyer Licenses screen, catalog
   regulated locks, expiring-license badge) and formally **DEFERS** the one real gap (buyer-cart
   two-block split preview) with the exact reason it needs an API/DTO change out of this plan's
   "mobile only" scope.
5. **WP5** — code-map update.

**Out of scope — already shipped, do NOT rebuild:**

- The operator **license guard** (`components/LicenseGuardModal.tsx` + `lib/authorizations-logic.ts`
  - `lib/api/authorizations.ts`), wired into `NewOrderScreen.submitOrder` and
    `orders/[id]/edit-items.tsx` — verified present, untouched by this plan.
- The buyer **Licenses** screen (`app/(customer)/licenses.tsx` + `lib/buyer-licenses-logic.ts`)
  and buyer **catalog regulated locks** (`LockedCategoriesTile` in `catalog.tsx`, `LockedCategory`
  type in `lib/api/buyer.ts`) and the **expiring-license bell badge**
  (`useBuyerExpiringAuthorizations` in `catalog.tsx`) — all verified present and correct; see
  WP4.
- **REG-2/REG-3** (Tracked Categories manager + product picker) — P10-REG-A, already merged
  (`d4da6888`).
- **REG-1/REG-7** (Regulated Items hub + driver POD-gate extraction) — P10-REG-B, currently
  uncommitted on this branch. This plan doesn't depend on it landing first.
- **REG-6** (Products list regulation-scope filter) — needs an unshipped backend query param,
  excluded by P10-REG-A's plan too; still out of scope here, not mentioned again below.
- Any API/Prisma change. Any web change. `SEPARATE_SECTION`/`LINE_TAX` invoice presentation
  (deferred server-side per `groupOrderLinesForInvoicing`'s own comment — this plan's preview
  correctly folds those into the "Standard" group, matching the server).
- `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` (order-edit builder) does **not**
  get the split preview — the task spec calls only for `NewOrderScreen`. (Also: by the time an
  order is being edited it may already be invoiced/split; a preview there would be misleading
  without also reading the order's existing `invoices[]`. Flag as a possible follow-up, not built
  here.)

## Key facts established by reading the code (do not re-derive)

- **Server grouping rule (authoritative — mirror exactly), `apps/api/src/invoices/
invoices.service.ts#groupOrderLinesForInvoicing` (L485-535):** resolve each line's category via
  `li.trackedCategoryId ?? li.product?.trackedCategoryId ?? null`; a category only forms its own
  group when `catMap.get(id)?.invoiceTreatment === "SEPARATE_INVOICE"` — every other line
  (uncategorised, or a regulated category whose treatment is `SEPARATE_SECTION`/`LINE_TAX`) folds
  into one **"standard"** group. Groups are emitted **standard first** (only if non-empty), then
  one group per `SEPARATE_INVOICE` category **sorted by category name**. When no
  `SEPARATE_INVOICE` line exists, the result is a **single group** → the caller
  (`createSplitInvoices`) creates exactly one invoice, byte-identical to pre-split behavior. Money:
  each group's amount is the **sum of its lines' subtotal only** (pre-tax); category tax is
  currently always 0 (guarded elsewhere in `createSplitInvoices` — a non-zero rate throws before
  any invoice is written), so this plan never needs to reason about tax.
- **Web reference implementation mirrors the server rule 1:1**,
  `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx` `invoiceSplit` memo
  (L355-383): builds `categoryById` from `useTrackedCategories({active:true})` (L174-178), computes
  each line's subtotal via `computeLineSubtotal`, groups exactly as above, and exposes
  `{groups: {label,count,subtotal}[], willSplit: separate.size > 0}`. Rendered at L1526-1548 as an
  amber banner ("Splits into N invoices", one row per group: `Invoice {i+1} — {label} ({count}
items) — ${subtotal}`, footnote "Regulated categories are billed on their own invoice. Amounts
  shown are pre-tax subtotals.") placed right after the line-items list, before the Order Totals
  card. **WP1/WP2 mirror this shape and this exact footnote wording.**
- **Mobile already has everything needed to build the split-preview lines except the category
  lookup:** `apps/mobile/components/NewOrderScreen.tsx`'s `Product` type already carries
  `trackedCategoryId?: string | null` (L101, added for the license-guard remove-line flow); the
  existing `total`/`totalItems` memo (L709-734) already iterates `items`/`productById`/`unlisted`
  with `effectiveQty`/`effectiveUnitPrice`/`tierPriceFor`/`computeLineSubtotal` — WP2's new memo is
  a straight sibling of that one, same inputs, same iteration. The category lookup itself
  (`useTrackedCategories({active:true})`, dash-style key `["tracked-categories", {...}]`) already
  exists at `apps/mobile/lib/api/tracked-categories.ts` (P10-REG-A, merged) — not rebuilt here.
- **`apps/mobile/lib/pricing.ts#computeLineSubtotal({unitPrice,qty,boxes,pieces,unitsPerBox})`**
  is RN-free (no import from `react-native`) and already the money-mirror locked by
  `__tests__/pricing.test.ts` — WP1 reuses it verbatim, exactly as web's memo does. WP1's own file
  is likewise RN-free so it runs under mobile's pure-logic Jest (node env), matching the
  `lib/buyer-cart-pricing.ts`/`lib/shelf-logic.ts` precedent.
- **REG-5 feasibility — verified `invoiceGroupId` is ALREADY RETURNED by the live API, just
  untyped on mobile (zero API change needed):** `apps/api/src/invoices/invoices.service.ts`
  `findOne` (L1335-1358) does `prisma.invoice.findUnique({ where, include: {...} })` — no `select`
  restricting scalars — so every scalar column on `Invoice`, including `orderId` and
  `invoiceGroupId` (`schema.prisma` L1691/L1696), comes back on `GET /invoices/:id` today. Same
  for the list endpoint: `findAll` (L1200-1333) does `prisma.invoice.findMany({ where, include:
{...} })`, same story — every row of `GET /invoices` already carries `invoiceGroupId` too. Both
  are simply **absent from the mobile `AdminInvoice` TypeScript interface**
  (`apps/mobile/lib/api/admin.ts` L258-306) — a pure client-side typing gap. Widening that
  interface is the entire "API-facing" part of WP3.
- **REG-5 — why NOT `order.invoices[]`:** `apps/api/src/orders/orders.service.ts` L255 selects the
  order's `invoices` relation as `{ select: { id, invoiceNumber, status, total } }` — deliberately
  **excludes** `invoiceGroupId`. So `useAdminOrder(orderId).data.invoices` cannot be filtered to
  "siblings from the same split" without a server change. WP3 does **not** use this path.
- **REG-5 — chosen approach (uses only an already-shipped endpoint + hook):** `GET /invoices`
  (`useAdminInvoices`, already used by `app/(operator)/(tabs)/invoices/index.tsx`) accepts
  `customerId`/`dateFrom`/`dateTo`/`limit` server-side (`ListInvoicesDto`,
  `apps/api/src/invoices/dto/list-invoices.dto.ts` L13-23) — `dateFrom`/`dateTo` are validated and
  applied (`invoices.service.ts` L1261-1269) but, like `invoiceGroupId`, were never added to the
  mobile hook's TS params (`admin.ts` L308-317 only exposes `status/search/page/limit/customerId/
isOverdue/shipped`). WP3 widens that params type (pure addition, pass-through, no behavior
  change to existing callers) and calls it with `{customerId: invoice.customer.id, dateFrom:
issueDay, dateTo: issueDay, limit: 25}` (same-day bracket around the current invoice's own
  `issueDate` — robust regardless of how many other invoices the customer has since accrued,
  unlike a bare recency-sorted `limit`), then filters the result client-side to
  `invoiceGroupId === current.invoiceGroupId && id !== current.id`. **Net: REG-5 needs zero new
  endpoints and zero schema changes** — exactly the bar the task set for "build it" vs "defer it."
  `MAX_LIST_LIMIT` is 1000 (`apps/api/src/common/pagination.ts`), so `limit: 25` is comfortably
  inside range.
- **REG-8 — verified already fully shipped on mobile, nothing to build for the license/lock
  surfaces:**
  - `apps/mobile/app/(customer)/licenses.tsx` + `lib/buyer-licenses-logic.ts`: per-category status
    pill (incl. `EXPIRED` → red), submit/renew form, and — already present — an **"Expires
    <date>"** line per row (L140-142). This _is_ the "expiring soon" surface the task asked to
    check for; no gap.
  - `apps/mobile/app/(customer)/(tabs)/catalog.tsx`: `LockedCategoriesTile` (L398+) hides
    unlicensed regulated products behind a lock card with per-category status copy
    (`lockedStatusCopy`, L385), fed by `hiddenCategories`/`LockedCategory` from
    `apps/mobile/lib/api/buyer.ts` (server-computed gate, `regulated-visibility.service.ts`); a
    header bell icon (L131-134) shows a badge from `useBuyerExpiringAuthorizations()` (L97) and
    deep-links to the Licenses screen. Nothing missing here either.
  - **REG-8's one genuine gap — DEFERRED, not built:** the underlying spec
    (`docs/design-package/PHASE-5-6-10-PLAN.md` L177) lists "two-block cart split, one Place
    Order" as a REG-8 acceptance line, mirroring REG-4 for the buyer cart
    (`apps/mobile/app/(customer)/orders/cart.tsx`). Verified this needs an API/DTO change: the
    buyer-facing product payload (`apps/api/src/buyer/buyer-catalog.service.ts`
    `BuyerProduct`/`getCatalog` L15-212) is a **hand-built object literal that does not include
    `trackedCategoryId`** (deliberately — the interface's own comment says it "strips all
    seller-internal fields"). Without that field, `apps/mobile/lib/api/buyer.ts`'s `BuyerProduct`
    and `apps/mobile/store/cartStore.ts`'s `CartItem` have no way to know a cart line's regulated
    category, so `groupLinesForInvoiceSplit` (WP1) cannot be fed real data for the buyer cart. This
    is exactly the "needs an unshipped endpoint" bar from the task brief — **DEFER**. One-line
    follow-up for later: add `trackedCategoryId: p.trackedCategoryId ?? null` to the `BuyerProduct`
    mapper in `getCatalog` (and its sibling methods) + the mobile `BuyerProduct`/`CartItem` types +
    the two `add({...})` call sites (`catalog.tsx` L341-348, `favorites.tsx` L86-93) — then WP2's
    exact same `groupLinesForInvoiceSplit` helper drops into `cart.tsx` with no new logic. Not done
    in this plan (would be a real, if small, API change inside a "mobile only" plan).

## New / changed files

| Path                                                  | Change | Purpose                                                                                                                                         |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/lib/invoice-split.ts`                    | NEW    | Pure invoice-split grouping helper (WP1, money-adjacent)                                                                                        |
| `apps/mobile/__tests__/invoice-split.test.ts`         | NEW    | Exhaustive Jest coverage incl. "single group → no split" (WP1)                                                                                  |
| `apps/mobile/components/NewOrderScreen.tsx`           | EDIT   | Wire the split preview into the footer badge + cart-review banner (WP2)                                                                         |
| `apps/mobile/lib/invoice-siblings.ts`                 | NEW    | Pure sibling-invoice filter (WP3)                                                                                                               |
| `apps/mobile/__tests__/invoice-siblings.test.ts`      | NEW    | Jest coverage for the filter (WP3)                                                                                                              |
| `apps/mobile/lib/api/admin.ts`                        | EDIT   | Widen `AdminInvoice` (+`orderId`,+`invoiceGroupId`) and `useAdminInvoices` params (+`dateFrom`,+`dateTo`) — both already server-supported (WP3) |
| `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx` | EDIT   | "Also billed on this order" sibling chip (WP3)                                                                                                  |
| `.claude/code-map/mobile.md`                          | EDIT   | Record the split-preview helper + sibling chip; note REG-8 verified/deferred (WP5)                                                              |
| `.claude/code-map/_meta.json`                         | EDIT   | Bump `mappedSha`/`generatedAt` (WP5)                                                                                                            |

**Execution order:** WP1 first (no dependents). WP2 depends on WP1. WP3 is fully independent of
WP1/WP2 (different files) — can run in parallel with WP1+WP2. WP4 is a documentation-only step,
no code, can happen any time. WP5 last, after WP1-3 land.

---

## WP1 — Pure invoice-split grouping helper (money-adjacent — read carefully)

### WP1.1 — `apps/mobile/lib/invoice-split.ts` (NEW)

```ts
import { computeLineSubtotal } from "./pricing";
import type { InvoiceTreatment } from "./api/tracked-categories";

/**
 * One order/cart line as seen by the invoice-split preview. Mirrors the fields
 * `computeLineSubtotal` needs plus the line's regulated category (or null/undefined
 * for a standard line) — never money the server hasn't already priced.
 */
export interface InvoiceSplitLineInput {
  trackedCategoryId?: string | null;
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

/** The subset of TrackedCategory this helper needs — id/name for grouping + display,
 *  invoiceTreatment to decide standard-fold vs own-invoice. */
export interface InvoiceSplitCategory {
  id: string;
  name: string;
  invoiceTreatment: InvoiceTreatment;
}

export interface InvoiceSplitGroup {
  /** "Standard" for the non-split group, else the regulated category's name. */
  label: string;
  count: number;
  /** Pre-tax subtotal for this group only — NEVER a total, NEVER includes tax. */
  subtotal: number;
}

export interface InvoiceSplitPreview {
  groups: InvoiceSplitGroup[];
  /** True only when at least one SEPARATE_INVOICE-category line is present. A
   *  single group (willSplit=false) means the order creates exactly ONE invoice,
   *  byte-identical to pre-split behavior — mirror this exactly, do not show any
   *  split UI in that case. */
  willSplit: boolean;
}

/**
 * Pure, display-only preview of how the server's `createSplitInvoices` will
 * partition an order's lines into invoices — mirrors
 * apps/api/src/invoices/invoices.service.ts#groupOrderLinesForInvoicing EXACTLY
 * (verified by reading both the server rule and web's `CreateOrderModal`
 * `invoiceSplit` memo, which mirrors the same server rule):
 *
 *   - Resolve each line's category via its own `trackedCategoryId` (this helper
 *     takes that pre-resolved; the caller does the OrderItem-vs-product fallback).
 *   - A category forms its OWN group only when `invoiceTreatment === "SEPARATE_INVOICE"`.
 *   - Every other line — uncategorised, OR a regulated category whose treatment is
 *     SEPARATE_SECTION/LINE_TAX — folds into ONE "Standard" group.
 *   - Groups emit Standard first (only if non-empty), then one group per
 *     SEPARATE_INVOICE category, sorted by category name.
 *   - No SEPARATE_INVOICE line present → a SINGLE group, willSplit=false.
 *
 * MONEY: `subtotal` is the sum of each line's `computeLineSubtotal` (pre-tax) —
 * the exact same money-mirror function used everywhere else on mobile. This
 * function computes NO tax and NO order total; it must never be used for
 * anything beyond this preview, and its output must never be sent to the server.
 * The server is the sole source of truth for the real split and the real money.
 */
export function groupLinesForInvoiceSplit(
  lines: InvoiceSplitLineInput[],
  categoryById: Map<string, InvoiceSplitCategory>,
): InvoiceSplitPreview {
  const standard = { count: 0, subtotal: 0 };
  const separate = new Map<string, { name: string; count: number; subtotal: number }>();

  for (const li of lines) {
    const lineTotal = computeLineSubtotal({
      unitPrice: li.unitPrice,
      qty: li.qty,
      boxes: li.boxes ?? null,
      pieces: li.pieces ?? null,
      unitsPerBox: li.unitsPerBox ?? null,
    });
    const cat = li.trackedCategoryId ? categoryById.get(li.trackedCategoryId) : undefined;
    if (cat && cat.invoiceTreatment === "SEPARATE_INVOICE") {
      const g = separate.get(cat.id) ?? { name: cat.name, count: 0, subtotal: 0 };
      g.count += 1;
      g.subtotal += lineTotal;
      separate.set(cat.id, g);
    } else {
      standard.count += 1;
      standard.subtotal += lineTotal;
    }
  }

  const groups: InvoiceSplitGroup[] = [];
  if (standard.count > 0) groups.push({ label: "Standard", ...standard });
  for (const g of Array.from(separate.values()).sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push({ label: g.name, count: g.count, subtotal: g.subtotal });
  }

  return { groups, willSplit: separate.size > 0 };
}
```

**Acceptance:** file has no `react-native` import (runs under mobile's pure-logic Jest); exported
names are exactly `InvoiceSplitLineInput`/`InvoiceSplitCategory`/`InvoiceSplitGroup`/
`InvoiceSplitPreview`/`groupLinesForInvoiceSplit`.

### WP1.2 — `apps/mobile/__tests__/invoice-split.test.ts` (NEW)

```ts
import { groupLinesForInvoiceSplit, type InvoiceSplitCategory } from "../lib/invoice-split";

const cat = (over: Partial<InvoiceSplitCategory> & { id: string }): InvoiceSplitCategory => ({
  name: over.id,
  invoiceTreatment: "SEPARATE_INVOICE",
  ...over,
});

describe("groupLinesForInvoiceSplit", () => {
  it("no lines → no groups, no split", () => {
    const r = groupLinesForInvoiceSplit([], new Map());
    expect(r).toEqual({ groups: [], willSplit: false });
  });

  it("LOCKS: all-standard lines (no trackedCategoryId) → a SINGLE 'Standard' group, no split", () => {
    const r = groupLinesForInvoiceSplit(
      [
        { unitPrice: 10, qty: 2 },
        { unitPrice: 5, qty: 3 },
      ],
      new Map(),
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 2, subtotal: 35 }]);
  });

  it("regulated line whose category is SEPARATE_SECTION folds into Standard, no split", () => {
    const categoryById = new Map([
      ["alcohol", cat({ id: "alcohol", name: "Alcohol", invoiceTreatment: "SEPARATE_SECTION" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [
        { unitPrice: 10, qty: 1 },
        { trackedCategoryId: "alcohol", unitPrice: 20, qty: 1 },
      ],
      categoryById,
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 2, subtotal: 30 }]);
  });

  it("regulated line whose category is LINE_TAX folds into Standard, no split", () => {
    const categoryById = new Map([
      ["crv", cat({ id: "crv", name: "CRV Deposits", invoiceTreatment: "LINE_TAX" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [{ trackedCategoryId: "crv", unitPrice: 12, qty: 4 }],
      categoryById,
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 48 }]);
  });

  it("a trackedCategoryId not present in categoryById (deactivated/unknown) folds into Standard", () => {
    const r = groupLinesForInvoiceSplit(
      [{ trackedCategoryId: "missing-id", unitPrice: 10, qty: 1 }],
      new Map(),
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 10 }]);
  });

  it("one standard line + one SEPARATE_INVOICE line → two groups, Standard first, willSplit=true", () => {
    const categoryById = new Map([
      ["tobacco", cat({ id: "tobacco", name: "Tobacco", invoiceTreatment: "SEPARATE_INVOICE" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [
        { unitPrice: 10, qty: 1 },
        { trackedCategoryId: "tobacco", unitPrice: 8, qty: 2 },
      ],
      categoryById,
    );
    expect(r.willSplit).toBe(true);
    expect(r.groups).toEqual([
      { label: "Standard", count: 1, subtotal: 10 },
      { label: "Tobacco", count: 1, subtotal: 16 },
    ]);
  });

  it("only SEPARATE_INVOICE lines, no standard lines → no 'Standard' group is pushed", () => {
    const categoryById = new Map([["tobacco", cat({ id: "tobacco", name: "Tobacco" })]]);
    const r = groupLinesForInvoiceSplit(
      [{ trackedCategoryId: "tobacco", unitPrice: 8, qty: 2 }],
      categoryById,
    );
    expect(r.willSplit).toBe(true);
    expect(r.groups).toEqual([{ label: "Tobacco", count: 1, subtotal: 16 }]);
  });

  it("multiple SEPARATE_INVOICE categories are sorted by name, independent of input/insertion order", () => {
    const categoryById = new Map([
      ["tobacco", cat({ id: "tobacco", name: "Tobacco" })],
      ["alcohol", cat({ id: "alcohol", name: "Alcohol" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [
        { trackedCategoryId: "tobacco", unitPrice: 8, qty: 1 },
        { trackedCategoryId: "alcohol", unitPrice: 20, qty: 1 },
      ],
      categoryById,
    );
    expect(r.groups.map((g) => g.label)).toEqual(["Alcohol", "Tobacco"]);
  });

  it("multiple lines in the SAME SEPARATE_INVOICE category accumulate into one group", () => {
    const categoryById = new Map([["tobacco", cat({ id: "tobacco", name: "Tobacco" })]]);
    const r = groupLinesForInvoiceSplit(
      [
        { trackedCategoryId: "tobacco", unitPrice: 8, qty: 1 },
        { trackedCategoryId: "tobacco", unitPrice: 5, qty: 2 },
      ],
      categoryById,
    );
    expect(r.groups).toEqual([{ label: "Tobacco", count: 2, subtotal: 18 }]);
  });

  it("cent-parity: a boxed line's subtotal uses computeLineSubtotal's box-equivalent formula", () => {
    // Guarded-failure case mirrored from shelf-logic.test.ts: qty*unitPrice would
    // wrongly give 24*30=720; the correct boxed math is boxes(2)*unitPrice(30)=60.
    const r = groupLinesForInvoiceSplit(
      [{ unitPrice: 30, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }],
      new Map(),
    );
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 60 }]);
  });

  it("an unlisted-style line (no trackedCategoryId, no boxes/unitsPerBox) is simple qty*unitPrice", () => {
    const r = groupLinesForInvoiceSplit([{ unitPrice: 4.5, qty: 3 }], new Map());
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 13.5 }]);
  });

  it("a zero-qty/negative-subtotal line the caller forgot to filter still sums without throwing", () => {
    const r = groupLinesForInvoiceSplit([{ unitPrice: 10, qty: 0 }], new Map());
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 0 }]);
  });
});
```

**Acceptance:** `npx jest --selectProjects mobile invoice-split` passes, all 12 cases green,
including the two explicitly required locks ("single group → no split" and the
SEPARATE_SECTION/LINE_TAX fold rule).

---

## WP2 — Wire the preview into `NewOrderScreen`

All edits are inside `apps/mobile/components/NewOrderScreen.tsx`. No other file changes.

### WP2.1 — imports (near the top, after the existing `lib/api/margin` import at L40)

```tsx
import { useMarginConfig, floorForCategory } from "../lib/api/margin";
import { useTrackedCategories } from "../lib/api/tracked-categories";
import {
  groupLinesForInvoiceSplit,
  type InvoiceSplitCategory,
  type InvoiceSplitLineInput,
  type InvoiceSplitPreview,
} from "../lib/invoice-split";
```

### WP2.2 — category lookup, inside `ProductPickView` (right after the `marginConfig` hook, L369)

```tsx
const { data: marginConfig } = useMarginConfig();
// REG-4: category lookup for the invoice-split preview. Reuses the shipped
// P10-REG-A hook — no new API surface. Called unconditionally, matching the
// rest of this screen's hooks (tenants with no regulated categories just get []).
const { data: splitTrackedCategories } = useTrackedCategories({ active: true });
const splitCategoryById = useMemo(() => {
  const m = new Map<string, InvoiceSplitCategory>();
  for (const c of splitTrackedCategories ?? [])
    m.set(c.id, { id: c.id, name: c.name, invoiceTreatment: c.invoiceTreatment });
  return m;
}, [splitTrackedCategories]);
```

### WP2.3 — the preview memo, right after the existing `total`/`totalItems` memo (ends L734,

just above `const inc = (id: string) => addOne(id);`)

```tsx
  }, [items, productById, unlisted, cpMap, customerTier]);

  // REG-4: live, DISPLAY-ONLY preview of how this cart will split into invoices.
  // Same iteration/inputs as the total memo above (by design — it can never
  // disagree with what's on screen). NEVER used for money: computeLineSubtotal
  // inside groupLinesForInvoiceSplit produces the same pre-tax per-line amounts
  // the total memo already sums; this just also buckets them by category. The
  // server (createSplitInvoices) is the sole source of truth for the real split.
  const invoiceSplit: InvoiceSplitPreview = useMemo(() => {
    const splitLines: InvoiceSplitLineInput[] = [];
    for (const [id, line] of Object.entries(items)) {
      const p = productById.get(id);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      splitLines.push({
        trackedCategoryId: p.trackedCategoryId ?? null,
        unitPrice: effectiveUnitPrice(line, tierPriceFor(p)),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
      });
    }
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      splitLines.push({ trackedCategoryId: null, unitPrice: u.unitPrice, qty: u.qty });
    }
    return groupLinesForInvoiceSplit(splitLines, splitCategoryById);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, productById, unlisted, splitCategoryById, cpMap, customerTier]);

  const inc = (id: string) => addOne(id);
```

### WP2.4 — compact footer badge (inside the `footerTotalTap` `Pressable`, L1176-1186)

Replace:

```tsx
<Pressable
  style={styles.footerTotalTap}
  onPress={totalItems > 0 ? () => setCartOpen(true) : undefined}
  disabled={totalItems === 0}
  hitSlop={6}
>
  <Text style={styles.footerEyebrow}>
    {totalItems} ITEM{totalItems === 1 ? "" : "S"}
  </Text>
  <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
</Pressable>
```

with:

```tsx
<Pressable
  style={styles.footerTotalTap}
  onPress={totalItems > 0 ? () => setCartOpen(true) : undefined}
  disabled={totalItems === 0}
  hitSlop={6}
>
  <Text style={styles.footerEyebrow}>
    {totalItems} ITEM{totalItems === 1 ? "" : "S"}
  </Text>
  <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
  {invoiceSplit.willSplit ? (
    <View style={styles.splitBadge}>
      <Ionicons name="layers-outline" size={10} color={ios.system.orangeInk} />
      <Text style={styles.splitBadgeText}>Splits × {invoiceSplit.groups.length}</Text>
    </View>
  ) : null}
</Pressable>
```

### WP2.5 — pass `invoiceSplit` into `CartModal` (call site, L1281-1313)

Add one prop to the existing call:

```tsx
      <CartModal
        open={cartOpen}
        items={items}
        productById={productById}
        priceHistory={priceHistory}
        tierPriceFor={tierPriceFor}
        marginFloorFor={(p) => floorForCategory(marginConfig, p.category)}
        unlisted={unlisted}
        total={total}
        totalItems={totalItems}
        invoiceSplit={invoiceSplit}
        saving={createOrder.isPending}
```

(rest of the props unchanged)

### WP2.6 — `CartModal` signature: add the prop (L1336-1396)

In the destructured param list, add `invoiceSplit,` right after `totalItems,` (L1345); in the
type annotation, add `invoiceSplit: InvoiceSplitPreview;` right after `totalItems: number;`
(L1375).

### WP2.7 — the banner, inside `CartModal`'s `ScrollView`, right before the "Add unlisted item"

button (insert between L1468 `)}` and L1469 `<Pressable style={styles.cartAddUnlisted}...`)

```tsx
            )}
            {invoiceSplit.willSplit ? (
              <View style={styles.splitBanner}>
                <Text style={styles.splitBannerHeader}>
                  SPLITS INTO {invoiceSplit.groups.length} INVOICES
                </Text>
                {invoiceSplit.groups.map((g, i) => (
                  <View key={g.label} style={styles.splitGroupRow}>
                    <Text style={styles.splitGroupLabel} numberOfLines={1}>
                      Invoice {i + 1} — {g.label} ({g.count} {g.count === 1 ? "item" : "items"})
                    </Text>
                    <Text style={styles.splitGroupAmount}>${g.subtotal.toFixed(2)}</Text>
                  </View>
                ))}
                <Text style={styles.splitFootnote}>
                  Regulated categories are billed on their own invoice. Amounts shown are pre-tax
                  subtotals.
                </Text>
              </View>
            ) : null}
            <Pressable style={styles.cartAddUnlisted} onPress={onAddUnlisted} hitSlop={4}>
```

(the existing `<Pressable style={styles.cartAddUnlisted}...>` line is kept — only the new banner
block is inserted above it)

### WP2.8 — new styles

Insert after `footerTotal: {...}` (L2144-2150), before `confirmBtn: {` (L2151):

```tsx
  splitBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 3,
    alignSelf: "flex-start",
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  splitBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
```

Insert after `cartRowFooterValue: {...}` (L2411-2416), before `cartFooter: {` (L2417):

```tsx
  splitBanner: {
    marginTop: 4,
    marginBottom: 4,
    backgroundColor: ios.system.orangeWash,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.system.orange,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  splitBannerHeader: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: ios.system.orangeInk,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  splitGroupRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  splitGroupLabel: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  splitGroupAmount: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  splitFootnote: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 2,
  },
```

**Acceptance:** empty cart → no badge, no banner (both gated on `invoiceSplit.willSplit`); a cart
with only standard lines → no badge/banner; a cart with a `SEPARATE_INVOICE` regulated line →
footer shows "Splits × 2", opening the cart shows the amber banner with one row per group and the
correct pre-tax subtotal per group (byte-matches what `total` already sums); adding/removing lines
updates the preview live (`useMemo` deps mirror the `total` memo's deps); nothing in this WP
changes `submitOrder`'s payload or the license-guard flow.

---

## WP3 — REG-5: sibling-invoice chip on the mobile invoice detail screen

### WP3.1 — `apps/mobile/lib/invoice-siblings.ts` (NEW)

```ts
export interface SiblingCandidate {
  id: string;
  invoiceGroupId?: string | null;
}

/**
 * Filter an already-loaded invoice list down to siblings of `current` — other
 * invoices sharing the same `invoiceGroupId` (set only when both were created
 * together by a regulated sale split,
 * apps/api/src/invoices/invoices.service.ts#createSplitInvoices). Returns []
 * when `current` has no group (the common case: most invoices aren't split) or
 * no candidate shares it. Pure so the ordering/exclusion rule is locked by Jest
 * independent of the screen's data-fetching.
 */
export function siblingInvoicesOf<T extends SiblingCandidate>(
  candidates: T[],
  current: SiblingCandidate | undefined,
): T[] {
  if (!current?.invoiceGroupId) return [];
  return candidates.filter(
    (c) => c.invoiceGroupId === current.invoiceGroupId && c.id !== current.id,
  );
}
```

### WP3.2 — `apps/mobile/__tests__/invoice-siblings.test.ts` (NEW)

```ts
import { siblingInvoicesOf } from "../lib/invoice-siblings";

describe("siblingInvoicesOf", () => {
  it("current has no invoiceGroupId → []", () => {
    expect(siblingInvoicesOf([{ id: "b", invoiceGroupId: "g1" }], { id: "a" })).toEqual([]);
  });

  it("current undefined → []", () => {
    expect(siblingInvoicesOf([{ id: "b", invoiceGroupId: "g1" }], undefined)).toEqual([]);
  });

  it("excludes the current invoice itself even if present in candidates", () => {
    const current = { id: "a", invoiceGroupId: "g1" };
    const candidates = [current, { id: "b", invoiceGroupId: "g1" }];
    expect(siblingInvoicesOf(candidates, current)).toEqual([{ id: "b", invoiceGroupId: "g1" }]);
  });

  it("excludes candidates with a different (or null) invoiceGroupId", () => {
    const current = { id: "a", invoiceGroupId: "g1" };
    const candidates = [
      { id: "b", invoiceGroupId: "g2" },
      { id: "c", invoiceGroupId: null },
      { id: "d", invoiceGroupId: "g1" },
    ];
    expect(siblingInvoicesOf(candidates, current)).toEqual([{ id: "d", invoiceGroupId: "g1" }]);
  });

  it("preserves candidate order and extra fields (generic passthrough)", () => {
    const current = { id: "a", invoiceGroupId: "g1" };
    const candidates = [
      { id: "d", invoiceGroupId: "g1", invoiceNumber: "INV-2" },
      { id: "e", invoiceGroupId: "g1", invoiceNumber: "INV-3" },
    ];
    expect(siblingInvoicesOf(candidates, current)).toEqual(candidates);
  });
});
```

**Acceptance:** `npx jest --selectProjects mobile invoice-siblings` passes, all 5 cases green.

### WP3.3 — `apps/mobile/lib/api/admin.ts` (EDIT)

Widen `AdminInvoice` (L258-306) — add two fields right after `isOverdue?: boolean;` (L270):

```tsx
  isOverdue?: boolean;
  /** Order this invoice was generated from. Raw scalar the API already returns
   *  (findOne/findAll use Prisma `include`, not a restrictive `select`) — was
   *  simply untyped on mobile until P10-REG-C. */
  orderId?: string | null;
  /** Set when this invoice was created as part of a regulated sale split;
   *  sibling invoices from the same split share this id. Same "already
   *  returned, just untyped" situation as orderId (P10-REG-C). */
  invoiceGroupId?: string | null;
```

Widen `useAdminInvoices`' params (L308-317) — add two optional fields right after `shipped?:
boolean;`:

```tsx
export function useAdminInvoices(params?: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  customerId?: string;
  isOverdue?: boolean;
  /** When true, return ONLY invoices that have a tracking number (shipments list). */
  shipped?: boolean;
  /** Issue-date range filter (YYYY-MM-DD) — already validated/applied server-side
   *  (ListInvoicesDto), just not previously exposed on this hook. Added for the
   *  P10-REG-C sibling-invoice lookup (scopes a customer's list to one exact
   *  issue date instead of relying on default-sort + a bare limit). */
  dateFrom?: string;
  dateTo?: string;
}) {
```

No change to the function body — `params` is already passed straight through to
`apiClient.get("/invoices", { params })`.

**Acceptance:** `AdminInvoice`/`useAdminInvoices` compile standalone; every existing caller of
`useAdminInvoices`/`AdminInvoice` still type-checks unchanged (both edits are additive/optional).

### WP3.4 — `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx` (EDIT)

Widen the import (L17):

```tsx
import { useAdminInvoice, useAdminInvoices } from "../../../../lib/api/admin";
```

Add one more import, grouped with the other `lib/` imports:

```tsx
import { siblingInvoicesOf } from "../../../../lib/invoice-siblings";
```

Add the sibling lookup right after the existing `useAdminInvoice` call (L70), before `const
sendMut = useSendInvoice();` (L71) — **must stay above the `isLoading || !invoice` early return**
(Rules of Hooks; `useAdminInvoice`/`sendMut`/etc. already establish this ordering):

```tsx
const { data: invoice, isLoading, refetch } = useAdminInvoice(isCreateAlias ? "" : (id ?? ""));
// REG-5: sibling invoices from the same regulated sale-split. No dedicated
// "list siblings" endpoint exists — GET /invoices already returns
// invoiceGroupId as a raw scalar on every row (verified: findAll's `include`
// doesn't restrict scalars), so a narrow customerId + same-issue-date lookup
// via the EXISTING useAdminInvoices hook is enough; zero new endpoints. Called
// unconditionally (mirrors the "call the hook unconditionally, gate only the
// display" convention established by P10-REG-B) — customerId/dateFrom/dateTo
// are undefined for one render until `invoice` loads, which just widens that
// one query harmlessly; the queryKey changes once real params land.
const issueDay = invoice?.issueDate ? invoice.issueDate.slice(0, 10) : undefined;
const { data: siblingCandidates } = useAdminInvoices({
  customerId: invoice?.customer?.id,
  dateFrom: issueDay,
  dateTo: issueDay,
  limit: 25,
});
const siblingInvoices = siblingInvoicesOf(siblingCandidates?.data ?? [], invoice);
const sendMut = useSendInvoice();
```

Render the chip inside the header card block, right after it closes (insert between the header
`</View>` at L257 and the `{/* Action grid */}` comment at L259):

```tsx
          </View>

          {siblingInvoices.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Also billed on this order</Text>
              <Text style={styles.siblingHint}>
                This sale was split into {siblingInvoices.length + 1} invoices by regulated
                category.
              </Text>
              <View style={{ gap: 8, marginTop: 6 }}>
                {siblingInvoices.map((sib) => {
                  const sp = statusPill(sib.status);
                  return (
                    <Pressable
                      key={sib.id}
                      style={styles.siblingRow}
                      onPress={() => router.push(`/(operator)/invoices/${sib.id}`)}
                    >
                      <Text style={styles.siblingNumber} numberOfLines={1}>
                        {sib.invoiceNumber}
                      </Text>
                      <Pill variant={sp.variant} small>
                        {sp.label}
                      </Pill>
                      <Text style={styles.siblingTotal}>{fmtCurrency(sib.total)}</Text>
                      <Ionicons name="chevron-forward" size={14} color={ios.label3} />
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* Action grid */}
```

Add styles, right after `cardTitle: {...}` (L517):

```tsx
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  siblingHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  siblingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  siblingNumber: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  siblingTotal: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
```

**Acceptance:** an invoice with no `invoiceGroupId` (the vast majority) renders nothing new — `git
diff` on a real device/screenshot would show zero visual change; an invoice that IS part of a
split shows its sibling(s) with correct invoiceNumber/status/total, tapping one navigates to
`/(operator)/invoices/<siblingId>` (matches the existing app-wide invoice-nav convention, verified
at 9 call sites incl. `credit-notes/[id].tsx`, `estimates/[id].tsx`, `invoices/index.tsx`); no
change to any existing action (send/void/record-payment/write-off/PDF) on this screen.

---

## WP4 — REG-8: verification (no code)

Documented fully in "Key facts" above. Summary for the reviewer:

- **Buyer Licenses screen, catalog regulated locks, and the expiring-license bell badge are all
  already shipped and correct on mobile.** No code changes planned for REG-8's core acceptance
  criteria ("unverified never sees addable regulated" → `LockedCategoriesTile`; "expiring soon
  surface" → per-row "Expires <date>" on `licenses.tsx` + the catalog bell badge).
- **One real gap — the spec's "two-block cart split, one Place Order" — is DEFERRED**, not built,
  because it needs `trackedCategoryId` added to the buyer-facing `BuyerProduct` API payload
  (`apps/api/src/buyer/buyer-catalog.service.ts`), which today deliberately strips it. That's an
  API/DTO change outside a "mobile only, no API changes" plan. If the team wants this unblocked,
  the follow-up is a one-field addition server-side + a two-line widen of
  `apps/mobile/lib/api/buyer.ts`'s `BuyerProduct` and `apps/mobile/store/cartStore.ts`'s
  `CartItem` + threading it through the two `add({...})` call sites in `catalog.tsx`/
  `favorites.tsx` — after which WP2's exact `groupLinesForInvoiceSplit` (WP1) drops straight into
  `cart.tsx` with no new grouping logic.

No files change for this WP.

---

## WP5 — Code map

Update `.claude/code-map/mobile.md`:

1. Add a new "Where to find" row (alphabetically near "Regulated categories manager" / "Regulated
   Items hub"):

   > | Sale-split preview + invoice sibling pairing (P10-REG-C) | `lib/invoice-split.ts`
   > `groupLinesForInvoiceSplit` (pure, mirrors API `groupOrderLinesForInvoicing` + web's
   > `CreateOrderModal` `invoiceSplit` memo exactly — Standard-fold rule, name-sorted
   > SEPARATE_INVOICE groups, single-group-means-no-split) wired into `NewOrderScreen`'s footer
   > badge ("Splits × N") + `CartModal` banner — DISPLAY ONLY, never sent to the server. REG-5:
   > `lib/invoice-siblings.ts` `siblingInvoicesOf` + `lib/api/admin.ts` `AdminInvoice` widened
   > with `orderId`/`invoiceGroupId` (both were already returned by the live API, just untyped)
   > and `useAdminInvoices` widened with `dateFrom`/`dateTo` (already server-supported) — powers
   > an "Also billed on this order" sibling chip on `invoices/[id].tsx`, no new endpoint. REG-8
   > verified fully shipped (buyer `licenses.tsx`, catalog `LockedCategoriesTile`, expiring-license
   > bell badge) — the spec's buyer-cart two-block split is DEFERRED, needs `trackedCategoryId`
   > added to the buyer-facing `BuyerProduct` API payload (not currently returned).

2. Under `## Tests (__tests__/)` add: `invoice-split.test.ts` (`groupLinesForInvoiceSplit` — Standard
   fold + SEPARATE_INVOICE grouping + sort + cent-parity, 12 cases) and `invoice-siblings.test.ts`
   (`siblingInvoicesOf` — 5 cases).

Update `.claude/code-map/_meta.json`: bump `mappedSha` to the post-implementation `git rev-parse
--short HEAD` and `generatedAt` to the implementation date.

---

## Verify / gate

```
npx turbo run check-types lint test --filter=./apps/mobile
```

Mobile can't be device-tested by the pipeline — the gate is: typecheck clean, lint clean, Jest
green (`invoice-split.test.ts` 12/12, `invoice-siblings.test.ts` 5/5), plus a manual code read
confirming:

- `NewOrderScreen`'s `submitOrder` payload is byte-unchanged by WP2 (grep the diff — only new
  `useMemo`/JSX/styles were added, no edit inside `submitOrder`/`createOrder.mutate`).
- The WP3 `AdminInvoice`/`useAdminInvoices` widenings are purely additive (every new field/param
  is optional) — no existing caller needed a change.
- No new API call was added anywhere in this plan beyond calling the EXISTING
  `useTrackedCategories`/`useAdminInvoices` hooks with new (but already server-supported)
  parameters.

## Money note

**WP1 (`groupLinesForInvoiceSplit`) is the only money-adjacent code in this plan** — it reuses
`computeLineSubtotal` verbatim (the same money-mirror function every other mobile money surface
uses) and produces **pre-tax, per-group subtotals for DISPLAY ONLY**. It:

- never computes or displays category tax (mirrors the server, which snapshots it at 0 today and
  hard-blocks a non-zero rate before any invoice is written);
- never computes or displays an order/invoice TOTAL — only per-group subtotals, exactly like web's
  banner, with the same "Amounts shown are pre-tax subtotals" footnote;
- never feeds into `submitOrder`'s request payload — the server (`createSplitInvoices` →
  `groupOrderLinesForInvoicing`) is the sole source of truth for the real split and the real
  money, at invoice-creation time, independent of anything computed here;
- is exercised by the exact same `items`/`productById`/`unlisted` inputs (and the exact same
  `effectiveQty`/`effectiveUnitPrice`/`tierPriceFor` resolution) as the pre-existing `total`
  memo, so it can never show a different per-line price than what the operator already sees on
  screen.

WP3 (invoice sibling pairing) touches no money math at all — `fmtCurrency`/`sib.total` render a
value the server already computed (`AdminInvoice.total`), verbatim, exactly as the rest of this
screen already does for the primary invoice.
