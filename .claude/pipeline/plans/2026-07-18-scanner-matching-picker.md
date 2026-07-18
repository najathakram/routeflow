# Plan: Invoice-scan matching accuracy + product picker overhaul + create-from-line

> Authored by Fable 5 on 2026-07-18. Status: IMPLEMENTED (pipeline wf_d8a32f68-b72 clean; verify green; 1 fix round — fixed a mis-constructed matcher spec + lint-warning gate failures + a bare-variant closed-state label in batch review)
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## Objective

Fix three user-reported problems with the supplier-invoice scanner and its product pickers:

A) **Weak matches stick.** The server matcher auto-assigns any product scoring ≥ 0.35 with a
first-in-DB-order tie-break, and matches against BARE variant names ("Cinnamon" instead of
"Big Red Chewing Gum - Cinnamon"), so wrong flavor-siblings win. And both scan review UIs
populate their per-line override dropdown from ONE static page of `useProducts({limit:1000})`
— catalogs beyond 1000 products lose the alphabetical tail entirely, so the operator can't
even correct the mistake. Fix: rarity-weighted matching against COMPOSED names, no
auto-assign below 0.6 (weak guesses become ranked `candidates[]` suggestions), and debounced
server-side search in the pickers (the `/products` endpoint already supports
contains/insensitive search).

B) **Truncated names.** The shared `SearchableProductPicker` truncates option names
(`truncate` class) so flavor variants sharing a prefix are indistinguishable. Fix: composed
display names, 2-line wrap, and a floating side-preview panel (full name, SKU, barcode,
price, thumbnail) that follows the highlighted option — the "beautiful floating window" the
user asked for.

C) **Add-product from an unmatched line.** Today ScanInvoiceModal hides a "Create product
from this line" text link behind the "Custom item" selection, opening a slim quick-create
missing most product fields; the batch review has no create option at all. Fix: a visible
"+" button right next to the picker on any未-linked line (both scan surfaces) opening the
FULL product form — the products page's AddProductModal extracted into a shared component —
pre-filled from the scanned line (name, SKU, price suggestion, cost). The OCR prompt gains
per-line `sku` extraction so there is a scanned SKU to prefill (today only
extractedName/qty/unitCost/lineTotal are extracted).

## Constraints & conventions

- Next.js 14 web `apps/web` (Radix+Tailwind, TanStack Query), NestJS API `apps/api`, Expo
  mobile `apps/mobile`. Prettier double quotes / printWidth 100. Jest for API+mobile; web has
  NO component-test infra (Playwright only) — correctness burden lives in the API specs.
- **No new dependencies** (no Radix HoverCard, no fuzzy-match npm package).
- The scan OCR call (Claude `claude-haiku-4-5` in `vendor-bills.service.ts`, prompt at
  ~594-619) stays pure OCR — no catalog reasoning in the model call.
- Scan response shape stays BACKWARD COMPATIBLE — `candidates`/`sku` are additive optional.
- `matchedProductName` becomes the COMPOSED display name. Audited consumers: batch import
  uses `extractedName` for descriptions (safe); web/mobile display-only (improved).
- Web display-name composition helper already exists: `displayProductName` +
  `PRODUCT_NAME_SEPARATOR` (" - ") in `apps/web/lib/product-display.ts`. The API matcher
  defines its own local `" - "` constant (no cross-app import).
- Prisma self-relation on Product: `parent Product? @relation("ProductVariants",
fields: [parentProductId], references: [id])` — variants are separate rows whose `name` is
  the bare variant name; invariant `name === variantName` for variant rows.
- Products list endpoint (`GET /products`, products.service.ts): default limit 20, max
  10000, `contains`/`mode:"insensitive"` on name/sku/barcode; response rows already include
  `parent {id,name}` and a presigned `thumbnailUrl`.

## Work packages

### WP1 — API: pure matcher module + scanInvoice rewire + OCR sku + specs

