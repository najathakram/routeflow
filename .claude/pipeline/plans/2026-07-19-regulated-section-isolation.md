# Plan: Isolate & manage regulated products (Products / Inventory / Compliance / Mobile)

> Authored by Fable 5 on 2026-07-19. Status: IMPLEMENTED (pipeline wf_f679aee4-186 clean first pass; verify green — 2007 tests, 0 findings)
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## Objective

Operators can isolate regulated products (rows with `Product.trackedCategoryId` → a
`TrackedCategory` "section": tobacco, vape, …) and manage them from that isolated view:

1. **Products page**: a "Section" toolbar dropdown — All / Any regulated / one section /
   Non-regulated — server-side (page is paginated), URL-deep-linkable via `?section=`.
2. **Rows show a Section pill**; the page's **Quick Edit** mode edits section+subcategory
   inline; the multi-select bar gains a bulk **"Assign to section…"** action.
3. **Inventory Stock tab**: the same 4-way filter client-side (its list is unpaginated) +
   section pills.
4. **Compliance hub**: the per-section "Regulated Products: N" KPI links to
   `/products?section=<id>`.
5. **Mobile products list**: section filter chips (server-side, same param).

**Param contract (everywhere):** one string `section` = `"any"` | `"none"` | `<sectionId uuid>`;
absent = all.

**In-scope bug fix (verified real):** `tracked-categories.service.assignProducts` overwrites
`trackedCategoryId` but never clears `trackedSubcategoryId` (`unassignProducts` same) — a bulk
move A→B strands a subcategory belonging to the old section, violating the invariant
`products.service.update` enforces (later PATCHes on such rows 400). Fixed in WP-A.

No migrations (`Product.trackedCategoryId`/`trackedSubcategoryId` + `@@index([tenantId,
trackedCategoryId])` exist). No new dependencies.

## Constraints & conventions

- Prettier double quotes / printWidth 100; Jest (`Test.createTestingModule`, module-boundary
  mocks); no unrelated reformatting; mobile has pure-logic tests only.
- The API's global ValidationPipe runs `forbidNonWhitelisted` — the new param MUST be added
  to `ListProductsDto` or requests 400.
- Section NAMES resolve client-side from `useTrackedCategories` (tiny list) — do NOT add a
  `trackedCategory` relation include to `products.service.findAll` (it serves `limit:0`
  fetch-alls up to 10k rows; keep the payload slim).
- Products-page naming trap: the existing "Category" filter is the free-text `Product.category`
  string; the legacy amber `isTobacco` badge is another separate axis. The new control is
  labeled **"Section"**; touch neither of the others.
- Hide ALL new UI when the tenant has no sections (`useTrackedCategories` returns empty).

## Work packages

### WP-A — API: section filter + assign invariant fix + overview scalar + specs

- **files:** `apps/api/src/products/dto/list-products.dto.ts`,
  `apps/api/src/products/products.service.ts`,
  `apps/api/src/products/products.service.spec.ts`,
  `apps/api/src/tracked-categories/tracked-categories.service.ts`,
  `apps/api/src/tracked-categories/tracked-categories.service.spec.ts`,
  `apps/api/src/inventory/inventory.service.ts`,
  `apps/api/src/inventory/inventory.service.spec.ts`
- **brief:**

1. `list-products.dto.ts` (import `Matches` from class-validator):
   ```ts
   /** Regulated-section filter: "any" (any regulated), "none" (non-regulated), or a section id. */
   @IsOptional()
   @IsString()
   @Matches(
     /^(any|none|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
     { message: 'section must be "any", "none", or a section id' },
   )
   section?: string;
   ```
2. `products.service.ts` `findAll` (~l.87-193): insert AFTER the internal
   `opts.excludeTrackedCategoryIds` block (~l.115-117, which writes
   `where.trackedCategoryId = { notIn: … }`):
   ```ts
   // Regulated-section filter ("any" | "none" | <sectionId>). When the internal
   // buyer-catalog exclusion already occupies where.trackedCategoryId, fold this
   // clause into AND so BOTH apply.
   if (query.section) {
     const clause =
       query.section === "any" ? { not: null } : query.section === "none" ? null : query.section;
     if (where.trackedCategoryId !== undefined) {
       where.AND = [...(where.AND ?? []), { trackedCategoryId: clause }];
     } else {
       where.trackedCategoryId = clause;
     }
   }
   ```
   NOTE: the stock-status branch below (~l.127) reshapes `where.AND` by spreading the
   existing array — verify the insertion point precedes it and composes (read the actual
   code; keep the spread pattern intact). `findMany` and `count` share `where`, so
   pagination meta stays correct.
