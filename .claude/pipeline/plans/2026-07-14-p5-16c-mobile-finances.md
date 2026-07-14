# P5-16c — Mobile buyer payments / credits / statement (buyer `(customer)` role)

## Status

PLANNED — 2026-07-14

## Context

**Mobile finances today:** `apps/mobile/app/(customer)/finances.tsx` (234 lines) is analytics-only over `useBuyerAnalytics` (spend tiles, invoice-status bars, monthly-spend bars, recent-payments rows = date·method·amount). NO wallet/credit tile, NO how-to-pay, NO statement download, NO check-status on rows. `invoices/[id].tsx` renders `invoice.payments` with no lifecycle badge / void / NSF treatment.

**Web shipped (mobile mirrors — same endpoints, no new API):**

- P5-12: `apps/web/lib/check-badge.ts` `checkBadgeFor` (CHECK-only; legacy null ⇒ Recorded; voided-not-bounced ⇒ no badge).
- P5-13: `GET /buyer/statement` → `{ outstandingAmount, overdueAmount, availableCredit, advanceBalance, pendingOrdersAmount, transactions[] }` (server-computed; `availableCredit` NEVER recomputed client-side).
- P5-14: `GET /buyer/payments` paginated → `{ data:[{id,invoiceId,invoiceNumber,amount,method,status,checkStatus,nsfFeeAmount,paidAt}], meta:{total,page,limit,totalPages} }` + `GET /buyer/remittance`.
- P5-15: `GET /buyer/statements` → `{ months:["YYYY-MM"] }` (≤12); `GET /buyer/statements/:month` → `{ url }` **presigned** (no JWT — no 401).

**Exact mobile PDF mechanism (REUSE):** `apps/mobile/lib/share-pdf.ts` `sharePdf({ url, filename, dialogTitle })` — the invoice-detail Share PDF button's function (`invoices/[id].tsx`). Native: `expo-file-system downloadAsync` → `expo-sharing shareAsync`; web build: Web Share / `window.open`. The statement URL is presigned, so the bare fetch/downloadAsync inside `sharePdf` needs no auth — the web `fetchPdfBlob` dance is NOT needed on mobile.

**Decision — new screen `(customer)/payments.tsx`** (not a finances extension): finances is already full; web P5-14 is its own page; `(customer)/_layout.tsx` is a bare `<Stack>` so a new file auto-registers. Entry = a More MenuRow + a finances cross-link.

**Flagged facts (verified):**

1. `GET /buyer/invoices/:id` returns RAW Prisma `InvoicePayment` rows (`invoices.service.ts:1345`) — fields `method`(enum)/`status`/`checkStatus`/`nsfFeeAmount`/`paidAt`/`createdAt`/`reference`/`amount`. **Pre-existing bug:** the mobile row renders `fmtPaymentMethod(pmt.paymentMethod)` but the field is `method` → every row shows "Payment". WP3 fixes via `pmt.method ?? pmt.paymentMethod`.
2. Raw rows serialize Decimal as strings → render amounts via `Number(x).toFixed(2)`. `/buyer/payments` amounts are already numbers.
3. Mobile keys are DASH-STYLE singletons (`["buyer-statement"]`), NOT web tuples.
4. No picker dep — month picker is a horizontal chip row (Pressables), ≤12.
5. Mobile `Pill` variants: `brand|green|orange|red|gray|yellow|purple`. Web badge → mobile: neutral→gray, info→brand, success→green, danger→red.
6. Jest: ts-jest, node env, `testMatch **/__tests__/**/*.test.ts`; keep helpers RN-free (type-only imports).
7. **NO money writes, NO recompute** — `availableCredit`/`outstandingAmount`/`amount`/`nsfFeeAmount`/`runningBalance` are server values, formatter-only.

## Acceptance

1. `npm run verify` passes; Jest covers the new pure helpers.
2. `buyer.ts` exports `useBuyerStatement`/`useBuyerPayments`/`useBuyerRemittance`/`useBuyerStatementMonths`/`fetchStatementPdfUrl` (dash keys, shapes mirror web); `BuyerInvoicePayment` widened with `method`/`status`/`checkStatus`/`nsfFeeAmount`/`paidAt`.
3. Invoice detail: CHECK payment rows show the lifecycle Pill; bounced → NSF fee note; VOID → struck amount; method labels no longer all "Payment".
4. New `payments.tsx`: wallet tile (`statement.availableCredit` verbatim) + active-credits list; paginated payment history w/ check badges; how-to-pay card (hide empty, empty state); month-chip picker + Download → `fetchStatementPdfUrl` → `sharePdf` (no 401).
5. More has a "Payments" row; finances cross-links.
6. Zero migrations, zero API changes, zero new deps, zero money recompute.

