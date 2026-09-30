# Plan: RouteFlow batch — 11 client-reported fixes & features

> Authored by Fable 5 on 2026-07-30. Status: SHIPPED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Ship eleven client-reported fixes/features across the RouteFlow monorepo (NestJS API,
Next.js web dashboard, Expo mobile), each with **web + mobile parity** where a surface exists
on both: an order-shipment crash fix, a returns credit-note-vs-refund choice, credit notes
issuable to any customer (web fix + new mobile create + inline create during order building),
a product tier-price cascade, Case/Unit selling UX with per-unit pricing, regulated reporting
over arbitrary date ranges with in-app preview and a TX Comptroller export format, in-app PDF
viewing of customer documents, a "sells regulated items" customer filter, and removal of the
leaking "Account Email" sentinel field.

## Constraints & conventions

**Stack.** npm workspaces + Turbo. API = NestJS 11 + Prisma 7/Postgres, tests Jest (`*.spec.ts`),
runs from compiled `dist`. Web = Next.js 14 App Router, TanStack Query, Radix + Tailwind, tests
Playwright only (**no unit-test runner on web**). Mobile = Expo 55 / expo-router, tests Jest on
**pure logic only** (`__tests__/*.test.ts`) — never render-test screens.

**Money discipline (load-bearing).** All line/tax/total math goes through the `pricing.ts` helpers:
`computeLineSubtotal` (boxed proration), `normalizeBoxesPieces` (integer boxes/pieces + rollover),
`roundMoney` (cents). **Never** re-derive `qty * unitPrice` for a boxed line — it over-charges by
`unitsPerBox`. Round every monetary write. `pricing.ts` exists as **three mirrors** that must stay
byte-identical for shared functions: `apps/api/src/common/pricing.ts`, `apps/web/lib/pricing.ts`,
`apps/mobile/lib/pricing.ts`. `getTierPrice` lives in a **fourth** file on the API side:
`apps/api/src/utils/pricing.ts` (plus copies inside the web/mobile mirrors).

**Boxed-pricing semantics (do not change).** `Product.pricePerUnit` and `priceTier2..5` are
**per SELLING UNIT** — that means **per case/box** when `unitsPerBox > 1`. `computeLineSubtotal`
prorates loose pieces at `casePrice / unitsPerBox`. A tier column of `0` means **"inherit the list
price"**, never "$0.00" (the `|| fallback` guard in `getTierPrice`). `OrderItem.unitsPerBox`
snapshots the box size at sale time; boxed line math must use the snapshot, never the live product.

**Global ValidationPipe is `whitelist: true, forbidNonWhitelisted: true`** (`apps/api/src/main.ts`).
Several endpoints currently take `@Body() dto: any`, which bypasses validation entirely. The moment
a DTO class is introduced, **any extra field a deployed client sends becomes a 400**. Every new DTO
in this plan therefore keeps explicitly-marked deprecated fields so the currently-deployed web
bundle keeps working through the rollout. This is not optional.

**Tenant scoping.** Everything is tenant-scoped. Use `this.prisma.forTenant()` — a bare
`this.prisma.<model>` bypasses scoping and is a security bug.

**Prisma client regeneration.** After editing `schema.prisma` you MUST run
`npx prisma generate --schema apps/api/prisma/schema.prisma` or typecheck fails with phantom
"X does not exist in type" errors. This is the first verification command for exactly that reason.

**Migrations are additive-only.** Never destructive, never `--force-reset`. New `migration.sql`
files are matched by a repo-wide `*.sql` gitignore rule — they must be committed with
`git add -f`. Migrations are applied to production manually, never on deploy.

**Client-data policy.** Never reference a real client tenant, business name, product, or license
number in code, tests, fixtures, or comments. Use `acme`-style placeholders.

**What must NOT change.**

- The boxed-proration math in `computeLineSubtotal` / `normalizeBoxesPieces` / `roundMoney`.
- Order and invoice **submission payloads** — lines still submit `{qty, boxes, pieces}` and a
  per-selling-unit `unitPrice`. The Case/Unit work in WP4/WP6 is entry + display only.
- The `RECEIVED → REFUNDED` atomic claim in `returns.service.processRefund` — it is the only
  guard preventing a return from minting two credit notes.
- Existing regulated filing CSV bytes: `apps/api/src/regulated/filing-csv.spec.ts` must keep
  passing **untouched** after the WP11 refactor. That spec is the byte-identity gate.
- Prettier config: semicolons, double quotes, printWidth 100, trailing commas.

**Commits.** Conventional Commits (commitlint-enforced): `feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`.

---

## Work packages

File lists are DISJOINT across packages. Several packages _import_ symbols created by another
package — the exact source for every such symbol is written into this plan, so implementers must
**import it, never redefine it**. Cross-package imports are called out in each brief.

---

### WP0 — Prisma schema + both migrations

