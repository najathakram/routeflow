# Plan: Zelle payment method + customer price-tier discoverability

> Authored by Fable 5 on 2026-08-21. Status: SHIPPED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Two small, independent wholesale-client requests:

1. **Zelle** must be selectable wherever a payment is recorded. The Prisma
   `PaymentMethod` enum, the migration, the shared web/mobile constants files, and
   `packages/types` are **already done** (see "Already done" below). What remains is
   repointing ~14 hand-rolled payment-method lists at the new shared constants so Zelle
   appears everywhere at once — and so the _next_ method is a one-line change.
2. **Customer price tier** is an existing, working feature (`Customer.pricingTier`, 1–5)
   that operators cannot find: the customer profile's "Product Tier Overrides" area only
   offers _per-product_ overrides, while the customer-wide tier select is buried in a
   sidebar block far below. Surface it where operators look.

## Already done (do NOT redo, do NOT modify)

These are committed on the branch already. Treat them as fixed API:

- `apps/api/prisma/schema.prisma` — `enum PaymentMethod` now ends with `ZELLE`.
- `apps/api/prisma/migrations/20260830000000_payment_method_zelle/migration.sql`.
- `packages/types/index.ts` — `PaymentMethod` enum backfilled to all 8 values.
- **`apps/web/lib/payment-methods.ts`** (new) exports:
  - `SELECTABLE_PAYMENT_METHODS` — readonly tuple
    `["CASH","CHECK","ZELLE","ACH","CREDIT_CARD","OTHER"]`
  - `SelectablePaymentMethod`, `ALL_PAYMENT_METHODS`, `AnyPaymentMethod` (adds
    `CREDIT_NOTE`, `ADVANCE`)
  - `PAYMENT_METHOD_LABELS` (e.g. `ACH: "ACH / Bank Transfer"`, `ZELLE: "Zelle"`),
    `PAYMENT_METHOD_COLORS` (Tailwind classes; `ZELLE: "bg-violet-50 text-violet-700"`),
    `paymentMethodLabel(method: string): string`
- **`apps/mobile/lib/payment-methods.ts`** (new) exports the same
  `SELECTABLE_PAYMENT_METHODS` / `PAYMENT_METHOD_LABELS` / `paymentMethodLabel`, plus
  **`SELECTABLE_METHOD_OPTIONS`** = `{ id, label }[]` ready for mobile chip rows.

Rationale for the ordering `CASH, CHECK, ZELLE, ACH, CREDIT_CARD, OTHER`: Zelle sits with
the other bank-ish instruments and ahead of ACH because these wholesalers use it more.

## Constraints & conventions

- npm + Turbo monorepo: NestJS API (`apps/api`), Next.js 14 App Router web (`apps/web`),
  Expo/React-Native mobile (`apps/mobile`), shared `packages/*`.
- Prettier: semicolons, double quotes, `printWidth` 100, trailing commas. ESLint flat
  config **per workspace** (never run eslint from the repo root).