- **files:** `apps/api/src/vendor-bills/product-matcher.ts` (new),
  `apps/api/src/vendor-bills/product-matcher.spec.ts` (new),
  `apps/api/src/vendor-bills/vendor-bills.service.ts`,
  `apps/api/src/vendor-bills/vendor-bills.service.spec.ts`
- **brief:**

1. **New `product-matcher.ts`** — pure functions, no Nest/Prisma imports (zero-mock specs).
   Transplant this code exactly (it is the heart of the fix; the rarity weighting is REQUIRED
   — composed names alone still tie 0.75/0.75 on the canonical flavor-sibling case, df
   weights break the tie the right way):

   ```ts
   /**
    * Pure matching logic for supplier-invoice scan lines. No Nest/Prisma imports —
    * the catalog and token weights are passed in, so specs run with zero mocks.
    *
    * Variants are separate Product rows whose `name` is the BARE variant name
    * ("Cinnamon"); matching always works on the COMPOSED display name
    * ("Big Red Chewing Gum - Cinnamon") so flavor lines land on the right sibling.
    * Rare (distinguishing) tokens — flavors, sizes — outweigh ubiquitous ones
    * ("gum", "chips") via document-frequency weights, which is what breaks
    * shared-prefix sibling ties correctly.
    */
   export interface CatalogProduct {
     id: string;
     name: string;
     sku: string | null;
     barcode: string | null;
     parentProductId?: string | null;
     parent?: { name: string } | null;
   }

   export interface MatchCandidate {
     productId: string;
     /** Composed display name. */
     name: string;
     sku: string | null;
     /** Weighted-overlap score, 0..1, rounded to 2dp. */
     score: number;
   }

   export interface LineMatch {
     matchedProductId: string | null;
     matchedProductName: string | null;
     confidence: "high" | "medium" | "low" | "none";
     candidates?: MatchCandidate[];
   }

   /** Mirrors apps/web/lib/product-display.ts PRODUCT_NAME_SEPARATOR. */
   const SEPARATOR = " - ";

   export function composedProductName(p: CatalogProduct): string {
     const parentName = p.parent?.name?.trim();
     if (!p.parentProductId || !parentName) return p.name;
     // Legacy variants sometimes already carry the parent prefix — don't double it.
     if (p.name.toLowerCase().startsWith(parentName.toLowerCase())) return p.name;
     return `${parentName}${SEPARATOR}${p.name}`;
   }

   export function normalizeForMatch(s: string): string {
     return s
       .toLowerCase()
       .replace(/[^a-z0-9 ]/g, " ")
       .replace(/\s+/g, " ")
       .trim();
   }

   function tokensOf(s: string): string[] {
     return normalizeForMatch(s)
       .split(" ")
       .filter((w) => w.length > 2);
   }

   /** Document-frequency token weights over the composed catalog names. */
   export function buildTokenWeights(products: CatalogProduct[]): Map<string, number> {
     const df = new Map<string, number>();
     for (const p of products) {
       for (const t of new Set(tokensOf(composedProductName(p)))) {
         df.set(t, (df.get(t) ?? 0) + 1);
       }
     }
     const weights = new Map<string, number>();
     for (const [t, n] of df) weights.set(t, 1 / Math.log2(2 + n));
     return weights;
   }

   function weightOf(t: string, weights: Map<string, number>): number {
     // A token the catalog has never seen (invoice-side noise) gets max weight so
     // it penalises the denominator — unknown words should LOWER confidence.
     return weights.get(t) ?? 1;
   }

   export function matchLine(
     raw: string,
     scannedSku: string | null | undefined,
     products: CatalogProduct[],
     weights: Map<string, number>,
   ): LineMatch {
     const rawTrim = (raw ?? "").trim();
     const rawLower = rawTrim.toLowerCase();
     const skuLower = scannedSku?.trim().toLowerCase() || null;
     if (!rawLower && !skuLower) {
       return { matchedProductId: null, matchedProductName: null, confidence: "none" };
     }

     // 1. Exact name — bare OR composed.
     for (const p of products) {
       const composed = composedProductName(p);
       if (p.name.toLowerCase() === rawLower || composed.toLowerCase() === rawLower) {
         return { matchedProductId: p.id, matchedProductName: composed, confidence: "high" };
       }
     }

     // 2. Exact SKU / barcode — against the raw text (legacy behaviour) AND the
     //    scanned per-line item code.
     for (const p of products) {
       const pSku = p.sku?.toLowerCase() ?? null;
       if (
         (pSku && (pSku === rawLower || (skuLower && pSku === skuLower))) ||
         (p.barcode && (p.barcode === rawTrim || (scannedSku && p.barcode === scannedSku)))
       ) {
         return {
           matchedProductId: p.id,
           matchedProductName: composedProductName(p),
           confidence: "high",
         };
       }
     }

     // 3. Weighted fuzzy overlap vs composed names.
     const rawToks = tokensOf(rawTrim);
     if (rawToks.length === 0) {
       return { matchedProductId: null, matchedProductName: null, confidence: "none" };
     }
     const rawSet = new Set(rawToks);
     const rawWeight = [...rawSet].reduce((s, t) => s + weightOf(t, weights), 0);
     const scored: Array<{
       p: CatalogProduct;
       composed: string;
       score: number;
       hits: number;
       prefix: boolean;
     }> = [];
     for (const p of products) {
       const composed = composedProductName(p);
       const pToks = new Set(tokensOf(composed));
       if (pToks.size === 0) continue;
       let matched = 0;
       let hits = 0;
       let pWeight = 0;
       for (const t of pToks) {
         const w = weightOf(t, weights);
         pWeight += w;
         if (rawSet.has(t)) {
           matched += w;
           hits++;
         }
       }
       if (hits === 0) continue;
       const score = matched / Math.max(rawWeight, pWeight);
       const nc = normalizeForMatch(composed);
       const nr = normalizeForMatch(rawTrim);
       scored.push({ p, composed, score, hits, prefix: nc.startsWith(nr) || nr.startsWith(nc) });
     }
     // Deterministic ordering: score → raw hit count → exact-prefix → name asc.
     scored.sort(
       (a, b) =>
         b.score - a.score ||
         b.hits - a.hits ||
         Number(b.prefix) - Number(a.prefix) ||
         a.composed.localeCompare(b.composed),
     );
     const candidates: MatchCandidate[] = scored
       .filter((s) => s.score >= 0.25)
       .slice(0, 5)
       .map((s) => ({
         productId: s.p.id,
         name: s.composed,
         sku: s.p.sku ?? null,
         score: Math.round(s.score * 100) / 100,
       }));
     const best = scored[0];
     if (best && best.score >= 0.6) {
       return {
         matchedProductId: best.p.id,
         matchedProductName: best.composed,
         confidence: best.score >= 0.8 ? "high" : "medium",
         ...(candidates.length ? { candidates } : {}),
       };
     }
     if (best && best.score >= 0.35) {
       // A weak guess is NOT auto-assigned — it is offered as suggestions. This is
       // the "weak matches get matched" fix: the line arrives unlinked, with chips.
       return { matchedProductId: null, matchedProductName: null, confidence: "low", candidates };
     }
     return {
       matchedProductId: null,
       matchedProductName: null,
       confidence: "none",
       ...(candidates.length ? { candidates } : {}),
     };
   }
   ```

