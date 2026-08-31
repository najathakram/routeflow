# F30 · Mobile scan-to-order loss (owner-reported hotfix)

**Bug IDs (12):** B190, B191, B192, B193, B194, B195, B196, B197, B198, B199, B200, B201 — minted 2026-08-31 from the 9-agent diagnosis (workflow wf_fc0b83ce-ced; all 3 symptom chains CONFIRMED by adversarial refutation). Board #549. **Ships as TWO PRs:** HF-scan-mobile (client) + HF-scan-api (server) — the api half owns orders.service/controller edits and PRECEDES F06 in the orders lane.

**Also confirmed reachable here (existing IDs, fixed in this batch where cited):** B143/B111 (useNetworkSync silent 4xx/exhaustion dequeue — the never-silent failed-list fix lands in HF-scan-mobile), B151 (iOS toast no-op — the InlineToast host wiring lands here). B47 stays with F06 (edit path); the CREATE-merge flatten is B199 here.

## Symptom mechanisms (verified chains)

### S1 — UI says 'item added' per scan but the order is later missing many items and quantities are random/wrong

The 'added' confirmation is purely client state emitted BEFORE any persistence (the server sees nothing until one POST /orders at Confirm). Between the camera frame and that single write there are two families of failure: (A) the frame-loop gate both DROPS scans (busyRef drop-not-queue during each server resolve, up to 15s) and DOUBLE-COUNTS them (single-slot raw-string dedupe accepts alternating symbology decodes of one label; the sliding cooldown suppresses deliberate re-scans), so the local cart is already wrong while every accepted scan haptic-confirms; and (B) the one write that matters is silently lost or duplicated — a 15s timeout classifies as 'offline' and enqueues the whole order, the queue replay silently discards any 4xx (409 MERGE_CHOICE_REQUIRED is guaranteed whenever the customer has an open order) and self-duplicates on flapping networks with no idempotency key, while server-side the staff merge flattens box/piece denominations and two 200-returning paths (silent `continue` on unresolved productId; replaceAll inferred from an id-less payload) silently drop or wipe lines. Local-cart corruption also leaks in via sale-line's boxed increment discarding typed plain qtys and the submit-time join excluding lines whose product misses productById.

Chain:

- apps/mobile/components/ScanCamera.tsx:81-98 — busyRef drops every detection while the previous scan's resolve is awaited; zero feedback
- apps/mobile/lib/scan-ladder.ts:56-68 + lib/use-product-search.ts:62 + lib/api/products.ts:13 — local fast path = only the current 50-row page, so most scans in a real catalog hold busyRef for a 2-GET round trip
- apps/mobile/lib/api-client.ts:8 — axios timeout 15000ms: one slow lookup freezes scanning up to 15s (no busy indicator exists in ScanOrderSheet.tsx:89-113)
- apps/mobile/lib/scan-loop.ts:34-39 — gateScan refreshes lastAt on every REJECTED detection (sliding window): re-presenting the same item at <700ms gaps never increments — 5 passes = qty 1
- apps/mobile/lib/scan-loop.ts:36 + components/ScanCamera.tsx:107-109 + lib/barcode-normalize.ts:8-13 — single lastCode slot on the RAW decode string with ean13/upc_a/itf14 all enabled: one label alternating decodes (ITF-14 case + EAN-13 item, or UPC-A/EAN-13 flicker) is accepted on EVERY flip
- apps/mobile/lib/sale-line.ts:17-49 — each flip lands as +1 box (incrementLine) or +1 loose piece (incrementLinePiece) depending on which code won → 'N cs + M loose' garbage
- apps/mobile/lib/sale-line.ts:25,48 + components/NewOrderScreen.tsx:1347-1350 vs 1367-1372 — boxed increment discards prev.qty when the line held a plain qty (catalog-row qty editor writes plain qty + clears boxes/pieces): typed 10 → scan → line becomes 1 box
- apps/mobile/components/NewOrderScreen.tsx:1707-1735 + lib/scan-tray.ts:153-156 + lib/pricing.ts:214-223 — submit joins the normalized cart against productById; a join miss silently excludes the line (boxed line evaluates boxes*0+pieces, filtered at qty>0)
- apps/mobile/lib/api-client.ts:125-160 — any no-response error (ECONNABORTED timeout included, no NetInfo check) on POST /orders → enqueued as 'offline' while the server may still complete the original; NewOrderScreen.tsx:1682 — deliberately NO idempotency key
- apps/mobile/hooks/useNetworkSync.ts:22-24,55-56 — drain silently dequeues any 4xx (409 MERGE_CHOICE_REQUIRED, 400 validation, 401-after-failed-refresh) and any retry-exhausted entry: the entire scanned order evaporates with zero feedback (= B143/B111)
- apps/mobile/lib/api-client.ts:131 + hooks/useNetworkSync.ts:45-50 — drain replays use a FRESH config without _offlineQueued: a timed-out replay enqueues a NEW entry while the old one increments — the queue self-duplicates, each copy re-applying the mutation (frozen mergeChoice:'merge' re-adds the same lines, NewOrderScreen.tsx:1752-1775)
- apps/api/src/orders/orders.controller.ts:87-127 + orders.service.ts:2902-2960 + common/pricing.ts:101-118 — staff merge flattens to {productId, qty}, summing piece-denominated with box-denominated qtys and dropping boxes/pieces/unitPrice/notes; recreated box-unaware, qty repriced as BOX count (B47 family)
- apps/api/src/orders/orders.service.ts:2857-2868 — replaceAll = dto.replaceAll ?? allItemsLackIds: an id-less add-only PATCH wipes and recreates the order, 200
- apps/api/src/orders/orders.service.ts:3069-3071 + prisma/prisma.service.ts:123-131 — diff-branch add: if (!product) continue — HTTP 200, line never persisted (stale/cross-tenant id post-filtered to null)
- apps/api/src/orders/orders.service.ts:759-777,903-1042 + orders.controller.ts:59-127 — merge sweep and controller merge are non-transactional read-modify-writes: concurrent scan-adds/queue replays clobber each other's lines