## Work Packages

### WP1 — mobile buyer.ts finance hooks + widened payment type + socket freshness — EXACT CODE

files:

- `apps/mobile/lib/api/buyer.ts` (edit)
- `apps/mobile/hooks/useBuyerSocket.ts` (edit)

**1a. Replace the `BuyerInvoicePayment` interface with:**

```ts
/** Check lifecycle states (P5-12). Only ever set when method = CHECK. */
export type BuyerCheckStatus = "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED";

/** Raw InvoicePayment row from GET /buyer/invoices/:id (no DTO mapping). Field
 *  is `method`; `paymentMethod` kept only for older cached shapes. Decimal
 *  fields may arrive as strings — render via Number(), never do arithmetic. */
export interface BuyerInvoicePayment {
  id: string;
  amount: number;
  createdAt: string;
  method?: string;
  /** @deprecated the API returns `method` — kept for older cached shapes. */
  paymentMethod?: string;
  reference?: string;
  notes?: string;
  status?: "DRAFT" | "PAID" | "VOID" | string;
  checkStatus?: BuyerCheckStatus | null;
  nsfFeeAmount?: number | string | null;
  paidAt?: string;
}
```

**1b. Insert after `useBuyerAnalytics` (before the Standing-orders banner):**

```ts
// ─── Payments / credits / statement (P5-12/13/14/15 twins — P5-16c) ──────────
// Mobile mirrors of the SHIPPED web hooks. Same endpoints/shapes; dash-style
// keys so useBuyerSocket prefix-invalidation covers them. ALL money figures are
// server values — render verbatim, NEVER recompute.

export interface BuyerStatementTransaction {
  type: "INVOICE" | "CREDIT_NOTE" | "ADVANCE_PAYMENT";
  id: string;
  description: string;
  date: string;
  amount: number;
  /** Server-computed OPEN/remaining amount (CREDIT_NOTE = amount − amountUsed). */
  runningBalance: number;
  status: string;
  expiresAt?: string | null;
}

export interface BuyerStatement {
  outstandingAmount: number;
  overdueAmount: number;
  /** Wallet balance (server Σ roundMoney(amount − amountUsed) over open credits). NEVER re-derive. */
  availableCredit: number;
  advanceBalance: number;
  pendingOrdersAmount: number;
  transactions: BuyerStatementTransaction[];
}

export function useBuyerStatement() {
  return useQuery<BuyerStatement>({
    queryKey: ["buyer-statement"],
    queryFn: () => buyerApiClient.get("/buyer/statement").then((r) => r.data),
    staleTime: 30_000,
  });
}

export interface BuyerPayment {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  method: string;
  status: "DRAFT" | "PAID" | "VOID";
  checkStatus: BuyerCheckStatus | null;
  nsfFeeAmount: number | null;
  paidAt: string;
}
export interface BuyerPaymentsMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function useBuyerPayments(params?: { page?: number; limit?: number }) {
  return useQuery<{ data: BuyerPayment[]; meta: BuyerPaymentsMeta }>({
    queryKey: ["buyer-payments", params],
    queryFn: () => buyerApiClient.get("/buyer/payments", { params }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export interface BuyerRemittance {
  payToName?: string;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  routingNumber?: string;
  achInstructions?: string;
  wireInstructions?: string;
  checkInstructions?: string;
  mailingAddress?: string;
  notes?: string;
}

export function useBuyerRemittance() {
  return useQuery<BuyerRemittance>({
    queryKey: ["buyer-remittance"],
    queryFn: () => buyerApiClient.get("/buyer/remittance").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useBuyerStatementMonths() {
  return useQuery<{ months: string[] }>({
    queryKey: ["buyer-statement-months"],
    queryFn: () => buyerApiClient.get("/buyer/statements").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** Imperative (PDF gen is slow): returns the PRESIGNED URL (no JWT) → hand to
 *  sharePdf(). No 401: only this call is authenticated, the download is not. */
export async function fetchStatementPdfUrl(month: string): Promise<string> {
  const r = await buyerApiClient.get<{ url: string }>(`/buyer/statements/${month}`);
  return r.data.url;
}
```

