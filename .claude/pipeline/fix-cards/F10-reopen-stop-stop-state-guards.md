# F10 · reopenStop and stop-state guards

**Bug IDs (6):** B54, B55, B71, B72, B120, B121

**Root cause:** reopenStop checks a dead model for payments (B54) and credits back stock delivery never decremented (B55) — same function, same transaction. Its neighbours have no from-state guard at all (B71, B72) and the POD artifact endpoint lets anyone overwrite a completed regulated signature (B121).

**Ships as:** One PR.

**Files:** routes.service.ts (reopenStop, updateStopStatus, updateRunStatus, attachPodArtifact) · dto/update-run-status.dto.ts

**Together because:** Same function, same transaction (B54/B55); same missing guard pattern across neighbouring stop-state transitions.

**Guardrails / shared infra:** None new. Consumes G7's extracted lineItems const.

**Dependencies / lane notes:** Requires F05 (semantic, consumes G7's const) and F02b (positional — F02b rewrites deleteRoute, different region, mechanical rebase). Serialized after F05 in the routes.service.ts lane (F02b -> F05 -> F10 -> F11 -> F12 -> F22+F24).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F10.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B54  | T1   | e5b0af8e       | MOVED (corrected)            |
| B55  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B71  | T1   | e5b0af8e       | MOVED (corrected)            |
| B72  | T1   | e5b0af8e       | MOVED (corrected)            |
| B120 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED          |
| B121 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED          |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B54 — reopenStop's payment block checks a dead model — at-door cash survives the reopen

**Area:** apps/api/src/routes/routes.service.ts + apps/api/src/invoices

**Meant to do:** reopenStop refuses to reopen a stop whose delivery already has money recorded against it — its own comment says exactly this — or reverses the payment along with the stock.

**Actually does:** The guard queries the legacy `transaction` model. There is no `.transaction.create(...)` writer anywhere in apps/api/src; the live at-door flow writes InvoicePayment via recordDeliveryPaymentInTx and flips the invoice to PAID. The guard therefore always finds zero rows and always passes, and the reopen transaction body never references Invoice or InvoicePayment.

**The gap:** Stock, items, order and stop are reversed while the PAID invoice and its InvoicePayment stand against an order the system now says was never delivered. On re-completion recordDeliveryPaymentInTx finds no PAYABLE invoice (PAID is excluded), returns applied:0, and the caller only logger.warn's — a second at-door collection is unrecorded cash.

**Evidence:** apps/api/src/routes/routes.service.ts:~2271 [re-anchored master@6c8f1401; was :2090-2103 at hunt round master@e5b0af8e] (guard reads legacy `.transaction.findMany`), :2105-2197 (reopen tx, no Invoice/InvoicePayment reference); repo-wide grep for `.transaction.create` in apps/api/src returns zero hits; apps/api/src/invoices/invoices.service.ts:4401-4531 (the real writer, InvoicePayment.create at :4513; PAYABLE list at :4419-4424 excludes PAID); apps/api/src/routes/routes.service.ts:1769-1788 (re-completion warn-only); routes.controller.ts:272-281 (no controller-level payment guard).

**Suggested fix:** Check for a live InvoicePayment against the stop's orders' invoices (payments relation with status != VOID, or invoice.status in PAID/PARTIAL) instead of the legacy model — or void the payment and reverse the invoice atomically inside the same reversal transaction.

### B55 — reopenStop credits back stock that delivery never decremented — every reopen inflates inventory

**Area:** apps/api/src/routes/routes.service.ts

**Meant to do:** currentStock is settled once at order creation and re-settled only by item edits (the codebase's own documented convention), so a reopen + re-deliver cycle must be stock-neutral: delivery itself writes no stock.

**Actually does:** reopenStop's mutation loop unconditionally writes a positive SALE StockMovement and increments Product.currentStock by the delivered qty for every DELIVERED/PARTIAL mutation on the stop — reversing a decrement that never happened.

**The gap:** Each reopen + re-deliver cycle permanently inflates currentStock by the delivered qty and mints an uncosted positive SALE row into COGS. It is a pure double-credit, not a reversal.

**Evidence:** apps/api/src/routes/routes.service.ts:2110-2152 (StockMovement type SALE qty>0 at :2135-2146, currentStock increment at :2147-2150), :1465-1631 (completeStop — no stock write anywhere in the tx); repo-wide grep confirms `stockMovement.create{type:'SALE'}` occurs only at routes.service.ts:2125/2138, both inside reopenStop, and no writer creates a negative SALE at delivery time; apps/api/src/orders/orders.service.ts:1894-1902 (create() decrement, the sole settlement), :3666-3714 (doc comment: "completeStop writes no stock ... currentStock is settled at order time and re-settled here on edit, and nowhere else").

**Suggested fix:** Remove the stock write from reopenStop's reversal loop entirely — there is nothing to reverse; reset only order/item/stop/mutation state.

### B71 — A COMPLETED stop can be flipped to SKIPPED, defeating the delivered-order demotion guard

**Area:** apps/api/src/routes/routes.service.ts — updateStopStatus

**Meant to do:** COMPLETED is exited only via reopenStop, which reverses the delivery's mutations, stock and payment; the delivered-order demotion guard relies on stop.status faithfully reflecting whether those effects still stand.

**Actually does:** updateStopStatus applies {IN_PROGRESS, SKIPPED} after only a driver-ownership check — it never reads stop.status or run.status, so a COMPLETED stop can be PATCHed straight to SKIPPED. The demotion guard then tests only `stop?.status === 'COMPLETED'`, which is now false, so DELIVERED -> CONFIRMED proceeds without being redirected to reopenStop.

**The gap:** updateStopStatus has no from-state guard at all, unlike its siblings: reopenStop refuses unless the stop is COMPLETED/SKIPPED, and completeStop refuses an already-COMPLETED stop. A completed delivery can silently escape into SKIPPED with none of its side effects reversed.

**Evidence:** apps/api/src/routes/routes.service.ts:1394-1422 (updateStopStatus — driver check then unconditional update), :2057-2072 [re-anchored: routes.service.ts now ~L2236 on master@6c8f1401; was :2057-2072 at hunt round master@e5b0af8e] (reopenStop's from-state guard), :1491 (completeStop's guard); apps/api/src/orders/orders.service.ts:2199-2213 (demotion guard fires only on COMPLETED); apps/api/src/routes/routes.controller.ts:221-231 (PATCH :id/stops/:stopId, body typed as a plain TS interface rather than a validated DTO).

**Suggested fix:** Reject the transition (409/400) when stop.status is COMPLETED or run.status is COMPLETED/CANCELLED, pointing the caller at reopenStop — the same guard reopenStop already applies.

### B72 — Route-run status endpoint has no transition matrix and no driver-ownership check

**Area:** apps/api/src/routes/routes.service.ts — updateRunStatus, completeStop

**Meant to do:** A run moves SCHEDULED -> IN_PROGRESS -> COMPLETED with CANCELLED terminal, and a DRIVER can only move a run assigned to them — the pattern updateStopStatus and reopenStop already enforce.

**Actually does:** updateRunStatus never loads the caller's driver record and never compares it to run.driverId; for a DRIVER it restricts only the TARGET status to IN_PROGRESS/COMPLETED, and imposes no FROM-state restriction for anyone. The DTO is a bare @IsEnum with no matrix, so COMPLETED -> SCHEDULED and CANCELLED -> IN_PROGRESS both go through. completeStop looks up the caller's driver row but likewise never compares it to run.driverId.

**The gap:** Two run/stop mutation entry points omit the ownership and from-state checks their siblings carry: any tenant driver can hijack another driver's run and complete its stops, and a CANCELLED run can be resurrected and delivered. CANCELLED is only ever set through this same unguarded endpoint, and its branch performs no side-effect reset on the linked orders.

**Evidence:** apps/api/src/routes/routes.service.ts:1342-1392 (updateRunStatus, no driver lookup, no from-state check), :1465-1639 (completeStop — driver fetched at :1500-1503, never compared), contrast :1405-1415 (updateStopStatus isolation check) and :2075-2081 [re-anchored: routes.service.ts now ~L2236 on master@6c8f1401; was :2075-2081 at hunt round master@e5b0af8e] (reopenStop's); apps/api/src/routes/dto/update-run-status.dto.ts:1-6 (bare IsEnum); apps/api/src/routes/routes.controller.ts:261-270; apps/api/prisma/schema.prisma:92-97 (RouteRunStatus incl. CANCELLED).

**Suggested fix:** For a DRIVER caller, require run.driverId === driver.id in both updateRunStatus and completeStop (mirroring updateStopStatus/reopenStop), and add a from -> to transition matrix rejecting anything sourced from CANCELLED and COMPLETED -> SCHEDULED.

### B120 — reopenStop nulls durable POD keys — evidence unrecoverable, storage objects orphaned

**Area:** Routes · POD lifecycle

**Meant to do:** Undoing a completed stop resets delivery state; the previously captured signature and photos should be retained for audit or explicitly deleted, not silently orphaned.

**Actually does:** Reset block sets signatureUrl:null and podPhotoUrls:[] with no storage deletion anywhere in the file; getStopPod reads only those columns, so the POD becomes unreachable while the compressed objects persist forever.

**The gap:** Since #477 these columns are the sole pointers to real stored artifacts; one undo tap destroys regulated-delivery evidence and leaks files, with no record of what was discarded.

**Evidence:** apps/api/src/routes/routes.service.ts:2352-2367 (reset), 1497-1526 + 1583-1586 (columns now storage keys, #477 = 9f00684d), 1595-1634 (getStopPod reads only these columns); grep '.delete(' in the file -> only routeStop/route/routeRun rows, never this.storage. No register duplicate (B54/B55 are reopenStop payment/stock; the POD register entry is the web read-surface gap).

**Suggested fix:** On reopen, archive the old keys (e.g. a podHistory JSON field or audit payload) or delete the storage objects; never just null the pointers. Keep the deliberate reset of ageVerified/identityVerified flags.

### B121 — pod-artifact endpoint lets anyone in-tenant replace a completed regulated stop's signature

**Area:** Routes · POD API

**Meant to do:** The at-door signature satisfying the regulated-delivery gate should be immutable once the stop is COMPLETED, or only appendable with a trail.

**Actually does:** attachPodArtifact checks only run/stop existence — no stop-status, run-status, or driver-assignment guard; any new artifactId bypasses the idempotency match and overwrites signatureUrl unconditionally, months after completion.

**The gap:** Any tenant OPERATOR or DRIVER can substitute the compliance signature; web shows the new image beside unchanged 'Age verified' chips and the original key is unrecoverable.

**Evidence:** apps/api/src/routes/routes.service.ts:1553-1588 (existence checks only; :1567-1578 idempotency matches same artifactId only; :1585 unconditional signatureUrl write), 1645-1662 (contrast: completeStop's guards); apps/api/src/routes/routes.controller.ts:225-233 (@Roles(OPERATOR, DRIVER), no driver-run binding); apps/api/src/common/regulated-delivery.ts:167-174 (signature is the gate, existingSignatureUrl fallback accepts pre-attached artifacts).

**Suggested fix:** Reject kind:'signature' when the stop is COMPLETED and a stored signature exists under a different artifactId (photos may stay appendable); add the driver-assignment check reopenStop already has. The documented offline-replay case still works via the same-artifactId idempotent path.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
