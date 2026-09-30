# Mobile UX batch — builders, drafts, scanner units + memory, navigation, share, SMTP

## Context

Owner reported ten mobile-app defects/papercuts (2026-08-17) with Zoho screenshots as a
_simplicity_ reference (keep RouteFlow's look/icons; fewer steps for non-technical
operators). Exploration (3 agents) + design (3 agents) verified every finding against
source. Headline discoveries that shape the plan:

- Edit-order is a **separate weaker builder** (private `ProductPicker` in
  `edit-items.tsx`), not a prop oversight — it needs the scan ladder's ambiguous/create
  branches, not a rewrite.
- The **draft system already exists server-side + web** (`SaleDraft` model, `/drafts`
  CRUD, web `DraftDock`); mobile has zero callers.
- The catalog flood is caused by `acceptScannedProduct` clearing the search box, landing
  back on the full-catalog view.
- `CONFIRMED→DELIVERED` is already a legal one-hop; web-only `POST /orders/sell`
  (`deliveredNow`) collapses create→deliver→invoice→send.
- A **match memory already exists** (`ProductMapping`, consumed tier-0 in scans) but is
  broken: cross-tenant key collision (global unique w/o tenantId ⇒ P2002 500s or
  overwrites; NULL-tenant rows block everyone), raw case-sensitive supplier-string key,
  mobile learns from unconfirmed auto-matches. The correct replacement `ProductAlias`
  (tenant-scoped, normalized) exists with `resolve()` **never called**.
- Purchase side already stores case-denominated lines (`qty`=cases, `unitCost`=case cost,
  `packSize`) with `lineInventoryDelta` converting at receive — the boxes/pieces feature
  is UI + pure conversion, **no schema change**.
- The deployed mobile app is the **Expo web export** (nginx SPA); list state dies via
  tab-bar popToTop, resetRoot-after-reload, and display:none scroll loss.
- WhatsApp send is text-only **by design** (signed PDF URL expires ≤1h, so never
  embedded); the file-share path exists separately and falls back silently.
- SMTP is basic-auth only; M365 disables basic SMTP AUTH by default — no client-side
  setting can fix that. `/settings/email/test` discards the mapped diagnostic that
  `/settings/email/verify` already produces.

**No Prisma migration anywhere in this batch** (ProductAlias + InvoiceScan.supplierId are
already in the baseline). One manual, dry-run-first backfill script.

## Owner decisions (locked 2026-08-17)

1. **WhatsApp = PDF via share sheet** (file + message text through the OS sheet; wa.me
   text link remains the fallback with a toast; recipient no longer preselected).
2. **Van-sale mode: adopt `/orders/sell` in the mobile invoice builder, "Delivered
   today?" default ON**; falls back to plain `POST /invoices` when per-line
   tax/discount/terms/reference are used.
3. **Quiet builder: browse + category chips behind a "Browse catalogue" button.**
4. Adopted recommendations (not re-asked): non-divisible pieces stay pieces + warning
   (never fractional cases); scan prompt gains a per-line `unitLabel` hint (preselects
   the unit toggle, never auto-converts); clearing a remembered match **forgets** the
   alias; RAG/embeddings deferred (exact recall = the ask; fuzzy matcher covers drift);
   `?search=` URL mirroring on the web export deferred; SMTP OAuth2/Graph deferred
   (owner must do Azure app registration first).

---

## PR-1 — guaranteed-400 bug fixes (small, ship first)

`fix(mobile): block send on pending-mirror invoices; require reason on order demotions`

- `apps/mobile/lib/invoices-logic.ts`: add `canSendInvoiceNow(status, pendingMirror)`
  (DRAFT && !mirror). `(tabs)/invoices/[id].tsx`: hoist the `pendingMirror` computation
  (162-66) above `canSend` (154) and use the helper; when mirror, show a passive hint
  ("unlocks for sending once the order is delivered") + "Open order" tile. Edit-tile
  gate unchanged.
- New `apps/mobile/lib/order-status-flow.ts`: `demotionRequiresReason(from, to)`
  mirroring `orders.service.ts:1735-39`. New `components/ReasonSheet.tsx` (FormSheet
  pattern). `orders/[id].tsx` `handleStatusChange`: demotions open ReasonSheet and pass
  `{reason}` (already carried by `useChangeOrderStatus`).
- Jest: `order-status-flow.test.ts`, extend invoices-logic spec.

## PR-2 — builder parity + quiet catalog (mobile)

Commits, riskiest first:

1. `refactor(mobile): extract shared scan ladder from the sale builders`
   — New pure `apps/mobile/lib/scan-ladder.ts`: `makeScanHandler(deps)` reproducing
   `NewOrderScreen.handleBarcodeScanned` (788-859: local fast-path over loaded rows via
   `normalizeScanCode` → `resolveProductByCode` → ambiguous ⇒ "Choose" pill → miss ⇒
   "Create" pill gated `canCreate`) + `runWedgeSubmit` (shared Enter-as-scan
   post-processing). Adopt in `NewOrderScreen.tsx` + `(tabs)/invoices/new.tsx`
   (behavior-preserving). Spec `scan-ladder.test.ts`.
2. `feat(mobile): scan-to-create and ambiguous-pick parity in order/invoice editors`
   — `edit-items.tsx` `ProductPicker`: replace `onScanned` (1695-1731) with the ladder;
   ambiguous ⇒ `ProductPickerSheet` (`initialSearch=code`) over paused camera; miss ⇒
   `InlineCreateProductSheet` (`initialCode`), `onCreated → onPickAndStay`. New prop
   `canCreateProducts` (screen passes `isStaff`; drivers keep plain error). Add
   `paused?: boolean` to `components/BarcodeScanner.tsx` + `.web.tsx` (gate decode,
   keep camera mounted). Also wire a scan loop into `(tabs)/invoices/[id]/edit.tsx`
   (reuses its ProductPickerSheet + the create sheet). ScanOrderSheet tray NOT ported
   into the editor (follow-up).
3. `feat(mobile): quiet catalog with opt-in browse in the sale builders`
   — Extend `lib/visible-cart.ts` with `visibleCatalogRows({base, cartIds, lookup,
browsing, searchTerm})`: searching ⇒ flat results; quiet+cart ⇒ "On this order"
   section only + "Browse catalogue" footer button; quiet+empty ⇒ "Scan, search, or
   browse" empty state; browsing ⇒ today's partitionCatalog view + category chips
   (chips render only while browsing; close chip exits, resets category). Wire into
   both builders' `filtered` memo + chips condition. Keep `useProductSearch` fetch
   ungated (local fast-path + wedge auto-add depend on loaded page 1). Extend
   `visible-cart.test.ts` with the state matrix.

## PR-3 — parked drafts (mobile)

Model: **bind to a server draft once parkable, autosave continuously (900ms debounce,
web's cadence), delete on successful submit.** Navigation hooks are flush points only —
survives browser back/refresh/tab-kill on the SPA export.

1. `feat(mobile): drafts API mirror and payload module`
   — New `lib/api/drafts.ts` (mirror web: useDrafts/useCreateDraft/useUpdateDraft/
   useDeleteDraft, key `["drafts"]`). New pure `lib/drafts-payload.ts`:
   `OrderDraftPayload` copied field-for-field from web `lib/drafts.ts` + additive
   optional `note?` per line; new `InvoiceDraftPayload` (kind INVOICE); `toOrderDraftPayload`
   / `fromOrderDraftPayload` (tempId=productId keeps floorAcked stable; hydration
   rebuilds Product snapshots for `scannedById`; totals via `computeLineSubtotal` only);
   ports of `draftDeviceLabel`/`parkedAgo`/`draftSummary`; `draftParkable`. New
   `lib/use-draft-autosave.ts` ({flush, discard}, JSON-unchanged skip, hydration-seeded
   lastSaved). Spec `drafts-payload.test.ts`.
2. `feat(mobile): park and resume order drafts`
   — NewOrderScreen: bind/hydrate/flush/delete-on-create; `resumeDraftId?` prop;
   route param `?resumeDraft=` on `/(operator)/new-order`; back handlers + one
   fire-and-forget `beforeRemove` flush; gate `enabled` on `!runId && !stopId`.
   New `components/DraftStrip.tsx` (RouteFlow-styled card strip, renders nothing when
   empty) above the list in `(tabs)/orders/index.tsx`. Existing manual "Save as draft"
   (server DRAFT order) stays; successful save deletes the bound personal draft.
3. `feat(mobile): invoice builder drafts` — kind INVOICE wiring in `invoices/new.tsx`
   - strip on invoices index.

## PR-4 — post-confirm flow (mobile)

1. `feat(mobile): confirm-to-send flow without the locked-invoice detour`
   — `orders/[id].tsx`: remove the auto-`openInvoiceForOrder()` on CONFIRMED success
   (line 339 only — the explicit tile at 757 stays); confirm success = toast + stay.
   CONFIRMED action grid: "Quick deliver" promoted to primary, relabeled **"Deliver &
   send invoice"** (existing DELIVERED branch already chains `openSendForOrder()` →
   SendInvoiceSheet). "Send for delivery" secondary. Verify Edit-items tile renders on
   DELIVERED (API allows item edits at any live status; invoices re-sync in place).
