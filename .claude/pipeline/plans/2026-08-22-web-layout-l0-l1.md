# Plan: Web layout audit — batch L0 (duplicate h1 → h2) + batch L1 (clipped-table overflow wrappers)

> Authored by Fable 5 on 2026-08-22. Status: IMPLEMENTED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

The operator-dashboard layout audit (docs/audit/2026-08-22-web-layout, machine-local) found that
24 dashboard pages render a second page-level `<h1>` duplicating the app-shell topbar's `<h1>`
(a11y defect), and 3 list pages have tables that are measurably wider than their host at 1024px
with no scroll wrapper — since `<main>` is `overflow-x-hidden`, trailing columns are clipped and
unreachable. This change demotes the in-page headings to `<h2>` (tag swap only) and wraps the
three clipped tables in `<div className="overflow-x-auto">` (markup only). No redesign, no
look-and-feel change, no behaviour change.

## Constraints & conventions

- **ALL file edits happen inside the worktree** `C:\ClaudeCode\routeflow\.claude\worktrees\layout-l0l1`
  (Git Bash path `/c/ClaudeCode/routeflow/.claude/worktrees/layout-l0l1`), branch
  `style/web-layout-l0-l1`. File paths below are relative to that worktree root. NEVER edit the
  main checkout at `C:\ClaudeCode\routeflow`.
- **Tag change only for L0**: `<h1` → `<h2` and the matching `</h1>` → `</h2>`. Keep the
  `className` string and every attribute EXACTLY as-is. There are no global element-level h1/h2
  CSS rules in this app (verified: apps/web/app/globals.css has none, no typography plugin), so
  the swap is visually a no-op.
- **Wrapper only for L1**: insert `<div className="overflow-x-auto">` immediately around the ONE
  specified `<table>…</table>` element per file (directly inside its existing parent card div —
  the parent keeps its `overflow-hidden` for rounded-corner clipping). Do not touch any other
  table on the page, do not move footers/pagination inside the wrapper, do not change any
  existing class strings.
- **Forbidden in the diff** (behaviour-change invariant): any change to
  `useState|useEffect|useMemo|useCallback|onClick|onChange|onSubmit|fetch(|api.|router.|useQuery|useMutation`,
  any className edit beyond the inserted wrapper div, any text change, any import change.
- **DO NOT TOUCH**: `packages/ui/src/web/Modal.tsx` (its `rounded-xl` string is an e2e selector
  in e2e/15-stock-count-ui.spec.ts:116 and e2e/16-variant-split-ui.spec.ts:114), and these three
  files owned by a parallel session:
  `apps/web/app/(dashboard)/customers/[id]/page.tsx`,
  `apps/web/app/(dashboard)/invoices/[id]/page.tsx`,
  `apps/web/app/(dashboard)/invoices/new/page.tsx`.
- e2e safety (verified): no Playwright spec selects a heading with `level: 1` or a bare `h1`
  locator on the touched pages; every heading locator in apps/web/e2e is an `h1, h2` OR-selector,
  so the demotion cannot break a spec.
- Prettier: double quotes, semicolons, printWidth 100 — the inserted div must match surrounding
  indentation (re-indent the wrapped `<table>` block by one level, 2 spaces).
- Line numbers below were verified against this worktree's checkout of master (de557140) — they
  are exact. If a file has drifted, locate the identical quoted snippet instead; every quoted
  `<h1` snippet occurs exactly once in its file.

## Work packages

Rules: file lists across packages are DISJOINT and run in parallel. All packages are mechanical.

### WP1 — L0+L1 finance pages

- **files:** `apps/web/app/(dashboard)/finance/payments/page.tsx`,
  `apps/web/app/(dashboard)/finance/payment-requests/page.tsx`,
  `apps/web/app/(dashboard)/finance/expenses/new/page.tsx`,
  `apps/web/app/(dashboard)/finance/dashboard/page.tsx`,
  `apps/web/app/(dashboard)/finance/payments/[id]/page.tsx`