3. `tracked-categories.service.ts`:
   - `assignProducts(id, productIds)` (~l.153-160) becomes:
   ```ts
   async assignProducts(id: string, productIds: string[]) {
     await this.findOne(id);
     // Movers/new assignees get the section AND a cleared subcategory (a
     // subcategory's parent must equal the product's section — leaving the old
     // one behind strands an invariant violation that 400s later product
     // updates). Rows already in this section are untouched.
     const { count } = await this.prisma.forTenant().product.updateMany({
       where: { id: { in: productIds }, NOT: { trackedCategoryId: id } },
       data: { trackedCategoryId: id, trackedSubcategoryId: null },
     });
     return { assigned: count };
   }
   ```
   (Semantics: `assigned` now counts movers only — safe: the one existing caller,
   web `AssignProductsModal`, diffs client-side and never sends same-section ids.)
   - `unassignProducts` (~l.163-170): `data` gains `trackedSubcategoryId: null`.
4. `inventory.service.ts` `getStockOverview` (~l.126-163): add `trackedCategoryId: true` to
   the product `select`; confirm the returned row mapping carries it through (it spreads).
5. Specs:
   - `products.service.spec.ts` findAll: `section: "<uuid>"` → `where.trackedCategoryId`
     equals it; `"any"` → `{ not: null }`; `"none"` → `null`; `section` combined with
     `opts.excludeTrackedCategoryIds` → `notIn` stays on `where.trackedCategoryId` and
     `where.AND` contains the section clause; `count` receives the same where.
   - `tracked-categories.service.spec.ts` (~l.128-162): UPDATE the existing assign/unassign
     assertions (assign where gains `NOT: { trackedCategoryId: id }`, data gains
     `trackedSubcategoryId: null`; unassign data gains it too) + one new case asserting the
     movers-only count semantics.
   - `inventory.service.spec.ts` `getStockOverview` describe (~l.465): a case asserting the
     findMany select includes `trackedCategoryId: true` and a fixture row passes it through.

### WP-B — Web Products page

- **files:** `apps/web/lib/api/products.ts`,
  `apps/web/app/(dashboard)/products/page.tsx`,
  `apps/web/app/(dashboard)/products/_components/QuickEditCell.tsx`,
  `apps/web/app/(dashboard)/products/_components/SectionEditCell.tsx` (new),
  `apps/web/components/AssignToSectionModal.tsx` (new)
- **brief:**

1. `lib/api/products.ts`: `useProducts` params type += `section?: string;` (passes through
   like the others). `ApiProduct` (wherever the page's row type lives — it may be local to
   the page) += `trackedCategoryId?: string | null; trackedSubcategoryId?: string | null;`.