- **files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260801000000_add_return_refund_fields/migration.sql`, `apps/api/prisma/migrations/20260801000100_add_tx_comptroller_config/migration.sql`
- **effort:** low
- **brief:** Add three nullable columns to `Return` (consumed by WP9) and three nullable columns
  to `TrackedCategory` (consumed by WP11). Both migrations are additive and idempotent. Do NOT
  add a Prisma relation between `Return.creditNoteId` and `CreditNote` — it stays a bare scalar
  (legacy rows may reference deleted credits; the join is done manually in WP9).
  After editing, run `npx prisma generate --schema apps/api/prisma/schema.prisma`.
  Remember the migration `.sql` files need `git add -f` (repo-wide `*.sql` gitignore).
- **exact code:**

  In `model Return` (search for `model Return {`, it has `creditNoteId String?`), add after
  `creditNoteId`:

  ```prisma
  // Return resolution snapshot (2026-07-30). refundMethod is "CREDIT_NOTE" (store credit was
  // minted; see creditNoteId) or "EXTERNAL_REFUND" (money returned outside RouteFlow — nothing
  // is minted, this is the audit trail). Kept as String? rather than an enum to avoid a
  // CREATE TYPE migration; validated at the DTO edge.
  refundMethod String?
  refundAmount Decimal? @db.Decimal(10, 2)
  refundedAt   DateTime?
  ```

  In `model TrackedCategory` (after `reportCadence`), add:

  ```prisma
  // TX Comptroller (TX_COMPTROLLER report template) config — all optional, per-program because
  // a TX cigarette permit differs from a cigar/tobacco permit.
  wholesalerLicenseNo String? // THIS tenant's own TX license/permit number (8 digits)
  txItemType          Int?    // 1 = Cigarettes, 2 = Cigars, 3 = Tobacco
  txUom               String? // CP|CS|CC (cigarettes) SB|SC|SD|SF (cigars) WO|WN (tobacco)
  ```

  `apps/api/prisma/migrations/20260801000000_add_return_refund_fields/migration.sql`:

  ```sql
  -- Return resolution snapshot: credit-note vs external refund, amount, timestamp.
  -- Additive + idempotent; no backfill (existing REFUNDED rows keep creditNoteId only).
  ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "refundMethod" TEXT;
  ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "refundAmount" DECIMAL(10,2);
  ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);
  ```

  `apps/api/prisma/migrations/20260801000100_add_tx_comptroller_config/migration.sql`:

  ```sql
  -- TX Comptroller reporting config on TrackedCategory. Additive + idempotent;
  -- non-TX categories are untouched (all NULL).
  ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "wholesalerLicenseNo" TEXT;
  ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "txItemType" INTEGER;
  ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "txUom" TEXT;
  ```

---

### WP1 — Order shipment save no longer crashes the page

- **files:** `apps/web/lib/api/orders.ts`, `apps/web/app/(dashboard)/error.tsx`
- **effort:** low
- **brief:** **Root cause (confirmed, do not re-diagnose):** `useUpdateOrderShipment` writes the
  PATCH response into the order-detail query cache via `qc.setQueryData(["orders", data.id], data)`.
  The server's `PATCH /orders/:id/shipment` returns a **bare** Prisma row (no `lineItems`,
  `customer`, `invoices`, `editWindow`), while `GET /orders/:id` returns a fully hydrated order.
  The bare row poisons the cache, the detail page re-renders, and
  `order.lineItems.filter(...)` throws `TypeError: Cannot read properties of undefined` — Next
  renders its global "Application error: a client-side exception has occurred" page. The write
  itself succeeded, which is why the tracking number appears after a manual reload. The invoice
  twin (`useUpdateInvoiceShipment` in `apps/web/lib/api/invoices.ts`) and the mobile twin already
  do this correctly by invalidating only.

  Fix 1: in `useUpdateOrderShipment.onSuccess`, **delete the `setQueryData` call** and invalidate
  both the list key and the detail key.

  Fix 2: add a Next.js segment error boundary at `apps/web/app/(dashboard)/error.tsx` so any
  future render throw inside the dashboard degrades to a recoverable panel instead of
  white-screening the app. Match the existing Ledger design language (see
  `apps/web/app/not-found.tsx` for the house styling of a standalone message page). It must be a
  Client Component.

- **exact code:**

  `apps/web/lib/api/orders.ts` — replace the `onSuccess` body of `useUpdateOrderShipment`:

  ```ts
    onSuccess: (data) => {
      // NEVER setQueryData here: PATCH /orders/:id/shipment returns a BARE order row
      // (no lineItems/customer/invoices), and writing it into the detail cache made the
      // order page throw on order.lineItems.filter — the "Application error" full-page
      // crash after adding a tracking number. Invalidate and let GET /orders/:id refill.
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", data.id] });
    },
  ```

  `apps/web/app/(dashboard)/error.tsx` (new):

  ```tsx
  "use client";

  import * as React from "react";
  import Link from "next/link";

  export default function DashboardError({
    error,
    reset,
  }: {
    error: Error & { digest?: string };
    reset: () => void;
  }) {
    React.useEffect(() => {
      // eslint-disable-next-line no-console
      console.error("Dashboard render error:", error);
    }, [error]);

    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold text-navy">Something went wrong</h1>
        <p className="max-w-md text-sm text-navy/70">
          This page hit an unexpected error. Your changes were most likely saved — try again, or go
          back to the dashboard.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="rounded border border-surface-border px-4 py-2 text-sm text-navy hover:bg-surface-sunken"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }
  ```

---

### WP2 — Shared pricing helpers (`cascadeTierPrices`, `perUnitPrice`) in all mirrors

- **files:** `apps/api/src/utils/pricing.ts`, `apps/api/src/utils/pricing.spec.ts`, `apps/api/src/common/pricing.ts`, `apps/api/src/common/pricing.spec.ts`, `apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts`, `apps/mobile/__tests__/pricing.test.ts`
- **brief:** Add two pure helpers, consumed by WP3/WP4/WP5/WP6. `cascadeTierPrices` goes next to
  `getTierPrice` (i.e. `apps/api/src/utils/pricing.ts` on the API side, and inside the
  `getTierPrice` region of the web and mobile mirrors). `perUnitPrice` goes next to
  `computeLineSubtotal` (i.e. `apps/api/src/common/pricing.ts` on the API side, and the
  corresponding region of the web and mobile mirrors). The web and mobile copies must be
  **byte-identical** to the API copies — web has no unit-test runner, so the API and mobile specs
  are what lock these.

  Add the specs listed below. Do not modify any existing helper.

- **exact code:**

  Append to `apps/api/src/utils/pricing.ts` (and the `getTierPrice` region of the web + mobile
  mirrors):

  ```ts
  /** The five tier price columns in ladder order. Index 0 (`pricePerUnit`) is Tier 1 / list. */
  export type TierField =
    | "pricePerUnit"
    | "priceTier2"
    | "priceTier3"
    | "priceTier4"
    | "priceTier5";
  export const TIER_FIELDS: readonly TierField[] = [
    "pricePerUnit",
    "priceTier2",
    "priceTier3",
    "priceTier4",
    "priceTier5",
  ];

  /**
   * Tier-edit cascade: COMMITTING a new price on tier N copies it down to every lower tier
   * (N+1..5) unconditionally, so an operator can walk the ladder setting each break once.
   * Returns ONLY the cascaded fields, as 2-dp decimal strings (ready for a form draft or a
   * PATCH payload); the edited field itself stays the caller's own write.
   *
   * Returns {} for tier 5 (nothing below it), negative, or non-finite input.
   *
   * NOT used for Tier 1 / `pricePerUnit` — the list price keeps its existing "smart" behavior
   * (only tiers that still matched the OLD list price follow it), which preserves a
   * deliberately customized ladder when the list price is re-priced.
   *
   * Committing 0 cascades an explicit "0.00", which under getTierPrice's `|| fallback` guard
   * means "these tiers inherit the list price again" — that is intended.
   *
   * Change detection ("the user focused and typed but did not actually change anything")
   * belongs to the caller's commit mechanism, never to this function.
   */
  export function cascadeTierPrices(
    field: TierField,
    value: number,
  ): Partial<Record<TierField, string>> {
    const idx = TIER_FIELDS.indexOf(field);
    if (idx < 1 || !Number.isFinite(value) || value < 0) return {};
    const v = (Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100).toFixed(2);
    const patch: Partial<Record<TierField, string>> = {};
    for (let i = idx + 1; i < TIER_FIELDS.length; i++) patch[TIER_FIELDS[i]] = v;
    return patch;
  }
  ```

  Append to `apps/api/src/common/pricing.ts` (and the `computeLineSubtotal` region of the web +
  mobile mirrors):

  ```ts
  /**
   * DISPLAY-ONLY derived per-unit price for a case-packed product: case price ÷ units-per-case,
   * rounded to cents. Returns null when the product is sold as single units (unitsPerBox
   * null/0/1) or the input is not a finite number.
   *
   * NEVER persist this, never submit it, never feed it back into line math. Lines always carry
   * the CASE price plus boxes/pieces and are priced by computeLineSubtotal, whose proration is
   * computed before rounding — so `perUnitPrice(p, upb) * pieces` can differ from the true line
   * subtotal by a cent. computeLineSubtotal is authoritative; this is a shopper-facing hint.
   */
  export function perUnitPrice(unitPrice: number, unitsPerBox?: number | null): number | null {
    const upb = Number(unitsPerBox ?? 0);
    const price = Number(unitPrice);
    if (!(upb > 1) || !Number.isFinite(price)) return null;
    return roundMoney(price / upb);
  }
  ```

  **Specs to add.** In `apps/api/src/utils/pricing.spec.ts` (and mirror all of these in
  `apps/mobile/__tests__/pricing.test.ts`):
  - `cascadeTierPrices("priceTier2", 9)` → `{ priceTier3: "9.00", priceTier4: "9.00", priceTier5: "9.00" }`
  - `cascadeTierPrices("priceTier4", 8.5)` → `{ priceTier5: "8.50" }`
  - `cascadeTierPrices("priceTier5", 7)` → `{}`
  - `cascadeTierPrices("pricePerUnit", 10)` → `{}` (Tier 1 is deliberately excluded)
  - `cascadeTierPrices("priceTier2", NaN)` / `(-1)` → `{}`
  - `cascadeTierPrices("priceTier2", 9.005)` → `"9.01"` (half-up cents)
  - `cascadeTierPrices("priceTier3", 0)` → `{ priceTier4: "0.00", priceTier5: "0.00" }` with a
    comment naming the 0-means-inherit convention.

  In `apps/api/src/common/pricing.spec.ts` (and mirror in `apps/mobile/__tests__/pricing.test.ts`):
  - `perUnitPrice(10, 6)` → `1.67`; `perUnitPrice(10, 3)` → `3.33`
  - `perUnitPrice(10, null)` / `(10, 0)` / `(10, 1)` → `null`
  - A **divergence guard** documenting that the display value is never used for math:
    ```ts
    it("is display-only: the line subtotal, not perUnitPrice x pieces, is authoritative", () => {
      // 2 loose pieces of a 3-pack at a $10 case price: the line prorates BEFORE rounding.
      expect(
        computeLineSubtotal({ unitPrice: 10, qty: 2, boxes: 0, pieces: 2, unitsPerBox: 3 }),
      ).toBe(6.67);
      // The per-unit hint rounds first, so multiplying it back is a cent off — by design.
      expect(roundMoney(perUnitPrice(10, 3)! * 2)).toBe(6.66);
    });
    ```

---

### WP3 — Web product pricing surfaces: tier cascade + Units per case

- **files:** `apps/web/components/MoneyInput.tsx`, `apps/web/app/(dashboard)/products/[id]/page.tsx`, `apps/web/app/(dashboard)/products/page.tsx`
- **brief:** Three changes.

  **(a) `DecimalInput` gains an optional `onCommit`.** The tier cascade must fire when the
  operator actually _changes_ a price and leaves the field — never on focus, never per keystroke.
  `DecimalInput` today has no commit event: `onChange` fires per keystroke, and `onBlur` only
  reformats. Add an optional `onCommit(value: number)` that snapshots the value on focus and fires
  once on blur (and on Enter, which we make blur the field) **only when the value actually
  changed**. Purely additive — every existing call site is unaffected. Note `onKeyDown` must be
  pulled out of `...rest` so a caller-supplied handler is not clobbered.

  **(b) Product detail tier grid cascades.** In `apps/web/app/(dashboard)/products/[id]/page.tsx`,
  `EditableNumber` (a thin wrapper over `DecimalInput`, ~line 176) forwards `onCommit`. The tier
  grid (~lines 1732–1790) renders Tier 2..5 via a `.map` over `[label, field, productVal]` tuples;
  wire each tier input's `onCommit` to merge `cascadeTierPrices(field, v)` into `editDraft`.
  Because `editDraft` holds strings and `DecimalInput` echoes external value changes while
  unfocused, the lower tier inputs visibly update as the operator tabs down. The cascade lands in
  the draft only, so Cancel still discards it. The save payload needs no change. Keep the existing
  "Set all to Tier 1" button. **The Tier 1 / `pricePerUnit` input must NOT be wired to
  `cascadeTierPrices`** — leave its behavior exactly as it is today.

  **(c) Product detail gains "Units per case"; tiers show a per-unit hint.** This page currently
  has **no** `unitsPerBox` field at all — the only post-creation edit surface is the products-list
  quick-edit column. Add an `InfoRow` labelled "Units per case" in the same details grid as SKU /
  Unit: view mode renders `product.unitsPerBox > 1 ? \`${product.unitsPerBox} units\` : "Sold
  individually"`; edit mode renders a `DecimalInput decimals={0} min={0}`bound to a new`editDraft.unitsPerBox`(seed it in`startEdit`from`product.unitsPerBox`); `saveEdit`sends`unitsPerBox: draft.unitsPerBox?.trim() ? parseInt(draft.unitsPerBox, 10) : null`(null clears —`UpdateProductDto`accepts it, and the list quick-edit already sends null this way).
In the tier grid **and** the Tier 1 row, when`Number(product.unitsPerBox) > 1`, render a muted
second line under each price: `≈ $X.XX / unit`using`perUnitPrice(tierValue, unitsPerBox)`from`@/lib/pricing` (WP2). Display only — it must never enter a payload.

  **(d) Products list cascade + undo fix.** In `apps/web/app/(dashboard)/products/page.tsx`,
  `handleQuickSave` (~line 702) contains two cascade blocks. Replace **only** the
  `field.startsWith("priceTier")` block (~lines 743–753, which today merely _caps_ higher tiers
  that are unset or more expensive) with an unconditional `Object.assign(updates,
cascadeTierPrices(field as TierField, parseFloat(newVal)))`. **Leave the `pricePerUnit` block
  (~lines 710–740) exactly as it is** — that is the "smart" Tier 1 behavior we are keeping.
  `QuickEditCell.commit` already no-ops when the value is unchanged, so that surface's change
  detection is already correct.
  Then fix undo: today the undo stack records only the single edited field, so a cascade cannot be
  undone. Push an **object patch** (old and new values for every field in `updates`) and generalize
  `handleUndo`/`handleRedo` (~lines 793–815) to accept either a scalar or an object patch — the
  existing `field === "section"` special case becomes the general object branch, so old scalar
  records and section records keep working. Also relabel the list's `unitsPerBox` column header
  from "Per Box" to "Units / case".

