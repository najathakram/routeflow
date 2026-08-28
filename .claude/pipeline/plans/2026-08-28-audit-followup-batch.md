# Plan: Audit follow-up batch — nav stability, IA dual-home, charts, copy, responsive

**Status:** PLANNED
**Date:** 2026-08-28
**Branch:** `fix/audit-followup-batch` off `origin/master` @ 179dcb29
(worktree `C:/ClaudeCode/routeflow/.claude/worktrees/audit-followup`)
**Context:** Second batch from the 2026-08-26 tenant-admin UX audit. The P0 batch (PR #457) is
merged and verified live; this batch closes the remaining P1/P2 findings. All observations below
were re-verified against production on 2026-08-28 unless noted.

## House rules (all packages)

- Web = Next.js 14 App Router (`apps/web`), Radix + Tailwind. Prettier: semicolons, double quotes,
  printWidth 100. No new deps, no Vitest, no snapshot tests. Web has no unit-test runner —
  verification is typecheck + lint.
- Match surrounding code style. Comments only for non-obvious constraints.
- `apps/web/lib/format.ts` (formatMoney/formatQty/formatDate/humanizeEnum) exists — use it for any
  new display strings. Calendar dates stored at UTC midnight use `lib/formatting.ts
fmtCalendarDate`, never `formatDate`.
- ⚠️ PR #472 (`feat/route-planning-options`) is OPEN and may touch route pages — in
  `routes/page.tsx` make ONLY the minimal className change specified, nothing structural.
- Money math is off-limits; nothing in this batch touches money computation.

---

## WPa — Dashboard: overdue panel badge shows the total, not the page size

**Files:** `apps/web/app/(dashboard)/dashboard/page.tsx`

**Verified live:** after #457 the KPI card reads "Overdue Invoices 17" (meta.total of the
`isOverdue` query) but the `OverdueInvoicesPanel` header badge shows "5" — the length of the
5-item list it receives. Two different numbers for the same concept on one screen.

**Change:** `OverdueInvoicesPanel` (defined ~line 278, used ~line 847) gains a
`totalCount: number` prop; the header badge renders `totalCount` (fed `overdueCount` from the
page). The list stays 5 items. If the panel shows a "View all" affordance, append the count there
too only if it already renders a number.

**Accept:** badge number === KPI number for any dataset; typecheck passes.

---

## WPbc — Nav: no pop-in, and one home for Bills & Purchasing

**Files:** `apps/web/app/(dashboard)/layout.tsx`,
`apps/web/app/(dashboard)/finance/expenses/page.tsx`

**Verified live (2026-08-28):** first paint renders the sidebar WITHOUT the Deliveries, Dispatch,
Sales Agents, and Regulated Items groups; they pop in seconds later when addon/entitlement queries
resolve. Separately, Finance → "Expenses" and Warehouse → "Bills & Purchasing" are two nav entries
for the same hub (`/finance/expenses/page.tsx` renders the Bills & Purchasing page that canonically
lives at `/vendor-bills`), and the active state highlights Finance → Expenses even when you're on
`/vendor-bills`.

**b — nav skeletons (pop-in):**
The gating hooks already expose readiness: `useRoutesAccess()` / `useDeliveryAccess()` return
`{ enabled, resolved }` (layout.tsx ~lines 301–303); the sales-agents / tobacco / tracked-categories
gates use `useHasAddon` / query hooks with their own loading state. Read how the nav-group array is
assembled (the sidebar render in this file) and change the pattern from "omit group until enabled"
to:

- While the relevant flag is UNRESOLVED (`!resolved`, or the addon query `isLoading`): render a
  skeleton placeholder row in the rail at that group's position — same height as a nav group
  header, using the existing `.skeleton` utility class from globals.css — so the rail's layout is
  final from first paint.
- Once resolved: render the group (enabled) or nothing (disabled) — the skeleton collapses only
  in the disabled case, which is the rare path and acceptable.
- Do NOT block the whole rail; static groups (Dashboard, Orders, Customers, Finance, Analytics,
  Settings) render immediately as today.
- Apply the same treatment to the dashboard header's Operator/Driver toggle ONLY if it lives in
  this file and pops in via the same flags; otherwise leave it.

