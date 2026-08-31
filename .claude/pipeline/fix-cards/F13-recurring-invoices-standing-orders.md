# F13 · Recurring invoices and standing orders

**Bug IDs (5):** B09, B46, B48, B92, B106

**Root cause:** The two daily crons. calcNextRunAt's MONTHLY branch has dead month-advance code, so every monthly template re-fires EVERY midnight with autoSend emailing a fresh invoice daily (B46); template-generated orders bill raw list price, ignoring tier, overrides and promotions (B48); a failed cycle is claimed and then silently skipped (B106).

**Ships as:** One PR.

**Files:** recurring-invoices.service.ts · order-templates.service.ts · web recurring pages · StandingOrderModal.tsx

**Together because:** Both are daily-cron pricing/scheduling defects with the same shape (dead branch / wrong basis / swallowed failure).

**Guardrails / shared infra:** None new.

**Dependencies / lane notes:** Requires F01 (semantic — needs RecurringInvoice.lastRunStatus/lastError column). No lane conflicts — freely parallel.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F13.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B09  | T2   | 2d0270fd       | OUT_OF_BOUNDS       |
| B46  | T1   | e5b0af8e       | OUT_OF_BOUNDS       |
| B48  | T1   | e5b0af8e       | OUT_OF_BOUNDS       |
| B92  | T2   | e5b0af8e       | OUT_OF_BOUNDS       |
| B106 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B09 — Standing-order edits silently drop item changes

**Area:** Orders / standing orders · web

**Meant to do:** Editing a standing order should let the operator update days/name/notes and also add, remove, or adjust quantities of product line items, since the modal shows a full product UI.

**Actually does:** In edit mode the same interactive product search/add/remove/qty-stepper UI renders and updates local state, but handleSubmit's isEditing branch only calls updateTemplate.mutate({id,name,daysOfWeek,notes}) — items are never sent.

**The gap:** Any item add/remove/qty change made while editing is silently discarded on save; useAddTemplateItem/useRemoveTemplateItem exist but are called from zero UI in web or mobile.