- **exact code:**

  `apps/web/components/MoneyInput.tsx` — add to `DecimalInputProps`:

  ```ts
    /**
     * Fired once per edit session (blur, or Enter which blurs) with the committed value, and
     * ONLY when it differs from the value the field had at focus time. Use this for side effects
     * that must not run while the user is mid-keystroke — e.g. the product tier-price cascade.
     * `onChange` still fires per keystroke so live totals keep working.
     */
    onCommit?: (value: number) => void;
  ```

  Destructure `onCommit` (and pull `onKeyDown` out of `rest`) in the component signature, add the
  focus snapshot ref, and extend the handlers:

  ```tsx
  const valueAtFocusRef = React.useRef<number | null>(null);
  ```

  ```tsx
          onFocus={(e) => {
            focusedRef.current = true;
            valueAtFocusRef.current = value;
            if (selectOnFocus) e.currentTarget.select();
          }}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            // Enter commits: blur runs the change-detection below.
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={() => {
            focusedRef.current = false;
            const parsed = text === "" || text === "-" ? null : parseFloat(text);
            if (parsed == null || Number.isNaN(parsed)) {
              setText(value == null ? "" : value.toFixed(decimals));
              return; // nothing committed — a cleared/invalid field must not fire onCommit
            }
            const clamped = clamp(parsed);
            setText(clamped.toFixed(decimals));
            if (clamped !== parsed) onChange(clamped);
            const before = valueAtFocusRef.current;
            const changed = before == null || Math.abs(clamped - before) >= 1e-9;
            if (changed) onCommit?.(clamped);
          }}
  ```

  `products/[id]/page.tsx` — `EditableNumber` becomes:

  ```tsx
  function EditableNumber({
    value,
    onChange,
    onCommit,
  }: {
    value: number;
    onChange: (v: number) => void;
    onCommit?: (v: number) => void;
  }) {
    return (
      <DecimalInput
        min={0}
        value={Number.isFinite(value) ? value : null}
        onChange={(v) => onChange(v ?? 0)}
        onCommit={onCommit}
        /* keep the existing className / props exactly as they are today */
      />
    );
  }
  ```

  and the tier input inside the grid map becomes:

  ```tsx
  <EditableNumber
    value={curVal}
    onChange={(v) => setEditDraft((d) => ({ ...d, [field]: String(v) }))}
    onCommit={(v) => setEditDraft((d) => ({ ...d, ...cascadeTierPrices(field as TierField, v) }))}
  />
  ```

  `products/page.tsx` — the replacement cascade block inside `handleQuickSave`:

  ```ts
  // Committing a tier price copies it down the ladder (T3..T5 when T2 is edited, etc).
  // The list price (pricePerUnit) deliberately keeps its smarter behavior above.
  if (field.startsWith("priceTier") && newVal) {
    Object.assign(updates, cascadeTierPrices(field as TierField, parseFloat(newVal)));
  }
  ```

---

### WP4 — Web order & invoice builders: Case/Unit selling + inline credit-note create

