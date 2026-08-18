# Batch architecture decisions — mobile UX batch, PR-3..PR-6 + blockers

**Date:** 2026-08-18 · **Author:** senior-architect (Fable 5) · **Status:** BINDING for the remaining PRs of `docs/plans/mobile-ux-batch-2026-08-17.md` (PR-1 #352, PR-2 #353 shipped).

Production facts used below (verified 2026-08-18, read-only): live tenant stores `settings.taxRate = "0"`; one QA tenant stores `"150"`; zero taxed invoice lines exist anywhere in the database. The A1 mismatch is latent, not active.

---

## A1 — `settings.taxRate` unit: PERCENT is canonical

**Decision:** The stored value is a PERCENT (0–100). The API is the single outlier and changes: `orders.service.getTaxRate()` divides by 100 and clamps. No client changes, no data backfill, no migration. Ships in **PR-B (blockers PR) before PR-4**.

**Why:** Every user-facing surface already treats it as percent — the web settings form (`label="Default Tax Rate"` with a literal `%` suffix, `z.coerce.number().min(0).max(100)`, `apps/web/app/(dashboard)/settings/page.tsx:101,344-352`), web invoice builder (`/100` at `invoices/new/page.tsx:709`), web CreateOrderModal (`/100` at line 125), mobile invoice builder and editor (`/100`). Only `orders.service.ts:155-159` reads it as a fraction (`subtotal * parseFloat(stored)` at 758/971/1427/2664/3430). Fixing one server function beats retraining four client surfaces and the admin's mental model. The live tenant stores `"0"`, where both readings coincide — so unit choice is on merit, and there is nothing to normalize.

**Implementation notes:**

- New pure helper `apps/api/src/common/tax-rate.ts`:

  ```ts
  /** SystemConfig "settings.taxRate" stores a PERCENT (0–100, string). Returns a FRACTION. */
  export function taxRateFractionFrom(stored: string | null): number {
    if (stored === null || stored === "") return 0;
    const pct = parseFloat(stored);
    if (!Number.isFinite(pct)) return 0;
    return Math.min(Math.max(pct, 0), 100) / 100;
  }
  ```

  `orders.service.getTaxRate()` becomes `taxRateFractionFrom(await this.systemConfig.get("settings.taxRate"))`. Spec `common/tax-rate.spec.ts`: `"10"→0.10`, `"0"→0`, `""→0`, `"150"→1` (clamped), `"abc"→0`, `"0.5"→0.005` (half a percent — the form says %).

- Update `orders.service.spec.ts` mocks from `"0.1"` to `"10"` (lines 483, 972, 997, 1023, 1135) — this is the executable contract flip.
- **`order-templates.service.ts:30-40,376` is a second latent bug**: it taxes template-generated orders with env `TAX_RATE ?? 0.1` (10%!) regardless of tenant settings. Replace with the same helper: inject `SystemConfigService`, read per-request (drop the constructor-cached field). Remove `taxRate` from `configuration.ts` (grep for remaining readers first; if any other reader exists, leave the config key but nothing in orders/templates may use it).
- **Server-side validation (the `"150"` answer):** `settings.controller.ts` `PATCH /settings` writes `String(dto[k])` with no validation (line 116-125) — that is how 150 got past the web form's zod (any direct API caller bypasses it). Add: reject `taxRate` unless `Number.isFinite(n) && n >= 0 && n <= 100` (400 with "Tax rate must be between 0 and 100 (percent)"). The read-side clamp in `taxRateFractionFrom` is the belt for existing junk; do NOT write to the QA tenant's stored value.
- **PR-4 tax gate:** NOT adopted as a standing gate. The unit fix ships in PR-B before PR-4 exists, and A2's total-equality gate independently guarantees the previewed total equals the saved total even if a future rate bug appeared. A permanent "disable sale mode when tax ≠ 0" workaround would outlive its reason and contradict the point of shipping the correct fix. Hard sequencing rule instead: **PR-4 must not merge until PR-B is deployed** (verify with a curl of a QA order if in doubt).

---

## A2 — `saleModeGate`: total-equality assertion, exact contract

**Decision:** Sale mode (`POST /orders/sell`) is used only when the client-predicted invoice total of the sale path **exactly equals** (integer cents, zero tolerance) the already-previewed plain-invoice total, AND no operator-entered field would be dropped. Enumerable reasons are surfaced; the equality assertion is the final authority and also catches anything the enumeration misses.

**Why:** Verified divergences are not just "per-line features": the from-order invoice hardcodes `discount: 0` (`invoices.service.ts:809`) so an invoice-level discount sent as `discountAmount` silently vanishes from the invoice — the plan's own "map discountAmount" instruction would have shipped a silent total change. Feature-sniffing enumerations rot; a total-equality assertion is self-verifying. The default mobile invoice is untaxed (`invoiceLineDto` serializes `taxRate: line.taxable ? rate : 0`, and lines are created without `taxable`), while `orders.create` taxes the whole subtotal (`orders.service.ts:1427`) — equality catches this on day one for any tenant with a non-zero rate.

**Implementation notes:** New pure module `apps/mobile/lib/sale-mode.ts` + spec `__tests__/sale-mode.test.ts`.

```ts
export interface SaleGateInput {
  lines: InvoiceTotalsLine[]; // EXACT same array fed to computeInvoiceTotals
  hasUnlistedInvalid: boolean; // any unlisted line with empty name or price<=0
  invDiscount: number; // invoice-level discount (0 if unset)
  shippingFee: number;
  isTaxExempt: boolean;
  taxRateFraction: number; // tenant percent/100 — post-A1 server behavior
  touched: { dueDate: boolean; terms: boolean; reference: boolean; subject: boolean };
  sendNowOn: boolean; // the builder's "Send" toggle
  deliveredNow: boolean;
  hasSeparateInvoiceCategoryLine: boolean; // product.trackedCategory.invoiceTreatment === "SEPARATE_INVOICE"
}
export type SaleGateResult = { eligible: true } | { eligible: false; reasons: string[] }; // operator-facing strings
export function saleModeGate(input: SaleGateInput): SaleGateResult;
```

Gate rules, in order (any hit ⇒ fallback with its reason):

1. **Per-line discount** on any line (`OrderItemDto` has no discount field; do NOT fold into a unitPrice override — that changes `originalPrice` semantics and boxed proration). Reason: "a line discount is set".
2. **Invoice-level discount** > 0 (dropped by `invoices.service.ts:809`). Reason: "the invoice discount is set".
3. **Tax mix**: eligible only when `taxRateFraction === 0` (covers exempt customers) OR every line (catalog + unlisted) has `taxable === true`. Reason: "some lines aren't taxed".
4. **Touched header fields**: `dueDate`/`terms`/`reference`/`subject` dirty ⇒ fallback (sale path derives `issueDate = orderDate ?? now`, `dueDate = issueDate + default terms`, `invoices.service.ts:1910-1916`, and `CreateSaleDto` has no reference/subject). Dirty = user edited, not value-compare. Reason: "due date / terms / reference are set".
5. **Send toggle**: `deliveredNow === false && sendNowOn` ⇒ fallback — the server ignores `dto.send` entirely (comment at `orders.service.ts:1681-1685`: deliver-later never auto-sends; deliveredNow always sends). **Never put `send` on the wire; it is a dead field.** Reason: "sending now without delivery".
6. **SEPARATE_INVOICE regulated lines** ⇒ fallback (the order path splits into `-R1` sibling invoices — a different artifact than the one previewed). Other regulated lines are fine: BOTH paths compute the same per-line `computeCategoryTax` server-side (direct create at `invoices.service.ts:220`, order path at `orders.service.ts:1384`), so the preview gap is symmetric. Load `useTrackedCategories({active:true})` in the builder (hook exists).
7. **Final assertion** (the contract): with `predictSaleInvoiceTotals` below,
   `Math.round(salePredicted.total*100) === Math.round(computeInvoiceTotals(sameInputs).total*100)` — else fallback with the generic reason. Zero tolerance: both values are `roundMoney` outputs; money is exact after rounding.

```ts
/** Mirror of orders.create → createInvoiceFromOrder for a FULL fresh sale:
 *  subtotal = roundMoney(Σ computeLineSubtotal(line))   [no per-line discounts on this path]
 *  tax      = isTaxExempt ? 0 : roundMoney(subtotal × taxRateFraction)   [orders.service.ts:1427 post-A1]
 *  total    = roundMoney(subtotal + tax + shippingFee)                    [invoices.service.ts:782-784; discount:0]
 */
export function predictSaleInvoiceTotals(input: {...}): { subtotal: number; taxTotal: number; total: number };
```

**What the eligible mobile sale sends** (`POST /orders/sell`): `customerId`, `items` = catalog lines (`{productId, qty, boxes?, pieces?, unitPrice?-only-when-≠-tier, notes?}`) **plus unlisted lines** (`{name, qty, unitPrice, notes?}` — `OrderItemDto` supports them for staff; web's filtering is a web-side simplification, do not copy it), `deliveredNow`, `notes?`, `shippingFee?` (>0 only), `orderDate` only when `issueDate ≠ today`. Never `send`, never `discountAmount` (rule 2 guarantees it is 0).

**Review-sheet disclosure (exact copy):**

- Delivered today = Yes: "Records the sale now: the order is marked delivered, stock is deducted, and the invoice is issued and sent. Available customer credit is applied automatically." The Send toggle is hidden in this mode (it is implied and non-optional).
- Delivered today = No (still eligible): "Creates a pending order with a draft invoice. Stock is deducted now; the invoice unlocks for sending once the order is delivered."
- Fallback: "Saving as a regular invoice (no delivery tracking) — [reason]. Your total stays $X exactly as shown." The Delivered-today control is disabled with that hint.

**Accepted limitation (same as web):** the server may re-price a line from a live promotion the client can't see; this shifts both paths' previews identically and the server stays authoritative. Not gate-detectable; documented in the module header.

---

## A3 — `toBillLine`: packSize is part of the return value, always explicit

**Decision:** `toBillLine` returns the full bill-line denomination **including `packSize`**: `packSize = piecesPerBox` when the chosen unit is Boxes, `packSize = null` when Pieces. The DTO builder always writes the key explicitly. "Never silently sets packSize" is reinterpreted: packSize may only reflect the operator-visible toggle + on-screen pieces/box value — it is never inferred invisibly; emitting it for a Boxes line the operator toggled is not silent.

**Why:** `lineInventoryDelta` (`vendor-bills.service.ts:133-145`) is the ONLY conversion point for receive/revert/void: `packSize > 1 ⇒ qty×pack, cost÷pack`. A Boxes line posted without packSize books 1 piece at $30 instead of 24 at $1.25 — the exact #335/#336 stock/AVCO corruption class. The plan's draft signature (qty/cost only) reintroduces it by construction.

**Implementation notes:** Pure mirrors `apps/{web,mobile}/lib/scan-line-units.ts` (mobile spec is the executable contract for both):

```ts
export type ScanLineUnit = "pieces" | "boxes";
export interface PieceSnapshot {
  qtyPieces: number;
  costPerPiece: number;
} // canonical, lossless-toggle source
export interface BillLineDenomination {
  qty: number; // in the chosen unit (cases when unit="boxes")
  unitCost: number; // per chosen unit, roundUnitCost (4dp)
  packSize: number | null; // piecesPerBox when unit="boxes", else null — ALWAYS present
  converted: boolean;
  warning?: "NOT_DIVISIBLE" | "PPB_MISMATCH";
}
export function toBillLine(
  snap: PieceSnapshot,
  unit: ScanLineUnit,
  piecesPerBox: number | null | undefined, // ppbDraft: OCR-then-product prefill, operator-editable
  catalogUnitsPerBox?: number | null, // linked product's unitsPerBox, hint only
): BillLineDenomination;
```

Rules:

- The modal/LineEditSheet keeps a canonical `PieceSnapshot` per line (`preConvert`): an OCR case line (1 @ $30, packSize 24) canonicalizes to {24, 1.25}; toggling back restores the ORIGINAL values exactly (lossless), never a re-derivation.
- `unit="pieces"` → `{qty: qtyPieces, unitCost: roundUnitCost(costPerPiece), packSize: null}`.
- `unit="boxes"` requires integer `piecesPerBox ≥ 2` AND `qtyPieces % piecesPerBox === 0` → `{qty: qtyPieces/ppb, unitCost: roundUnitCost(costPerPiece*ppb), packSize: ppb}`. Otherwise return the pieces form + `NOT_DIVISIBLE` (never fractional cases — they drift stock at receive).
- **Mismatch contract:** when `catalogUnitsPerBox` is present, ≠ the effective ppb, add `PPB_MISMATCH`; UI shows "Catalog says N/box". The on-screen ppbDraft WINS (what's displayed is what's saved); the catalog value only prefills when OCR gave none.
- Invariants the specs MUST pin:
  1. Money: `roundMoney(qty×unitCost)` identical across both representations of the same snapshot (construct fixtures with exact 4dp costs; also pin the 25/24-style case via the lossless-toggle rule, not re-derivation).
  2. Round-trip: pieces→boxes→pieces restores the snapshot bit-for-bit.
  3. DTO: `buildBillDtoFromScan`/`applyLineEdit` output includes the `packSize` key on EVERY line that passed through the toggle (explicit null included) — a stale OCR packSize can never leak beside a pieces choice.
  4. API side (extend `vendor-bills.service.spec`): receive of `{qty:1, unitCost:30, packSize:24}` and `{qty:24, unitCost:1.25, packSize:null}` produce identical stock deltas and AVCO.

---

## PR-3 — parked drafts: concrete designs for the five risks

**1. Single-flight create latch.** `apps/mobile/lib/use-draft-autosave.ts` holds `draftIdRef` + `createPromiseRef: Promise<string> | null`. Any flush needing a draft id awaits the EXISTING promise if set, else creates it (`POST /drafts`) and stores the promise before awaiting. Hydration seeds `draftIdRef`, so a resumed session can never create. Contract (spec-pinned): at most one create per builder session regardless of flush concurrency — enforced by storing the promise, not a boolean.

**2. Delete-on-submit + duplicate protection.** Two layers, no API changes (`POST /orders` gets no idempotency key this batch; the MERGE_CHOICE_REQUIRED 409 + auto-merge sweep already blunt same-customer duplicates):

- On create success: `await Promise.race([deleteDraft(id), timeout(1500ms)])` before navigating; on failure, one background retry.
- Poison-pill: immediately after create success (before delete), fire a final PATCH stamping `payload.submittedAt = ISO`. `DraftStrip` filters out drafts with `submittedAt`; when its query returns one, it lazily fire-and-forget deletes it. If BOTH writes failed (offline), the draft resurfaces honestly — resuming shows the same lines and the operator sees the created order in the list; acceptable residual.
- Also flush() once BEFORE `createOrder.mutate` so a failed create leaves an up-to-date draft.

**3. Mobile-only state hydration.** Extend the payload ADDITIVELY, keeping web's `OrderDraftPayload` field-for-field:

- `unlisted[]` maps into web's existing `DraftLineItem { isUnlisted: true, tempId: localId, productName: name, unitPrice, qty }` — cross-device compatible by construction.
- `selectedCreditIds?: string[]` added as a new OPTIONAL top-level payload field (mobile round-trips it; web ignores unknown fields — additionally add the optional field to web's `lib/drafts.ts` type in the same PR, type-only, so the mirrors stay identical).
- `floorAcked` already exists (tempId=productId keeps it stable per the plan). Per-line `note?` per the plan.
- On hydrate, validate resumed credit ids against `isCreditOpenForApply` (existing predicate) and drop dead ones silently.

**4. Deleted / re-priced products on resume.** Hydration fetches live products for parked productIds and:

- Missing/archived product ⇒ drop the line, collect names, ONE alert after hydrate: "Removed N item(s) no longer in your catalog: …".
- Prices: pin the parked `unitPrice` ONLY when parked `priceType === "MANUAL"` (an operator override); otherwise leave the line's unitPrice unset so the live tier price re-derives — this matches `submitOrder`'s existing rule (overrides equal to tier are stripped; the server owns tier/promo pricing).
- `unitsPerBox` changed ⇒ keep the parked `boxes/pieces` counts (physical counts) and re-derive `qty` with the LIVE upb via `normalizeBoxesPieces`.

**5. Child-mount / binding point.** The autosave hook lives INSIDE `ProductPickView` (it owns all parkable state). `draftParkable` = customer chosen AND (catalog lines > 0 OR unlisted lines > 0) — customer-only drafts are noise. Resume: `?resumeDraft=` is resolved at `NewOrderScreen` level via `useDraft(id)` (spinner state); the loaded draft seeds `pickedCustomerId/Name` so `ProductPickView` mounts immediately and receives the payload as a prop to hydrate from. A 404 (deleted on another device) toasts "That draft is gone" and falls into the normal empty builder. `onChangeCustomer` keeps the SAME server draft and PATCHes customerId/customerName on the next flush. Autosave: 900ms debounce, JSON-unchanged skip, flush on back/`beforeRemove`/web `visibilitychange`; `enabled` gated on `!runId && !stopId` (per plan).

---

## PR-4 — post-confirm flow (beyond A1/A2)

- Confirm success = toast + stay: remove ONLY the auto-`openInvoiceForOrder()` (line ~339); the explicit tile stays. CONFIRMED grid: "Deliver & send invoice" primary (existing DELIVERED branch already chains `openSendForOrder()`); "Send for delivery" secondary. Per plan.
- The sale path's stock/notification side effects are DISCLOSED, not gated (A2 copy above). `deliveredNow=true` always issues + sends every sibling invoice and runs oldest-first credit auto-apply (`orders.service.ts:1686-1694` → `invoices.service.send`) — the review sheet says so.
- `dueDate/terms/reference/subject/issueDate` handling and the full fallback-trigger list are defined in A2 and are binding; no second list exists.
- Deploy dependency: PR-4 merges only after PR-B is live (A1).

---

## PR-5 — scanner memory + boxes/pieces (beyond A3)

- **Alias scope:** the scan flow NEVER learns under `supplierId: ""`. `saveProductMapping`'s dual-write calls `learn` ONLY when a supplier was resolved; unresolved-supplier corrections still write the legacy `ProductMapping` (existing behavior, string-keyed) and nothing else. The `""` scope stays reserved for batch-import's any-supplier aliases; `resolve()`'s `[sid, ""]` fallback is kept so those still help scans.
- **Unlearn contract:** clearing a remembered match forgets it at BOTH scopes:
  `unlearn(supplierId, rawText)` ⇒ `deleteMany({ tenantId, rawText: normalize(rawText), supplierId: { in: [sid, ""] } })` — the operator's intent is "stop suggesting this", and the suggestion may have come from the `""` fallback the supplier-scoped delete would otherwise miss. Returns `{deleted}`; spec pins the two-scope delete.
- **Cache path:** extract the current Phase-2 matching block (`vendor-bills.service.ts:1270-1338`) into a private `matchItems(supplierRaw, items)` and run it on BOTH the fresh path and the `findScanByHash` hit: strip stale match fields (`matchedProductId/matchedProductName/confidence/candidates/matchSource`) from the cached payload's items and re-match in memory (alias tier → legacy mapping tier → fuzzy) before returning. Do NOT rewrite `extractedPayload` (fingerprints and history stay stable). This is what makes "rescan → Remembered match" literally possible; without it the verification step in the plan cannot pass.
- Everything else (tenant-safe `saveProductMapping` findFirst→update/create with P2002-swallow, typed DTO, `supplier-match.ts` move, `resolveMany` batching, confirm-only learning via `operatorConfirmed`, backfill script dry-run-first, web badge/prefill, `roundUnitCost` additive in web+mobile pricing.ts): adopt the plan as written, with A3's `toBillLine` contract replacing the plan's draft signature.

---

## PR-6 — list restore, product↔movements, WhatsApp PDF, SMTP

- **WhatsApp PDF + transient activation:** never `await` a fetch between the tap and `navigator.share`. On tap: start the PDF fetch with busy state "Preparing PDF…"; if the blob resolves within `ACTIVATION_BUDGET_MS = 3000`, call `share()` immediately (still within Chrome's activation window); otherwise flip the row to "PDF ready — tap to share" and the SECOND tap calls `share()` synchronously with the cached `File`. The `window.open` fallback obeys the same budget; when expired it toasts with an explicit "Open PDF" action (fresh tap). `sharePdf` gains `text?` and returns `ShareOutcome: "shared" | "opened-tab" | "ready-await-tap" | "failed"`; EVERY failure path toasts (no more silent returns at `share-pdf.ts:60-70`). `planWhatsAppSend({phone, message, canShareFiles})` stays pure and testable; native expo-sharing is file-only (text ignored — documented). Desktop = current wa.me text link + toast.
- **`requireTLS`:** ship `requireTLS: port === 587 && !secure` on BOTH transports (send `email.service.ts:657` and verify `:561`). A 587 server that doesn't offer STARTTLS is accepting the tenant's password in cleartext — failing is the correct behavior, and this cannot break Gmail/M365/any mainstream 587 host (all offer STARTTLS). Add a `mapSmtpError` branch for the nodemailer STARTTLS-unavailable failure ("The mail server didn't offer a secure connection on port 587 — check the host, or use port 465 with the secure toggle ON.").
- **Mapped diagnostics reach the operator even when Resend rescues:** `send()` return type gains `smtpFallbackReason?: string` = `mapSmtpError(err, host, port)` captured at the SMTP catch (`:682-685`), logging `err.code/responseCode` + redacted response. Invoice-send responses embed it as a non-blocking `warning`; web + mobile send toasts render it: "Sent via RouteFlow's mail service (from \<platform address\>) — your own email couldn't send: \<reason\>." — the From-address change is part of the disclosure.
- **`sendTestEmail`:** returns the mapped reason instead of the generic string: SMTP-failed-and-no-Resend ⇒ `success:false, message: mapped`; SMTP-failed-but-Resend-delivered ⇒ `success:true` with the mapped SMTP reason appended (mail DID deliver — say so honestly, then explain the tenant-SMTP problem, which for M365 is the admin-center Authenticated-SMTP guidance).
- **List restore + products↔movements:** adopt the plan as written (`list-ui-snapshot.ts` TTL 15min / MAX_RESTORE_PAGES 10 / one-shot scroll restore; Zustand `listUiStore` keyed `"operator-products"`; movements param-seeded filter; fix the warehouse quick-action mislink). No open decisions.
- SMTP commit remains LAST in the PR (owner instruction).

---

## C — Sequencing (definitive)

| #   | PR                                                                      | Contents                                                                                                                                                                                    | Depends on                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PR-B** `fix(api): tax-rate unit + tenant-safe product mapping`        | A1 (tax-rate helper, orders + order-templates adoption, settings PATCH validation, spec flips) + PR-5 commit 1 (tenant-safe `saveProductMapping` — a live 500/overwrite bug, not a feature) | — ship first                                                                                                                                                                             |
| 2   | **PR-3** parked drafts (mobile-only)                                    | per plan + decisions above                                                                                                                                                                  | PR-B not required; ship second                                                                                                                                                           |
| 3   | **PR-4** post-confirm + van sale (mobile-only)                          | A2 gate; touches `invoices/new.tsx` + `orders/[id].tsx`                                                                                                                                     | **PR-B deployed** (A1) and PR-3 merged (both edit `invoices/new.tsx` — serialize, drafts first)                                                                                          |
| 4   | **PR-5** scanner memory + boxes/pieces (api+web+mobile, minus commit 1) | A3 contract; alias/cache decisions                                                                                                                                                          | independent of PR-3/PR-4 — **may be built in parallel** (disjoint files); merge after PR-4 to keep one-PR-in-flight deploy discipline; run the backfill (dry-run first) after its deploy |
| 5   | **PR-6** list restore / movements / WhatsApp / SMTP-last                | decisions above; touches `orders/[id].tsx`                                                                                                                                                  | after PR-4 (file overlap); SMTP commit last                                                                                                                                              |

Each PR ships via the canonical rebuild routine (`npm run verify` → public → CI → squash-merge → private immediately → watch deploy → `npm run post-deploy-check`), code-map updated surgically per PR, **no Prisma migrations anywhere**, `pricing.ts` untouched except the additive `roundUnitCost`.

**Deliberately descoped (recorded):** `POST /orders` idempotency keys (PR-3 uses client-side latch + poison-pill instead); folding per-line invoice discounts into sale-path unitPrice overrides (semantic mismatch); normalizing the QA tenant's stored `"150"` (read-side clamp + write-side validation make it inert); Resend-side handling when BOTH transports fail mid-invoice-send (existing behavior already honest); mobile unlearn UI (already deferred by the plan).
