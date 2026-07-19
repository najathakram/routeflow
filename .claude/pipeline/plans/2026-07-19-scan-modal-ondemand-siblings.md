# Plan: ScanInvoiceModal — on-demand variant siblings, delete the 1000-product preload

> Authored by Fable 5 on 2026-07-19. Status: IMPLEMENTED (pipeline wf_c50a09f0-c1a clean on first pass; verify green, 0 findings)
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## Objective

Remove `ScanInvoiceModal`'s residual `useProducts({ limit: 1000 })` catalog preload. Since the
picker overhaul, the preload serves ONLY the variant-split feature (`getVariantSiblings`) and
a few product-object lookups. Replace it with an on-demand fetch when the operator actually
uses the split feature. This also fixes a latent bug: today `getVariantSiblings` returns `[]`
whenever the matched product isn't in the first-1000 preload, so the split button silently
no-ops for catalogs beyond 1000 products.

Server support already exists — NO API changes:

- `GET /products/:id` (products.service.ts `findOne` :220-225) includes `variants` (ordered)
  and `parent: true`.
- `GET /products?search=…` is contains/insensitive on name/sku/barcode.

## Constraints & conventions

- ONE file: `apps/web/components/ScanInvoiceModal.tsx`. Prettier double quotes/printWidth 100.
  No new deps. Preserve existing behaviors byte-for-byte except where stated.
- Use `apiClient` (already imported or import from `@/lib/api-client`) for the imperative
  fetches — same pattern as other on-click lookups in the codebase (e.g. barcode resolve).
- `displayProductName` is already imported from `@/lib/product-display`; called with ONE arg
  it composes "Parent - Variant" from `product.parent?.name`/`variantName` and falls back to
  `product.name`.

## Work packages

### WP1 — swap the preload for an on-demand sibling fetch

- **files:** `apps/web/components/ScanInvoiceModal.tsx`
- **brief:** Current consumers of the preloaded `products` array (from
  `useProducts({ limit: 1000 })` at ~359-374):
  (a) `getVariantSiblings` ~395-435 (two paths: parent-tagged family; name-prefix grouping
  with separators `" - "`, `" — "`, `": "`, prefix ≥3 chars, startsWith match);
  (b) `handleProductSelect` ~718-730 (`products.find ?? pickedProduct` + `displayProductName(product, products)`);
  (c) `startSplit` ~759-769 (seeds splits from siblings);
  (d) render ~1662-1672 (`siblings`/`autoDetectedCount` for the split-button title; `canSplit`
  itself does NOT need siblings);
  (e) `buildBillItems` ~862-885 (`products.find` for split-row descriptions);
  (f) the split panel rows ~1904-1919 (`products.find` for labels) and the panel's manual-add
  variant picker below them (find it — it feeds `addSplitVariant`).

1. **Extend the split-entry type.** Find the local `VarietySplit` type (`{ productId; qty }`)
   and add `name?: string; variantName?: string | null;` — split entries become
   self-describing so nothing needs a catalog lookup later.

2. **New sibling state + fetch.**

   ```ts
   type SiblingProduct = {
     id: string;
     name: string;
     variantName?: string | null;
     parentProductId?: string | null;
   };
   const [siblingCache, setSiblingCache] = React.useState<Record<string, SiblingProduct[]>>({});
   const [siblingLoadingId, setSiblingLoadingId] = React.useState<string | null>(null);
   ```

   ```ts
   /**
    * On-demand replacement for the old preload-based getVariantSiblings. Same
    * two discovery paths, same ordering, but fetched only when the operator
    * reaches for the split feature — and no longer blind past the first 1000
    * products (the old preload silently no-op'd the split button there).
    */
   const fetchVariantSiblings = React.useCallback(
     async (matched: { id: string; name: string }): Promise<SiblingProduct[]> => {
       // Path 1 — parent-tagged family via the product detail (includes parent + variants).
       const detail = await apiClient.get(`/products/${matched.id}`).then((r) => r.data);
       const familyRootId: string = detail.parentProductId ?? detail.id;
       const root =
         familyRootId === detail.id
           ? detail
           : await apiClient.get(`/products/${familyRootId}`).then((r) => r.data);
       // Mirror the old semantics: the family set is the root's CHILDREN (variants);
       // the matched product itself is re-added first in the merge below.
       const parentSiblings: SiblingProduct[] = (root?.variants ?? []).map((v: any) => ({
         id: v.id,
         name: v.name,
         variantName: v.variantName ?? null,
         parentProductId: v.parentProductId ?? null,
       }));
       // Path 2 — name-prefix grouping for flavors entered as standalone products.
       const SEPARATORS = [" - ", " — ", ": "];
       const sep = SEPARATORS.find((s) => matched.name.includes(s));
       let prefixSiblings: SiblingProduct[] = [];
       if (sep) {
         const prefix = matched.name.split(sep).slice(0, -1).join(sep).trim();
         if (prefix.length >= 3) {
           const needle = `${prefix}${sep}`.toLowerCase();
           const res = await apiClient
             .get(`/products`, { params: { search: prefix, limit: 100 } })
             .then((r) => r.data);
           prefixSiblings = ((res?.data ?? []) as any[])
             .filter((p) => p.name.toLowerCase().startsWith(needle))
             .map((p) => ({
               id: p.id,
               name: p.name,
               variantName: p.variantName ?? null,
               parentProductId: p.parentProductId ?? null,
             }));
         }
       }
       const matchedSibling: SiblingProduct = {
         id: detail.id,
         name: detail.name,
         variantName: detail.variantName ?? null,
         parentProductId: detail.parentProductId ?? null,
       };
       const seen = new Set<string>();
       const merged: SiblingProduct[] = [];
       for (const p of [matchedSibling, ...parentSiblings, ...prefixSiblings]) {
         if (seen.has(p.id)) continue;
         seen.add(p.id);
         merged.push(p);
       }
       return merged.sort((a, b) => {
         if (a.id === matched.id) return -1;
         if (b.id === matched.id) return 1;
         return (a.variantName ?? a.name).localeCompare(b.variantName ?? b.name);
       });
     },
     [],
   );
   ```

   Delete the old `getVariantSiblings` and the `useProducts({ limit: 1000 })` block +
   `products` array entirely. Remove the `useProducts` import if nothing else in the file
   uses it (verify by grep within the file).