- **files:** `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`, `apps/web/app/(dashboard)/invoices/new/page.tsx`, `apps/web/app/(dashboard)/orders/_components/CreditNotePicker.tsx`
- **brief:** Three changes.

  **(a) Case/Unit sell-by selector on case-packed lines.** Today a case-packed line is entered as
  a **boxes** input plus a **pieces** input capped at `unitsPerBox - 1`, so "sell 7 loose units of
  a 6-pack" is literally impossible to type. Add a small two-segment toggle (`Case` | `Unit`) on
  each line whose product has `unitsPerBox > 1`, defaulting to `Case`.
  - `Case` mode = today's two inputs, relabelled "cases" and "units" (was "boxes" / "pcs"),
    caption `1 case = {unitsPerBox} units · {qty} units total`.
  - `Unit` mode = **one** integer input holding the total unit count, with **no max**, routed
    through `normalizeBoxesPieces({ qty: value, unitsPerBox })` so 7 units of a 6-pack becomes
    `{boxes: 1, pieces: 1, qty: 7}`. The price is identical either way because the proration is
    linear (`casePrice × (boxes + pieces/upb)` = `casePrice × totalUnits/upb`).

  `LineItem` gains `sellBy?: "case" | "unit"`. **It is UI state only and must never appear in a
  payload.** The submit block, the `computeLineSubtotal` call, and the boxes/pieces DTO fields all
  stay exactly as they are. Drafts serialize `lineItems` wholesale, so `sellBy` round-trips
  harmlessly through park/resume.

  Also replace the ad-hoc per-piece hint (a raw `li.unitPrice / li.unitsPerBox` division, ~line 1443) with `perUnitPrice(li.unitPrice, li.unitsPerBox)` from `@/lib/pricing` (WP2), and relabel
  the one-time price override field to "Case price" when the line is case-packed (the override has
  always been a per-selling-unit price; the label just never said so).

  **(b) Same treatment in `invoices/new/page.tsx`** — same toggle, same `normalizeBoxesPieces`
  routing, same `perUnitPrice` replacement of its raw `/pc` division (~line 1634). Its submission
  blocks stay untouched.

  **(c) Inline credit-note create in `CreditNotePicker.tsx`.** Today the component returns `null`
  when the customer has no open credits, so there is nowhere to hang a create affordance. Change
  the early return to bail on `!customerId` **only**, and render an empty state ("No open credits
  for this customer.") when the list is empty. Add a "+ New credit note" button in the section
  header opening a compact local modal: amount (`MoneyInput`), reason (required), optional expiry
  date. Submit through the existing `useCreateCreditNote()` hook from `@/lib/api/credit-notes`.

  **On success, select it immediately from the create response** — do not wait for the refetch:
  call `onChange([...value, { creditNoteId: created.id }])` and merge the created credit into a
  local `justCreated` array that is deduped (by id) into the rendered rows, so the row and the
  running "Credits to apply" total include it right away. The server's pre-gate
  (`validateSelectionsForCustomer`) accepts a freshly-minted credit: it is `ISSUED` with its full
  balance open. This one component serves both the create-order modal and the order-edit page, so
  no changes are needed in either caller.

- **exact code:**

  New handlers in `CreateOrderModal.tsx`, next to the existing `setBoxes` / `setPieces`:

  ```ts
  /** Unit mode: the operator types a TOTAL unit count; normalize it back into cases + loose.
   *  7 units of a 6-pack -> {boxes:1, pieces:1, qty:7}. Price is unchanged either way because
   *  computeLineSubtotal's proration is linear. */
  const setUnitQty = (tempId: string, value: number) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        const n = normalizeBoxesPieces({ qty: value, unitsPerBox: li.unitsPerBox });
        return { ...li, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty };
      }),
    );
  };

  const setSellBy = (tempId: string, sellBy: "case" | "unit") =>
    setLineItems((prev) => prev.map((li) => (li.tempId === tempId ? { ...li, sellBy } : li)));
  ```

  `LineItem` addition:

  ```ts
    /** UI-only qty entry mode for case-packed lines. NEVER submitted — the payload always
     *  carries {qty, boxes, pieces} and the per-case unitPrice. */
    sellBy?: "case" | "unit";
  ```

---

### WP5 — Mobile product form: tier prices + Case/Unit labels

- **files:** `apps/mobile/lib/product-form.ts`, `apps/mobile/components/ProductForm.tsx`, `apps/mobile/components/InlineCreateProductSheet.tsx`, `apps/mobile/__tests__/operator-create-forms.test.ts`
- **brief:** Mobile has **no tier-price editing at all** today — `ProductFormValues` has no
  `priceTier*` keys. Add parity.

  In `apps/mobile/lib/product-form.ts`: add `priceTier2 | priceTier3 | priceTier4 | priceTier5:
string` to `ProductFormValues`; default them to `""` in `emptyProductForm()`; hydrate them in
  `productFormFromValues` as `p.priceTierN != null ? String(p.priceTierN) : ""`; add them to
  `SubmitPayload` and emit them from `buildProductPayload` via the existing `parseOptionalNumber`
  (so a blank field is `undefined` = leave unchanged; the API's `toOptionalDecimalString` transform
  accepts numbers).

  In `apps/mobile/components/ProductForm.tsx`: add four `FormTextInput`s ("Tier 2 price" …
  "Tier 5 price", `keyboardType="decimal-pad"`) after the existing price field. Implement the
  same commit-not-keystroke rule React Native style: snapshot `form[field]` into a ref on
  `onFocus`, and on `onEndEditing` compare the parsed values (epsilon compare) — only on a real
  change apply `set({ ...cascadeTierPrices(field, parsed) })` using `cascadeTierPrices` from
  `../lib/pricing` (WP2). **Do not cascade from the main price field** (Tier 1 keeps its behavior).

  Also, when `unitsPerBox > 1`, render a per-unit preview line under the price fields using
  `perUnitPrice` from `../lib/pricing`: `≈ $X.XX / unit`. Extend the existing conditional hint
  rather than adding a competing one.

  Terminology pass: relabel "Pieces per box (optional)" → "Units per case (optional)" in both
  `ProductForm.tsx` and `InlineCreateProductSheet.tsx`, and change "box" → "case" in the
  surrounding hint copy (e.g. "This is the CASE price. A loose unit costs price ÷ units-per-case.").
  Field names, payload keys, and the `unitsPerBox` API field are **unchanged** — labels only.

  Extend `apps/mobile/__tests__/operator-create-forms.test.ts` with a tier round-trip case
  (`productFormFromValues` → `buildProductPayload`) asserting blank tiers are omitted in edit mode
  and populated tiers are emitted.

---

### WP6 — Mobile sale surfaces: Case/Unit entry + inline credit-note create

- **files:** `apps/mobile/lib/sale-line.ts`, `apps/mobile/__tests__/sale-line.test.ts`, `apps/mobile/components/NewOrderScreen.tsx`, `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`
- **brief:** Mirror of WP4 on mobile, plus the mobile half of the inline credit create.

  **(a)** Add a pure helper `setLineUnits` to `apps/mobile/lib/sale-line.ts` (sibling of the
  existing `setLineBoxes` / `setLinePieces`), and cover it in `__tests__/sale-line.test.ts`.

  **(b)** In `components/NewOrderScreen.tsx`: `LineState` gains `sellBy?: "case" | "unit"`
  (UI-only, never submitted — the submit block stays byte-identical). On the case-packed product
  row and in the cart sheet, add a mini segmented control (`Cases` | `Units`); `Units` mode shows a
  single `QtyStepper` bound to the total unit count with **no `max`**, wired to `setLineUnits`.
  Relabel "Boxes" → "Cases" and "Loose pcs" → "Loose units", preferring the product's free-text
  `unit` where the code already interpolates it. Add a per-unit hint on the product row using
  `perUnitPrice` from `../lib/pricing` (WP2).

  **(c)** Inline credit create: the "Apply credit" section is currently gated on
  `customerId && openCredits.length > 0`, so it vanishes exactly when the operator needs to create
  one. Gate it on `customerId` alone, show an empty state, and add a "New credit note" button
  opening a small create sheet (follow the structure of `InlineCreateProductSheet.tsx`) with
  amount + reason. Use `useCreateCreditNote` from `../lib/api/credit-notes` — **created by WP8;
  import it, do not define it here.** On success append the new id to `selectedCreditIds` and merge
  the created credit into a local `justCreated` array so it renders before the refetch lands.

  **(d)** Same treatment in `app/(operator)/(tabs)/orders/[id]/edit-items.tsx`: gate the credit
  section on `!isDriver && customerId` (drop the `creditRows.length > 0` requirement), add the same
  create sheet, and on create success set `creditsTouched = true` **and** select the new id — the
  `creditsTouched` flag is what makes the save send `appliedCreditNotes` at all.

- **exact code:**

  ```ts
  /**
   * Sell-by-unit entry: the operator types a TOTAL unit count for a case-packed line, and we
   * normalize it back into cases + loose units (7 units of a 6-pack -> 1 case + 1 loose).
   * Every other field on the line (unitPrice override, note) is preserved — rebuilding the line
   * from scratch is the field-wipe bug that incrementLine already exists to avoid.
   * Returns null when the line reaches zero, matching decrementLine's remove signal.
   */
  export function setLineUnits<
    T extends { qty: number; boxes?: number | null; pieces?: number | null },
  >(
    prev: T,
    units: number,
    unitsPerBox: number,
  ): (T & { qty: number; boxes: number; pieces: number }) | null {
    const upb = Math.trunc(Number(unitsPerBox));
    if (!(upb > 1)) return null;
    const total = Math.max(0, Math.trunc(Number(units) || 0));
    if (total === 0) return null;
    return { ...prev, qty: total, boxes: Math.floor(total / upb), pieces: total % upb };
  }
  ```

  Spec cases: `setLineUnits({qty:6,boxes:1,pieces:0,unitPrice:30,note:"x"}, 7, 6)` →
  `{qty:7,boxes:1,pieces:1,unitPrice:30,note:"x"}`; `(…, 0, 6)` → `null`;
  `(…, 12, 6)` → `{qty:12,boxes:2,pieces:0}`; non-case-packed (`upb` 1) → `null`.

---

### WP7 — Credit notes: server DTO + web create modal (any customer, working search)

- **files:** `apps/api/src/credit-notes/dto/create-credit-note.dto.ts`, `apps/api/src/credit-notes/dto/create-credit-note.dto.spec.ts`, `apps/api/src/credit-notes/credit-notes.controller.ts`, `apps/web/app/(dashboard)/credit-notes/page.tsx`
- **brief:** **Root causes (confirmed, do not re-diagnose).** The service already supports a
  standalone credit for **any** customer — `create({customerId, amount, reason})` needs no invoice,
  runs no "does this customer have orders" check, and imposes no invoice-status restriction (the
  PAID guard lives only in `applyToInvoice`). Both reported problems are client-side in
  `CreateCreditNoteModal`:
  1. _"the list of customers is limited"_ — the modal calls `useCustomers({search})` with **no
     `limit`**, so the API's default `limit = 20` applies and the dropdown only ever contains the
     20 most-recently-created customers. Every other picker in the app passes an explicit limit.
  2. _"searching by typing does not work"_ — the raw search state goes straight into the query key
     with **no debounce and no placeholder data**, so every keystroke mints a new key, `data`
     becomes `undefined`, and the `<select>` collapses to just its placeholder while in flight.
     The search input also sits inside the form, so pressing Enter submits the form and paints
     validation errors instead of searching.

  **Web fix.** Replace the search-input + native `<select>` pair with the proven combobox pattern
  from `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx` (300 ms debounce →
  `useCustomers({ search })` → results dropdown → selected chip with a clear button). Add
  `e.preventDefault()` on Enter in the search input. Also fix the invoice dropdown, which today
  fetches the newest 100 invoices **tenant-wide** and filters client-side (so a customer's invoices
  can be entirely absent): call `useInvoices({ customerId, limit: 100 })` — `ListInvoicesDto`
  supports `customerId` server-side — and enable it only once a customer is chosen. The invoice is
  **optional and unrestricted by status**: a fully-paid invoice must be selectable (the service's
  cumulative per-invoice cap is what prevents over-crediting). Show the status in each option label;
  filter out only `VOID` and `WRITTEN_OFF`. Finally, delete the dead `issueDate` and `notes` form
  fields — neither exists on the `CreditNote` model and the service silently drops both today.

  **Server hardening.** The controller takes `@Body() dto: any`, so `POST /credit-notes` is
  completely unvalidated. Add a real DTO. **Critical:** the global pipe is `forbidNonWhitelisted`,
  and the _currently deployed_ web bundle still posts `issueDate` and `notes` — the DTO must
  tolerate them or every existing client 400s the moment this deploys. Keep them as explicitly
  deprecated, ignored fields. Use `@IsString()` (not `@IsUUID()`) for ids, matching the convention
  in `ListInvoicesDto` — imported records can carry non-UUID ids. The service keeps its own
  amount/expiry/items guards as defense in depth; behavior for existing callers
  (`ReturnsService.processRefund` calls the service directly, bypassing the pipe) is unchanged.

- **exact code:**

  `apps/api/src/credit-notes/dto/create-credit-note.dto.ts` (new):

  ```ts
  import { Type } from "class-transformer";
  import {
    IsArray,
    IsISO8601,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ValidateNested,
  } from "class-validator";

  export class CreateCreditNoteLineDto {
    @IsString()
    @IsNotEmpty()
    invoiceItemId!: string;

    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    amount!: number;

    @IsOptional()
    @IsNumber({ maxDecimalPlaces: 3 })
    @Min(0.001)
    qty?: number;
  }

  export class CreateCreditNoteDto {
    @IsString()
    @IsNotEmpty()
    customerId!: string;

    /** Optional source invoice. Absent = a standalone credit for this customer. */
    @IsOptional()
    @IsString()
    invoiceId?: string;

    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    @Max(1_000_000)
    amount!: number;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateCreditNoteLineDto)
    items?: CreateCreditNoteLineDto[];

    /** ISO date; the service additionally requires it to be in the future. */
    @IsOptional()
    @IsISO8601()
    expiresAt?: string;

    // ---- Deprecated, accepted-and-ignored -------------------------------------------------
    // The global ValidationPipe runs forbidNonWhitelisted, and the deployed web bundle still
    // posts these two. They have no columns on CreditNote and the service already drops them.
    // Keeping them declared is what stops this DTO from 400-ing every in-flight client.
    // Remove once the old bundle has aged out of caches.
    @IsOptional()
    @IsString()
    issueDate?: string;

    @IsOptional()
    @IsString()
    notes?: string;
  }
  ```

  Controller: change `create(@Body() dto: any)` → `create(@Body() dto: CreateCreditNoteDto)`.

  Spec `create-credit-note.dto.spec.ts` — validate via `plainToInstance` + `validate` (follow the
  shape of `apps/api/src/suppliers/dto/list-suppliers.dto.spec.ts`): rejects `amount: 0`,
  `amount: -5`, `amount: 2_000_000`, three-decimal amounts, a missing `customerId`, a malformed
  `expiresAt`, and a malformed `items[]` entry; **accepts a payload carrying `issueDate` and
  `notes`** (the rollout-critical case — name it explicitly in the test title).

---

### WP8 — Mobile: create a credit note

- **files:** `apps/mobile/lib/api/credit-notes.ts`, `apps/mobile/app/(operator)/credit-notes/new.tsx`, `apps/mobile/app/(operator)/credit-notes/index.tsx`, `apps/mobile/app/(operator)/credit-notes/[id].tsx`
- **brief:** Mobile can view, issue, apply, unapply and void credit notes but **cannot create
  one** — there is no `useCreateCreditNote` and no create route.

  In `lib/api/credit-notes.ts`: add `useCreateCreditNote()` posting `POST /credit-notes` with
  `{ customerId, amount, reason?, invoiceId?, expiresAt? }`, returning the created `CreditNote`,
  invalidating `["credit-notes"]` on success. Also rename `useOpenInvoicesForCustomer` →
  `useInvoicesForCustomer` (it already fetches every status — the OPEN filter is applied
  client-side in `[id].tsx`) and keep `export const useOpenInvoicesForCustomer =
useInvoicesForCustomer;` as an alias so the existing call site keeps working. Update the stale
  header comment that claims credit notes are "create-only server-side".

  New screen `app/(operator)/credit-notes/new.tsx` — one lean screen, not a multi-step wizard:
  customer picker (copy the `CustomerPickerView` pattern from `components/NewOrderScreen.tsx`:
  `useAdminCustomers({ search, limit: 50 })` + `SearchBar`), amount via `MoneyTextInput`, reason
  (required), optional expiry, optional invoice picker listing **all** statuses with a status pill
  (hide only `VOID` / `WRITTEN_OFF`). Submit → `router.replace("/(operator)/credit-notes/<id>")`.
  A bare `<Stack>` auto-registers the screen, so `_layout.tsx` needs no edit.

  `index.tsx`: add a NavBar trailing "New" action navigating to the new route — copy the
  `NavAction` usage in `app/(operator)/returns/index.tsx`.

- **effort:** (normal)

---

### WP9 — Returns API: credit-note vs external-refund choice, resolve without receiving

- **files:** `apps/api/src/returns/dto/process-refund.dto.ts`, `apps/api/src/returns/dto/receive-return.dto.ts`, `apps/api/src/returns/returns.service.ts`, `apps/api/src/returns/returns.controller.ts`, `apps/api/src/returns/returns-refund.spec.ts`
- **brief:** Today `POST /returns/:id/refund` **always** mints a credit note, takes **no body**, and
  the operator has no choice. The web UI's separate "Issue Credit Note" button posts straight to
  `/credit-notes` with different (wrong, box-unsafe) math — an operator can mint two credits for
  one return. This package makes the choice explicit and server-authoritative; WP10 removes the
  rogue client path.

  Depends on WP0's three new `Return` columns.

  **(a) `receive()` accepts APPROVED as well as IN_TRANSIT, and can suppress restocking.**
  The user's requirement is "receiving the item depends on if we want it or not". Signature becomes
  `receive(id: string, userId: string, opts?: { restock?: boolean })`. Relax **both** the pre-check
  and the atomic-claim `where` from `status: "IN_TRANSIT"` to `status: { in: ["APPROVED",
"IN_TRANSIT"] }`, updating the error message to "Only APPROVED or IN_TRANSIT returns can be
  received". When `opts?.restock === false`: skip the per-item restock loop entirely **and**
  `await tx.returnItem.updateMany({ where: { returnId: id }, data: { restock: false } })` inside
  the same transaction. That second write is not optional — `cancel()` decrements stock for every
  item whose `restock` is true, so leaving the flags at their default would make a later cancel
  decrement stock that was never incremented. `ledger.reverseReturnEntries` stays **unconditional**:
  a returned regulated sale must reverse for tax whether or not the goods come back.

  **Design note for reviewers:** we deliberately do NOT add an `APPROVED → REFUNDED` shortcut.
  "Resolve without receiving" is `receive({restock:false})` followed by the normal refund — two
  independently atomic steps. This keeps the `RECEIVED → REFUNDED` claim as the single mint gate
  and keeps the ledger reversal in exactly one place.

  **(b) `processRefund(id, dto?)` gains a method.** `const method = dto?.method ?? "CREDIT_NOTE";`
  Compute `refundAmount` exactly as today (the `subtotal / qty` per-unit derivation is
  box-price-safe — do not "simplify" it to `unitPrice`). Fold the new columns into the **existing**
  atomic claim rather than adding a second write. `CREDIT_NOTE` keeps today's behavior verbatim.
  `EXTERNAL_REFUND` mints nothing — the money moved outside RouteFlow and `refundAmount` +
  `refundMethod` + `refundedAt` are the audit trail.

  **(c) `findOne()` surfaces the resolution.** `Return.creditNoteId` is populated but never
  reaches a client. After the existing fetch, when `creditNoteId` is set, look up
  `{ id, creditNoteNumber, amount, status }` and attach it as `creditNote`. Also attach
  `refundEstimate` — the same `Σ qty × (subtotal/qty)` figure `processRefund` computes — so clients
  can show the amount **before** resolving without re-deriving box-priced money client-side
  (add `subtotal` to the order `lineItems` select if it is not already there).

  **(d) Controller** passes the new bodies through. Empty-body POSTs must keep working (Nest
  materializes `{}`; every DTO field is optional).

- **exact code:**

  `apps/api/src/returns/dto/process-refund.dto.ts` (new):

  ```ts
  import { IsBoolean, IsIn, IsOptional } from "class-validator";

  export const REFUND_METHODS = ["CREDIT_NOTE", "EXTERNAL_REFUND"] as const;
  export type RefundMethod = (typeof REFUND_METHODS)[number];

  export class ProcessRefundDto {
    /**
     * CREDIT_NOTE (default) mints store credit for the customer — today's only behavior.
     * EXTERNAL_REFUND records that money was returned outside RouteFlow and mints nothing.
     */
    @IsOptional()
    @IsIn(REFUND_METHODS)
    method?: RefundMethod;

    /**
     * Deprecated and ignored. The endpoint never read a body, so the deployed web bundle sends
     * { restock } here; with forbidNonWhitelisted active, omitting this field would 400 every
     * in-flight client. Restocking is decided at receive() time. Remove after the old bundle ages out.
     */
    @IsOptional()
    @IsBoolean()
    restock?: boolean;
  }
  ```

  `apps/api/src/returns/dto/receive-return.dto.ts` (new):

  ```ts
  import { IsBoolean, IsOptional } from "class-validator";

  export class ReceiveReturnDto {
    /**
     * false = "we are not keeping these goods": skip ALL restocking and persist restock=false on
     * every ReturnItem, so a later cancel() stays symmetric. Omitted/true keeps the per-item flags
     * chosen when the return was created. The regulated ledger reversal happens either way.
     */
    @IsOptional()
    @IsBoolean()
    restock?: boolean;
  }
  ```

  `returns.service.processRefund` — the claim becomes:

  ```ts
  const method = dto?.method ?? "CREDIT_NOTE";
  // ... refundAmount computed exactly as before ...

  const claimed = await this.prisma.forTenant().return.updateMany({
    where: { id, status: "RECEIVED" },
    data: {
      status: "REFUNDED",
      refundMethod: method,
      refundAmount,
      refundedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    throw new BadRequestException("Only RECEIVED returns can be refunded");
  }
  const updated = await this.prisma.forTenant().return.findUnique({ where: { id } });

  // EXTERNAL_REFUND: the money was returned outside RouteFlow. Record it, mint nothing.
  if (method === "EXTERNAL_REFUND") return updated;

  if (refundAmount <= 0.001) return updated;
  // ... existing creditNotes.create(...) + creditNoteId write, unchanged ...
  ```

  **Specs** — extend `returns-refund.spec.ts`:
  - no body → still mints a credit note (regression of the default) and persists
    `refundMethod: "CREDIT_NOTE"`, `refundAmount`, `refundedAt`.
  - `{ method: "EXTERNAL_REFUND" }` → `creditNotes.create` is **never called**, the claim's `data`
    carries `refundMethod: "EXTERNAL_REFUND"` + the amount, and no `creditNoteId` is written.
  - Double-mint guard on both methods: `updateMany` resolving `{count: 0}` → `BadRequestException`
    and no mint.
  - `refundAmount` is rounded (assert the exact cents on a box-priced fixture).
  - `receive`: allowed from `APPROVED`; rejected from `PENDING`; `{restock:false}` → no
    `stockMovement.create`, no `product.update`, **but** `returnItem.updateMany({data:{restock:false}})`
    IS called and `reverseReturnEntries` IS still called.

---

### WP10 — Returns clients: web + mobile resolve flow

- **files:** `apps/web/app/(dashboard)/returns/[id]/page.tsx`, `apps/web/lib/api/returns.ts`, `apps/mobile/lib/returns-logic.ts`, `apps/mobile/lib/api/returns.ts`, `apps/mobile/app/(operator)/returns/[id].tsx`, `apps/mobile/__tests__/returns-logic.test.ts`
- **brief:** Consumes WP9's API.

  **Web.** Delete `handleConvertToCreditNote` and its "Issue Credit Note" button outright — that
  path posts directly to `/credit-notes` with `Σ qty × unitPrice` (wrong for box-priced lines),
  floors a $0 total to $0.01, never links the credit back to the return, and can be clicked
  _alongside_ "Process Refund" to mint a second credit for the same goods. The choice now lives in
  one modal.

  Replace `ProcessRefundModal` with `ResolveReturnModal`: a radio choice — "Issue store credit
  (credit note)" (default) / "Refunded outside RouteFlow (cash, check, transfer)" — showing the
  server's `refundEstimate` as the amount. **Remove the restock checkbox** (it was inert: the
  endpoint never read a body) and the copy claiming the credit must be issued outside RouteFlow
  (that was never true). Write copy that states exactly what each option does.

  Actions by status: `RECEIVED` → one "Resolve Return" button. `APPROVED` / `IN_TRANSIT` → keep the
  existing physical-path buttons and add a secondary **"Resolve without receiving"** which calls
  receive with `{ restock: false }` and then opens the same resolve modal. If the operator abandons
  step two the return sits at `RECEIVED`, which is truthful.

  On a `REFUNDED` return, show the refund amount, the method, the date, and — when
  `creditNoteId` is present — a link to `/credit-notes/<id>` labelled with the credit note number
  from the new `creditNote` relation.

  `apps/web/lib/api/returns.ts`: add `creditNoteId`, `creditNote`, `refundAmount`, `refundMethod`,
  `refundedAt`, `refundEstimate` to the `Return` interface; `useMarkReturnReceived` takes
  `{ id, restock? }` and sends the body; `ProcessRefundDto` becomes `{ id, method? }` (drop the
  dead `restock`); `useProcessRefund.onSuccess` also invalidates `["credit-notes"]`.

  **Mobile.** `lib/returns-logic.ts`: `canReceive` becomes `status === "APPROVED" || status ===
"IN_TRANSIT"`; add `canResolveWithoutReceipt` with the same predicate; `canRefund` stays
  `RECEIVED`-only. Update `__tests__/returns-logic.test.ts`'s flag matrix accordingly.
  `lib/api/returns.ts`: send bodies for receive (`{restock?}`) and refund (`{method?}`), add the new
  `Return` fields (`creditNoteId` already exists), and fix the now-stale comment asserting these
  endpoints take no body. `app/(operator)/returns/[id].tsx`: replace the refund confirm with a
  three-option `Alert.alert` (Issue store credit / Refunded outside app / Cancel), add a "Resolve
  without receiving" action tile behind `canResolveWithoutReceipt` (chaining receive
  `{restock:false}` then the same alert), and on a `REFUNDED` return show amount + method and a tile
  linking to `/(operator)/credit-notes/<creditNoteId>` when one exists.

