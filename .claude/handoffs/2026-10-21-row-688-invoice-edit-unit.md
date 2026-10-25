# Row 688: invoice edit form mixes units (handoff 2026-10-21, Mac mini lane)

> **DONE (pushed, no PR yet):** per the lead, re-cut from master 67b76cb7d (not #3542).
> origin/fix/row-688-invoice-edit-unit = c483b6b88927116b571aa285e182076cc156541c; red observed, then green; counts sent to the lead.
> PR: https://github.com/najathakram/routeflow/pull/3564 (base master, not draft); Opus review + SA read pending.
> Don't move the sha unless a review asks. Open: the "Prints as N pcs" hint goes in #3542.
> Gotcha: a reused worktree's built @routeflow/pricing goes stale. Rebuild `turbo run build --filter='./packages/*'` before trusting a red (an NSF tax test failed on it).

**Owner:** Mac mini lane (lead-assigned). Tier 1 money, so it runs through **bug-pipeline**. Lands IN #3542
(`feat/sa827-invoice-display-units` @ 4127b3a0d, draft) before it merges.
**Tree:** ~/code/rf-wt-r3img, branch `fix/row-688-invoice-edit-unit` at 4127b3a0d (upstream = origin/feat/sa827-invoice-display-units).
The R3 stack is stopped and its `.next` cleared (R3 shipped). Disk is ~20 GB, RAM ~400 MB: one heavy job at a time.

**Root cause (read, not yet proven red):** `apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx`. A boxed line
(`boxes != null`, upb > 1) hydrates `qty` as TOTAL PIECES (line ~597) and renders one `Qty` DecimalInput (decimals 3,
~1016) beside `Unit Price` = the BOX price (~1026). That's how 48.000 sits beside 21.60. The totals (`toTotalsLine` →
computeInvoiceTotals) and the save (`lineSplit` → boxes/pieces, ~711) prorate correctly, so the subtotal reads $43.20.
#3542 does not touch edit/page.tsx, so this is on master too. Still to observe red: whether any path posts
qty 48 without boxes/pieces (e.g. a line with no productId: see `it.unitsPerBox && it.productId` at ~724).

**SA ruling (SA-827 §1/§4/P7):** the edit form ALWAYS edits the STORED line in its sold unit. Boxes + loose pieces
(split by normalizeBoxesPieces at the line's OWN stored unitsPerBox), the box price as stored, and the subtotal from
computeLineSubtotal: "2 box (24) + 0 pcs × $21.60 / box = $43.20". Optional read-only hint for a pieces customer:
"Prints as 48 pcs" (via invoiceDisplayLines / invoiceLineDisplay, display only). Save posts qty = boxes×upb+pieces,
boxes, pieces, the box unitPrice and the stored unitsPerBox. No conversion from any displayed figure. The display
resolver must NOT be imported into the edit/save path; extend the P7 pin (apps/api/src/common/invoice-unit-display-only.spec.ts) to the edit form.

**Red-first tests (SA list):**
1. A pieces customer's 2-box line opens as 2 box @ $21.60; saving it unchanged gives an identical row.
2. 3 box gives qty 72, $64.80.
3. 50 pcs gives 2 box + 2 pcs, prorated by computeLineSubtotal.
4. Mobile edit mirrors web.

**Lead rules:** report the red as observed; full jest of each touched workspace + lint at --maxWorkers=4 through the
heavy slot; HEAD commit carries `Bookkeeping-Follow-Up: pending`; no code-map or lessons edits; push through the real
hooks; report sha + test counts to Routeflow Lead. No pkill. No client names (the fixture tenant in the shots is
local-assets only). Shots: local-assets/apple-ux/2026-10-21-3542/pieces-edit-1440.png.
**After 688:** R7b counter sales (card 2026-10-20-counter-ux-lane.md).
