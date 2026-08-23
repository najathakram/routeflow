# Plan: invoice dates & terms bugfix (client-blocking)

> Status: IMPLEMENTED (2026-08-23, autopilot run 1 — gate green: check-types, lint, 2613 api + mobile tests) · Authored 2026-08-23 from the verified 2026-08-22 recon. This file is the ONLY
> context implementers receive. Root causes below are CONFIRMED by direct code reading — do not
> re-investigate, implement.

## ⚠️ WORKTREE — read before anything else

ALL work happens in the git worktree:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-terms-dates
```

Your process may start in `C:\ClaudeCode\routeflow` (the main checkout) — you must NOT touch files
there. `cd` into the worktree before ANY command (git, npm, node), and use ABSOLUTE paths under the
worktree for every file read/edit. Every relative path in this plan is relative to the worktree
root. Branch is already `fix/invoice-dates-terms`; do not commit, stage, or push — the orchestrator
handles git.

## Objective

A live wholesale client cannot issue correct invoices. Two confirmed defects:

1. **Every invoice calendar date renders one day early** for US-timezone viewers.
2. **The "New sale" flow silently discards the operator's chosen Terms and Due Date** — the saved
   invoice gets tenant-default +30 days, while the "Terms:" label can say something else entirely
   ("Net 60" label with a +30 due date).

## Confirmed root causes (do not re-derive)

**Defect 1:** `Invoice.issueDate`/`dueDate` are stored CORRECTLY as UTC-midnight instants. The day
is lost only at display, wherever code does `new Date(iso).toLocaleDateString(...)` (or equivalent
local-time formatting) without `timeZone: "UTC"`. UTC midnight of day D formats as D−1 in any
negative-UTC-offset zone.

**Defect 2:** web `apps/web/app/(dashboard)/invoices/new/page.tsx` `handleSubmitSale` (~L1190-1201)
posts only `customerId, items, deliveredNow, notes, discountAmount, orderDate, send`. The on-screen
Terms dropdown (`terms` state, ~L669) and auto-computed Due Date (`dueDate` state, ~L671, maintained
by `handleTermsChange`/`handleIssueDateChange` ~L741-761) are never sent. `CreateSaleDto`
(`apps/api/src/orders/dto/create-sale.dto.ts`) has no such fields. `OrdersService.createSale`
(`apps/api/src/orders/orders.service.ts` ~L2009) calls
`invoicesService.createInvoiceFromOrder(order.id)` bare. That method
(`apps/api/src/invoices/invoices.service.ts` ~L376-471) derives dueDate from
`resolveDefaultTerms()` (~L85-89: SystemConfig `invoice.defaultTerms` → `TERM_DAYS` → days,
default 30) and the persisted `terms` label from `resolveTenantInvoiceDefaults()` (~L91-103:
TenantConfig free-text T&C) — two INDEPENDENT sources, hence label/arithmetic disagreement. The
same duplicated logic exists in `createInvoiceFromOrderWithTenant` (~L1796-1878, fire-and-forget
auto-invoice-on-delivery) and `createPartialFromOrder` (~L1904+, see ~L1978/1987). Mobile sale mode
(`apps/mobile/app/(operator)/(tabs)/invoices/new.tsx` ~L1161-1170) has the identical omission.

**Constraint:** do NOT store the "Net 30"-style label into `Invoice.terms` — that column is the
long-form Terms & Conditions text; the comment at `invoices/new/page.tsx` ~L992-1004 documents the
bug that caused last time. Persisting a structured label is a SEPARATE later task with a migration.
This task fixes the DUE DATE and the display; it adds NO schema change and NO migration.

## Work packages

### WP1 — UTC-safe date formatter, web (files: `apps/web/lib/formatting.ts`, `apps/web/lib/formatting.spec.ts` [new], `apps/web/app/buyer/portal/[seller]/invoices/page.tsx`, `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx`)

In `apps/web/lib/formatting.ts`, make the calendar-date formatter timezone-proof. The tricky part,
exactly:

```ts
/**
 * Format a calendar date (an ISO string whose meaningful part is YYYY-MM-DD,
 * stored at UTC midnight) WITHOUT timezone shifting. new Date(iso) +
 * toLocaleDateString() renders UTC midnight as the PREVIOUS day for any
 * negative-UTC-offset viewer — so we format the UTC components directly.
 */