2. **`vendor-bills.service.ts` rewire** (the Phase-2 matching block, ~701-822):
   - Catalog query select gains `parentProductId: true, parent: { select: { name: true } }`.
   - `productMapping.findMany` include gains the same on its `product` select; the mapping
     branch returns `matchedProductName: m.product ? composedProductName(m.product) : m.productName`
     (learned mappings stay FIRST and authoritative, `confidence: "high"`, no candidates).
   - Delete the inline `norm`/`overlap` helpers and the exact/fuzzy blocks (steps 2-4);
     replace with `const weights = buildTokenWeights(products);` once, then per line:
     `const match = matchLine(raw, item.sku ?? null, products, weights); return { ...item, ...match };`
   - **OCR prompt**: in the items schema (~line 605-611) add, after `"extractedName"`:
     `"sku": "item code / SKU / product number printed on the line, exactly as written, or null if none",`
     (the per-line spread `...item` already carries any extra parsed key through to the
     response — no further mapping needed).

3. **Specs**:
   - New `product-matcher.spec.ts` (pure, no mocks): composedProductName (standalone /
     variant with parent / parent-not-loaded fallback / already-prefixed legacy name);
     exact composed-name match → high; exact scanned-SKU match → high; **the canonical
     variant trap**: catalog = standalone `{name:"Big Red Chewing Gum"}` + variant
     `{name:"Cinnamon", parentProductId:"p1", parent:{name:"Big Red Chewing Gum"}}`, raw
     `"Big Red Cinnamon Gum"` → the VARIANT wins with confidence high (score ≈0.81 vs
     ≈0.70) and the standalone appears in candidates ranked 2nd; thresholds (≥0.8 high /
     0.6-0.8 medium assigned / 0.35-0.6 → null + "low" + candidates / <0.35 none);
     deterministic tie-break (equal score → higher hit count → prefix → name asc);
     candidates capped at 5, scores 2dp.
   - `vendor-bills.service.spec.ts` (extend the existing scanInvoice block ~308-400): a weak
     line comes back with `matchedProductId: null`, `confidence: "low"`, non-empty
     `candidates`; a learned mapping still wins over fuzzy and returns the composed name;
     the response carries per-line `sku` through when the OCR JSON includes one.