**1c. In `useBuyerSocket.ts`, extend the `invoice.updated` handler to also `invalidateQueries` `["buyer-payments"]` + `["buyer-statement"]`, and the `creditNote.created` handler to also invalidate `["buyer-statement"]`. Preserve the `inventory.low.stock` handler verbatim (net +3 lines). Exact block in the authored plan.**

### WP2 — mobile check-badge + payments display helpers + tests — EXACT CODE

files:

- `apps/mobile/lib/check-badge.ts` (new)
- `apps/mobile/lib/buyer-payments-logic.ts` (new)
- `apps/mobile/__tests__/check-badge.test.ts` (new)
- `apps/mobile/__tests__/buyer-payments-logic.test.ts` (new)

**2a. `apps/mobile/lib/check-badge.ts`:**

```ts
/**
 * P5-16c (P5-12 twin): CHECK payment lifecycle badge — mobile mirror of
 * apps/web/lib/check-badge.ts. Same decision table; variants mapped to the
 * mobile Pill (neutral→gray, info→brand, success→green, danger→red). RN-free.
 */
export type CheckBadgeVariant = "gray" | "brand" | "green" | "red";
export interface CheckBadge {
  label: string;
  variant: CheckBadgeVariant;
}

export function checkBadgeFor(p: {
  method?: string | null;
  status?: string;
  checkStatus?: "RECORDED" | "DEPOSITED" | "CLEARED" | "BOUNCED" | null;
}): CheckBadge | null {
  if (p.method !== "CHECK") return null;
  if (!p.checkStatus) {
    if (p.status === "VOID") return null;
    return { label: "Recorded", variant: "gray" };
  }
  switch (p.checkStatus) {
    case "RECORDED":
      return { label: "Recorded", variant: "gray" };
    case "DEPOSITED":
      return { label: "Deposited", variant: "brand" };
    case "CLEARED":
      return { label: "Cleared", variant: "green" };
    case "BOUNCED":
      return { label: "Bounced", variant: "red" };
    default:
      return null;
  }
}
```

**2b. `apps/mobile/lib/buyer-payments-logic.ts`:**

```ts
/**
 * Pure display helpers for the buyer Payments screen (P5-16c). Money figures
 * are SERVER values rendered verbatim — nothing here computes an amount; the
 * only logic is filtering + label formatting. RN-free.
 */
import type { BuyerStatementTransaction } from "./api/buyer";

/** "YYYY-MM" → "July 2026", UTC-safe. Malformed → as-is (never "Invalid Date"). */
export function monthLabel(bucket: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(bucket);
  if (!m) return bucket;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return bucket;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "CREDIT_CARD" → "Credit Card"; missing method → "Payment". */
export function formatPaymentMethod(method?: string | null): string {
  if (!method) return "Payment";
  return method
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Open CREDIT_NOTE rows (server remaining > 0) — a filter over server values,
 *  NOT a wallet recompute (the tile shows statement.availableCredit). */
export function activeCreditRows(
  transactions: BuyerStatementTransaction[] | undefined,
): BuyerStatementTransaction[] {
  return (transactions ?? []).filter((t) => t.type === "CREDIT_NOTE" && t.runningBalance > 0.001);
}

/** Render flags for one payment row. */
export function paymentRowFlags(p: {
  status?: string;
  checkStatus?: string | null;
  nsfFeeAmount?: number | string | null;
}): { voided: boolean; showNsfFee: boolean } {
  return {
    voided: p.status === "VOID",
    showNsfFee: p.checkStatus === "BOUNCED" && p.nsfFeeAmount != null,
  };
}
```

**2c/2d. Tests** — `check-badge.test.ts` (non-CHECK→null, each lifecycle→variant incl. BOUNCED+status VOID→red, legacy null→Recorded, voided-not-bounced→null) + `buyer-payments-logic.test.ts` (monthLabel UTC + malformed as-is, formatPaymentMethod incl. ACH→"Ach" + missing→"Payment", activeCreditRows keeps only CREDIT_NOTE runningBalance>0.001, paymentRowFlags void+NSF combos). Full bodies as authored.