2. `page.tsx`:
   - `import { useUrlFilters } from "@/lib/hooks/useUrlFilters";` —
     `const [urlFilters, setUrlFilter] = useUrlFilters({ section: "" });`
     `const sectionFilter = urlFilters.section;` READ the hook first to match its exact API
     (it exists at `apps/web/lib/hooks/useUrlFilters.ts`). Only `section` moves to the URL;
     all other filter state stays as-is.
   - Page-reset effect (~l.781-783): deps += `sectionFilter`.
   - `useProducts` call (~l.785-796): `section: sectionFilter || undefined`.
   - `useTrackedCategories()` (UNFILTERED — names must resolve for deactivated sections) →
     `const sectionNameById = React.useMemo(() => new Map(cats.map(c => [c.id, c.name])), [cats]);`
     and `activeSections = cats.filter(c => c.active)`. Hide every new control when
     `cats.length === 0`.
   - Toolbar (~l.1016-1025, next to the Category select): a `Select` labeled/aria'd
     "Section" with options `"" → All sections`, `"any" → Regulated (any section)`,
     one per active section (name), `"none" → Non-regulated` →
     `onChange={(v) => setUrlFilter("section", v)}`. Match the existing selects' styling.
   - `makeTableColumns` (~l.239-567): add a **Section** column right after Category.
     Read mode: when `p.trackedCategoryId`, a small brand-tinted pill
     (`rounded-full bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 text-[11px]`)
     showing `sectionNameById.get(p.trackedCategoryId) ?? "Section"`, with
     `title` = subcategory name if resolvable else section name; when null, `—` muted.
     Quick-Edit mode: render `<SectionEditCell …/>` (WP item 4). Thread the new inputs
     through `makeTableColumns`'s params + the memo deps that call it. Grid cards
     (~l.100-230 region): the same pill near the existing badges.
   - Selection action bar (~l.1067-1098): a "Assign to section…" `Button` (Layers icon,
     same styling as "Group as variants of…") opening `AssignToSectionModal` with
     `products={visibleRows.filter(p => selected.has(p.id)).map(p => ({ id: p.id, trackedCategoryId: p.trackedCategoryId ?? null }))}`;
     `onSuccess` clears the selection + closes.
   - `handleSectionSave(productId, patch: { trackedCategoryId: string | null; trackedSubcategoryId: string | null }, prior: same-shape)`:
     calls the page's existing update mutation (`useUpdateProduct`-style — find it; quick
     edit already saves via it) with `{ id: productId, ...patch }`, and pushes an
     `EditRecord { productId, field: "section", oldValue: prior, newValue: patch }`.
   - `handleUndo`/`handleRedo` (~l.676-692): replay object patches —
     `const patch = record.field === "section" ? (value as Record<string, unknown>) : { [record.field]: value };`
     then mutate with `{ id, ...patch }`. Keep all other fields' behavior identical.
3. `QuickEditCell.tsx`: TYPE-ONLY — widen the `EditRecord` value union with
   `| Record<string, unknown>` (or the exported type that holds oldValue/newValue).
4. **NEW `SectionEditCell.tsx`** (a real component so hooks are legal in the cell):
   ```tsx
   props: {
     productId: string;
     trackedCategoryId: string | null;
     trackedSubcategoryId: string | null;
     activeSections: TrackedCategory[];
     onSave(patch: { trackedCategoryId: string | null; trackedSubcategoryId: string | null }): void;
     disabled?: boolean;
   }
   ```
   Two compact stacked selects (`h-7 text-xs`, match QuickEditCell inputs):
   - Section: `<option value="">None (not regulated)</option>` +
     `sectionPickerOptions(activeSections, current)` (import from `@/lib/regulated-format`
     — read its signature; it returns option descriptors used elsewhere with a current-value
     escape so a deactivated current section still lists).
   - Subcategory (rendered ONLY when a section is set):
     `useTrackedSubcategories(trackedCategoryId || undefined)` +
     `subcategoryPickerOptions(subs, trackedSubcategoryId)`, leading
     `<option value="">—</option>`.
     Save-on-change (selects are discrete; no draft state): section change →
     `onSave({ trackedCategoryId: v || null, trackedSubcategoryId: null })` (subcategory
     ALWAYS clears on section change — mirrors the product detail page's dependent selects);
     subcategory change → `onSave({ trackedCategoryId, trackedSubcategoryId: v || null })`.
     The server independently validates subcategory-parent === section.
5. **NEW `AssignToSectionModal.tsx`** — chrome copied from `AssignProductsModal`
   (fixed overlay, white card, `Button`, `useToast`).
   Props `{ isOpen, onClose, products: Array<{ id: string; trackedCategoryId: string | null }>, onSuccess?: () => void }`.
   Body: count line ("N product(s) selected"), one `<select>`: placeholder
   "Choose a section…", each ACTIVE section, and `__none__ → "None — remove from section"`.
   Helper text: "Products already in another section are moved; their subcategory is
   cleared." Apply:
   - target = section id → ONE `useAssignProductsToCategory().mutateAsync({ id: target, productIds: all ids })`
     (server-side updateMany is idempotent for same-section rows after WP-A).
   - target = `__none__` → group ids by their CURRENT `trackedCategoryId` (skip nulls) and
     call `useUnassignProductsFromCategory().mutateAsync({ id: sectionId, productIds })`
     sequentially per group.
     Toast success with counts; the existing hooks' invalidations (products +
     tracked-categories keys) refresh everything. Read
     `apps/web/lib/api/tracked-categories.ts` for the hooks' exact mutate shapes.