### S2 — UI says 'item added' but a later notification says the item was NOT FOUND although it exists in the catalog

There is NO server-side producer of a not-found notification (all push/messaging producers enumerated — none emits such text). The notice is client-generated and arrives seconds-to-minutes after the scan it belongs to, and it is frequently a FALSE negative for a product that genuinely exists. Primary chain: the scan ladder's miss pill ('No product for X') renders only after an awaited two-GET resolve (up to ~30s under timeouts) while later scans have already haptic-confirmed — so the notice is misattributed to an item the operator saw added. Three producers make it fire for existing products: (1) the wedge path concatenates two hardware-scan bursts into one garbage code because the search box clears only on accept; (2) the client fallback search rung filters isActive:true & limit 10 while the barcode rung matches inactive products — so an inactive item scan-ADDS via the barcode rung yet reports not-found via the search rung, and draft-resume hydration later DROPS it with 'no longer in your catalog'; (3) at submit, a stale local-fast-path productId (session-old scannedById snapshot / 50-row page — B140 territory) hits the API's all-or-nothing 400 'Product <uuid> not found' minutes after every scan said Added. On top: customer-role tokens 403 on BOTH resolve rungs, and the sink asymmetry (Android system toast outlives the screen = detached late 'notification'; iOS showToast is a no-op = nothing at all, B151) shapes when/whether the owner sees it.

Chain:

- apps/mobile/lib/scan-ladder.ts:70-110 — miss text `No product for "<code>"` produced only after `await deps.resolve(...)` (two sequential GETs, each on the 15s timeout); network/5xx yields the distinct 'Couldn't look up barcode.'
- apps/mobile/components/ScanCamera.tsx:81-98 — during that await, busyRef silently swallows further scans, so the late pill lands amid newer 'added' haptics — misattribution
- apps/mobile/components/NewOrderScreen.tsx:1131-1145 (clear only at acceptScannedProduct:1089; mirrored edit-items.tsx:1771-1785) — wedge submits drop at searchScanBusy AND the field is cleared only on accept: the next hardware burst CONCATENATES → guaranteed false 'No product for "<code1><code2>"'; neither product is added
- apps/mobile/lib/barcode-resolve.ts:72-76,85,107 — barcode-rung 404 swallowed; search rung sends isActive:true&limit:10; terminal {notFound:true} = 'no exact match AND no active search hit in 10 rows' — NOT a server verdict
- apps/api/src/products/products.service.ts:441-483 vs 212-221 — server asymmetry: findByBarcode matches INACTIVE products (no isActive filter); findAll?scanCode applies isActive — an inactive product resolves on rung 1 but is invisible to rung 2
- apps/mobile/components/NewOrderScreen.tsx:763-854 (esp. 808-812, 849-854) — draft resume re-fetches each parked productId and DROPS 404/isActive===false lines with the delayed alert 'Removed N item(s) no longer in your catalog' — for items that scan-added with full confirmation
- apps/mobile/components/NewOrderScreen.tsx:1788-1823 + apps/api/src/orders/orders.service.ts:1651 (also 2781, 2938) — submit-time alertInfo('Couldn't save order', 'Product <uuid> not found'): all-or-nothing rejection surfaced minutes late; when the submit itself was queue-replayed, the 400 is instead swallowed (→ S1 silence)
- apps/mobile/lib/scan-ladder.ts:56-68 — the stale productId originates in the local fast path matching session-old scannedById snapshots / the 50-row page (B140 overlap)
- apps/api/src/products/products.controller.ts:37-55 + buyer/buyer-catalog.service.ts — GET /products and /products/barcode are @Roles(OPERATOR, DRIVER); a CUSTOMER token 403s both rungs and no buyer scan endpoint exists
- apps/mobile/lib/toast.ts:3-35 (no-op at 34) — several sinks route the miss through showToast: iOS = invisible (pure S1), Android = system toast surviving navigation (reads as a late detached notification = S2) — B151

### S3 — the SAME scan set through the WEB app works correctly

Web is immune by construction, not by luck — each mobile divergence maps to a web invariant: discrete serialized wedge events (no frame loop → nothing to drop at a mutex, no alternating decodes, input cleared synchronously so no concatenation), server-only resolution per scan (always the current live row — no stale local fast path, and 'lookup failed' is never rendered as 'not found'), fully denormalized lines (a web line can never lose its product at submit), and exactly one loud write (no offline queue: a failed POST surfaces immediately in the same interaction with builder state intact, 409-merge and regulated blocks handled interactively, every other failure guaranteed visible by the global MutationCache toast). Additionally web's repeat-scan is a plain qty+1 with boxes/pieces sent authoritative — no denomination reclassification per symbology.

Chain:

- apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx:310-316 — one Enter per trigger pull; input cleared synchronously BEFORE the async lookup (kills concatenation and double-fire)
- apps/web/lib/barcode-resolve.ts:47-91 — server-only ladder with exact barcode→sku→unitSku precedence; non-404 errors propagate as a retry toast, never as not-found; a true miss opens the create-product modal in the operator's face
- apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx:432-500 — lines denormalized at add time (name/price/unitsPerBox copied on): no join at submit, no silent exclusion
- apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx:887-980 + apps/web/app/providers.tsx:16-38 — single POST with interactive 409 MERGE_CHOICE_REQUIRED and regulated-license recovery; global MutationCache.onError toast guarantees visibility
- apps/web/lib/api-client.ts:98-249 — interceptors are auth + 401-refresh ONLY: no offline queue, so nothing is silently enqueued, replayed, duplicated, or dropped
- Web sends replaceAll:false explicitly and box data on boxed lines — it never trips the server's allNewItems wipe heuristic (orders.service.ts:2857-2868) or the box-unaware merge repricing

## Bug details

### B190 — Scan gate single-slot raw-string dedupe re-adds one label on every alternating decode

**Severity:** CRITICAL

**Meant to do:** One physical presentation of an item = one add, regardless of which symbology the decoder happened to pick that frame.

**Actually does:** gateScan keeps a single lastCode slot of the RAW decode string and accepts any DIFFERENT string immediately (scan-loop.ts:34-39), while ean13/upc_a/itf14 are all enabled (ScanCamera.tsx:107-109) and barcode-normalize.ts:8-13 documents that the same label genuinely reaches the app as 12- or 13-digit depending on decoder. Product resolution normalizes; dedupe does not.

**The gap:** A carton face showing both its ITF-14 case code and EAN-13 item code — or one label flickering UPC-A/EAN-13 — is accepted on EVERY flip, each flip calling addOne, sometimes as a case (incrementLine) and sometimes as a loose piece (incrementLinePiece via scanUnitKind). Runaway 'N cs + M loose' quantities.

**Evidence:** apps/mobile/lib/scan-loop.ts:26-40 (verified in-repo: reject path returns state:next, single slot); apps/mobile/components/ScanCamera.tsx:82,96,107-109; apps/mobile/lib/barcode-normalize.ts:8-13,67-88; apps/mobile/lib/sale-line.ts:17-49

**Suggested fix:** Multi-slot (LRU ~4) gate keyed on the normalizeScanCode candidate set; per-code cooldown.

### B191 — Sliding cooldown suppresses deliberate same-item re-scans (under-count)

**Severity:** HIGH

**Meant to do:** Re-presenting the same item at a natural pace increments its qty (the 700ms constant was tuned for exactly this — the file's own comment says 1500ms was rejected because qty did not go up).

**Actually does:** Every REJECTED detection refreshes lastAt (gateScan returns {lastCode, lastAt: now} on the reject path too — verified at scan-loop.ts:34,39), so the code must be fully ABSENT from frame for ≥700ms before a repeat is accepted.

**The gap:** Scanning 5 units of one item at <700ms gaps yields qty 1; the operator got an 'added' haptic only for the first and believes all five counted. Web's wedge = 5 discrete adds.

**Evidence:** apps/mobile/lib/scan-loop.ts:6-19 (intent in comment), 34-39 (contradicting behavior)

**Suggested fix:** Refresh lastAt only on ACCEPT (fixed window). Ships with NEW-1's gate rework.

### B192 — busyRef drop-not-queue silently discards scans for up to 15s per resolve

**Severity:** CRITICAL

**Meant to do:** Every accepted decode is processed or visibly deferred.

**Actually does:** handleBarcodeScanned early-returns on busyRef with no haptic/pill/queue while the previous scan's 2-GET server resolve is awaited (ScanCamera.tsx:81-98). The local fast path covers only the current 50-row product page (scan-ladder.ts:56-68; PRODUCT_PAGE_SIZE=50), so in a real catalog most scans hold the mutex a full round trip — 15s on timeout (api-client.ts:8) — and ScanOrderSheet has no busy indicator (89-113).

**The gap:** A fast operator loses every item scanned inside these windows. This is the primary 'order missing many items' producer.

**Evidence:** apps/mobile/components/ScanCamera.tsx:74-99; apps/mobile/lib/scan-ladder.ts:56-96; apps/mobile/lib/use-product-search.ts:59-67; apps/mobile/lib/api/products.ts:13; apps/mobile/lib/api-client.ts:8

**Suggested fix:** Bounded pending buffer (deduped by normalized code) + visible resolving state + ~6s per-resolve timeout.

### B193 — Wedge-path concatenation turns two valid codes into one false NOT FOUND

**Severity:** HIGH

**Meant to do:** Each hardware-scanner burst resolves independently.

**Actually does:** While a ladder resolve is in flight, handleSearchSubmit early-returns on searchScanBusy AND the search field is cleared only inside acceptScannedProduct — the next wedge burst types into the still-populated field, so the eventual submit resolves '<code1><code2>' (NewOrderScreen.tsx:1131-1145, clear at 1089; mirrored edit-items.tsx:1771-1785). Web clears synchronously before awaiting (CreateOrderModal.tsx:310-316).

**The gap:** Guaranteed delayed 'No product for "<code1><code2>"' for two products that BOTH exist; neither is added. Direct S2 producer plus double item loss.

**Evidence:** apps/mobile/components/NewOrderScreen.tsx:1089,1131-1145; apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx:1771-1785; contrast apps/web/.../CreateOrderModal.tsx:310-316

**Suggested fix:** Clear the field synchronously at submit; buffer (not drop) a submit arriving during an in-flight resolve.

### B194 — Boxed increment discards a typed plain qty (typed 10 → scan → 1 box)

**Severity:** HIGH

**Meant to do:** Scanning a product already on the order increments its existing line, preserving what the operator entered (sale-line.ts's own doc comment: 'PRESERVING every other field').

**Actually does:** incrementLine/incrementLinePiece boxed branches recompute qty = boxes*upb+pieces WITHOUT folding prev.qty (verified sale-line.ts:25,48), and the catalog-row qty editor writes a plain qty and clears boxes/pieces even for boxed products (NewOrderScreen.tsx:1347-1350 via setLineQty, which deletes boxes/pieces — sale-line.ts:77-87), unlike the tray editor (1367-1372 routes upb>1 through setUnits).

**The gap:** Type qty 10 on a boxed product's catalog row, scan it once → the line becomes 1 box (= upb pieces); the 10 is silently destroyed. Also fires when the first add ran with unknown unitsPerBox and later adds see upb>1.

**Evidence:** apps/mobile/lib/sale-line.ts:17-49,77-87 (verified in-repo); apps/mobile/components/NewOrderScreen.tsx:1347-1350 vs 1367-1372

**Suggested fix:** Fold prev.qty as loose pieces and renormalize before adding; route boxed row-qty edits through setUnits.

### B195 — isActive asymmetry between resolve rungs → false NOT FOUND and vanish-on-resume

**Severity:** HIGH

**Meant to do:** A code that resolves at scan time stays resolvable, and 'not found' means the product does not exist.

**Actually does:** The API barcode rung matches INACTIVE products (products.service.ts:441-483, no isActive filter) but the client fallback search rung sends isActive:true&limit:10 (barcode-resolve.ts:85), the barcode-rung 404 is swallowed (72-76), and draft-resume hydration DROPS isActive===false / 404 lines with a delayed alert (NewOrderScreen.tsx:763-854).

**The gap:** An inactive product scan-adds with full confirmation, then vanishes on resume ('no longer in your catalog'); conversely a product findable only via search-shaped matching (digits in name, stored-code shape outside the candidate expansion, or past the 10-row cap) reports 'No product for X' while plainly visible in the catalog list. Both halves of S2's 'not found although it exists'.

**Evidence:** apps/api/src/products/products.service.ts:212-221,441-483; apps/mobile/lib/barcode-resolve.ts:66-107; apps/mobile/components/NewOrderScreen.tsx:763-854

**Suggested fix:** Align rungs (drop isActive from the search rung; distinct 'archived' outcome with reactivate affordance); hydration keeps-and-flags inactive lines instead of dropping.

### B196 — Timeout-as-offline enqueue + queue self-duplication + no idempotency on POST /orders

**Severity:** CRITICAL

**Meant to do:** A network-failed order submit is surfaced or retried safely, at most once.

**Actually does:** Any no-response axios error — the 15s ECONNABORTED timeout included — on a mutation enqueues it as 'offline' with NO NetInfo check (verified api-client.ts:125-131) even though the server may still complete the original; NetInfo's listener re-fires on every [queue] resubscribe (useNetworkSync.ts:67-76) replaying within seconds; drain replays run through the interceptor with a FRESH config lacking _offlineQueued, so a timed-out replay enqueues a NEW entry (retries=0) while the old one increments — the queue self-duplicates; and POST /orders deliberately carries no Idempotency-Key (NewOrderScreen.tsx:1682; only routes.ts:287 ever sets one), while a frozen mergeChoice:'merge' body re-adds the same lines each replay (1752-1775).

**The gap:** On 1-bar mobile networks (exactly where mobile differs from web-on-wifi) orders duplicate or quantities double/triple; combined with NEW-10's sweep the duplicates get SUMMED.

**Evidence:** apps/mobile/lib/api-client.ts:8,125-160 (verified); apps/mobile/hooks/useNetworkSync.ts:44-51,67-76 (verified); apps/mobile/components/NewOrderScreen.tsx:1682,1752-1775

**Suggested fix:** Gate enqueue on actual offline state / reject timeouts loudly; propagate a replay marker from drain; idempotency key on order create honored server-side.

### B197 — PATCH /orders/:id/items diff-add silently drops unresolvable productIds (200 with data loss)

**Severity:** HIGH

**Meant to do:** An add that cannot be applied fails loudly.

**Actually does:** `const product = await tx.product.findUnique(...); if (!product) continue;` — HTTP 200, the line is never persisted (orders.service.ts:3069-3071); the tenant tx proxy post-filters cross-tenant rows to null (prisma.service.ts:123-131), so a stale-cached id vanishes with zero signal anywhere.

**The gap:** Mobile per-scan/edit adds report success while the order silently misses items; nothing in logs, response, or UI distinguishes it from success.

**Evidence:** apps/api/src/orders/orders.service.ts:3069-3071,3124-3151; apps/api/src/prisma/prisma.service.ts:123-131

**Suggested fix:** Collect unresolved ids → 400 (or explicit warnings array clients must render).

### B198 — replaceAll inferred from payload shape wipes entire orders

**Severity:** CRITICAL

**Meant to do:** Wipe-and-recreate happens only on an explicit replaceAll instruction.

**Actually does:** Operator branch computes replaceAll = dto.replaceAll ?? allItemsLackIds (orders.service.ts:2857-2868): an id-less 'just add these' PATCH with the flag omitted deleteMany's every line and recreates only what was sent, returning 200. Web always sends replaceAll:false; any mobile/queued/third-party call that omits it destroys the order.

**The gap:** Catastrophic silent line loss keyed on an incidental payload property. Also the direct web-vs-mobile asymmetry for S3.

**Evidence:** apps/api/src/orders/orders.service.ts:2857-2868,2902-2910

**Suggested fix:** Default false; require explicit dto.replaceAll === true for the destructive branch.

### B199 — Staff merge flattens denominations and races itself (B47 family, CREATE path)

**Severity:** CRITICAL

**Meant to do:** Merging a new scan batch into the customer's open order preserves quantities, box splits, price overrides, and notes.

**Actually does:** The controller merge flattens existing+new to bare {productId, qty}, SUMMING piece-denominated qtys (box-split lines store qty in PIECES) with box-denominated qtys and dropping boxes/pieces/unitPrice/notes (orders.controller.ts:87-127); the replace branch recreates box-unaware and computeLineSubtotal prices qty as BOX count for upb>1 (orders.service.ts:2902-2960, missing the buyer re-split at 2790-2799; pricing.ts:101-118). The whole merge is a non-transactional read-modify-write (controller 59-127), and mergeAllPendingForCustomer reads orders+lines OUTSIDE its tx with no locks, overwriting winner qtys from a stale snapshot and hard-deleting losers (759-777,903-1042).

**The gap:** A 1-box+2-piece line (26 pieces) becomes 26 boxes at box price — quantities and totals explode by unitsPerBox in the DEFAULT staff mobile multi-batch flow; concurrent scan-adds/queue replays clobber each other's lines. Money-impacting: violates the boxed-line money discipline (never re-derive qty×unitPrice for a boxed line).

**Evidence:** apps/api/src/orders/orders.controller.ts:59-127; apps/api/src/orders/orders.service.ts:759-777,903-1042,2790-2799,2902-2960; apps/api/src/common/pricing.ts:101-118

**Suggested fix:** Denomination-aware lossless merge computed under updateOrderItems' FOR UPDATE lock; move sweep reads inside its tx with row locks; extend pricing.spec regression coverage.

### B200 — Customer role cannot resolve scans at all (403 on both rungs)

**Severity:** HIGH

**Meant to do:** Customer scanning resolves against the catalog like operator scanning ('operator/customer scanning' per the owner report).

**Actually does:** GET /products and GET /products/barcode are @Roles(OPERATOR, DRIVER) (products.controller.ts:37-55) and no buyer scan endpoint exists (buyer-catalog.service.ts only returns barcode as a field) — every customer-token resolve attempt is a 4xx.

**The gap:** Customer-side scans can only match stale local data or fail; the failures surface late (submit-time) or never (queue swallow). Every 'not found' a customer sees is structural, not data.

**Evidence:** apps/api/src/products/products.controller.ts:37-55; apps/api/src/buyer/buyer-catalog.service.ts:20,221,398

**Suggested fix:** Buyer-catalog-scoped barcode lookup endpoint, or remove the scan affordance from customer UI.

### B201 — Settled-search auto-add re-fires on slow refetch (phantom adds)

**Severity:** MEDIUM

**Meant to do:** The auto-add-on-exact-match effect fires once per wedge scan when the search results settle.

**Actually does:** The effect runs on [searchTerm, products, isSearching] guarded only by an 800ms same-code window (NewOrderScreen.tsx:1148-1161); a query refetch that re-settles after 800ms with the scan-looking term still in the field re-adds the product with no scan.

**The gap:** Phantom +1s on slow networks — a minor contributor to S1's 'random quantities'. Largely mooted once NEW-4's synchronous field clear lands (the term no longer lingers).

**Evidence:** apps/mobile/components/NewOrderScreen.tsx:1148-1161

**Suggested fix:** Guard on a per-scan nonce instead of a time window; clear the term synchronously (NEW-4).

## Fix set (from the synthesis)

- **apps/mobile/lib/scan-loop.ts** — Rework gateScan: (1) dedupe on the NORMALIZED candidate set (normalizeScanCode), not the raw decode string, with a small multi-slot LRU (e.g. last 4 codes, each with its own timestamp) so alternating decodes of the same label — or two codes printed on one carton face — are gated instead of re-added on every flip; (2) refresh lastAt only on ACCEPTED scans (fixed window, not sliding) so a natural-pace re-present of the same item increments qty. Both behaviors are pure functions with existing spec seams — add jest specs for the A/B/A alternation and the <700ms re-present cases. _[closes: NEW-1 (alternating-decode over-add), NEW-2 (sliding-cooldown under-count); largest single contributor to S1's 'random quantities']_
- **apps/mobile/components/ScanCamera.tsx** — Replace the busyRef drop-not-queue with a bounded pending buffer (depth 1-2, deduped by normalized code) and pass an isResolving flag to ScanOrderSheet so the operator sees a 'looking up…' state instead of dead frames; cap the per-scan resolve with a shorter effective timeout (~6s via AbortController/axios per-request timeout) so one slow lookup cannot freeze scanning for 15s. _[closes: NEW-3 (silent scan drops during in-flight resolve) — S1's 'missing many items']_
- **apps/mobile/components/NewOrderScreen.tsx (+ mirror in apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx and invoices/new.tsx)** — (1) Wedge path: clear the search field SYNCHRONOUSLY at submit before awaiting the ladder (exactly web CreateOrderModal.tsx:310-316) and buffer-not-drop a submit that arrives during searchScanBusy — kills the concatenation false-not-found. (2) onRowChangeQty: route unitsPerBox>1 products through setUnits (as onTrayChangeQty already does at 1367-1372) instead of setQty, so a typed quantity on a boxed catalog row survives a subsequent scan. _[closes: NEW-4 (wedge concatenation), NEW-5 (typed-qty wipe, with the sale-line.ts change)]_
- **apps/mobile/lib/sale-line.ts** — incrementLine and incrementLinePiece boxed branches must FOLD prev.qty instead of discarding it: when the line holds a plain qty with no boxes/pieces, treat that qty as loose pieces and renormalize (rollover at upb) before adding the new box/piece. Add regression specs (typed-10-then-scan case). _[closes: NEW-5 (boxed increment destroys typed plain qty) — S1 'quantities random/wrong']_
- **apps/mobile/lib/barcode-resolve.ts** — Align the two rungs: drop isActive:true from the fallback search rung and, when the best match is inactive, return a distinct 'archived' outcome (pill: 'X is archived — reactivate?') instead of {notFound:true}. This also requires NOT hard-dropping inactive lines in NewOrderScreen draft hydration (keep the line, badge it, let the operator decide) so a scan-added inactive product can't vanish on resume. _[closes: NEW-6 (isActive asymmetry → false NOT FOUND + vanish-on-resume) — core of S2]_
- **apps/mobile/hooks/useNetworkSync.ts** — Never dequeue silently: on 4xx and on retry-exhaustion, move the action into a persisted failedActions list on the offlineQueue store and surface it via alertInfo/InlineToast (NOT showToast) naming what was lost ('Order for <customer> could not be submitted: <server message>') with a retry affordance. Keep the RF-170 cancelled-run special case. This is the minimal 'never silent' cut of B143/B111 for this flow; the full failed-actions UI belongs to F20. _[closes: B143/B111 (this flow's reachable path: queued POST /orders → 409/400 → silent evaporation)]_
- **apps/mobile/lib/api-client.ts** — (1) Do not classify a timeout as offline while NetInfo reports online: gate the enqueue branch on useOfflineQueue.getState().isOnline === false (or error.code === 'ECONNABORTED' → reject loudly instead of enqueue) — a timed-out POST /orders must surface to submitOrder's onError, where the operator still has the full cart. (2) Mark drain replays (propagate _offlineQueued / a replay header from useNetworkSync's request) so a timed-out replay increments retries on the EXISTING entry instead of enqueuing a duplicate — stops queue self-duplication. _[closes: NEW-7 (timeout-as-offline duplication + queue self-duplication)]_
- **apps/mobile/components/NewOrderScreen.tsx (submitOrder) + apps/api/src/orders/orders.controller.ts** — Add a client-generated Idempotency-Key (uuid per cart session) to POST /orders and honor it server-side (tenant+key unique table, replay returns the original result). The api-client already preserves exactly this header for queue replays (api-client.ts:142-150) — this converts the queue's replay semantics from at-least-once to effectively-once. Supersedes the 'deliberately no idempotency key' stance at NewOrderScreen.tsx:1682, which predates timeout-enqueue behavior. _[closes: NEW-7's duplicate-order leg; hardens B143/B111 remediation]_
- **apps/mobile/lib/toast.ts** — Implement the iOS branch: route showToast to the existing InlineToast host (InlineToast.tsx exists precisely because of this gap) or Alert fallback when no host is mounted — so every wedge-path miss/failure sink (edit-items.tsx:1780, ProductPickerSheet.tsx:90, movements.tsx:89, adjust-picker.tsx:42, vendor-bills/new.tsx:277) becomes visible on iOS. _[closes: B151 (iOS showToast no-op)]_
- **apps/api/src/orders/orders.service.ts** — (1) 3069-3071: replace `if (!product) continue` with collecting the unresolved id and throwing 400 (or returning the order with an explicit warnings array the clients must render) — never 200 with a dropped line. (2) 2857-2868: kill the allNewItems inference — wipe-and-recreate ONLY on explicit dto.replaceAll === true, default false for the operator branch. (3) 2902-2960: apply the buyer branch's piece-denomination re-split (2790-2799) to operator replace payloads so merged boxed lines aren't repriced as boxes. (4) mergeAllPendingForCustomer 759-777/903-1042: move the orders+lineItems reads INSIDE the tx with SELECT..FOR UPDATE so winner-qty overwrites and loser deleteMany can't operate on a stale snapshot. _[closes: NEW-8 (silent continue), NEW-9 (replaceAll heuristic), NEW-10 (denomination mixing + merge races, B47 family)]_
- **apps/api/src/orders/orders.controller.ts** — 87-127: make the staff merge denomination-aware and lossless — merge per productId preserving boxes/pieces (sum boxes with boxes, pieces with pieces, rollover via normalizeBoxesPieces), carry unitPrice overrides and notes; and execute read-merge-write atomically by moving the merge computation into updateOrderItems under its existing FOR UPDATE order lock instead of computing from a controller-side pre-read. _[closes: NEW-10 (merge flatten + non-transactional read-modify-write)]_
- **apps/api/src/products/products.controller.ts (+ buyer-catalog)** — Either add a CUSTOMER-permitted, catalog-visibility-scoped barcode lookup (thin buyer-catalog scan endpoint reusing findByBarcode's normalize/tiers, filtered to what the buyer may see) or hide the scan affordance entirely from customer-role mobile UI. Today every customer resolve rung 403s, so customer scanning can only 'work' against stale local data. _[closes: NEW-11 (customer role cannot resolve scans)]_

## Routing / urgency

NEW IMMEDIATE HOTFIX BATCH (recommended name HF-scan, cut before resuming the 179-bug campaign) — two small PRs: (1) HF-scan-mobile, client-only, one mobile release: scan-loop gate rework (NEW-1/NEW-2: normalized multi-slot dedupe + accept-only cooldown refresh — pure functions, jest-speccable), ScanCamera pending buffer + resolving indicator + shorter resolve timeout (NEW-3), NewOrderScreen/edit-items synchronous wedge-field clear (NEW-4, which also moots NEW-12), sale-line prev.qty fold + boxed row-qty routing (NEW-5), barcode-resolve isActive alignment client half (NEW-6), and the minimal never-silent change in useNetworkSync (B143/B111 cut: 4xx/exhaustion → persisted failed list + alertInfo). (2) HF-scan-api, independently deployable via the standard public-window flow: orders.service silent `continue` → collected 400 (NEW-8), replaceAll default-false explicit-flag (NEW-9), and the search-rung/barcode-rung isActive alignment server half (NEW-6). These are the direct, smallest-diff causes of the active pain. FAST-FOLLOW API BATCH (same week, needs pricing regression specs per money discipline): NEW-10 — denomination-aware lossless merge under the updateOrderItems lock + mergeAllPendingForCustomer tx/locks (money-impacting; cross-ref B47 but do NOT fold into the B47 edit-path fix). F19 (mobile session/offline-queue): the full NEW-7 remediation — timeout≠offline classification, drain replay marker to stop queue self-duplication, queue age cutoff, replay-time tenant/role guard, and the POST /orders Idempotency-Key (client+server, needs a small dedupe table design — why it's F19 not hotfix). F20 (error feedback): B151 iOS toast implementation across all sinks, the full failed-actions store + surfacing UI (upgrade of the hotfix's minimal alert), distinct 'archived product' messaging, submit-error attribution. F21 (cache coherence): B140 overlap — scannedById/50-row fast-path staleness vs server truth, local-index invalidation, draft-resume revalidation policy (keep-and-flag instead of drop). NEW-11 (customer scan endpoint) is product-decision-gated: route to F20 if the answer is 'hide the affordance', or its own small feature PR if the answer is a buyer lookup endpoint — ask the owner which.

CRITICAL — ship the hotfix batch immediately. This is active production pain for paying operators with three compounding properties: (1) silent data loss — multiple paths return success (client haptic, HTTP 200) while lines or whole orders are dropped, so the blast radius is invisible to users AND to logs; (2) money impact — NEW-10 reprices merged boxed lines as boxes (overcharge by unitsPerBox, violating the repo's boxed-line money discipline) and NEW-7 can duplicate whole orders, i.e. real invoicing errors against real customers are plausibly occurring now; (3) trust erosion in the primary operator surface (mobile-first program) with web as the workaround. Sequencing: start HF-scan-mobile first since a mobile release has the longest lead time, land HF-scan-api the same day via the standard flow (it deploys in minutes), then the NEW-10 money fix with pricing.spec coverage this week. Until the mobile release reaches devices, the honest interim guidance to the owner's affected clients is: scan-heavy order building on WEB, mobile for everything else. The register/artifact update owed by mandate should record NEW-1..NEW-12 plus the B143/B111/B151/B47/B140 confirmations in the same pass.

## Residuals (recorded at F30 close-out, 2026-08-31)

- **POST /orders/sell has no idempotency protection.** `createSale` delegates its order half to
  `create()` but forwards no key (CreateSaleDto has none), and its invoice half
  (`createInvoiceFromOrder` + delivered-now update) is not replay-aware — a naive key forward
  would make a replay hit the "order created but invoice could not be generated" 500 instead of
  returning the original sale. Needs a small design (replay flag out of `create()`, fetch-existing
  branch for the invoice half) — out of F30's minted scope (B190–B201 cover POST /orders + the
  scan pipeline). Severity minor: van-sale is a deliberate button press; the offline queue's
  replay marker (R2) already stops queue self-duplication. Candidate for a future hunt round to
  mint as its own register entry.
- **withOrderMergeLock is per-process (R11/B199 lost-update half) — DEFERRED ON EVIDENCE 2026-08-31.**
  The controller-instance Map serializes merges within ONE API process; two replicas would still race
  their reads. Checked before acting: `@routeflow/api` runs exactly 1 instance (no `numReplicas` in
  railway.toml, `numReplicas = null` in Railway's API, live deployment reports 1 running instance), so
  the race is unreachable and restructuring the money path to close it is the larger risk. ⚠️ Scaling is
  the trigger and it fails SILENTLY (wrong money, no error/log/test); Railway injects no replica-count
  variable, so the guard is a comment in `apps/api/railway.toml`'s `[deploy]` block. Three designs in
  `withOrderMergeLock`'s doc comment — Redis lock (cheapest, Redis already a dependency), optimistic CAS
  + 409 retry, or the full fold-inside-the-transaction (which must MOVE, not delete, the T-B199
  "ONE INSTANCE" spec block).
- **recordIdempotencyKey single-slot carry (R6).** When an auto-merge sweep folds several keyed
  losers into one winner, only the eldest loser's key can occupy the winner's slot; later losers'
  keys are dropped (their clients' replays fall back to content comparison against the merged
  order, which 409s on mismatch instead of duplicating). Documented Low — by design.