### WP3 — invoice-detail check badges — BRIEF (anchors)

files:

- `apps/mobile/app/(customer)/invoices/[id].tsx` (edit)

brief: import `checkBadgeFor` + `formatPaymentMethod`/`paymentRowFlags`; delete the local `fmtPaymentMethod`; in the `invoice.payments.map` block compute `const method = pmt.method ?? pmt.paymentMethod; const badge = checkBadgeFor({method, status:pmt.status, checkStatus:pmt.checkStatus}); const flags = paymentRowFlags(pmt);`. Render `formatPaymentMethod(method)` (fixes the "Payment" bug) + a `<Pill variant={badge.variant} small>{badge.label}</Pill>` when non-null; when `flags.showNsfFee` a red `+ ${Number(pmt.nsfFeeAmount).toFixed(2)} NSF fee` note; date `fmtDate(pmt.paidAt ?? pmt.createdAt)`; struck red amount when `flags.voided`. Add `nsfNote`/`voidAmount` styles. Touch ONLY the Payments card + imports + styles; NO arithmetic on amounts.

### WP4 — mobile payments/wallet/how-to-pay/statement screen + nav — BRIEF (anchors)

files:

- `apps/mobile/app/(customer)/payments.tsx` (new)
- `apps/mobile/app/(customer)/(tabs)/more.tsx` (edit)
- `apps/mobile/app/(customer)/finances.tsx` (edit — cross-link)

brief: new `payments.tsx` mirroring web `payments/page.tsx` in RN (finances.tsx = styling template): SafeAreaView + NavBar "Payments"; gate load/error ONLY on `useBuyerPayments`; `useBuyerStatement`/`useBuyerRemittance`/`useBuyerStatementMonths` independent. Sections: (1) wallet tiles — Store credit = `money(statement?.availableCredit)` **verbatim** + Outstanding, `credits = activeCreditRows(statement?.transactions)`; (2) active-credits card when `credits.length>0` (description + date/expiry + green `money(runningBalance)`); (3) monthly-statement card — empty state when no months, else horizontal month chips (`monthLabel`, selected = brandWash) + Download `Pressable` → `handleDownload`: `fetchStatementPdfUrl(selectedMonth)` → `sharePdf({url, filename:`statement-${month}.pdf`, dialogTitle})` (toast on error, spinner while downloading — presigned, no 401); (4) payment-history card — rows (invoice # + `formatPaymentMethod(p.method)` + `checkBadgeFor` Pill + NSF note when `paymentRowFlags(p).showNsfFee`; `money(p.amount)` struck-red when voided; tap → invoice detail) + Prev/Next pagination when `meta.totalPages>1`; (5) how-to-pay card — a `Field({label,value})` returning null for blanks, ten fields in web order, card empty state when all blank. Money guardrail: only `money(x)`/`Number(x).toFixed(2)` — no sums. Nav: a More "Payments" MenuRow (`card-outline`) → `router.push("/(customer)/payments")` + change Finances subtitle to "Spend & invoice status"; a finances cross-link row "All payments & statements". Full RN brief (anchors) as authored.

### WP5 — code-map (mobile.md)

files:

- `.claude/code-map/mobile.md` (edit)

brief: add `payments.tsx` (wallet verbatim + paginated history w/ check badges + how-to-pay + statement chips → sharePdf) to the `(customer)` section; note `invoices/[id].tsx` now shows check badges + NSF note + VOID strike + the method-field fix; catalogue the new hooks (`useBuyerStatement`/`useBuyerPayments`/`useBuyerRemittance`/`useBuyerStatementMonths`/`fetchStatementPdfUrl`) + widened `BuyerInvoicePayment` + pure helpers `lib/check-badge.ts`/`lib/buyer-payments-logic.ts` + tests + the useBuyerSocket invalidations.

## Verify

`npm run verify`. Mobile can't be device-verified — gate = tsc + lint + the two new Jest suites + review.

### Critical Files

- apps/mobile/lib/api/buyer.ts
- apps/mobile/app/(customer)/invoices/[id].tsx
- apps/mobile/app/(customer)/(tabs)/more.tsx
- apps/web/app/buyer/portal/[seller]/payments/page.tsx (read-only ref)
- apps/mobile/lib/share-pdf.ts (read-only — reuse sharePdf as-is)