**c — dual-home merge:**

1. Replace the entire contents of `apps/web/app/(dashboard)/finance/expenses/page.tsx` with a thin
   redirect stub to `/vendor-bills`, mirroring the existing `/routes/trips*` → `/deliveries*`
   redirect-stub pattern (find one of those stub files and copy its shape — it preserves deep links
   and nav active-state compat). ⚠️ `finance/expenses/new/` (expense creation) must keep working —
   do not touch that directory; verify the stub only replaces the hub page.
2. In layout.tsx, REMOVE the Finance group's "Expenses" nav item ("Bills & Purchasing" under
   Warehouse is the one home; the hub's "Other Expenses" tab covers the content).
3. Fix active-state: navigating to `/vendor-bills` must highlight the "Bills & Purchasing" nav
   item. Find the active-match logic in layout.tsx (it currently maps `/vendor-bills` or
   `/finance/expenses` to the Expenses item) and correct the mapping.

**Accept:** hard-reload any dashboard page → the rail never changes shape after first paint
(groups appear as skeletons, then fill); `/finance/expenses` redirects to `/vendor-bills`;
`/finance/expenses/new` still renders; "Bills & Purchasing" highlights on `/vendor-bills`; no nav
item named "Expenses" remains in the Finance group; typecheck passes.

---

## WPd — Analytics: replace the 20-slice pie with readable bars

**Files:** `apps/web/app/(dashboard)/analytics/page.tsx`

**Verified:** "Sales by Category" renders a recharts `<PieChart>/<Pie>` (~lines 481–495) with ~20
slices, overlapping percentage labels, and a 20-chip legend. Biggest slice is "Uncategorized 23%".

**Change:** replace the pie with a HORIZONTAL bar list of the top 8 categories by value plus a
final "Other (N categories)" bar aggregating the rest:

- Prefer the recharts `BarChart layout="vertical"` pattern if the file already imports BarChart for
  the revenue trend; otherwise render a simple div-based bar list (label left, bar + formatted
  value right) styled like the surrounding cards — whichever is LESS code in this file.
- Sort descending by value. Values formatted with `formatMoney` from `@/lib/format`; percentages
  to 0 dp appended to the label (e.g. "Uncategorized — 23%").
