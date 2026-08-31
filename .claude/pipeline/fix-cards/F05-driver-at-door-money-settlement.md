# F05 · Driver at-door money and settlement

**Bug IDs (5):** B49, B83, B148, B152, B167

**Root cause:** The route-run payload never sends subtotal/boxes/pieces/unitsPerBox, so four driver screens re-derive qty × unitPrice and over-collect on every boxed stop; the excess is then dropped with a warn log. B148 is a DTO/payload mismatch that 400s every stop completion.

**Ships as:** One PR.

**Files:** routes.service.ts (lineItems select, recordDeliveryPaymentInTx caller) · routes/dto/complete-stop.dto.ts · apps/mobile/app/(driver)/route/** · runSettlementStore.ts

**Together because:** One server payload change fixes all four client sites at once, and B148 must land with them or none of it is reachable.

**Guardrails / shared infra:** Delivers G7 — consolidate the route-run lineItems select. The literal `{ id, productId, product, qty, unitPrice, status }` has two unrefactored copies, BOTH inside findOneRun (main query ~:1147 and its own "fallback for unlinked orders" block ~:1253). getPackingList (:2034+) has no copy (narrower include-only shape, no qty/unitPrice/status). A third occurrence at :87 already lives inside the shared RUN_STOP_INCLUDE const (declared :64, reused at :1076 and :2180) and needs no extraction. So the job is a single-function hoist plus consolidation into the existing constant, not a cross-function extraction. B49's fix adds subtotal/boxes/pieces/unitsPerBox to it.

**Dependencies / lane notes:** Requires F04 (semantic, corrected pricing kernel). Must land before F10, F11, F12, F22 (semantic — they consume the extracted lineItems const).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F05.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B49  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B83  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B148 | T1   | 0b2c3a0a       | FILE_NOT_FOUND               |
| B152 | T1   | 0b2c3a0a       | AMBIGUOUS_FILE               |
| B167 | T2   | 0b2c3a0a       | OUT_OF_BOUNDS                |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B49 — Driver at-door totals re-derive qty x unitPrice — boxed stops overcharged, including the cash collected

**Area:** apps/mobile/app/(driver)/route/** + apps/api/src/routes/routes.service.ts

**Meant to do:** The driver app's route value, per-stop amount due, at-door payment total and return-screen original total should all reflect the order's real box-aware subtotal — the same figure the office invoice shows.

**Actually does:** All four figures compute `qty * unitPrice` straight off route-run line items, and the API's route-run select never sends subtotal/boxes/pieces/unitsPerBox for those lines, so nothing correct is even available to compute from. For a boxed line (qty in pieces, unitPrice = box price) every figure is inflated by roughly unitsPerBox.

**The gap:** The driver is shown, and prompted to collect, an inflated amount at any stop with a boxed line — and that inflated figure is what is posted to the server as payment.amount.

**Evidence:** apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:68-72 (fullOrderTotal), :111-118, :239 (`collected = Math.min(receivedNum, invoiceTotal)`); apps/mobile/app/(driver)/route/index.tsx:174-177; apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx:173-176; apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx:117-121. Root cause server-side: apps/api/src/routes/routes.service.ts:1125-1140 (lineItems select = id/productId/product/qty/unitPrice/status only) matching apps/mobile/lib/api/routes.ts:21-22. The correct box-aware helper exists and is unused here: apps/mobile/lib/pricing.ts:152-171.

**Suggested fix:** Add subtotal (or boxes/pieces/unitsPerBox) to the route-run lineItems select, and replace every `qty * unitPrice` sum in the four driver files with `li.subtotal` / computeLineSubtotal.

### B83 — Driver-collected cash above the server's delivered-basis total is dropped with only a warn log

**Area:** apps/api/src/routes delivery payment + driver payment screen

**Meant to do:** Every dollar a driver reports collecting at the door lands in a financial record — a payment, a credit, or an explicit overage/advance — so end-of-day cash reconciles against the system.

**Actually does:** recordDeliveryPaymentInTx spreads the lump sum oldest-first, capped at each payable invoice's remaining balance, and returns `applied < amount`. The caller logs "collected X but only Y applied ... remainder unrecorded" and does nothing else — no InvoicePayment, no AdvancePayment, no record of any kind for the difference.

**The gap:** The client's collected-amount cap is its own pre-delivery/full-order estimate, not the server's post-reconcile DELIVERED-basis total, so the two routinely diverge (see B49 and B50) and the excess simply disappears. The manual allocations flow has an explicit "excess -> AdvancePayment" branch; this path has no equivalent.

**Evidence:** apps/api/src/routes/routes.service.ts:1769-1788 (warn-only, no compensating write); apps/api/src/invoices/invoices.service.ts:4401-4553 (per-invoice cap at :4488-4505, leftover never persisted at :4550-4553), contrast :4908+ (the manual flow's excess -> AdvancePayment branch); apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:105-118 (reconciledTotal used only once short-pick lines exist AND the richer order has loaded; other orders on a multi-order stop always contribute the full ordered total), :239 (collected capped at the client's own estimate).

**Suggested fix:** When applied < amount, book the remainder as an AdvancePayment (or a dedicated driver-overage record) against the customer instead of only logging it, so the cash is traceable and can be applied or refunded.

### B148 — Driver stop completion always 400s — deliveries[].productId is not declared on the DTO

**Area:** Driver stop completion · mobile + API

**Meant to do:** A driver marks items delivered, captures signature and photos, taps Complete, and the server closes the stop — writing delivery mutations, reconciling the invoice on the delivered basis, and taking any at-door payment.

**Actually does:** Every deliveries[] element the app sends carries productId, which RunDeliveryDto does not declare. The global pipe's forbidNonWhitelisted applies inside @ValidateNested children, so the request is rejected with a 400 before the service ever runs.

**The gap:** Payload and DTO disagree on one property, and whitelist validation recurses into nested arrays — so the driver's only stop-closing action is unreachable.

**Evidence:** apps/api/src/routes/dto/complete-stop.dto.ts:18-23 (RunDeliveryDto = orderItemId/type/quantityDelivered/note) and :36-40 (@ValidateNested({each:true})); complete-with-payment.dto.ts:22-26; apps/api/src/main.ts:180-186 (whitelist + forbidNonWhitelisted, with no @UsePipes override in routes.controller.ts); routes.controller.ts:209-220; payload side: apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:189-215 and :278-294, apps/mobile/lib/short-pick.ts:52-66, apps/mobile/lib/api/routes.ts:245-251 and :288-303; productId is genuinely populated (routes.service.ts:1143-1152, :1249-1257). Runtime proof: class-validator validateSync with whitelist and forbidNonWhitelisted over classes replicating these decorators returns whitelistValidation "property productId should not exist". git log -S shows the DTO landed in #157 and the productId payload in #270 — the payload broke the contract after the DTO existed.

**Suggested fix:** Add @IsOptional() @IsString() productId?: string | null to RunDeliveryDto (the service already ignores it) or strip productId from the mobile payload before posting.

### B152 — Run settlement is gated on a RAM-only tally, so a mid-run app restart makes the reconciliation step vanish

**Area:** Run settlement · mobile driver + API

**Meant to do:** A run where cash or cheques were taken at the door ends on the Run Settlement screen: expected total, counted total, a forced reason for any variance, and a settlement note left on the run for the office.

**Actually does:** hasCashToReconcile reads a non-persisted Zustand store. After any JS-runtime restart — OS reclaim, crash, force-quit, or a second device on the same run — it is empty, so "Mark route complete" falls through to a generic confirm and PATCHes COMPLETED with no counted cash, no variance check and no note. updateRunStatus checks only stop status, so there is no server backstop.

**The gap:** The only entry point to settlement is branched off volatile device state, so the control silently disappears instead of failing loudly.

**Evidence:** apps/mobile/store/runSettlementStore.ts:10-19 (module doc: in-memory, non-persisted, "an app kill mid-run … will under-count. Accepted, documented limitation"), :20 (plain create(), no persist); apps/mobile/app/(driver)/route/index.tsx:288-290 (collections + hasCashToReconcile), :383-401 (the only branch into settlement; the else path is confirm() → updateStatus COMPLETED); apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:296-315 (server payment recorded first and paymentIds returned; recordCollection is a device-local echo afterwards); apps/mobile/app/(driver)/route/settlement.tsx:42-47, :55-59, :79-119, :146-149 ("Collected on this device during this run"); apps/api/src/routes/routes.service.ts:1352-1382 (updateRunStatus: role check and incomplete-stops check only); grep of apps/mobile for "route/settlement" finds route/index.tsx:385 as the sole navigation call site.

**Suggested fix:** Derive hasCashToReconcile from server data — expose the run's collected CASH/CHECK payments on the route-run payload — and have updateRunStatus refuse COMPLETED for a run with cash collections until a settlement note or an explicit skip reason has been recorded.

### B167 — The forced settlement variance note lands in run.notes, which no screen shows once the run closes

**Area:** Run settlement · mobile driver + web routes

**Meant to do:** A cash variance, and the reason the driver was forced to type at run close, are reviewable by the office so a real shortage or overage can be investigated.

**Actually does:** closeRun appends the note to RouteRun.notes and then flips the run to COMPLETED in the very next call. The only UI that ever renders run.notes is the Edit Run modal, whose trigger is hidden for COMPLETED and CANCELLED runs.

**The gap:** The note becomes unreachable through every UI path the moment the run it describes closes — no read-only run view, operator screen or driver history renders it.

**Evidence:** apps/mobile/app/(driver)/route/settlement.tsx:81-119 (note built and PATCHed at :107-111, then COMPLETED at :112 — always in that order), :83-90 (counted required, reason required on variance); the server does persist it (apps/api/src/routes/routes.controller.ts:265-274 and routes.service.ts:1278-1303); sole reader apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx:13, :34, :110-113, opened only from routes/page.tsx:353 and gated at :492-500 on the run not being COMPLETED or CANCELLED; the run detail page never reads run.notes; grep for .notes across the web routes tree and the mobile operator tree returns only invoice, payment and stop notes.

**Suggested fix:** Render run.notes read-only on the run detail page for every status, or write the settlement result to a dedicated, surfaced field instead of appending to the free-text driver-notes column.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