### WP2 — Batch import: candidates type + learning-loop write + specs

- **files:** `apps/api/src/import/batch-import.service.ts`,
  `apps/api/src/import/batch-import.service.spec.ts`
- **effort:** low
- **brief:**
  - The local `ScanLine` interface (~10-20) gains `sku?: string | null` and
    `candidates?: Array<{ productId: string; name: string; sku: string | null; score: number }>`.
    No behavioural change in `classifyAndPersist` needed: former low-confidence lines now
    arrive with `matchedProductId: null` → counted `unmatched` → NEEDS_REVIEW (they already
    forced review via the `lowConfidence` gate, so queue statuses are unchanged; they now
    present as unmatched-with-suggestions instead of silently pre-picked).
  - **Learning-loop fix**: in `updateItemLines` (~263-333), when a patch sets a `productId`
    for a line, upsert a product mapping so batch-review picks teach the matcher (today they
    teach nothing). Find the existing mapping-save method on VendorBillsService (grep
    `productMapping` writes in vendor-bills.service.ts — the same method the web scanner's
    mapping endpoint uses) and call it with (supplier name from the item's payload, the
    line's `extractedName`, the picked productId) — ONLY when both supplier and
    extractedName are non-empty strings. `VendorBillsService` is already injected.
  - Specs: a null-matched line with candidates → NEEDS_REVIEW + counted in unmatched;
    `updateItemLines` with a productId patch calls the mapping save with the right args;
    no mapping write when supplier or extractedName is missing.

### WP3 — Web: SearchableProductPicker async mode + composed labels + floating preview

- **files:** `apps/web/components/SearchableProductPicker.tsx`, `apps/web/lib/api/products.ts`
- **brief:** The picker (verbatim current structure: `PickerProduct{id,name,sku?,isActive?}`,
  static `products` prop, `visibleProducts` memo with `.slice(0,200)`, `highlight` state
  driven by mouse-enter + arrow keys, option row at ~196-201 with `className="truncate"`,
  popup div `absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto …`):

1. `lib/api/products.ts` — `useProducts(params)` gains an options arg
   `opts?: { enabled?: boolean }` spread into the useQuery (`enabled: opts?.enabled ?? true`).
   Purely additive; existing callers untouched.
2. Picker props: add `async?: boolean;` and `selectedLabel?: string;`; widen `onChange` to
   `(productId: string, product?: PickerProduct) => void`; widen `PickerProduct` with
   OPTIONAL `barcode?`, `variantName?`, `parentProductId?`, `parent?: { name?: string | null } | null`,
   `pricePerUnit?: string | number`, `thumbnailUrl?: string | null` (all optional — the 4
   existing static call sites compile untouched).
3. Async mode: debounce the internal `search` 300ms (same pattern as CreateOrderModal);
   `useProducts({ search: debounced || undefined, isActive: true, includeVariants: true, limit: 50 }, { enabled: !!asyncMode && open })`
   — the `enabled: open` gate matters: a scan table renders ~50 pickers; only the OPEN one
   may fetch. Source list = async ? fetched rows : `products` prop. In async mode the
   closed-state display value is `selectedLabel ?? selectedFromList?.name ?? ""` (the
   selection is often NOT in the current page). `handleSelect` passes the picked object to
   `onChange(id, product)`.
4. Labels: render `displayProductName(p)` (import from `@/lib/product-display`; it already
   falls back to `p.name` for narrow shapes) instead of `p.name` in both the option rows and
   the closed-state display; replace the option `truncate` class with
   `line-clamp-2 break-words` (keep `title`).
5. **Floating side-preview panel** (new private component in the same file, rendered when
   `open && visibleProducts[highlight]`): `position: fixed`, width 280px, `z-[300]` (above
   modal overlays; the scan surfaces put pickers inside `overflow-y-auto` containers that
   clip absolute descendants — fixed escapes them). Position from
   `containerRef.current.getBoundingClientRect()` recomputed on open/highlight/search
   change: `left = rect.right + 8`, flipped to `rect.left - 288` when it would overflow
   `window.innerWidth - 8`; `top = Math.min(rect.top, window.innerHeight - panelMax - 8)`
   with `panelMax ≈ 320`. Content, all conditional on field presence: thumbnail
   (`thumbnailUrl`, `h-28 w-full rounded object-cover`), full composed name
   (`text-sm font-medium text-navy break-words` — NO truncation), SKU + barcode lines
   (`text-[11px] text-navy/70`), price (`pricePerUnit` formatted `$X.XX`), "Inactive" badge
   (reuse the existing badge markup). Styling matches the popup:
   `rounded-lg border border-surface-border bg-white p-3 shadow-lg`. Degrades to a
   name-only card for narrow static shapes. Add `preview?: boolean` prop defaulting to
   TRUE (all call sites get it; pass `preview={false}` nowhere for now).

### WP4 — Web: ScanInvoiceModal — async picker, chips, add-product button, sku prefill

- **files:** `apps/web/components/ScanInvoiceModal.tsx`, `apps/web/lib/api/invoice-scan.ts`
- **brief:**

1. `lib/api/invoice-scan.ts`: `ScannedItem` gains `sku?: string | null;` and
   `candidates?: ScanCandidate[];` with
   `export interface ScanCandidate { productId: string; name: string; sku: string | null; score: number }`.
2. The per-line native `<select>` (~1648-1669) → `<SearchableProductPicker async
value={item.productId} selectedLabel={item.description || item.matchedProductName || undefined}
onChange={(id, product) => handleProductSelect(i, id, product)} placeholder="Search products…" />`.
   Extend `handleProductSelect` to accept the optional product object and use it when the
   local 1000-row `products` list misses (fresh/async picks): description from
   `displayProductName(product)` (or the passed object's name), mapping-save unchanged.
   KEEP the "— Custom item —" affordance: the picker's clear (X) sets `productId: ""` which
   is the existing custom-item state; keep the custom-description input block below.
   KEEP `useProducts({ limit: 1000 })` (:332) — it still powers variant-sibling splits and
   other flows; removing it is an explicit non-goal.
3. The `ReviewItem` row type + `applyScan` (~457-467) carry `sku` and `candidates` through
   from the scan response.
4. **Candidate chips**: when `!item.productId && item.candidates?.length`, render up to 3
   small buttons under the picker: `Did you mean {name}? ({Math.round(score * 100)}%)` —
   each calls `handleProductSelect(i, c.productId, { id: c.productId, name: c.name, sku: c.sku ?? undefined })`
   (the candidate name is already composed; this also feeds the mapping-learn on select).
   Style like the existing small brand-tinted action buttons in this file.
5. **"+ Add product" button** immediately RIGHT of the picker (same flex row), shown when
   `!item.productId`: a compact bordered icon button (`Plus` icon, size ~h-7 w-7,
   `border-surface-border text-brand-600 hover:bg-brand-50 rounded-lg`, `title="Add as new
product"`) that calls `setCreateFromRow(i)`. DELETE the old buried "Create product from
   this line" text link (~1681-1689) — the button replaces it (the custom-description input
   stays).
6. Swap the modal at the bottom (~2028-2066) from `InlineCreateProductModal` to the new
   shared `ProductCreateModal` (WP6), adding `initialSku={reviewItems[createFromRow].sku ?? undefined}`
   to the existing initialName/initialPrice/initialCost prefills. The `onCreated` handler is
   UNCHANGED (link row + saveMapping + close). Remove the now-unused
   `InlineCreateProductModal` import from THIS file only (other surfaces keep using it).
7. `ConfidenceBadge` (~203-226): the "low" variant's label/tooltip now means "no match —
   suggestions below" (it is no longer an assigned match); reword accordingly, keep colors.

### WP5 — Web: BatchItemReviewModal — async picker, chips, add-product + types

- **files:** `apps/web/components/BatchItemReviewModal.tsx`, `apps/web/lib/api/batch-import.ts`
- **effort:** low
- **brief:** Drop `useProducts({ limit: 1000 })` (~39-45); switch the picker (~210-216) to
  `async` with `selectedLabel` from the line's matched/extracted name; candidate chips (same
  chip pattern as WP4) wiring into the existing `setPicks` state; a "+ Add product" button
  next to the picker for unmatched lines opening `ProductCreateModal` with the line's
  prefills (extractedName / sku / unitCost·1.3 / unitCost), `onCreated` → set the pick for
  that line. `lib/api/batch-import.ts`: add `sku?: string | null` + `candidates?` to the
  scan-line type it declares (grep for `matchedProductId` in that file).