- Drop the 20-chip legend entirely (bars are self-labeling). Keep the card title.
- Colors: use one brand token (the teal the app's KPIs use) for all bars, with "Other" in a muted
  gray — no rainbow.

**Accept:** no `<Pie` remains in the file; max 9 bars; legend chips gone; typecheck passes.

---

## WPe — Copy pass: de-jargon the operator-facing strings

**Files (only these):** `apps/web/app/(dashboard)/finance/statements/page.tsx`,
`apps/web/app/(dashboard)/inventory/page.tsx`, `apps/web/app/(dashboard)/sales-agents/[id]/page.tsx`,
`apps/web/app/(dashboard)/orders/page.tsx`, `apps/web/app/(dashboard)/compliance/[id]/page.tsx`
(or wherever the compliance page component lives — find it by grepping for "TX_COMPTROLLER"),
plus the notifications empty-state component (grep `"No notifications yet"` under apps/web).

Exact replacements (find each string, keep surrounding markup):

1. Statements footnote "Powered by Claude AI — matching happens in code afterward,
   deterministically, never by asking the model to decide." →
   "AI reads the statement; every match is then verified line-by-line before anything is applied."
2. Stock Count helper "Scanning starts a new count on the server — pause any time and resume it
   from another device via the Continue-count strip above or Count history." →
   "Scanning starts a new count. Pause any time — you can pick it up later from any device via
   the strip above or Count history."
3. Sales-agent detail "Per-customer overrides layer on top of the agent default. There is no list
   here — resolved rates show per-accrual in the ledger's Rate column below." →
   "Set a custom rate for specific customers — it overrides the agent's default rate. Each
   commission row below shows the rate that was actually applied."
4. Orders list: the "Urgent" quick-filter pill — hide the pill entirely when its count is 0
   (keep it, with count, when > 0).
5. Inventory OUT OF STOCK card sublabel "0 or fewer on hand" → "none on hand (or negative)".
6. Compliance template dropdown showing raw `TX_COMPTROLLER` → map known template enum values to
   labels ("Texas Comptroller default") with `humanizeEnum` from `@/lib/format` as the fallback
   for unknown values. Also relabel the page's config-token subtitle "Tracked only · no auto tax ·
   Sectioned on invoice · monthly filings" → "Tracked separately · tax handled on filing ·
   itemized on invoices · monthly filings" ONLY if those exact tokens are static strings; if they
   are data-driven config echoes, leave them and note it.
7. Notifications empty state "Urgent orders, driver updates, and low-stock alerts will appear
   here" → "Order, delivery, and account alerts will appear here." (the current copy promises
   low-stock alerts that don't notify).
8. Customers subtitle is handled in WPg (file ownership) — do NOT touch customers/page.tsx here.

**Accept:** each old string is gone (grep), replacements present verbatim, no other copy changed;
typecheck passes.

---

## WPf — Order detail: demote Delete on delivered/invoiced orders

**Files:** `apps/web/app/(dashboard)/orders/[id]/page.tsx`

**Verified live:** a DELIVERED order with a SENT invoice still shows a first-class "Delete order"
button in its header (the P0 batch fixed invoices and runs; orders were explicitly deferred).
The file has a shared delete trigger + two-tap confirm (~line 2084+) with a comment noting the
server 409s only when a linked invoice has recorded payments.

**Change:**

1. Render the "Delete order" trigger ONLY when the order is still operationally open:
   `status !== "DELIVERED" && status !== "PARTIALLY_DELIVERED"` AND the order has no linked
   non-draft invoice (the page already loads linked invoice data for its Invoice card — reuse
   that; a DRAFT pending-mirror invoice does not count as posted).
2. When hidden, nothing replaces it — "Reopen Order" (already present) is the sanctioned path for
   delivered orders.
3. Reopen helper copy (same file): "Reopening keeps the invoice — Edit Items re-syncs it.
   Route-delivered orders reopen from their run stop." →
   "Reopening keeps the invoice in sync while you edit. Orders delivered on a route reopen at
   their original stop."

**Accept:** delete trigger absent on delivered/invoiced orders, present on PENDING/CONFIRMED
uninvoiced orders; new helper copy exact; typecheck passes.

---

## WPg — Responsive: card grids wrap, tables scroll, customers subtitle

**Files:** `apps/web/app/(dashboard)/dispatch/page.tsx`, `apps/web/app/(dashboard)/routes/page.tsx`,
`apps/web/app/(dashboard)/customers/page.tsx`

**Verified (audit, ~1200px viewport):** the Dispatch "Active & Upcoming Runs" and Routes "Active
Runs" card grids clip the third card at the viewport edge instead of wrapping; the Customers table
pushes Status + row actions off-screen with body-level horizontal scroll.

**Change:**

1. `dispatch/page.tsx`: the runs grid currently uses fixed breakpoint columns
   (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3` — see ~line 71 skeleton and the real grid nearby).
   Change BOTH (skeleton + real) to
   `grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4` so cards wrap at every width.
2. `routes/page.tsx`: same treatment on the Active Runs card grid — className-only change (open
   PR #472 may touch this file; touch nothing else).
3. `customers/page.tsx`: wrap the table in its own `overflow-x-auto` container (if the Table
   component already provides one, ensure it's enabled) so the page body never scrolls
   horizontally; the table keeps its natural min-width. Also (file ownership): change the
   subtitle "N customers · filters live in the URL, so views are shareable." →
   "N customers · your current filters are saved in the page link — copy the URL to share this
   view." Keep the count prefix logic.

**Accept:** at a ~1200px viewport no page-level horizontal scroll on the three pages; grids wrap
to 2 columns; subtitle replaced; typecheck passes.

---

## Out of scope

`format.ts`/`formatting.ts` consolidation (map cross-refs suffice for now); wiring real low-stock
notifications; realtime during impersonation; per-page date-format sweep beyond what format.ts
adopters already cover; anything in open PRs #472/#473/#471.

## Verification

- Per round: `npm run check-types` (worktree root).
- Final: `npm run verify`.