### WP-C — Web Inventory + Compliance deep link

- **files:** `apps/web/app/(dashboard)/inventory/page.tsx`,
  `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx`
- **brief:**

1. `inventory/page.tsx`:
   - `StockItem` type (~l.63-74) += `trackedCategoryId?: string | null;`.
   - Page-level `const [sectionFilter, setSectionFilter] = React.useState("");` (component
     state — this list is client-filtered and unpaginated, mirroring `missingCostOnly`
     ~l.2242). `useTrackedCategories()` import + `sectionNameById` memo + `activeSections`;
     hide the control when no sections.
   - Stock-tab toolbar (button cluster ~l.2561-2620): a compact `Select` with the same
     4-way options driving `setSectionFilter`.
   - `StockTable` (~l.432): new props `sectionFilter: string` and
     `sectionNameById: Map<string, string>`; extend the client filter `useMemo`
     (~l.449-460): `"any"` → `it.trackedCategoryId != null`; `"none"` → `== null`;
     uuid → `===`; update deps. Render the same brand-tinted section pill next to the
     product name when `trackedCategoryId` is set.
   - Known pre-existing quirk, leave alone: the "shown of total" caption ignores
     `missingCostOnly` and will ignore this filter too.
2. `compliance/[categoryId]/page.tsx`: wrap the "Regulated Products: N" KPI card
   (~l.182-187) in `<Link href={`/products?section=${categoryId}`}>` (Link is already
   imported; use the route param variable actually in scope) and add a hover ring +
   `title="View these products"`.

### WP-D — Mobile products list section chips

- **files:** `apps/mobile/lib/api/admin.ts`, `apps/mobile/app/(operator)/products/index.tsx`
- **effort:** low
- **brief:**

1. `admin.ts`: `useAdminProducts` (~l.459) and `useAdminProductsInfinite` (~l.479) param
   types += `section?: string;` (params already flow verbatim into the `GET /products`
   query string + queryKey).
2. `products/index.tsx`: `useTrackedCategories({ active: true })` (mobile mirror at
   `lib/api/tracked-categories.ts`); `const [sectionFilter, setSectionFilter] = useState<string | undefined>();`
   pass `section: sectionFilter` into the infinite hook. A SECOND `FilterChipRow` under the
   existing stock chips (match the `FILTERS` construction ~l.39-44), rendered only when
   sections exist: `All → undefined`, `Regulated → "any"`, one chip per section (name → id),
   `Non-reg → "none"`. Optional (do it if trivial): a muted section-name `Pill` on
   `ProductRow` via an id→name map.

## Acceptance criteria

1. `GET /products?section=<uuid|any|none>` filters server-side; invalid values 400 via DTO;
   composes with search/category/stockStatus/isActive/pagination AND the internal
   buyer-catalog exclusion (AND-fold); `meta.total/totalPages` reflect the filter.
2. `assignProducts` moves products with subcategory cleared, skips same-section rows;
   `unassignProducts` clears both fields; existing modal behavior unchanged.
3. Products page: Section dropdown ⇄ `?section=` (deep link pre-applies; changing it resets
   to page 1); Section pill on rows + grid cards; legacy tobacco badge + free-text Category
   filter untouched; all new UI hidden when the tenant has no sections.
4. Quick Edit: dependent section/subcategory selects; section change clears subcategory in
   ONE update; undo/redo restores both fields together.
5. Bulk "Assign to section…" assigns/moves all selected in one call; "None" unassigns
   grouped by current section; selection clears on success.
6. Inventory Stock tab: 4-way client filter composing with search + missingCostOnly;
   section pills; overview payload gains only the scalar.
7. Compliance per-section KPI links to `/products?section=<id>`.
8. Mobile: section chips filter server-side; infinite paging + existing chips/search intact.
9. `npm run verify` green; no migrations; no new deps.

## Verification commands

- `npm run verify`

## Risks & rollback

- `where.AND` composition with the stock-status reshaping — the spec case with
  `excludeTrackedCategoryIds` + `section` guards it; implementer must read the actual
  reshape code before inserting.
- `assigned` count semantics change (movers only) — verified safe for the only caller.
- Rollback: revert the commit; no schema changes.