- **`CREDIT_NOTE` and `ADVANCE` are never user-selectable.** The server rejects them on
  `POST /invoices/:id/payments` ("use the dedicated Apply Credit Note / Apply Advance
  actions"). They must still render correctly in **display/label/filter** contexts. Use
  `SELECTABLE_PAYMENT_METHODS` for pickers and `ALL_PAYMENT_METHODS` for display/filters.
- **Do not change any API DTO.** They validate with `@IsEnum(PaymentMethod)` imported from
  `@prisma/client`, so `ZELLE` already validates server-side. No API work in this plan.
- **Do not change money math.** Nothing here touches pricing/rounding.
- Keep every existing behaviour that is not about the method list: check-lifecycle badges,
  payment images, bank/settled-date fields, credit-note handling, toasts.
- Preserve each call site's existing styling/markup shape. This is a **swap of the data
  source**, not a redesign — replace the literal array/union with the shared constant and
  map over it. Do not restyle selects, chips, or badges.
- TypeScript must stay strict-clean: where a local union type is replaced, use the
  exported types (`SelectablePaymentMethod` / `AnyPaymentMethod`) rather than `string`,
  and keep `as const` where inference needs it.

## Work packages

File lists are DISJOINT. WP1–WP4 may run in parallel.

### WP1 — Web: payment pickers & modals

- **files:**
  `apps/web/app/(dashboard)/invoices/[id]/page.tsx`,
  `apps/web/components/CustomerRecordPaymentModal.tsx`,
  `apps/web/components/RecordSupplierPaymentModal.tsx`
- **effort:** low
- **brief:**
  - `invoices/[id]/page.tsx`: a local union type around **line ~308**
    (`"CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD"`) → `SelectablePaymentMethod`;
    **two** `<select>` option blocks (~L405-409 and ~L632-636) → map over
    `SELECTABLE_PAYMENT_METHODS` rendering `PAYMENT_METHOD_LABELS[m]`; the method→label
    display switch (~L93-118, which also handles CREDIT_NOTE/ADVANCE) → `paymentMethodLabel`.
    Casts at ~L1632 and ~L1688 must still compile.
  - `CustomerRecordPaymentModal.tsx`: option list ~L245-249 → shared constant. Its state is
    typed from `StandalonePaymentDto["method"]` — that type comes from WP4; type the state as
    `SelectablePaymentMethod` and let it flow.
  - `RecordSupplierPaymentModal.tsx`: option list ~L202-206 → shared constant. It imports
    `SupplierPaymentMethod` from `apps/web/lib/api/supplier-payments.ts` (WP4 widens that
    type); keep the import working.
- **exact code** (the option-block shape to use in every web `<select>`):
  ```tsx
  {
    SELECTABLE_PAYMENT_METHODS.map((m) => (
      <option key={m} value={m}>
        {PAYMENT_METHOD_LABELS[m]}
      </option>
    ));
  }
  ```

### WP2 — Web: finance pages (labels, colors, filters)

- **files:**
  `apps/web/app/(dashboard)/finance/payments/page.tsx`,
  `apps/web/app/(dashboard)/finance/reports/page.tsx`,
  `apps/web/app/(dashboard)/bookkeeping/[transactionId]/page.tsx`
- **effort:** low
- **brief:**
  - `finance/payments/page.tsx`: delete the local `METHOD_LABELS` (~L27-35) and
    `METHOD_COLORS` (~L36-44) and import `PAYMENT_METHOD_LABELS` / `PAYMENT_METHOD_COLORS`
    (alias on import if it keeps the diff smaller). Two option blocks: the **picker** at
    ~L276-280 uses `SELECTABLE_PAYMENT_METHODS`; the **filter** at ~L649-655 uses
    `ALL_PAYMENT_METHODS` (filters legitimately include CREDIT_NOTE/ADVANCE). Keep any
    "All methods" placeholder option.
  - `finance/reports/page.tsx`: local state type at ~L1934 is a too-narrow 4-value union
    (missing CREDIT_CARD) → `SelectablePaymentMethod`; options ~L2142-2145 → shared
    constant. **This fixes a pre-existing gap** — CREDIT_CARD becomes selectable here.
    Leave the CREDIT_NOTE badge color logic (~L1910) working; prefer
    `PAYMENT_METHOD_COLORS` if it drops in cleanly, otherwise leave it.
  - `bookkeeping/[transactionId]/page.tsx`: the zod schema at ~L33 is
    `z.enum(["CASH","CHECK","ACH","OTHER"])` → build from the shared tuple; options ~L95-98
    → shared constant. **Also a pre-existing gap fix.**
- **exact code** (zod enum from the readonly tuple — zod needs a mutable-tuple type):
  ```ts
  import { SELECTABLE_PAYMENT_METHODS } from "@/lib/payment-methods";
  // z.enum needs [string, ...string[]]; spread the readonly tuple through a cast.
  method: z.enum([...SELECTABLE_PAYMENT_METHODS] as [string, ...string[]]),
  ```
  If the file uses relative imports rather than `@/`, match the file's existing style.

### WP3 — Mobile: payment screens

- **files:**
  `apps/mobile/app/(operator)/(tabs)/invoices/[id]/record-payment.tsx`,
  `apps/mobile/app/(operator)/(tabs)/invoices/[id]/payments/[paymentId]/edit.tsx`,
  `apps/mobile/components/RecordSupplierPaymentSheet.tsx`,
  `apps/mobile/app/(operator)/payments/record.tsx`
- **effort:** low
- **brief:** each file declares its own `METHODS` array (and some an
  `EditablePaymentMethod` type). Replace each with `SELECTABLE_METHOD_OPTIONS` from
  `apps/mobile/lib/payment-methods.ts` (adjust the relative import depth per file) and type
  state as `SelectablePaymentMethod`.
  - `record-payment.tsx` (~L22-28) currently offers only **CASH/CHECK/ACH** — it gains
    Zelle, Credit card and Other. Keep the explanatory comment above the list about
    Advance/Credit-Note being excluded (it is still accurate and still valuable).
  - `edit.tsx` (~L31-35), `RecordSupplierPaymentSheet.tsx` (~L39-43),
    `payments/record.tsx` (~L33 area) — same swap.
  - Chips render `{ id, label }`; keep each screen's existing chip styling and selected
    state exactly as-is.

### WP4 — Shared client types (web + mobile API layers)

- **files:**
  `apps/web/lib/api/invoices.ts`,
  `apps/web/lib/api/supplier-payments.ts`,
  `apps/mobile/lib/api/invoices.ts`
- **effort:** low
- **brief:** these declare duplicated literal unions that must gain `ZELLE`.
  - `apps/web/lib/api/invoices.ts` — **five** separate declarations:
    `InvoicePayment.method` (~L56, all 8 values incl. CREDIT_NOTE/ADVANCE →
    `AnyPaymentMethod`), `AllPayment.method` (~L179, same → `AnyPaymentMethod`),
    `RecordInvoicePaymentDto.method` (~L477 → `SelectablePaymentMethod`),
    `UpdateInvoicePaymentDto.method` (~L503 → `SelectablePaymentMethod`),
    `StandalonePaymentDto.method` (~L584 → `SelectablePaymentMethod`).
  - `apps/web/lib/api/supplier-payments.ts` — `SupplierPaymentMethod` (~L17): keep the
    exported name (other files import it) and redefine it as
    `export type SupplierPaymentMethod = SelectablePaymentMethod;`.
  - `apps/mobile/lib/api/invoices.ts` — the canonical mobile `PaymentMethod` type (~L30-37,
    7 values): keep the exported name, redefine as
    `export type PaymentMethod = AnyPaymentMethod;`.
  - Keep every export name stable — many files import these.

### WP5 — Customer price-tier discoverability (web)

- **files:** `apps/web/app/(dashboard)/customers/[id]/page.tsx`
- **brief:** The customer-wide tier control already exists but is buried in a sidebar block
  (~L2006-2037: a `<select>` bound to `updateCustomer.mutate({ id, pricingTier })`, gated by
  `isOperator`). **Leave that block exactly as it is.** Add a prominent control at the TOP
  of the Special Prices tab, which today opens straight into "Product Tier Overrides".
  - `SpecialPricesTab` is declared at **L750** as
    `function SpecialPricesTab({ customerId }: { customerId: string })` and is rendered at
    **L3469** as `<SpecialPricesTab customerId={params.id} />`.
  - Inside `SpecialPricesTab`, read the customer with the existing hook
    `useCustomer(customerId)` and mutate with `useUpdateCustomer()` (both from
    `apps/web/lib/api/customers.ts`; the page already imports them — match its import style).
    Do not add new props and do not change the render site.
  - Render, ABOVE the existing "Product Tier Overrides" `<Card>`, a new `<Card>` titled
    **"Default Pricing Tier"** with helper text
    _"Applies to every product for this customer. Per-product overrides below take
    precedence."_ and the 1–5 select (same option labels as the sidebar: `Tier N`, with
    `" (Default)"` appended for tier 1).
  - When `priceList.length > 0`, show a muted note under the select:
    _"N product(s) have a per-product override and will keep their own tier."_ — singular
    "product" when N is 1. This is the anti-confusion requirement: an operator who changes
    the tier must immediately understand why some prices did not move.
  - Gate the select on the same operator check the page already uses (`isOperator`); when
    not an operator, render the tier read-only as the sidebar does.