2. `feat(mobile): delivered-now sale mode in the invoice builder`
   — Mirror web `useCreateSale` (`POST /orders/sell`): "Delivered today? Yes/No"
   segmented choice in the review sheet, **default Yes**; pure `saleModeGate(state)`
   decides eligibility (falls back to `POST /invoices` + explains why when per-line
   tax/discount/terms/reference in use; DTO mapping: deliveredNow, send,
   discountAmount, shippingFee, orderDate only-when-touched). Spec `sale-mode.test.ts`.

## PR-5 — scanner: match memory + boxes/pieces (api + web + mobile)

Commits:

1. `fix(api): tenant-safe product-mapping writes with typed DTO`
   — `saveProductMapping` rewritten: tenant-scoped findFirst → update-by-id / create;
   P2002 on create swallowed (another tenant holds the global key). New
   `dto/save-product-mapping.dto.ts` (`SaveProductMappingDto`). No upsert remains.
2. `feat(api): supplier resolution and alias memory in invoice scan`
   — New `apps/api/src/import/supplier-match.ts` (move batch-import's private
   `matchSupplier`; exact → unique startsWith → unique contains) + spec. New
   `product-alias.module.ts` (DuplicateMatchModule precedent); ProductAliasService gains
   `resolveMany(supplierId, rawTexts[])` (batched; no-tenant ⇒ empty map; dangling
   products dropped) + `unlearn`. `scanInvoice`: resolve supplierId server-side; alias
   tier-0 before the legacy-mapping tier before the matcher; items gain
   `matchSource?: "alias"|"memory"`; result gains `supplierId`; `persistScan` writes
   `InvoiceScan.supplierId`. `saveProductMapping` dual-writes:
   `learn(sid||"", raw, {productId})`, clear ⇒ `unlearn`. Extend
   vendor-bills.service.spec (alias beats mapping beats matcher; prisma-mock gains
   productAlias + supplier).
3. `feat(api): backfill script for product-mapping → alias migration`
   — `apps/api/scripts/backfill-product-aliases.mjs`: dry-run default, `--apply`;
   per-tenant supplier match; `createMany skipDuplicates` (idempotent); skips
   NULL-tenant/NULL-product rows with a report. Run manually on prod after deploy
   (`railway run --service postgres node …`). Dual-read makes ordering irrelevant;
   legacy read tier retired in a later cleanup PR.
4. `feat(web): remembered-match badge and scan supplier prefill`
   — `lib/api/invoice-scan.ts` types + `ScanInvoiceModal.tsx`: prefer server
   `supplierId` in `applyScan`; `ConfidenceBadge` gains "Remembered match" variant with
   unlearn-on-clear tooltip; clear `matchSource` on manual change.
5. `feat(mobile): learn scan matches on confirm only, remembered badge`
   — `vendor-bill-scan.ts`: `linkScanItem` sets `operatorConfirmed`; `mappingsFromScan`
   filters on it (stops learning auto-guesses); `buildBillDtoFromScan` prefers server
   supplierId. scan.tsx meta gains "· remembered". Tests extended.
6. `fix(web): case cost prefill when linking boxed product on bill detail`
   — `vendor-bills/[id]/page.tsx` mirrors mobile `linePrefillFor` (case cost =
   averageCost×upb when boxed). Widen `SearchableProductPicker.PickerProduct` with
   `unitsPerBox`/`averageCost` (kills `as any`).
7. `feat(web): boxes-pieces unit choice on scanned lines`
   — New pure mirrors `apps/{web,mobile}/lib/scan-line-units.ts`: `toBillLine(qty,
unitCost, unit, piecesPerBox)` — pieces→boxes only when qty divisible integer
   (qty/ppb cases @ cost×ppb; line total invariant); otherwise keep pieces + warning
   (**never fractional cases** — would drift stock at receive). `roundUnitCost` (4dp)
   added beside `roundMoney` in web+mobile pricing.ts. Modal: unit DERIVED from
   `packSize>1`; UI-only `ppbDraft` + `preConvert` snapshot (lossless toggle);
   [Boxes|Pieces] mini-toggle replaces the bare "× N pcs" block; product-link arms
   `ppbDraft` from `unitsPerBox` but never silently sets packSize; catalog-mismatch +
   fractional-case warnings; post-convert "from 24 pcs @ $1.25" note replaces the AI
   drift sparkles. Spec `scan-line-units.test.ts` (mobile harness = executable contract
   for both mirrors).