- **effort:** low
- **brief:** Five h1→h2 tag swaps plus ONE overflow wrapper in finance/payments/page.tsx.
  1. `finance/payments/page.tsx` line 562: `<h1 className="text-xl font-semibold text-navy">Payments Received</h1>` → h2 both tags.
  2. `finance/payments/page.tsx` lines 694–856: wrap the MAIN list table (the one inside the
     `{/* Table */}` card at line 688, in the non-loading ternary branch) — see exact code below.
     Do NOT touch the small allocation table at line ~346.
  3. `finance/payment-requests/page.tsx` line 272: `<h1 className="text-xl font-semibold text-navy">Payment Requests</h1>` → h2.
  4. `finance/expenses/new/page.tsx` line 904: `<h1 className="text-xl font-semibold text-navy">New Expense</h1>` → h2.
  5. `finance/dashboard/page.tsx` line 169: `<h1 className="text-2xl font-bold text-navy">Receivables Overview</h1>` → h2.
     (Leave the comment at line 120 mentioning `<h1>` alone — comments are not findings.)
  6. `finance/payments/[id]/page.tsx` lines 112–114 (multi-line):
     `<h1 className="font-mono text-2xl font-bold text-navy">` … `{payment.paymentNumber ?? "Payment"}` … `</h1>` → h2 both tags, inner line unchanged.
- **exact code** (finance/payments/page.tsx wrapper; current code at 693–857):

  Before:

  ```tsx
        ) : (
          <table className="w-full text-sm">
            ...entire table unchanged...
          </table>
        )}
  ```

  After:

  ```tsx
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              ...entire table unchanged, re-indented one level...
            </table>
          </div>
        )}
  ```

### WP2 — L0 settings pages

- **files:** `apps/web/app/(dashboard)/settings/page.tsx`,
  `apps/web/app/(dashboard)/settings/batch-import/page.tsx`,
  `apps/web/app/(dashboard)/settings/import/page.tsx`,
  `apps/web/app/(dashboard)/settings/migration/page.tsx`
- **effort:** low
- **brief:** Six h1→h2 tag swaps.
  1. `settings/page.tsx` line 2582: `<h1 className="mb-5 text-2xl font-bold text-navy">Settings</h1>` → h2.
  2. `settings/page.tsx` line 2599: `<h1 className="mb-5 text-2xl font-bold text-navy">{section.title}</h1>` → h2.
  3. `settings/page.tsx` line 2613: `<h1 className="mb-5 text-2xl font-bold text-navy">Settings</h1>` → h2.
  4. `settings/batch-import/page.tsx` line 168: `<h1 className="text-xl font-semibold text-navy">Batch invoice import</h1>` → h2.
  5. `settings/import/page.tsx` line 644: `<h1 className="text-xl font-semibold text-navy">Import from Zoho</h1>` → h2.
  6. `settings/migration/page.tsx` line 226: `<h1 className="text-xl font-semibold text-navy">Move to RouteFlow</h1>` → h2.

### WP3 — L0 detail pages

- **files:** `apps/web/app/(dashboard)/estimates/[id]/page.tsx`,
  `apps/web/app/(dashboard)/orders/[id]/page.tsx`,
  `apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx`,
  `apps/web/app/(dashboard)/suppliers/[id]/page.tsx`,
  `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx`,
  `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx`,
  `apps/web/app/(dashboard)/compliance/page.tsx`
- **effort:** low
- **brief:** Seven h1→h2 tag swaps.
  1. `estimates/[id]/page.tsx` line 229: `<h1 className="text-2xl font-bold text-navy">{estimate.estimateNumber}</h1>` → h2.
  2. `orders/[id]/page.tsx` lines 1981–1983 (multi-line):
     `<h1 className="mono text-2xl font-bold tracking-[-0.01em] text-navy">` … `{order.orderNumber}` … `</h1>` → h2 both tags.
  3. `vendor-bills/[id]/page.tsx` line 987: `<h1 className="mono text-2xl font-bold text-navy">{bill.billNumber}</h1>` → h2.
  4. `suppliers/[id]/page.tsx` line 469: `<h1 className="text-2xl font-bold text-navy">{supplier.name}</h1>` → h2.
  5. `credit-notes/[id]/page.tsx` line 394: `<h1 className="text-2xl font-bold text-navy">{cn.creditNoteNumber}</h1>` → h2.
  6. `compliance/[categoryId]/page.tsx` line 135: `<h1 className="text-2xl font-bold text-navy">{c.name}</h1>` → h2.
  7. `compliance/page.tsx` line 40: `<h1 className="text-2xl font-bold text-navy">Regulated Items</h1>` → h2.

### WP4 — L0 remaining pages + L1 suppliers/expenses wrappers

- **files:** `apps/web/app/(dashboard)/invoices/recurring/page.tsx`,
  `apps/web/app/(dashboard)/invoices/recurring/new/page.tsx`,
  `apps/web/app/(dashboard)/routes/create/page.tsx`,
  `apps/web/app/(dashboard)/inventory/movements/page.tsx`,
  `apps/web/app/(dashboard)/shipments/page.tsx`,
  `apps/web/app/(dashboard)/suppliers/page.tsx`,
  `apps/web/app/(dashboard)/finance/expenses/page.tsx`