export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
```

Preserve the function's existing name, signature and output STYLE (read the current implementation
first and keep its formatting options — only add `timeZone: "UTC"` semantics; if the current one
takes an options argument or returns a different shape, keep that contract). Then check the two
buyer-portal invoice pages: if they have their own local date-format helpers, route them through
this shared `fmtDate` (import from `@/lib/formatting`); if they already use `fmtDate`, no edit
needed. Add `apps/web/lib/formatting.spec.ts`? — NO: web has no Jest runner (tests are Playwright).
Instead do not add a web spec; the API-side spec in WP2 covers the algorithm. Delete the file from
this package's list if you created it.

Sweep scope for THIS package: only `apps/web/lib/formatting.ts` and the two buyer portal invoice
pages. (The dashboard invoice pages consume `fmtDate` and are fixed transitively.) Additionally
grep `apps/web` for `toLocaleDateString(` — for any OTHER occurrence that formats an
invoice/order/bill/estimate **calendar date** (not a created-at timestamp), fix it by importing
`fmtDate` or adding `timeZone: "UTC"`. List every file you touched in your report.

### WP2 — UTC-safe dates, API render surfaces (files: `apps/api/src/invoices/invoice-pdf-template.tsx`, `apps/api/src/messaging/messaging.helpers.ts`, `apps/api/src/messaging/messaging.helpers.spec.ts`)

Same defect, server-rendered surfaces (PDF + email/notification text). Fix the date formatter in
`messaging.helpers.ts` (`formatDate`) and any local date formatting inside
`invoice-pdf-template.tsx` to format the UTC calendar components (same approach as WP1's snippet —
`timeZone: "UTC"` in `toLocaleDateString`, or manual UTC-component formatting; match the existing
output style exactly, e.g. if it prints `MM/DD/YYYY` keep that).

Extend (or create) `apps/api/src/messaging/messaging.helpers.spec.ts` with the regression spec —
this is the executable proof for the whole batch:

```ts
it("formats a UTC-midnight instant as the SAME calendar day in any timezone", () => {
  // 2026-08-04T00:00:00.000Z must render as Aug 4 REGARDLESS of process TZ.
  expect(formatDate(new Date("2026-08-04T00:00:00.000Z"))).toContain("4");
  expect(formatDate(new Date("2026-08-04T00:00:00.000Z"))).not.toContain("3");
});
```

(Adapt the assertions to the helper's real output format — assert the day-of-month is 4, and that
it is not 3.)

### WP3 — UTC-safe dates, mobile (files: `apps/mobile/app/(operator)/(tabs)/invoices/index.tsx`, `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`, `apps/mobile/app/(customer)/(tabs)/invoices.tsx`, `apps/mobile/app/(customer)/invoices/[id].tsx`, `apps/mobile/app/(operator)/recurring-invoices/index.tsx`, `apps/mobile/app/(operator)/recurring-invoices/[id].tsx`, `apps/mobile/app/(operator)/vendor-bills/scan.tsx`, `apps/mobile/lib/format-date.ts`)

Create ONE shared helper `apps/mobile/lib/format-date.ts` exporting `fmtCalendarDate(iso)` using the
WP1 snippet's approach (React Native's Hermes supports `toLocaleDateString` with `timeZone`; if the
existing screens hand-format with `getMonth()`/`getDate()`, replace with UTC getters
`getUTCMonth()`/`getUTCDate()`/`getUTCFullYear()` inside the helper instead — match each screen's
existing display style; where styles differ per screen, give the helper an options or style
parameter rather than changing what users see). Then replace the local date formatting of
invoice/bill calendar dates in each listed screen with the helper. Also grep `apps/mobile/app` and
`apps/mobile/components` for `toLocaleDateString(` and fix any other invoice/order/bill calendar
date the list missed (report which). Do NOT touch timestamps with meaningful time-of-day.

### WP4 — sale flow carries dueDate/terms, API (files: `apps/api/src/orders/dto/create-sale.dto.ts`, `apps/api/src/orders/orders.service.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/orders/orders.service.spec.ts`)

1. `CreateSaleDto`: add
   ```ts
   @IsOptional() @IsDateString() dueDate?: string;
   @IsOptional() @IsString() @MaxLength(5000) terms?: string;
   ```
2. `InvoicesService.createInvoiceFromOrder(orderId: string, overrides?: { dueDate?: string; terms?: string })`:
   when `overrides?.dueDate` is present use `new Date(overrides.dueDate)` instead of the
   `resolveDefaultTerms()`-derived date; when `overrides?.terms` is present (non-empty after trim)
   use it for the persisted `terms` instead of `tenantDefaults.terms ?? defaultTerms`. Fall back to
   the EXISTING behavior for anything absent — zero behavior change for callers that pass nothing.
3. Apply the identical optional-overrides parameter to `createInvoiceFromOrderWithTenant` and
   `createPartialFromOrder` (they are duplicated copies of the same defaulting logic — keep all
   three behaviorally identical; where `createPartialFromOrder` already accepts an explicit
   `dto.dueDate`, keep its precedence: explicit dto value wins, then override, then default).
4. `OrdersService.createSale`: pass `{ dueDate: dto.dueDate, terms: dto.terms }` through to
   `createInvoiceFromOrder`.
5. Specs in `orders.service.spec.ts` (extend the existing createSale suite, mock at the Prisma
   boundary per repo convention): (a) sale with `dueDate: "2026-10-03"` → the created invoice
   receives exactly that date; (b) sale without `dueDate` → the tenant default (+30) path still
   runs, unchanged.

### WP5 — sale flow sends the values, web + mobile (files: `apps/web/app/(dashboard)/invoices/new/page.tsx`, `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx`, `apps/mobile/lib/api/orders.ts`, `apps/web/lib/api/orders.ts`)

Web `handleSubmitSale`: include in the `createSale.mutate` payload:

```ts
...(dueDate ? { dueDate } : {}),
...(termsText.trim() ? { terms: termsText.trim() } : {}),
```

(`dueDate` is the page's existing state; `termsText` is the long-form T&C textarea state — the SAME
value `buildInvoiceDto` already sends for the standalone flow, keeping the two flows' semantics
identical. The dropdown continues to drive `dueDate` only.)

Mobile sale-mode branch: send the equivalent — the screen's computed due date and its terms text
state if it has one (read the screen; if mobile has no terms textarea, send only `dueDate`).

Update the `createSale` client typings in `apps/web/lib/api/orders.ts` / `apps/mobile/lib/api/orders.ts`
to carry the optional fields.

## Acceptance criteria

1. `new Date("2026-08-04T00:00:00.000Z")` renders as August 4 on every touched surface regardless
   of the process/browser timezone (spec proves it server-side).
2. A web "New sale" with sale date Aug 4 + Terms "Net 60" (due date auto-computed Oct 3) produces an
   invoice whose stored dueDate is Oct 3 — proven by the WP4 spec.
3. A sale posted with no dueDate behaves exactly as today (tenant default) — proven by spec.
4. No schema change, no migration, no edit to `Invoice.terms` semantics.
5. `git status` in the worktree shows changes ONLY under the files listed in the packages (plus any
   extra formatter call sites found by the mandated greps, reported explicitly).

## Verification commands (run from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-terms-dates && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-terms-dates && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-terms-dates && npm run test
```

## Out of scope

Persisting a structured payment-terms label (separate task, has a migration) · vendor-bill terms ·
deposit schedules · editing terms post-issuance · anything in `.claude/code-map` (the orchestrator
updates the map).