- **exact code** (the mutation call — must match the existing sidebar behaviour):
  ```tsx
  updateCustomer.mutate({ id: customerId, pricingTier: Number(e.target.value) });
  ```

## Acceptance criteria

1. No file under `apps/web` or `apps/mobile` declares its own literal list of payment
   methods for a picker any more; every picker maps over `SELECTABLE_PAYMENT_METHODS`
   (or `SELECTABLE_METHOD_OPTIONS` on mobile).
2. "Zelle" is offered in **every** payment-recording UI: web invoice detail (both
   selects), web customer payment modal, web supplier payment modal, web finance reports
   record-payment form, web bookkeeping transaction detail, and all four mobile payment
   screens.
3. `CREDIT_NOTE` and `ADVANCE` are **not** offered in any picker, but still render with
   their correct labels/colors in display and filter contexts (notably the
   `finance/payments` method filter and payment-history rows).
4. Two pre-existing gaps are closed: `finance/reports` and `bookkeeping/[transactionId]`
   now offer CREDIT_CARD; mobile `record-payment.tsx` now offers more than CASH/CHECK/ACH.
5. No API DTO, service, controller, or Prisma file is modified by this work.
6. The Special Prices tab of a customer shows a "Default Pricing Tier" card above the
   per-product overrides; changing it persists via `useUpdateCustomer` and, when overrides
   exist, the tab states how many products keep their own tier.
7. The pre-existing sidebar tier select still exists and still works.
8. `npx tsc --noEmit` passes for both `apps/web` and `apps/mobile`; lint passes per
   workspace.

## Verification commands

Run from the repo root:

- `npm run check-types`
- `npm run lint`
- `npm run test`

## Risks & rollback

- **Type churn is the main risk.** `apps/web/lib/api/invoices.ts` and
  `apps/mobile/lib/api/invoices.ts` are imported widely; widening those unions is safe, but
  narrowing a display type to `SelectablePaymentMethod` would break rows that legitimately
  carry `CREDIT_NOTE`/`ADVANCE`. Display types must use `AnyPaymentMethod`.
- The zod `z.enum` cast in WP2 is the one non-obvious line — use the exact code given.
- Mobile relative import depth differs per file; a wrong `../` count fails typecheck loudly.
- Rollback: the branch is `feat/zelle-tier-quickwins`; every change is additive UI/type
  work plus one additive enum value. `git revert` of the implementation commit restores the
  previous lists without touching data (the enum value may stay — it is harmless).