---

### WP11 — Regulated reports API: range preview, shared row model, TX Comptroller

- **files:** `apps/api/src/regulated/report-types.ts`, `apps/api/src/regulated/report-csv.ts`, `apps/api/src/regulated/report-csv.spec.ts`, `apps/api/src/regulated/tx-report.ts`, `apps/api/src/regulated/tx-report.spec.ts`, `apps/api/src/regulated/regulated-report.service.ts`, `apps/api/src/regulated/regulated-report.service.spec.ts`, `apps/api/src/regulated/dto/report-query.dto.ts`, `apps/api/src/regulated/filing-csv.ts`, `apps/api/src/regulated/regulated.controller.ts`, `apps/api/src/regulated/regulated.module.ts`, `apps/api/src/regulated/regulated-filing.service.ts`, `apps/api/src/regulated/regulated-filing.service.spec.ts`, `apps/api/src/tracked-categories/dto/create-tracked-category.dto.ts`, `apps/api/src/tracked-categories/dto/update-tracked-category.dto.ts`, `apps/api/src/tracked-categories/tracked-categories.service.ts`
- **brief:** Three user asks: report over an arbitrary date range; **view it in-app before
  downloading**; add a **TX Comptroller** format. Today filings are locked to completed calendar
  periods (`@@unique(tenantId, trackedCategoryId, periodKey)`, plus a hard "period must be over"
  guard), and every artifact path is a `window.open` on a presigned CSV — there is no preview
  anywhere.

  **Architecture (decided — implement this, do not redesign).** Filings stay period-keyed and
  remain the compliance archive; the daily cron is untouched. Add **stateless** report endpoints
  that compute on demand and persist nothing. One row model feeds both the JSON preview and the CSV
  bytes, so what the operator sees is literally the file.

  **(a) `report-types.ts`** — the shared `RegulatedReport` shape (see exact code).

  **(b) `report-csv.ts`** — move `esc()` here verbatim from `filing-csv.ts` and add
  `serializeReportCsv(report)`: emit `csv.preamble` rows, then the header row **only if**
  `csv.includeHeader`, then `rows`, then `totalsRow` **only if** `csv.includeTotals`, then
  `csv.footer`; join with `\n` and end with a trailing newline.

  **(c) `filing-csv.ts` refactor** — turn the existing template switch into
  `buildAggregateReport(template, data & { periodLabel })` returning a `RegulatedReport`, and
  reduce `buildFilingCsv(template, data)` to
  `serializeReportCsv(buildAggregateReport(template, { ...data, periodLabel: data.periodKey }))`.
  For legacy templates set `preamble: [[title, categoryName, periodLabel]]`, `includeHeader: true`,
  `includeTotals: true`, `footer: [["Note", <the existing disclosure string>]]`.
  **`filing-csv.spec.ts` must keep passing with zero edits — that is the byte-identity gate.**
  Preserve the optional `withSubcategory` column injection and the unknown-template → GENERIC
  fallback exactly.

  **(d) `tx-report.ts`** — a pure `buildTxReport(input)` (signature below). Grouping and netting:
  ledger rows are pre-signed (REVERSAL rows are negative and carry the sibling invoice's
  `invoiceId`), so summing signed `unitBasisQty` and `netSales` per `invoiceId` nets credit notes
  and returns automatically. Rows whose sums both round to zero are dropped; negative-net invoices
  are still emitted, with a `NEGATIVE_NET_INVOICE` warning. Ledger rows with a null `invoiceId`
  are excluded, with one `UNLINKED_LEDGER_ROWS` warning carrying the count.
  Retailer license = the category's `CustomerAuthorization.licenseNumber`, falling back to
  `Customer.tobaccoLicenseNo`, else empty + warning. Address = first match of: default **and**
  BILLING → any BILLING → any default → first (expose the picker as `pickReportAddress` for tests).
  IDs are emitted **digits-only as stored** — never zero-padded, never fabricated — with a warning
  when the length is wrong (wholesaler license ≠ 8, taxpayer ID ≠ 11, retailer license ≠ 8).
  Text fields truncate to the spec lengths (name 50, street 50, city 30, state 2 uppercase, zip =
  first 5 digits). Quantity and invoice amount are `Math.round`ed to whole numbers (the spec says
  dollars rounded to the nearest dollar); a fractional quantity also raises `FRACTIONAL_QTY`.
  Rows sort by invoice issue date, then invoice number. TX CSV carries **no header row**
  (`includeHeader: false`, empty preamble/footer/totals) — commas inside fields are double-quoted
  by `esc`.

  **(e) `regulated-report.service.ts`** — `buildReport({category, from, to, template?})` validates
  `YYYY-MM-DD` on both dates, `from <= to`, and a span of at most 366 days (`BadRequestException`
  otherwise), then queries the **half-open** window `soldAt >= from 00:00Z` and
  `soldAt < (to + 1 day) 00:00Z` — `from`/`to` are **inclusive dates**, which is what a date picker
  produces ("last month" = the 1st through the 31st). Template defaults to the category's
  `reportTemplate`. The TX path does a manual three-step join, because `RegulatedSalesLedger` has
  **no Prisma relations** — its `invoiceId` is a plain indexed scalar, so `include` is impossible:
  ledger rows → `invoice.findMany({ where: { id: { in: invoiceIds } } })` → `customer.findMany`
  with `addresses` and `authorizations` filtered to this category. All queries via `forTenant()`.
  Non-TX templates reuse `RegulatedService.getLedger` with `{ exclusiveTo: true }` and feed
  `buildAggregateReport`. `buildReportCsv` serializes and returns `{ csv, filename }` where the
  filename is `<category-slug>-<template>-<from>-<to>.csv`.

  **(f) Controller** — add `GET /regulated/reports/preview` (JSON) and `GET /regulated/reports/csv`
  (`text/csv` attachment via `@Res({ passthrough: true })`), both taking `ReportQueryDto`. Register
  them **above** the existing `filings/:id/...` routes so the static segment wins. The class-level
  `JwtAuthGuard` + `RolesGuard` + `@Roles(OPERATOR)` already cover them; add no addon gate (the
  existing regulated routes have none). Register `RegulatedReportService` in `regulated.module.ts`.

  **(g) `prepareFiling` learns TX** — when `category.reportTemplate === "TX_COMPTROLLER"`, build the
  TX report for the period's range and store **that** as the filing CSV, with
  `rows: { txRows, warnings }` in the existing Json column. The four Decimal total columns keep
  coming from the ledger aggregate (no schema change). Without this, a TX-configured category's
  cron filing would silently contain the GENERIC aggregate CSV — a confusing mismatch with what the
  Reports panel shows.

  **(h) Tracked-category DTOs + service** pass through WP0's three new columns:
  `@IsOptional() @IsString() @MaxLength(20) wholesalerLicenseNo`,
  `@IsOptional() @IsInt() @IsIn([1,2,3]) txItemType`,
  `@IsOptional() @IsString() @IsIn([...TX_UOM_CODES]) txUom`. Mirror how `unitBasis` is handled in
  create/update.