- **effort:** low
- **brief:** Five h1→h2 tag swaps plus TWO overflow wrappers.
  1. `invoices/recurring/page.tsx` line 99: `<h1 className="text-2xl font-bold text-navy">Recurring Invoices</h1>` → h2.
  2. `invoices/recurring/new/page.tsx` line 316: `<h1 className="text-2xl font-bold text-navy">New Recurring Template</h1>` → h2.
  3. `routes/create/page.tsx` line 300: `<h1 className="text-2xl font-bold text-navy">Create Route</h1>` → h2.
  4. `inventory/movements/page.tsx` line 114: `<h1 className="text-2xl font-bold text-navy">Stock Movements</h1>` → h2.
  5. `shipments/page.tsx` line 77: `<h1 className="text-xl font-bold text-navy">Shipments</h1>` → h2.
  6. `suppliers/page.tsx` lines 1007–1037: wrap the list-view table — see exact code below. The
     "Total outstanding footer" div after `</table>` stays OUTSIDE the new wrapper.
  7. `finance/expenses/page.tsx` lines 1205–1396: wrap the Vendor Bills table (the one inside
     `InventoryPurchasesTab`, whose card div at line 1204 is
     `<div className="overflow-hidden rounded-lg border border-surface-border">`) — see exact
     code below. Do NOT touch the Purchase Orders table (~1519) or Other Expenses table (~1841).
- **exact code** (suppliers/page.tsx; current code at 1006–1038):

  Before:

  ```tsx
        <div className="overflow-hidden rounded-xl border border-surface-border bg-white">
          <table className="w-full text-sm">
            ...entire table unchanged...
          </table>

          {/* Total outstanding footer */}
  ```

  After:

  ```tsx
        <div className="overflow-hidden rounded-xl border border-surface-border bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              ...entire table unchanged, re-indented one level...
            </table>
          </div>

          {/* Total outstanding footer */}
  ```

  (finance/expenses/page.tsx follows the identical pattern: insert
  `<div className="overflow-x-auto">` directly inside the card div at line 1204, around the
  `<table>` at 1205 through its `</table>` at 1396, re-indenting the table block one level. The
  `{/* Pagination */}` block after the card stays where it is.)

## Acceptance criteria

1. `git diff --stat` in the worktree touches EXACTLY these 23 files, nothing else:
   the 21 L0 files listed above + `suppliers/page.tsx` + `finance/expenses/page.tsx`
   (`finance/payments/page.tsx` carries both an L0 and an L1 change).
2. Zero `<h1` tags remain in the 21 L0 files' diffs — every listed heading is now `<h2` with an
   identical className/attribute string, and its matching closing tag is `</h2>`.
3. Exactly three `<div className="overflow-x-auto">` insertions exist in the diff: one per L1
   file, each immediately wrapping only the specified `<table>…</table>`.
4. The diff contains NO other className change, no text change, no import change, and no match
   for `useState|useEffect|useMemo|useCallback|onClick|onChange|onSubmit|fetch\(|api\.|router\.|useQuery|useMutation`
   on any +/- line.
5. `apps/web/app/(dashboard)/customers/[id]/page.tsx`, `invoices/[id]/page.tsx`,
   `invoices/new/page.tsx`, and `packages/ui/src/web/Modal.tsx` are untouched.
6. Verification commands below pass.

## Verification commands

Run from the worktree root (`cd /c/ClaudeCode/routeflow/.claude/worktrees/layout-l0l1`):

1. `cd /c/ClaudeCode/routeflow/.claude/worktrees/layout-l0l1 && npx turbo run check-types --filter=@routeflow/web`
2. `cd /c/ClaudeCode/routeflow/.claude/worktrees/layout-l0l1 && npx turbo run lint --filter=@routeflow/web`

(Full `npm run check-types && npm run lint && npm run test` and the Playwright subset run once at
close-out by the session, not per gate round.)

## Risks & rollback

- **Missed closing tag** → JSX parse error; caught instantly by check-types. Rollback: revert the file.
- **Wrapper around the wrong table** (payments has 2 tables, expenses has 3) → review walks the
  line numbers; the correct targets are the ONLY tables inside the quoted card divs.
- **Indentation drift** → lint/prettier catches; run `npx prettier --write` on the touched file if flagged.
- Whole batch is trivially revertible: `git checkout origin/master -- <file>` per file, or drop the branch.