### WP6 — Web: extract the full product form into a shared ProductCreateModal

- **files:** `apps/web/components/ProductCreateModal.tsx` (new),
  `apps/web/app/(dashboard)/products/page.tsx`
- **brief:** Move the products page's inline `AddProductModal` component (~585-1080: form
  state `name/sku/unit/pricePerUnit/category/description/costingMethod/standardCost/
unitsPerBox/parentProductId/variantName/trackedCategoryId/trackedSubcategoryId`,
  parent-inheritance effect, regulated section+subcategory pickers, barcode-resolve for
  "Variant of", image queue + `uploadProductImages` after create) into
  `components/ProductCreateModal.tsx`, prop-for-prop identical behaviour, with these changes:
  - The shared component OWNS its data needs: fetch parent candidates via
    `useProducts({ limit: 0 })` inside it (the page currently passes `allProducts`); keep
    accepting `units` the way the page sources it — if `units` comes from a hook, move the
    hook inside; if it's derived page state, keep a `units?: string[]` prop with the page
    passing it (choose whichever keeps the page-side diff smallest and say so in a comment).
  - Keep `defaultParentId?: string` (the page's create-variant-from-parent flow).
  - New optional prefill props: `initialName?: string; initialSku?: string;
initialPrice?: number; initialCost?: number`. On open, seed `name`/`sku` and
    `pricePerUnit` (2dp) from them. `initialCost`: render the same "Suggested from invoice
    cost $X + 30%" hint the slim modal shows, and include
    `standardCost: String(initialCost)` in the create payload ONLY when
    `costingMethod === "STANDARD"` OR the form's standardCost field is left untouched —
    simplest faithful rule: when `initialCost > 0`, pre-fill the `standardCost` field with
    it (visible + editable); the existing submit logic (`standardCost` sent only when
    `costingMethod === "STANDARD"`) then applies unchanged, and FIFO products get their
    cost from the bill's receive layer instead (no data loss — note this in a comment).
  - The component calls `useCreateProduct` + `uploadProductImages` itself and invokes
    `onCreated(product)` with the created row (same `CreatedProduct`-style shape the scan
    surfaces need: id, name, sku, unit, pricePerUnit, unitsPerBox, parentProductId,
    variantName, parent) then closes.
  - `products/page.tsx` swaps its inline component for the import — ZERO behaviour change
    on the page (its own create flow, variant flow, image upload must work identically).
  - Do NOT touch `InlineCreateProductModal` (the app-wide quick-create keeps its ~10 other
    call sites).

### WP7 — Mobile: scan types + helper test

- **files:** `apps/mobile/lib/api/vendor-bills.ts`, `apps/mobile/__tests__/vendor-bill-scan.test.ts`
  (locate the actual scan-helpers test file — grep `unmatchedCount` under `apps/mobile`)
- **effort:** low
- **brief:** Mirror the additive scan-response fields (`sku?`, `candidates?`) on the mobile
  scan types (~34-42). Mobile behaviour then improves automatically: former weak matches
  arrive null → `unmatchedCount` counts them → the review prompt fires (desired). Add one
  test: a candidates-bearing unmatched line counts in `unmatchedCount` and contributes no
  productId to the built bill DTO. All existing tests must stay green. Mobile candidate-chip
  UI and create-from-line are OUT OF SCOPE (deferred).

## Acceptance criteria

1. Matcher: exact bare/composed name, scanned-SKU, and barcode matches → high; scores
   0.35–0.6 are NOT auto-assigned (null + confidence "low" + candidates); candidates (≤5,
   score ≥0.25, composed names, 2dp) returned on fuzzy-path lines; deterministic tie-breaks;
   the canonical variant-trap case resolves to the variant with the old wrong winner ranked
   2nd. Learned mappings still win over everything and return composed names.
2. The OCR prompt requests per-line `sku` and the scan response carries it through.
3. Both scan surfaces' pickers search the WHOLE catalog server-side (debounced, limit 50,
   fetch only while open) — a product alphabetically beyond position 1000 is findable.