- **exact code:**

  `report-types.ts`:

  ```ts
  export type ReportWarningCode =
    | "MISSING_WHOLESALER_LICENSE"
    | "MISSING_ITEM_TYPE"
    | "MISSING_UOM"
    | "MISSING_TAXPAYER_ID"
    | "INVALID_TAXPAYER_ID"
    | "MISSING_RETAILER_LICENSE"
    | "INVALID_RETAILER_LICENSE"
    | "INVALID_WHOLESALER_LICENSE"
    | "MISSING_ADDRESS"
    | "NEGATIVE_NET_INVOICE"
    | "FRACTIONAL_QTY"
    | "UNLINKED_LEDGER_ROWS";

  export interface ReportWarning {
    code: ReportWarningCode;
    /** A complete human sentence, ready to render in the UI. */
    message: string;
    invoiceId?: string;
    customerName?: string;
  }

  export interface ReportColumn {
    key: string;
    label: string;
    align?: "right";
  }

  /**
   * One report, in a shape that serializes to BOTH the in-app preview (JSON) and the CSV file.
   * `rows` holds fully FORMATTED cells in `columns` order — the preview table and the downloaded
   * file therefore cannot drift.
   */
  export interface RegulatedReport {
    template: string;
    title: string;
    categoryId: string;
    categoryName: string;
    /** Inclusive YYYY-MM-DD range, echoed back for display. */
    from: string;
    to: string;
    columns: ReportColumn[];
    rows: string[][];
    /** Aggregate templates only; null for per-sale templates like TX. */
    totalsRow: string[] | null;
    /** Headline figures for the preview UI (not necessarily in the CSV). */
    displayTotals: { label: string; value: string }[];
    warnings: ReportWarning[];
    csv: {
      preamble: string[][];
      includeHeader: boolean;
      includeTotals: boolean;
      footer: string[][];
    };
  }
  ```

  `tx-report.ts` public surface:

  ```ts
  /** TX Comptroller unit-of-measure codes, keyed by item type. */
  export const TX_UOM_CODES = {
    1: ["CP", "CS", "CC"], // cigarettes: packs, sticks, cartons
    2: ["SB", "SC", "SD", "SF"], // cigars: class B/C/D/F sticks
    3: ["WO", "WN"], // tobacco: ounces, number (cans/packages)
  } as const;

  export const TX_ITEM_TYPE_LABELS: Record<number, string> = {
    1: "Cigarettes",
    2: "Cigars",
    3: "Tobacco",
  };

  export interface TxLedgerRow {
    invoiceId: string | null;
    /** Signed: REVERSAL rows are negative. */
    unitBasisQty: number;
    netSales: number;
  }
  export interface TxInvoiceInfo {
    id: string;
    invoiceNumber: string;
    issueDate: Date;
    customerId: string;
  }
  export interface TxCustomerAddress {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    zip: string;
    isDefault: boolean;
    addressType: string | null;
  }
  export interface TxCustomerInfo {
    id: string;
    businessName: string;
    taxId: string | null;
    tobaccoLicenseNo: string | null;
    /** CustomerAuthorization.licenseNumber for THIS tracked category, when present. */
    authLicenseNumber: string | null;
    addresses: TxCustomerAddress[];
  }
  export interface TxCategoryConfig {
    id: string;
    name: string;
    wholesalerLicenseNo: string | null;
    txItemType: number | null;
    txUom: string | null;
  }

  /** Digits only — IDs are emitted as stored, never padded or invented. */
  export function digitsOnly(v: string | null | undefined): string;
  /** default+BILLING -> any BILLING -> any default -> first -> null. */
  export function pickReportAddress(addresses: TxCustomerAddress[]): TxCustomerAddress | null;

  export function buildTxReport(input: {
    category: TxCategoryConfig;
    ledgerRows: TxLedgerRow[];
    invoicesById: Map<string, TxInvoiceInfo>;
    customersById: Map<string, TxCustomerInfo>;
    from: string;
    to: string;
  }): RegulatedReport;
  ```

  The 12 columns, in spec order (labels for the preview; the CSV emits no header row):
  `Wholesaler Permit #`, `Retailer Taxpayer ID`, `Retailer Name`, `Retailer Street Address`,
  `Retailer City`, `State`, `ZIP`, `Retailer Permit #`, `Item Type`, `Unit of Measure`,
  `Quantity` (right), `Invoice Amount` (right).

  `dto/report-query.dto.ts`:

  ```ts
  import { IsOptional, IsString, IsNotEmpty, Matches, MaxLength } from "class-validator";

  export class ReportQueryDto {
    @IsString()
    @IsNotEmpty()
    category!: string;

    /** Inclusive start date. */
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be YYYY-MM-DD" })
    from!: string;

    /** Inclusive end date — the server queries soldAt < to + 1 day. */
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be YYYY-MM-DD" })
    to!: string;

    /** Defaults to the category's configured reportTemplate. */
    @IsOptional()
    @IsString()
    @MaxLength(40)
    template?: string;
  }
  ```

  **Specs.** `tx-report.spec.ts` — two ledger rows on one invoice collapse to one report row;
  SALE + partial REVERSAL nets (300 − 60 → 240); a fully reversed invoice is dropped; negative net
  emits a row plus `NEGATIVE_NET_INVOICE`; `1873.49 → "1873"` and `1873.50 → "1874"`; a fractional
  quantity rounds and warns; a 60-char business name truncates to 50 and a 35-char city to 30;
  `"tx"` → `"TX"`; `"78701-1234"` → `"78701"`; `"3-20123456-78"` → `"32012345678"` with no warning
  while a 9-digit taxpayer ID emits `INVALID_TAXPAYER_ID` and is still written as stored; the
  retailer-license fallback chain; missing category config emits each `MISSING_*` warning exactly
  once while still emitting rows; null-`invoiceId` rows are excluded with a counted
  `UNLINKED_LEDGER_ROWS`; rows sort by issue date then invoice number; and the serialized CSV has
  **no header line**, quotes a comma-containing name, and carries no totals or disclosure lines.
  Use `acme`-style placeholder retailers and invented license numbers only.
  `regulated-report.service.spec.ts` (mock Prisma, follow `regulated-filing.service.spec.ts`) —
  400 on `from > to`, on a non-date string, and on a span over 366 days; template falls back to the
  category's; an unknown template takes the GENERIC aggregate path; `pickReportAddress` precedence;
  and the findMany mock is asserted to receive `gte`/`lt` (half-open, so the final day is included).
  `report-csv.spec.ts` — the four section toggles.
  Extend `regulated-filing.service.spec.ts` — a TX-templated category stores a TX-serialized CSV
  (no header) and `rows` Json carrying `txRows` + `warnings`, while the Decimal totals stay ledger
  aggregates.

