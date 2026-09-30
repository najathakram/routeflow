# Operator dashboard — layout audit findings

Captured on the live prod deployment across **61 screens** at 1440 / 1280 / 1024.

> **Nothing here has been changed yet.** Tick the batches you want and I'll run each through `dev-pipeline`, one PR per batch.

> Constraint honoured throughout: no redesign, no look-and-feel or branding change, no behaviour change.


**46 findings** (after dedupe) — S0:6  S1:25  S2:2  S3:12  S4:1

## 🔴 Broken now (S0) — 6

| Page | What | Fix |
| --- | --- | --- |
| `customers-id` | The customer-detail tab bar does not fit at 1024px and pushes main into page-level horizontal overflow; since <main> is overflow-x-hidden, the trailing tabs (Documents, Licenses) are unreachable at this width. | Let the tab row scroll horizontally (overflow-x-auto, no wrap) at narrow widths so it stays inside main's content box; no change to tab behaviour. |
| `customers-id` | main reserves pb-24 specifically so bottom-anchored floating UI (PwaInstallPrompt) never covers page content (see the comment at layout.tsx:1132-1138), but DraftDock is not covered by that same clearance and visibly overlaps in-flow cards on this page. | Give DraftDock the same bottom clearance treatment as PwaInstallPrompt (respect main's pb-24 / raise the dock above reserved space) so it stops sitting on top of page content; no change to dock behaviour. |
| `suppliers` | At 1024px the supplier table is 64px wider than its host with no scroll wrapper; main is overflow-x-hidden so table content is clipped rather than reachable — not visible as a hard edge in the screenshot because the browser instead force-wraps supplier names to 2-3 lines to compensate. | Wrap the <table> in <div className="overflow-x-auto">. Markup only, no logic change. |
| `finance-payments` | At 1024px the 10-column payments table is wider than its host with no scroll wrapper; the trailing Actions column is clipped off and unreachable. | Wrap the <table> in <div className="overflow-x-auto">. Markup only, no logic change. |
| `inventory` | At 1024 the toolbar's button group doesn't wrap under the parent's flex-wrap the way it does at 1280; it overflows main's content box instead. main is overflow-x-hidden so the tail of the button row is clipped and the Quick Restock button is partially unreachable. | Let the button group itself wrap (add flex-wrap to the `flex gap-2` div around the six toolbar buttons, apps/web/app/(dashboard)/inventory/page.tsx ~line 2699) or move it to its own row below the count text at this breakpoint. Markup only. |
| `finance-expenses` | The 11-column vendor-bills table is wider than its container at 1024px with no overflow wrapper; main is overflow-x-hidden so right-side columns (Paid/Balance/Status/eye icon) are clipped and unreachable, and headers wrap raggedly under the compression. | Wrap the <table> in <div className="overflow-x-auto">. Markup only, no logic change. |

## Fix batches


### L0 — Remove duplicate `<h1>` (a11y, ~4 lines each)

**24 findings across 24 files.** Risk: ~zero — deleting a redundant tag.

| ✓ | Sev | Page | Problem | Fix |
| --- | --- | --- | --- | --- |
| [ ] | S1 | `customers-id` | Two <h1> elements carry the identical customer name text; the profile heading should be an <h2> per PageHeader convention (topbar already owns the page's one <h1>). | Change the customer-name heading in the profile card from <h1> to <h2>/<h3>; purely a tag change, no visual or behaviour change. |
| [ ] | S1 | `settings-tab-email` +4 | The tab's own title "Email (SMTP)" renders as a second <h1>; topbar already owns the page's <h1> ("Settings"). Same pattern on the Profile tab. | Render the settings-tab title as <h2> instead of <h1>, matching PageHeader convention. |
| [ ] | S1 | `finance-payments` | The page heading duplicates the topbar's title as a second literal <h1> with the same text. | Render the page's own "Payments Received" heading as <h2> per PageHeader convention. |
| [ ] | S1 | `estimates-id` | The estimate number renders as a second <h1>, duplicating the topbar's own <h1> with identical text. | Render the in-page estimate-number heading as <h2>, matching PageHeader convention. |
| [ ] | S1 | `settings-batch-import` | The page's own "Batch invoice import" heading is a second <h1>; topbar already owns the page's <h1> ("Batch import"). | Render the page heading as <h2> per PageHeader convention. |
| [ ] | S1 | `finance-payment-requests` | The page heading duplicates the topbar's title as a second literal <h1> with the same text. | Render the page's own "Payment Requests" heading as <h2> per PageHeader convention. |
| [ ] | S1 | `orders-id` | Page renders its own <h1>ORD-00005</h1> duplicating the shell topbar's h1 with identical text — two page-level h1 elements, an a11y violation. | Change the page's own title element to <h2> (or route through PageHeader, which renders h2) so only the shell contributes the h1. |
| [ ] | S1 | `vendor-bills-id` | Page renders its own <h1>BILL-2026-0013</h1> duplicating the shell topbar's h1 with identical text. | Demote the page's own title to <h2>, matching PageHeader's convention. |
| [ ] | S1 | `finance-expenses-new` | Page renders its own <h1>New Expense</h1> duplicating the shell topbar's h1 with identical text. | Demote the page's own title to <h2>. |
| [ ] | S1 | `settings-import` | Page renders its own <h1>Import from Zoho</h1> in addition to the shell topbar's h1 ("Import Data") — two page-level h1 elements. | Demote the page's own title to <h2>. |
| [ ] | S1 | `routes-create` | Page renders its own breadcrumb-row <h1>Create Route</h1> duplicating the shell topbar's h1. | Demote the page's own title to <h2>. |
| [ ] | S1 | `compliance-categoryId` | Page renders its own <h1>E2E-DIAG</h1> (with shield icon + status badge) duplicating the shell topbar's h1. | Demote the page's own title to <h2>. |
| [ ] | S1 | `invoices-recurring` | Page renders its own <h1>Recurring Invoices</h1> duplicating the shell topbar's h1. | Demote the page's own title to <h2>. |
| [ ] | S1 | `invoices-new` | Page-level hand-rolled <h1> duplicates the app shell topbar's h1, same pattern as PageHeader's <h2> convention is meant to avoid. | Change the h1 at invoices/new/page.tsx:470 (and its sibling step headers at similar hand-rolled headers in this file) to h2. Markup only. |
| [ ] | S1 | `suppliers-id` | Detail-page header duplicates the topbar's h1 verbatim (same text twice in the DOM) instead of using PageHeader's h2 convention. | Change the h1 at suppliers/[id]/page.tsx:469 to h2. Markup only. |
| [ ] | S1 | `credit-notes-id` | Detail-page header duplicates the topbar's h1 verbatim instead of using PageHeader's h2 convention — same recurring pattern as the other detail pages in this audit (suppliers/[id], invoices/new, settings tabs). | Change the h1 at credit-notes/[id]/page.tsx:394 to h2. Markup only. |
| [ ] | S1 | `finance-dashboard` | Page renders a second, hand-rolled <h1> with different wording from the topbar's own h1, duplicating the heading level and creating two conflicting page titles in the DOM. | Change the h1 at finance/dashboard/page.tsx:169 to h2. Markup only. |
| [ ] | S1 | `inventory-movements` | Same recurring pattern as the other detail/sub pages in this audit: a hand-rolled h1 duplicates the topbar's h1 verbatim. | Change the h1 at inventory/movements/page.tsx:114 to h2. Markup only. |
| [ ] | S1 | `compliance` | Same recurring pattern as the other pages in this audit: a hand-rolled h1 duplicates the topbar's h1 verbatim. | Change the h1 at compliance/page.tsx:40 to h2. Markup only. |
| [ ] | S1 | `invoices-id` | Page renders two <h1> elements with identical text (topbar + hand-rolled page header) — an a11y defect; PageHeader deliberately renders h2 to avoid this. | Change the page's own title element from <h1> to <h2> (or adopt PageHeader), matching the convention every other page in the slice follows. |
| [ ] | S1 | `invoices-recurring-new` | Page renders two <h1> elements with identical text (topbar + hand-rolled page title) — a11y duplicate-heading defect, same pattern as invoices/[id] and settings. | Change the page's own <h1> at line 316 to <h2>, matching the convention PageHeader uses. |
| [ ] | S1 | `settings-migration` | Page renders two <h1> elements (topbar + its own hand-rolled title) — a11y duplicate-heading defect, same recurring pattern as invoices/[id], settings, and invoices/recurring/new. | Change the page's own <h1> at line 226 to <h2>. |
| [ ] | S1 | `finance-payments-id` | Page renders two <h1> elements (topbar + hand-rolled page title "Payment") — a11y duplicate-heading defect, the same recurring pattern seen on invoices/[id], settings, invoices/recurring/new, and settings/migration. | Change the page's own <h1> at line 112 to <h2>. |
| [ ] | S1 | `shipments` | Page renders two <h1> elements with identical text (topbar + hand-rolled page title) — a11y duplicate-heading defect, the same recurring pattern seen across this slice (invoices/[id], settings, invoices/recurring/new, settings/migration, finance/payments/[id]). | Change the page's own <h1> at line 77 to <h2>. |

### L1 — Wrap clipped tables in `overflow-x-auto` (content currently unreachable)

**3 findings across 3 files.** Risk: low — markup-only wrapper.

| ✓ | Sev | Page | Problem | Fix |
| --- | --- | --- | --- | --- |
| [ ] | S0 | `suppliers` | At 1024px the supplier table is 64px wider than its host with no scroll wrapper; main is overflow-x-hidden so table content is clipped rather than reachable — not visible as a hard edge in the screenshot because the browser instead force-wraps supplier names to 2-3 lines to compensate. | Wrap the <table> in <div className="overflow-x-auto">. Markup only, no logic change. |
| [ ] | S0 | `finance-payments` | At 1024px the 10-column payments table is wider than its host with no scroll wrapper; the trailing Actions column is clipped off and unreachable. | Wrap the <table> in <div className="overflow-x-auto">. Markup only, no logic change. |
| [ ] | S0 | `finance-expenses` | The 11-column vendor-bills table is wider than its container at 1024px with no overflow wrapper; main is overflow-x-hidden so right-side columns (Paid/Balance/Status/eye icon) are clipped and unreachable, and headers wrap raggedly under the compression. | Wrap the <table> in <div className="overflow-x-auto">. Markup only, no logic change. |

### L2 — Standardise the page container (`PageShell`)

**4 findings across 4 files.** Risk: low — outer wrapper class only.

| ✓ | Sev | Page | Problem | Fix |
| --- | --- | --- | --- | --- |
| [ ] | S0 | `customers-id` +4 | main reserves pb-24 specifically so bottom-anchored floating UI (PwaInstallPrompt) never covers page content (see the comment at layout.tsx:1132-1138), but DraftDock is not covered by that same clearance and visibly overlaps in-flow cards on this page. | Give DraftDock the same bottom clearance treatment as PwaInstallPrompt (respect main's pb-24 / raise the dock above reserved space) so it stops sitting on top of page content; no change to dock behaviour. |
| [ ] | S1 | `invoices-new` | Bottom padding is applied twice: 96px from <main> plus another 96px from the page's own wrapper, stacking to 192px of dead space below the form on every step of the new-invoice flow. | Drop the page-level pb-24 wrapper (or the outer <div> entirely) at lines 461/556/1283 and rely on main's existing pb-24. Markup only. |
| [ ] | S3 | `finance-payments` | Vertical rhythm between page sections is 24px here vs the 20px (space-y-5) used on every other list-style page in this slice. | Change the shell wrapper from space-y-6 to space-y-5 to match peer pages. |
| [ ] | S3 | `invoices-recurring-new` | This create-form page has no width cap, so short-content fields (Day of Month, Frequency dropdown) stretch to the full column width at 1440 instead of sizing to their content, unlike the settings page which constrains form width. | Add a max-width wrapper (e.g. max-w-5xl, matching settings/page.tsx) around the form content so narrow fields stop stretching full-bleed. |

### L3 — Adopt the shared `PageHeader`

**1 findings across 1 files.** Risk: MEDIUM — changes DOM nesting; e2e xpath gate applies.

| ✓ | Sev | Page | Problem | Fix |
| --- | --- | --- | --- | --- |
| [ ] | S3 | `finance-dashboard` | Card title and its inline legend don't reflow together at 1024 — the wrapped title fragment ("Expenses") collides visually with the adjacent legend row, reading as run-together text. | Stack the legend under the title (flex-col) below the breakpoint where the title would wrap, instead of keeping them on one flex row. Markup/CSS only. |

### L4 — Token conformance — radius / shadow / scrim (one PR per family)

**1 findings across 1 files.** Risk: MEDIUM — blocked until the Modal.tsx e2e re-selector PR lands.

| ✓ | Sev | Page | Problem | Fix |
| --- | --- | --- | --- | --- |
| [ ] | S2 | `orders-id` | Both modals on this page use bg-black/40 for the scrim instead of the sanctioned bg-ink-900/40 token. | Swap bg-black/40 for bg-ink-900/40 in both modal wrappers. |

### L6 — Density, alignment, whitespace, button placement

**12 findings across 12 files.** Risk: judgement — smallest batches, last.

| ✓ | Sev | Page | Problem | Fix |
| --- | --- | --- | --- | --- |
| [ ] | S0 | `customers-id` | The customer-detail tab bar does not fit at 1024px and pushes main into page-level horizontal overflow; since <main> is overflow-x-hidden, the trailing tabs (Documents, Licenses) are unreachable at this width. | Let the tab row scroll horizontally (overflow-x-auto, no wrap) at narrow widths so it stays inside main's content box; no change to tab behaviour. |
| [ ] | S0 | `inventory` | At 1024 the toolbar's button group doesn't wrap under the parent's flex-wrap the way it does at 1280; it overflows main's content box instead. main is overflow-x-hidden so the tail of the button row is clipped and the Quick Restock button is partially unreachable. | Let the button group itself wrap (add flex-wrap to the `flex gap-2` div around the six toolbar buttons, apps/web/app/(dashboard)/inventory/page.tsx ~line 2699) or move it to its own row below the count text at this breakpoint. Markup only. |
| [ ] | S2 | `settings-import` | The document-numbering PREVIEW column is too narrow at 1024, truncating the one piece of information that row exists to show. | Give the PREVIEW column a min-width or let the row wrap instead of squeezing PREVIEW below its content width. |
| [ ] | S3 | `suppliers` | Supplier rows render at 61px vs the 44px compact operator density documented in the rubric's tokens and vs 41px on the peer Reports table. | Reduce vertical cell padding on supplier rows to match the 44px compact row height used elsewhere. |
| [ ] | S3 | `returns` | Leftover bare FileText icon from before EmptyState was adopted renders redundantly on top of EmptyState's own illustration, producing two icons where every peer empty state (e.g. Promotions) shows one. | Move the <FileText> icon inside only the hasActiveFilters branch (the "no results match filters" case), not the shared wrapper, so the no-active-filters branch shows only EmptyState's illustration. |
| [ ] | S3 | `settings-batch-import` | The header action buttons aren't sized/constrained for their label at 1024, so their text wraps and the two buttons end up different heights side by side. | Add whitespace-nowrap (or a min-width) to the two header buttons so they stay single-line at 1024 like they do at wider widths. |
| [ ] | S3 | `inventory-stock-counts-id` | Numeric/currency columns on this table are left-aligned while the equivalent numeric column on the Payments Received table is right-aligned, so number columns don't scan consistently across the app. | Right-align the Expected/Counted/After/Variance/$-at-avg-cost/Unit-cost header and cell text (text-right / tabular-nums), matching the Payments table convention. |
| [ ] | S3 | `estimates` | The estimates list toolbar wraps into a ragged second row at 1024 while sibling list pages keep their filter row intact. | Let the date-range group wrap as a unit with the rest of the toolbar (flex-wrap with consistent gap), or drop it to always sit on its own row instead of only at this one breakpoint. |
| [ ] | S3 | `routes` | Stops is a numeric column but is left-aligned, inconsistent with the right-aligned numeric convention used on the Inventory table. | Add text-right (and tabular-nums) to the Stops header and cell in routes/page.tsx's column def. Markup only. |
| [ ] | S3 | `finance-dashboard` | At 1024 the stat row's big numbers are no longer baseline-aligned across the 4 cards — the last card's value is visibly lower than its peers. | Either shrink the grid to 2x2 below a breakpoint or give the label row a fixed min-height so all 4 values sit on the same baseline regardless of label wrap. Markup/CSS only. |
| [ ] | S3 | `inventory-movements` | Long product/variant names wrap unbounded in the Product column, producing sharply ragged row heights within the same table instead of a consistent row height. | Constrain the Product name span with a max-width + truncate (title attr for full text on hover), matching how other tables in the app clip long cell text. Markup only. |
| [ ] | S3 | `dashboard` | The stat-card row is less readable at the wider xl breakpoint than at the narrower lg one — cramming 6 cards into one row leaves no room for their own labels, while the same component fits fine one step down at 3-per-row. Inconsistent with its own peer state. | Widen the xl:grid-cols-6 track or drop to xl:grid-cols-4/5 so StatCard labels stop truncating at 1280/1440, matching how they already render at 1024. |

## ⚠️ Could not judge — thin demo data (1)

These screens had too little data to judge density or whitespace honestly. Re-run against `routeflow-demo` to cover them.

`credit-notes`

## Noted, deliberately NOT fixing (1)

Would require a redesign or a behaviour change — outside what you asked for.

| Page | Observation |
| --- | --- |
| `credit-notes` | DATA_THIN — capture tenant has only 1 credit note, so the large gap below the table can't be judged as a real density/whitespace defect. |