4. Picker options show composed names, wrap to 2 lines, and a fixed-position side preview
   follows the highlighted option showing full name/SKU/barcode/price/thumbnail; no popup
   clipping inside either modal; static call sites compile and behave unchanged.
5. Unmatched lines show up to 3 "Did you mean …" chips; picking one links the line AND
   feeds the mapping learning loop (web scanner immediately; batch review via
   updateItemLines).
6. An unlinked line shows a "+" add-product button beside the picker (both surfaces) opening
   the FULL product form (variants, regulated section/subcategory, description, costing,
   units/box, images) pre-filled with scanned name/SKU/price/cost; creating auto-selects the
   product into the line. The products page's own create flow is byte-identical in behaviour.
7. Batch review operator picks write productMapping rows (supplier + extractedName guard).
8. `npm run verify` green; no new deps; scan response changes purely additive.

## Verification commands

- `npm run verify`

## Risks & rollback

- Shared picker regression across its 5 call sites — every new prop optional, static mode
  preserved except labels/wrap/preview; reviewers should check `GroupAsVariantsModal`,
  `InlineCreateProductModal`, `inventory/page.tsx`, `products/page.tsx` compile + behave.
- `AddProductModal` extraction touches the app's primary product-create flow — keep it
  mechanical; reviewer walks create/variant-create/image-upload paths on the page diff.
- Score drift on borderline mediums is locked by the matcher spec's canonical examples;
  thresholds (0.8/0.6/0.35) deliberately unchanged.
- Visible behaviour shift (weak matches now unlinked-with-suggestions) is the requested fix.
- Rollback: revert the commit — no migration, response fields additive.