**Evidence:** apps/web/app/(dashboard)/customers/[id]/StandingOrderModal.tsx: item UI unconditionally rendered lines 301-392 (no isEditing gate); handleSubmit isEditing branch lines 179-194 omits items; apps/web/lib/api/order-templates.ts lines 92 & 107 define useAddTemplateItem/useRemoveTemplateItem — repo-wide grep for both names finds only these two definitions (plus mobile's own unused copies at apps/mobile/lib/api/order-templates.ts:131,144), no callers anywhere

**Suggested fix:** Either hide/disable the product-item controls while isEditing (make edit mode name/days/notes-only, matching what actually saves) or wire handleSubmit's edit path to diff lineItems against template.items and call useAddTemplateItem/useRemoveTemplateItem (or extend the PATCH DTO to accept items) so the visible changes persist.

### B46 — MONTHLY recurring invoices re-fire every midnight — a duplicate invoice (and email) per day

**Area:** apps/api/src/recurring-invoices

**Meant to do:** A MONTHLY template generates one invoice per cycle: after it fires, nextRunAt advances to next month's dayOfMonth so the midnight cron leaves it alone until then.

**Actually does:** calcNextRunAt's MONTHLY branch calls d.setDate(1) before testing `d.getDate() > dom`, so that test always compares 1 against dom and is always false — the month-advance is dead code and the function returns a date in the SAME month, at or before the day it just ran on.

**The gap:** nextRunAt never moves strictly past `now`, so the cron's `nextRunAt <= now` filter re-selects the same template every midnight; with autoSend on, the customer is emailed a fresh invoice daily, indefinitely.

**Evidence:** apps/api/src/recurring-invoices/recurring-invoices.service.ts:27-38 (dead month-advance branch), :169-198 (advanced value is the sole cycle guard in the CAS claim), :227-251 (EVERY_DAY_AT_MIDNIGHT cron, `nextRunAt lte now`), :205-214 (autoSend email); dto/create-recurring-invoice.dto.ts:31 caps dayOfMonth to 1-28, so "tomorrow" lands in the same month essentially always — this is the default outcome, not an edge case. Traced: nextRunAt 2026-07-15, dom 15 -> d=07-16 -> setDate(1)=07-01 -> `1>15` false -> returns 2026-07-15 unchanged. recurring-invoices.service.spec.ts:184 asserts only `toBeInstanceOf(Date)`, never the value, so nothing catches it.

**Suggested fix:** Decide the month rollover from the pre-setDate(1) date (compare the candidate against `from`), advance a month whenever the candidate isn't strictly in the future, then clamp to min(dom, daysInThatMonth). Assert the returned Date value across two consecutive cycles in the spec.

### B48 — Standing-order reorder bills raw list price — ignores buyer tier, price overrides and promotions

**Area:** apps/api/src/order-templates — createOrderFromTemplate

**Meant to do:** An order generated from a standing-order template (buyer "Reorder Now" or the daily 6am cron) should bill each line at the price the buyer would get shopping manually: their pricing tier, any CustomerPrice override, any active promotion.

**Actually does:** createOrderFromTemplate prices every line at raw `product.pricePerUnit` and calls computeLineSubtotal with it — no tier lookup, no CustomerPrice, no promotion resolution anywhere in the function.

**The gap:** Every template-generated order bills full list price, silently overcharging any customer with a discounted tier, a negotiated override, or an active promotion on a templated product — on the buyer's own reorder tap and automatically every morning.

**Evidence:** apps/api/src/order-templates/order-templates.service.ts:309-372 (unitPrice = Number(product.pricePerUnit), no tier/promo lookup), :217-233 (generateOrder), :251-307 (@Cron('0 6 * * *') generateDailyOrders); reachable from apps/api/src/buyer/buyer.controller.ts:742-757 (POST reorder). Contrast the tier+promo pipeline used everywhere else: apps/api/src/buyer/buyer-catalog.service.ts:193-207 and apps/api/src/orders/orders.service.ts:119-174, :1742-1753 (resolveBuyerLinePrice).

**Suggested fix:** Have createOrderFromTemplate resolve each line through the same path as resolveBuyerLinePrice (customer pricingTier / CustomerPrice override, then applyBestPromotion) instead of reading product.pricePerUnit directly.

### B92 — Recurring invoice templates cannot be edited after creation

**Area:** apps/web/app/(dashboard)/invoices/recurring

**Meant to do:** After creating a recurring template, an operator can open it to fix a typo, change a line price, or move its schedule from weekly to monthly — without deleting and rebuilding it.

**Actually does:** The list page renders only Run Now and Pause/Activate per card; only the list and new routes exist, with no [id] route. The typed useRecurringInvoice / useUpdateRecurringInvoice hooks and a working PATCH /recurring-invoices/:id (real service update, item replacement included) exist and are never called from any component.

**The gap:** A fully working backend PATCH and fully typed frontend hooks with no UI reaching them — dead on the client for anything beyond create/list/toggle/run.

**Evidence:** apps/web/app/(dashboard)/invoices/recurring/page.tsx:1-196 (no edit affordance; directory holds only page.tsx and new/page.tsx); apps/web/lib/api/invoices.ts:754-771, :787-824 (hooks defined, no callers); apps/api/src/recurring-invoices/recurring-invoices.controller.ts:40-43 backed by recurring-invoices.service.ts:103-123 (frequency/schedule/notes/terms/discount/shippingFee/items all patchable).

**Suggested fix:** Add an /invoices/recurring/[id]/edit route loading via useRecurringInvoice and submitting through useUpdateRecurringInvoice, and link each list card to it.

### B106 — Recurring cycle claimed before invoice creation — a failure silently skips the bill while "Last run" says it ran

**Area:** Recurring invoices · API cron + web

**Meant to do:** Every due recurring template bills its customer once per cycle; a generation failure should be visible so someone re-runs it (the code comment says "recoverable via runNow").

**Actually does:** nextRunAt/lastRunAt are stamped first (:174-178); if invoicesService.create then throws, the cron's catch only logs and totalFail is never persisted. The UI renders the fresh lastRunAt as positive confirmation.

**The gap:** Cycle consumed, no invoice, no error column or status flag on RecurringInvoice, no retry — the customer is simply never billed for the period.

**Evidence:** apps/api/src/recurring-invoices/recurring-invoices.service.ts:174-182 (CAS claim stamps nextRunAt+lastRunAt before create), :184-198 (create afterwards), :249-258 (log-only catch), :263-265 (totalFail logged, never stored); apps/api/src/invoices/invoices.service.ts:527-531 (create() really throws ConflictException on P2002); apps/api/prisma/schema.prisma:2746-2768 (RecurringInvoice has no error/status field beyond isActive); apps/web/app/(dashboard)/invoices/recurring/page.tsx:163-167 (renders lastRunAt as "Last run").

**Suggested fix:** Persist the failure on the template (lastError/lastRunStatus) and surface it in the recurring list; optionally roll the claim back (or auto-runNow retry) on create failure inside a compensating step.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