---

### WP12 — Regulated reports web UI

- **files:** `apps/web/components/RegulatedReportPanel.tsx`, `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx`, `apps/web/lib/api/tracked-categories.ts`, `apps/web/components/CategoryFormModal.tsx`, `apps/web/lib/regulated-format.ts`
- **brief:** Consumes WP11's endpoints.

  `lib/api/tracked-categories.ts`: add `RegulatedReportWarning` / `RegulatedReportPreview` types
  mirroring WP11's `RegulatedReport`, a `useRegulatedReportPreview(params | null)` query
  (`GET /regulated/reports/preview`, key `["regulated","report", params]`, `enabled: !!params` so
  nothing fires until the operator clicks Preview), and
  `fetchRegulatedReportCsv(params): Promise<Blob>` (`responseType: "blob"`). Add
  `wholesalerLicenseNo` / `txItemType` / `txUom` to the `TrackedCategory` type and its input type.

  `lib/regulated-format.ts`: add `presetRange(preset, today): { from, to }` for
  `last-month` (default) / `this-month` / `last-quarter` / `year-to-date`, all UTC, returning
  inclusive `YYYY-MM-DD` — sibling of the existing `lastCompletedPeriod`.

  `components/RegulatedReportPanel.tsx` (new), mounted as a `Card` titled "Reports" in
  `compliance/[categoryId]/page.tsx` **above** the existing filings card (leave the existing
  "Prepare filing" flow alone — it is the compliance archive): a preset `<select>` plus two
  `<input type="date">` that populate from the preset and unlock on "Custom"; a template `<select>`
  (category default, `TX_COMPTROLLER`, `GENERIC`, `CA_CDTFA`, `CA_ABC`, `CALRECYCLE`); a **Preview**
  button; an amber warnings banner (collapsible past five) rendering each `message`; the preview
  table built from `columns` + `rows` (right-align columns marked `align: "right"`) with
  `totalsRow` / `displayTotals` in the footer and an empty state ("No regulated sales in this
  range."); and a **Download CSV** button that fetches the blob and triggers a programmatic
  `<a download>` — follow the blob-download pattern already used in
  `apps/web/app/(dashboard)/invoices/new/page.tsx` (create object URL, click, revoke). Never use a
  bare `window.open` on an API URL here: the CSV endpoint needs the auth header.

  `components/CategoryFormModal.tsx`: append `"TX_COMPTROLLER"` to `TEMPLATES`, and when it is
  selected show a "TX Comptroller" fieldset — wholesaler license text input (helper: "Your 8-digit
  Texas license or permit number"), item-type `<select>` (1 Cigarettes / 2 Cigars / 3 Tobacco), and
  a unit-of-measure `<select>` whose options are filtered by the chosen item type. Thread the three
  fields through form state, hydration, and the save payload.

---

### WP13 — Regulated reports mobile UI

- **files:** `apps/mobile/components/RegulatedReportSection.tsx`, `apps/mobile/app/(operator)/compliance/[id].tsx`, `apps/mobile/lib/api/regulated.ts`, `apps/mobile/lib/share-pdf.ts`, `apps/mobile/components/RegulatedCategoryForm.tsx`
- **brief:** Mobile mirror of WP12 — the user asked for parity on both apps.

  `lib/api/regulated.ts`: add `useRegulatedReportPreview` (dash-style key
  `["regulated-report", params ?? {}]`, matching this file's existing key convention) and
  `fetchRegulatedReportCsvText(params): Promise<string>` (`responseType: "text"` — we share the
  server's exact bytes rather than a URL, because the CSV endpoint needs an auth header the OS
  share sheet cannot send). Mirror WP12's types.

  `lib/share-pdf.ts`: add `shareCsvText({ csv, filename, dialogTitle })` — the text sibling of the
  existing `shareCsv` (which downloads from a URL). Native: `FileSystem.writeAsStringAsync` into
  `cacheDirectory` then `Sharing.shareAsync(uri, { mimeType: "text/csv", UTI:
"public.comma-separated-values-text" })`. Web: a Blob + object URL download. Leave `sharePdf` and
  `shareCsv` untouched.

  `components/RegulatedReportSection.tsx` (new), mounted in `compliance/[id].tsx` between the
  prepare row and the filings list: preset chips (Last month default / This month / Last quarter /
  YTD) plus two `YYYY-MM-DD` text inputs for Custom (this app has no date-picker dependency —
  validate the format rather than adding one); a template picker sheet reusing the `PickerOption`
  pattern from `RegulatedCategoryForm.tsx`; a warnings banner; the preview rendered as **one card
  per row** (retailer name, permit, quantity × UOM, invoice amount) plus a totals card — a
  twelve-column table is unusable at 375 px, so aim for information parity, not layout parity; and
  a "Share CSV" action calling `shareCsvText`.

  `components/RegulatedCategoryForm.tsx`: append `"TX_COMPTROLLER"` to its `TEMPLATES` list and add
  the same three conditional TX fields (license input, item-type picker, UOM picker filtered by
  item type).

---

### WP14 — Customers web: regulated filter, remove "Account Email", document viewer

- **files:** `apps/web/app/(dashboard)/customers/page.tsx`, `apps/web/app/(dashboard)/customers/[id]/page.tsx`, `apps/web/lib/formatting.ts`, `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx`
- **brief:** Three user-visible fixes on the web customer surfaces.

  **(a) Remove the "Account Email" row.** Customers with no email address get a non-routable
  sentinel minted onto their `User` record (`no-email+<uuid>@placeholder.local`) because
  `User.email` is required and unique per tenant; `Customer.email` stays null so nothing
  customer-facing shows it. The customer detail page nonetheless renders an unconditional
  `InfoRow label="Account Email" value={customer.user?.email}` — which is exactly where the
  reported gibberish comes from. **Delete that row** (the real `Customer.email` row above it stays).

  A second, separate sentinel exists for CSV-imported customers (`<username>@imported.local`), and
  the list page's Email column filters only _that_ one — so the placeholder sentinel leaks there
  too. Add a shared helper to `apps/web/lib/formatting.ts` and use it in both the list column and
  the edit-form prefill (which today checks only `@placeholder.local`):

  ```ts
  /**
   * True for the internal, non-routable email sentinels we mint when a customer has no address:
   * `no-email+<uuid>@placeholder.local` (User.email is required + unique per tenant) and
   * `<username>@imported.local` (CSV import). Never render one of these to a user.
   */
  export function isInternalEmail(email?: string | null): boolean {
    if (!email) return false;
    const e = email.toLowerCase();
    return e.endsWith("@placeholder.local") || e.endsWith("@imported.local");
  }
  ```

  **(b) "Regulated" filter on the customers list.** Add a filter chip next to the existing status
  chips, URL-synced through the page's existing `useUrlFilters` pattern, passing `regulated: "1"` to
  `useCustomers` (the API side is WP15). When a row's payload reports regulated authorizations, show
  a small shield badge next to the business name.

  **(c) Document viewer.** The detail page's `DocumentViewer` modal already renders PDFs in an
  `<iframe src={doc.url}>` — the reason nothing appears today is a server header, fixed in WP15.
  Here: verify the PDF branch is reachable, and route the **tax-exempt document lightbox** (which
  is image-only today) through the same `DocumentViewer` so a tax-exempt PDF is viewable too.

---

### WP15 — Customers API + uploads inline PDFs + mobile customer surfaces

- **files:** `apps/api/src/uploads/uploads.controller.ts`, `apps/api/src/customers/dto/list-customers.dto.ts`, `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/customers.service.spec.ts`, `apps/mobile/lib/api/customers.ts`, `apps/mobile/app/(operator)/customers/index.tsx`, `apps/mobile/app/(operator)/customers/[id]/documents.tsx`
- **brief:** Three changes.

  **(a) Serve PDFs inline.** `uploads.controller.ts` sets `Content-Disposition: attachment` for
  everything except three raster image types, so a customer's PDF downloads instead of rendering in
  the web app's existing iframe viewer. Add `"application/pdf"` to `RENDERABLE_INLINE_MIMES`. Update
  the comment above it to record why this is safe: uploads are MIME-allowlisted at the customer
  document endpoint (jpeg/png/webp/pdf only), the browser PDF viewer is sandboxed, and `nosniff`
  plus the signed-URL gate are unchanged. **Do not** widen it to any other type — the SVG/HTML
  exclusion is a deliberate XSS control.

  **(b) "Sells regulated items" filter.** `CustomerAuthorization` already links a customer to a
  `TrackedCategory` (that is what the customer-detail "Licenses" tab manages), so no new model is
  needed. Add `regulated?: string` to `ListCustomersDto` and, in `customers.service.findAll`, apply
  it exactly like the existing `tag` relation filter:

  ```ts
  // Customers authorized to sell regulated items — i.e. holding at least one authorization
  // against a license-requiring tracked category. Mirrors the `tag` relation filter above.
  if (query.regulated === "1") {
    where.authorizations = { some: { trackedCategory: { requiresLicense: true } } };
  }
  ```

  Also expose a per-row count so the UI can badge it — add a filtered
  `_count: { select: { authorizations: { where: { trackedCategory: { requiresLicense: true } } } } }`
  to the existing `findMany` include (or an equivalent lightweight projection), and surface it as
  `regulatedCount`. Add a `customers.service.spec.ts` case asserting the where-clause shape.

  **(c) Mobile customer surfaces.** `app/(operator)/customers/index.tsx` has search only today —
  add a `FilterChipRow` with All / Regulated passing the same `regulated` param through
  `useAdminCustomers`. And add the missing documents surface: hooks in `lib/api/customers.ts` for
  `GET /customers/:id/documents` (list; the server returns a freshly presigned `url` per document
  on every list call) and `DELETE /customers/:id/documents/:docId`, plus a new
  `app/(operator)/customers/[id]/documents.tsx` screen listing name / type / size / date, reachable
  from the customer detail. Tapping a document **views it in-app**: on native use
  `expo-web-browser`'s `openBrowserAsync(doc.url)` (an in-app browser sheet — the presigned URL
  carries its own auth, so no header is needed), and on web open the URL in a modal iframe. Keep a
  secondary Share action using the existing `sharePdf`. Upload is **out of scope** for this package
  — view, share, and delete only.

---

## Acceptance criteria

1. `useUpdateOrderShipment` in `apps/web/lib/api/orders.ts` contains **no** `setQueryData` call and
   invalidates both `["orders"]` and `["orders", id]`.
2. `apps/web/app/(dashboard)/error.tsx` exists, is a Client Component (`"use client"`), and renders
   a retry control wired to the `reset` prop.
3. `cascadeTierPrices` and `perUnitPrice` exist with **identical bodies** in the API, web, and
   mobile copies described in WP2, and the new spec cases in `apps/api/src/utils/pricing.spec.ts`,
   `apps/api/src/common/pricing.spec.ts`, and `apps/mobile/__tests__/pricing.test.ts` all pass.
4. `cascadeTierPrices("pricePerUnit", n)` returns `{}` — Tier 1 is never cascaded by the helper, and
   the `pricePerUnit` branch of `handleQuickSave` in `products/page.tsx` is unchanged.
5. `DecimalInput` accepts an optional `onCommit` that fires on blur/Enter **only when the value
   changed since focus**, and never fires when the field is left empty or invalid. A
   caller-supplied `onKeyDown` is still invoked.
6. The web product detail page has a "Units per case" InfoRow (view + edit) that PATCHes
   `unitsPerBox`, and renders a per-unit hint under tier prices when `unitsPerBox > 1` using
   `perUnitPrice`.
7. No raw `unitPrice / unitsPerBox` division remains in `CreateOrderModal.tsx` or
   `invoices/new/page.tsx`; both use `perUnitPrice`.
8. Case-packed lines in `CreateOrderModal.tsx`, `invoices/new/page.tsx`, mobile `NewOrderScreen.tsx`
   and mobile `edit-items.tsx` offer a Case/Unit toggle; Unit mode has **no maximum** on the unit
   count and routes through `normalizeBoxesPieces` (web) / `setLineUnits` (mobile).
9. `sellBy` appears in **no** request payload anywhere in the diff, and the order/invoice submit
   blocks still send `{qty, boxes, pieces}` plus a per-selling-unit `unitPrice`.
10. `apps/mobile/lib/product-form.ts` carries `priceTier2..priceTier5` through
    `emptyProductForm`, `productFormFromValues`, and `buildProductPayload`, and mobile
    `ProductForm.tsx` renders four tier inputs whose cascade fires on end-editing, not per keystroke.
11. `CreateCreditNoteDto` exists, the controller uses it, and its spec proves a payload containing
    `issueDate` and `notes` **validates successfully** (no 400).
12. The web credit-note create modal uses a debounced server-side customer search (no undebounced
    query key), passes a `limit`, and its invoice list is fetched with `customerId` server-side with
    no open-status restriction.
13. `useCreateCreditNote` exists in `apps/mobile/lib/api/credit-notes.ts`,
    `app/(operator)/credit-notes/new.tsx` exists, and the list screen has a "New" action.
14. `CreditNotePicker.tsx` returns null only when `customerId` is falsy, and offers an inline
    create that selects the new credit from the **create response** without waiting for a refetch.
    The mobile apply-credit sections are likewise gated on `customerId` alone.
15. `returns.service.receive` accepts APPROVED **and** IN_TRANSIT in both its guard and its atomic
    claim; with `{restock:false}` it performs no stock movement, persists `restock:false` on the
    return's items, and still calls `reverseReturnEntries`.
16. `returns.service.processRefund` writes `refundMethod`/`refundAmount`/`refundedAt` inside the
    existing `RECEIVED → REFUNDED` `updateMany` claim (not a second write), and the
    `EXTERNAL_REFUND` path never calls `creditNotes.create`.
17. `handleConvertToCreditNote` and its "Issue Credit Note" button no longer exist in
    `apps/web/app/(dashboard)/returns/[id]/page.tsx`; the resolve modal offers both methods and
    contains no restock checkbox.
18. `apps/api/src/regulated/filing-csv.spec.ts` passes **with no edits to that file**.
19. `GET /regulated/reports/preview` and `GET /regulated/reports/csv` exist, are declared above the
    `filings/:id` routes, validate `from`/`to` as `YYYY-MM-DD` with `from <= to` and a ≤366-day
    span, and query the ledger with `gte`/`lt` (so the final day of the range is included).
20. `buildTxReport` emits exactly the 12 spec fields per row in order, nets REVERSAL rows by
    invoice, rounds quantity and amount to whole numbers, truncates to 50/50/30/2/5, never pads an
    ID, and serializes with **no CSV header row**. All `tx-report.spec.ts` cases pass.
21. The web compliance category page and the mobile compliance detail screen both offer a date
    range, a template choice including TX Comptroller, an **in-app preview rendered before any
    download**, and a separate CSV download/share action.
22. `RENDERABLE_INLINE_MIMES` in `uploads.controller.ts` contains `application/pdf` and nothing
    else new.
23. `ListCustomersDto` accepts `regulated`, `customers.service.findAll` applies
    `where.authorizations = { some: { trackedCategory: { requiresLicense: true } } }` for it, and
    both the web and mobile customer lists expose the filter.
24. No `InfoRow` labelled "Account Email" remains anywhere in `apps/web`, `isInternalEmail` exists
    in `apps/web/lib/formatting.ts`, and both the customers list Email column and the customer form
    prefill use it.
25. No real client tenant, business name, or license number appears in any new code, comment,
    fixture, or test.
26. No new file references `this.prisma.<model>` directly for tenant-scoped data — all new queries
    go through `forTenant()`.

## Verification commands

Run from the repo root, in this order:

1. `npx prisma generate --schema apps/api/prisma/schema.prisma`
2. `npm run check-types`
3. `npm run lint`
4. `npm run test`

(`npm run verify` is the same as commands 2–4 in one turbo invocation; run them separately for
clearer failure attribution. Command 1 is mandatory whenever `schema.prisma` changes — without it
typecheck fails with phantom "does not exist in type" errors on the new columns. Playwright
`npm run test:e2e` needs a running stack and is **not** part of this gate.)

## Risks & rollback

- **Money paths.** The highest-risk surface is WP4/WP6. `perUnitPrice` and the Case/Unit toggle are
  display and entry only: reviewers should confirm the diff contains no new arithmetic in a
  submit payload, that `sellBy` never leaves the client, and that every line subtotal still comes
  from `computeLineSubtotal`. Any per-unit number written to an order/invoice line is a bug.
- **Rollout 400s.** If `CreateCreditNoteDto` or `ProcessRefundDto` drops its deprecated fields, the
  currently deployed web bundle starts failing the moment the API deploys, before the new bundle is
  live. The specs for those fields are the guard.
- **Double-mint.** WP9 and WP10 must land together: WP10 removes the rogue direct-POST credit path
  and WP9 owns the choice. Landing WP10 alone would remove a button; landing WP9 alone leaves the
  hazard in place.
- **Byte-identity of existing filings.** The WP11 refactor touches code that produces regulatory
  artifacts. `filing-csv.spec.ts` must pass unmodified; a reviewer editing that spec to make the
  build green would be defeating its purpose.
- **Stale Prisma client.** A missing `prisma generate` after WP0 surfaces as confusing type errors
  in unrelated packages. That is why it is verification step 1.
- **Rollback.** Every package is independently revertible. The two migrations are additive and
  nullable, so reverting the code leaves harmless unused columns — no down-migration is needed and
  none should be written.