8. `feat(mobile): line editing with boxes-pieces choice in scan review`
   — scan.tsx ReviewStep gains per-row "Edit" chip → new `LineEditSheet` (qty,
   [Boxes|Pieces] pills, pieces/box prefilled OCR-then-product, unit cost, live total);
   pure `applyLineEdit` in vendor-bill-scan.ts. Tests extended.
9. `feat(api): extract per-line unit label hint in scan prompt`
   — one schema line in the prompt (`"unitLabel"`); spread already forwards it; clients
   use it only to preselect the toggle.

## PR-6 — list state, inventory nav, WhatsApp PDF, SMTP

1. `fix(mobile): debounce products search, share paging de-dupe, keep previous pages`
   — products/index.tsx adopts 250ms debounce (`PRODUCT_SEARCH_DEBOUNCE_MS`),
   `flattenPages` from lib/paged-rows.ts, `placeholderData: keepPreviousData` on
   `useAdminProductsInfinite`, onEndReached gated on `!isPlaceholderData`.
2. `feat(mobile): restore products list search, filters and scroll across remounts`
   — New pure `lib/list-ui-snapshot.ts` (`ListUiSnapshot {search, filters,
scrollOffset, pageCount, savedAt}`, TTL 15min, `MAX_RESTORE_PAGES=10`, one-shot
   `stepScrollRestore`) + in-memory Zustand `store/listUiStore.ts` keyed
   `"operator-products"` (reusable for other lists later). Lazy-init from snapshot;
   write-through saves; bounded page-chase; offset restore on `onContentSizeChange` +
   re-apply on `useFocusEffect` (display:none case). Tab-bar popToTop stays. Cold
   reload restores nothing (by design). Spec `list-ui-snapshot.test.ts`.
3. `feat(mobile): link products and stock movements both ways`
   — `movements.tsx` accepts `{productId?, productName?}` params → seeded filter
   banner; movement rows tappable → product detail; product detail movements card gains
   "See all"; **fix warehouse quick-action "Movements" which mislinks to the products
   list** (root cause of the orphaned route).
4. `feat(mobile): attach the invoice PDF to WhatsApp shares and surface share fallbacks`
   — `share-pdf.ts`: `text?` option, `ShareOutcome` return, `canShareFilesHere()`;
   web share includes files+text; window.open fallback now toasts; native expo-sharing
   is file-only (text ignored, documented). Pure `planWhatsAppSend({phone, message,
canShareFiles})` in invoice-send-logic.ts (+spec). orders/[id].tsx `handleWhatsApp`:
   file mode fetches the final PDF then shares; text mode = current wa.me + toast.
   SendInvoiceSheet gains busy state ("Sending PDF…"). invoices/[id].tsx share tile
   consumes ShareOutcome.
5. `fix(api): actionable SMTP failures` (LAST, per owner)
   — `requireTLS: port===587 && !secure` on both transports; send() catch logs
   err.code/responseCode/redacted response and returns `mapSmtpError(...)` (+
   `smtpFallbackReason` when Resend rescues) — invoice-send toasts inherit the mapped
   M365 guidance via existing `sendResult.error` embedding; `sendTestEmail` returns the
   mapped reason instead of the generic string. Extend email specs (requireTLS present
   587/absent 465; mapped 5.7.139 fixture). **Likely real-world fix is on the Microsoft
   side**: enable "Authenticated SMTP" for the mailbox (admin center → Users → Mail →
   Manage email apps) — the verify endpoint already explains this; after this PR the
   test-send does too. OAuth2/Graph = scoped follow-up needing owner's Azure app
   registration.

## Sequencing & deploy

