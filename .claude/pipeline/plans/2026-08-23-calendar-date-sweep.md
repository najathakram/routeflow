# Plan: calendar-date sweep — finish the −1-day fix everywhere (STACKED on fix/invoice-dates-terms)

> Status: IMPLEMENTED (2026-08-23, autopilot; clean=true, 2 style regressions caught and restored, final gate green; several sites verified already fixed on the base branch) · Authored 2026-08-23. This file is the ONLY context implementers receive. The
> sites below were catalogued and schema-verified by the PR #416 review — trust the list, verify
> each line number before editing (they may have drifted a few lines).

## ⚠️ WORKTREE — read before anything else

ALL work happens in:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-date-sweep
```

Your process may start in `C:\ClaudeCode\routeflow` (main checkout) — do NOT touch files there.
`cd` into the worktree first; ABSOLUTE paths under the worktree for every edit. Branch is
`fix/calendar-date-sweep`, cut from `fix/invoice-dates-terms` (PR #416) — the shared helpers
ALREADY EXIST here: web `apps/web/lib/formatting.ts` (`fmtCalendarDate`) and mobile
`apps/mobile/lib/format-date.ts`. Read both helpers FIRST and reuse them; create nothing new. Do
not commit, stage or push.

## The rule (same as PR #416)

CALENDAR-date fields (stored at UTC midnight, no meaningful time-of-day: billDate, dueDate,
issueDate, expiresAt on credit notes/estimates, expectedDate on POs, requestedDeliveryDate) →
format via the UTC-safe helper. REAL timestamps (`paidAt`, `createdAt`, `receivedAt`,
`@default(now())` columns) keep local rendering — forcing UTC on those CREATES a bug. When in
doubt, check the field in `apps/api/prisma/schema.prisma`: `@default(now())` or set from
`new Date()` at write time = timestamp; set from a `YYYY-MM-DD` DTO string = calendar date.

## WP1 — mobile sweep (files: `apps/mobile/app/(operator)/vendor-bills/[id].tsx`, `apps/mobile/app/(operator)/vendor-bills/index.tsx`, `apps/mobile/app/(operator)/(tabs)/finance.tsx`, `apps/mobile/components/RecordSupplierPaymentSheet.tsx`, `apps/mobile/app/(operator)/payments/record.tsx`, `apps/mobile/app/(customer)/orders/[id].tsx`, `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`, `apps/mobile/app/(customer)/orders/cart.tsx`, `apps/mobile/app/(operator)/credit-notes/[id].tsx`, `apps/mobile/app/(operator)/credit-notes/index.tsx`, `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`, `apps/mobile/components/NewOrderScreen.tsx`, `apps/mobile/app/(operator)/purchase-orders/[id].tsx`, `apps/mobile/app/(operator)/purchase-orders/index.tsx`, `apps/mobile/app/(operator)/estimates/[id].tsx`, `apps/mobile/app/(operator)/estimates/index.tsx`)

Route these through `fmtCalendarDate` from `@/lib/format-date` (check the import alias mobile
actually uses — read an already-fixed screen like `(operator)/(tabs)/invoices/index.tsx` for the
exact import style):

- vendor-bills `[id].tsx` ~L127 (`bill.billDate`), ~L137 (`bill.dueDate`); `index.tsx` ~L143/150;
  `finance.tsx` ~L179 (`bill.billDate`); `RecordSupplierPaymentSheet.tsx` ~L275 (`bill.billDate`)
- `payments/record.tsx` ~L362 (`inv.dueDate`)
- `requestedDeliveryDate`: `(customer)/orders/[id].tsx` ~L219, `(operator)/(tabs)/orders/[id].tsx`
  ~L728; `(customer)/orders/cart.tsx` ~L26 currently dodges via a manual `iso + "T00:00:00"`
  parse — consolidate onto the helper
- credit notes: `credit-notes/[id].tsx` ~L139 (`issueDate ?? createdAt` — CAREFUL: when it falls
  back to `createdAt` that is a timestamp; format `issueDate` with the helper and `createdAt`
  locally, e.g. `cn.issueDate ? fmtCalendarDate(cn.issueDate) : <existing local format>(cn.createdAt)`),
  ~L160 (`expiresAt`); `credit-notes/index.tsx` ~L124 (same issued pattern);
  `edit-items.tsx` ~L871 (`cn.expiresAt`); `NewOrderScreen.tsx` ~L2491 (`cn.expiresAt`)
- purchase orders `[id].tsx` ~L123 / `index.tsx` ~L118 (`expectedDate`)
- estimates `[id].tsx` ~L145 / `index.tsx` ~L113 (`expiresAt`)

Preserve each screen's existing display STYLE (the helper takes a style/options param — read it).
Touch nothing else in these files.

## WP2 — web sweep (files: `apps/web/app/(dashboard)/orders/[id]/page.tsx`, `apps/web/app/(dashboard)/invoices/recurring/page.tsx`, `apps/web/app/(dashboard)/bookkeeping/[transactionId]/page.tsx`, `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx`, `apps/web/app/(dashboard)/orders/_components/CreditNotePicker.tsx`)

Route through `fmtCalendarDate` from `@/lib/formatting`:

- `orders/[id]/page.tsx` ~L3008: `Due {new Date(inv.dueDate).toLocaleDateString()}` in the
  linked-invoices section
- `invoices/recurring/page.tsx` ~L19-24: a LOCAL `fmtDate` duplicate — delete it and import the
  shared one (verify the call sites' display style survives)
- `bookkeeping/[transactionId]/page.tsx` ~L313: `txn.dueDate`
- buyer portal `orders/[id]/page.tsx` ~L649: `requestedDeliveryDate` (local en-GB helper — route
  ONLY the calendar-date call through the shared helper; keep the local helper for any timestamp
  usages in the same file)
- `CreditNotePicker.tsx` ~L270: `cn.expiresAt` — FIRST verify in
  `apps/api/prisma/schema.prisma` + the credit-note write path that `expiresAt` is set from a
  date-only string (the PR #416 review was unsure); if it turns out to be a timestamp, leave it
  and say so in your report.

Also re-grep both apps for `toLocaleDateString(` and report (do not fix) anything outside these
lists that still renders a calendar date locally.

## Acceptance criteria

1. Every listed site renders the SAME calendar day in any timezone; visual style unchanged.
2. No timestamp field switched to UTC rendering (the credit-note `issueDate ?? createdAt` split is
   the test of care).
3. No new helpers, no API changes, no migration.
4. Full gates green.

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-date-sweep && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-date-sweep && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-date-sweep && npm run test
```