3. **`startSplit` goes async** (keep the name):

   ```ts
   const startSplit = async (i: number) => {
     const item = reviewItems[i];
     if (!item.productId || siblingLoadingId) return;
     let siblings = siblingCache[item.productId];
     if (!siblings) {
       setSiblingLoadingId(item.productId);
       try {
         siblings = await fetchVariantSiblings({
           id: item.productId,
           // description carries the composed display name for linked rows.
           name: item.description || item.extractedName || "",
         });
         setSiblingCache((prev) => ({ ...prev, [item.productId]: siblings! }));
       } catch {
         toast({
           title: "Couldn't load varieties",
           description: "Check your connection and try again.",
           variant: "error",
         });
         return;
       } finally {
         setSiblingLoadingId(null);
       }
     }
     const splits: VarietySplit[] = siblings.map((s) => ({
       productId: s.id,
       qty: s.id === item.productId ? item.qty : "0",
       name: s.name,
       variantName: s.variantName ?? null,
     }));
     updateItem(i, { splits });
   };
   ```

   NOTE the behavior change vs old code: the old `if (siblings.length === 0) return;` no-op
   is GONE — the fetch always returns at least the matched product, so the panel always opens
   (matching the render comment at ~1668-1671 that the operator can add varieties manually).
   Use the file's existing toast mechanism (`useToast`) — check what's already imported.

4. **Render block ~1662-1672:** replace the synchronous computation with cache reads:

   ```ts
   const siblings = item.productId ? siblingCache[item.productId] : undefined;
   const autoDetectedCount = siblings ? siblings.length - 1 : null;
   const canSplit = !!item.productId && !isSplit;
   ```

   Split-button `title`: when `autoDetectedCount == null` → "Split this qty across multiple
   varieties" (generic — we haven't fetched yet); when `> 0` → the existing count wording;
   when `0` → the existing manual-pick wording. Show a disabled/loading state on the button
   while `siblingLoadingId === item.productId` (reuse the file's small-spinner or opacity
   pattern).

5. **`buildBillItems` ~862-885:** split rows use the self-describing entry:
   `description: s.name ?? item.description` (drop the `products.find`).

6. **Split panel rows ~1904-1919:** render `split.variantName ?? split.name ?? "Unknown variant"`
   with `title={split.name}` (drop the `products.find`).

7. **Manual-add variant picker** (the control that feeds `addSplitVariant`, below the split
   rows): switch it to the async `SearchableProductPicker` mode (`async`, no `products` prop)
   if it isn't already, and extend `addSplitVariant(rowIdx, productId, product?)` to store
   `name`/`variantName` on the new entry from the picker's `onChange(id, product)` second
   argument (fall back to `name: undefined` — the render's "Unknown variant" covers it, but
   with the async picker the object is always present on a pick).

8. **`handleProductSelect` ~718-741:** drop the `products.find` fallback and the list arg:

   ```ts
   const product = productId ? pickedProduct : undefined;
   ...
   description: displayProductName(product),
   ```

   (All callers pass an object now: the async picker's onChange, the candidate chips — whose
   `name` is already the composed display name — and nothing else. The create-from-line flow
   updates the row directly, not through handleProductSelect. Verify by checking each call
   site of `handleProductSelect` in the file; if any caller passes no object, keep a
   minimal `{ id: productId, name: item.matchedProductName ?? item.description }` fallback
   built from the row instead of reintroducing a catalog list.)
   Invalidate the sibling cache for a re-linked row: `setSiblingCache(prev => { const next = { ...prev }; delete next[productId]; return next; })`
   is unnecessary (cache is keyed by productId, not row) — but DO nothing else; a stale
   cache entry for a product is still correct for that product.

9. **Final sweep:** grep the file for `products` — zero references to the old array must
   remain; typecheck-clean.

## Acceptance criteria

1. `ScanInvoiceModal.tsx` contains no `useProducts` preload; opening the modal issues no
   catalog list request until a picker is opened or Split is clicked.
2. Split on a parent-tagged product opens the panel with the family (matched first, then
   variants sorted by variantName/name) — including products beyond any 1000-row boundary.
3. Split on a prefix-named product ("Brand - Cherry") finds its prefix siblings via server
   search; a product with no siblings still opens the panel with just itself.
4. Split rows and bill-line descriptions render from the split entries themselves; manual
   add stores the picked product's names.
5. The split button shows a loading state during the fetch and a friendly error toast on
   failure (panel not opened).
6. Linking/re-linking rows (picker, chips) still composes display names correctly.
7. `npm run verify` green.

## Verification commands

- `npm run verify`

## Risks & rollback

- The split feature's discovery must MATCH the old semantics (family = root's children +
  matched-first merge + same sort) — the reviewer should diff the logic against the old
  `getVariantSiblings` doc comment and body quoted in this plan's brief.
- The old silent no-op (`siblings.length === 0 → return`) is intentionally removed.
- Rollback: revert the commit; UI-only.