Ship PRs sequentially (PR-1 first — it's two guaranteed-400 fixes), each via the
canonical rebuild routine: `npm run verify` → public → push/CI → squash-merge → private
immediately → watch deploy → `npm run post-deploy-check`. PR-5 commit 3's backfill runs
manually on prod after PR-5 deploys. Update `.claude/code-map/` surgically in every PR
(hook-enforced). No `apps/api` changes outside PR-5/PR-6-c5; **no Prisma migrations**.
Don't touch: driver route-run/stop flows, buyer portal, `pricing.ts` money helpers
(except the additive `roundUnitCost`), ScanOrderSheet internals.

## Verification

- **Jest (new/extended)**: scan-ladder, drafts-payload, visible-cart matrix,
  order-status-flow, invoices-logic, sale-mode, list-ui-snapshot, invoice-send-helpers,
  scan-line-units, vendor-bill-scan-helpers; API: supplier-match, product-alias
  (resolveMany/unlearn), vendor-bills scanInvoice alias tier, saveProductMapping
  tenant-safety, email requireTLS/mapped-error specs. `npm run verify` green before
  every push.
- **Manual browser (Expo web dev server; RNW needs full pointer sequences; verify
  against API/DB when the pane has no compositor)**:
  - Edit a confirmed order → scan an unknown code → Create sheet opens → product lands
    on the order. Ambiguous code → picker sheet.
  - Build an order, leave via back/tab/browser-refresh → DraftStrip shows it → resume
    restores lines incl. boxed splits + overrides; cross-device: web-parked draft
    resumes on mobile and vice versa.
  - Scan an item → list stays quiet (On-this-order only); Browse catalogue reveals
    chips; close returns to quiet.
  - Confirm → "Deliver & send invoice" → SendInvoiceSheet (two taps); demote asks for
    a reason (no 400); pending-mirror invoice shows hint instead of Send.
  - Invoice builder with "Delivered today" ON → one save ⇒ order DELIVERED + invoice
    SENT (verify via API).
  - Products page 3+ / search → open product → back → position+search intact; tab-away
    and return → restored; hard reload → clean list (expected).
  - Product ↔ movements round-trip; warehouse quick-action lands on movements.
  - Scan an invoice for a supplier, correct a line's product, save; rescan the same
    invoice → line auto-matches with "Remembered match"; clear it → next scan shows no
    memory. Tenant-safety: second tenant saving the same (supplier, description) no
    longer 500s.
  - Scanned line quoted in pieces (24 pcs @ $1.25, product 24/box) → toggle Boxes ⇒
    1 case @ $30.00, line total unchanged; receive → stock +24 pieces at $1.25 avg.
  - Android phone: Deliver & send → WhatsApp → share sheet with PDF attached; desktop
    Chrome → toast + wa.me text fallback.
  - Settings → Email (M365, SMTP-AUTH-disabled mailbox): "Send test" now shows the
    admin-center guidance; Gmail app-password 587 still works (requireTLS no-op).

## This session's remaining deliverable — HANDOFF.md rewrite (execution happens in a NEW session)

Per owner instruction, the batch is executed by a fresh session; this session finishes by
rewriting the untracked repo-root `HANDOFF.md` (never committed):

- **Update the header**: written 2026-08-17, branch `master` (clean), everything through
  PR #349 shipped+live.
- **Remove stale §1** (credit-restore branch "parked/unshipped" — it shipped as PR #341
  on 2026-08-14; keep only a one-line pointer in "decisions" that cancel-with-warning is
  live).
- **Keep** (still true): §2.1 returns question (STILL OPEN — blocked on owner); §2.2 two
  prod data repairs awaiting sign-off (costing repair + pack-size backfill, neither
  executed); §3 decisions (reword "built in the branch" → shipped #341); §4 next build
  work (in-app pack size #45, Wave 5 #23, Wave 6 #24, residuals); §5 owner-facing items;
  §6 session mechanics (all still accurate).
- **Add a new top section "NEXT UP — mobile UX batch (planned 2026-08-17)"**: points at
  this plan file (`C:\Users\nakram\.claude\plans\i-noticed-a-couple-lazy-elephant.md`)
  as the source of truth; lists the six PRs in ship order (PR-1 bug fixes first, SMTP
  last per owner); records the locked owner decisions (WhatsApp = PDF share sheet;
  van-sale delivered-today default ON; browse behind a button; keep-pieces on
  non-divisible; unitLabel hint yes; clear = forget alias); notes: no Prisma migrations
  anywhere, one manual dry-run-first backfill script after PR-5, `npm run verify` +
  code-map update per PR, canonical public→CI→merge→private-immediately ship flow per
  PR.
- Also save a project memory entry for the planned batch (plan path + decisions) so
  recall works even if HANDOFF.md is deleted.

## Deferred (recorded, not in this batch)

- ScanOrderSheet tray in the edit-items editor; unlearn UI on mobile;
  `?search=` URL mirroring on the web export; embeddings/RAG matching layer
  (measure alias hit-rate first via InvoiceScan archive); legacy ProductMapping read
  tier retirement (after backfill verification); SMTP OAuth2/Graph (owner: Azure app
  registration + Mail.Send consent); tenantTransaction upsert-scoping audit for other
  models; web page-position restore (web #346 fixed search only).
