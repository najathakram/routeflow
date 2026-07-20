# Plan: Regulated TYPE vs Category — fix the conceptual confusion

> Authored by Fable 5 on 2026-07-19. Status: IMPLEMENTED (pipeline wf_85a65bb4-165 clean; verify green; WP-E agent rate-limit-died AFTER completing its files — fix round verified line-by-line + finished 2 missed strings)
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## Objective

Fix a naming/model confusion: today `TrackedCategory` ("section", e.g. Tobacco) reads like a
product category, and its children are called "subcategories" — while every other product
uses the free-text `Product.category`. The corrected mental model (user decision):

- **Regulated type** = the compliance entity (Tobacco, Vape…). Internally still
  `TrackedCategory` — ALL tax/license/filing/split machinery unchanged. UI-only rename.
- **Category** = ONE axis for every product. Non-regulated items keep the free-text
  Category. Regulated items pick/type their category from their type's structured list
  (today's `TrackedSubcategory` rows — internally unchanged, user-facing name becomes
  "Category"), and the product's normal `Product.category` field is **auto-synced to that
  name server-side**, so lists/filters/analytics/buyer facets show "Zyn", never "Tobacco".
- Product forms stop showing two parallel classification fields: when a regulated type is
  selected, the free-text Category input is REPLACED by the structured Category picker.

Plus a **one-time data tidy** (user-approved) for legacy rows where the free-text category
equals the type name ("Tobacco" as category): replace with the structured category's name
when set, else clear.

NO schema change. NO API field renames (`trackedCategoryId`/`trackedSubcategoryId` stay).
NO endpoint changes. Reporting/ledger/filings untouched.

## Constraints & conventions

- Prettier double quotes / printWidth 100; Jest module-boundary mocks; no unrelated
  reformatting. Rename ONLY user-visible strings (labels/titles/toasts/placeholders/aria) —
  never identifiers, DB names, API fields, query keys, or route paths.
- Terminology: "Regulated section"/"Section" → **"Regulated type"** (compact contexts:
  **"Type"**); "Subcategory" → **"Category"** in regulated contexts. EXCEPTION: the invoice
  treatment label "Sectioned on invoice" (`treatmentLabel` in both `regulated-format.ts`
  mirrors) describes INVOICE LAYOUT, not this entity — leave it and all
  invoice-splitting wording alone.
- `Product.category` sync is SERVER-side (covers web + mobile + future clients uniformly).
- Existing invariants preserved: type change clears the structured category; server
  validates category-parent === type (`assertSubcategoryInSection`).
- Test-tenant policy: the tidy script's single-tenant mode is guarded by
  `assertTestTenant`; the all-tenants mode exists for the OWNER to run against prod
  (`railway run …`) — the script never bypasses the guard silently.

## Work packages

### WP-A — API: category sync + rename propagation + specs

- **files:** `apps/api/src/products/products.service.ts`,
  `apps/api/src/products/products.service.spec.ts`,
  `apps/api/src/tracked-categories/tracked-categories.service.ts`,
  `apps/api/src/tracked-categories/tracked-categories.service.spec.ts`
- **brief:**

1. **`products.service.create`** (regulated pair resolved at ~383-396; `category` in data at
   ~408): after `assertSubcategoryInSection`, when `regulated.trackedSubcategoryId` is set,
   fetch the subcategory's name and make it WIN the category resolution:
   ```ts
   // One-category-axis rule: a regulated product's category IS its structured
   // (per-type) category name — synced server-side so every category surface
   // (filters, analytics, buyer facets) shows "Zyn", never the type name.
   let syncedCategory: string | undefined;
   if (regulated.trackedSubcategoryId) {
     const sub = await this.prisma.forTenant().trackedSubcategory.findUnique({
       where: { id: regulated.trackedSubcategoryId },
       select: { name: true },
     });
     syncedCategory = sub?.name;
   }
   ```
   and in the create data: `category: syncedCategory ?? dto.category ?? parent?.category ?? undefined,`
   (replacing the current `dto.category ?? parent?.category ?? undefined` at ~408).
   Variant nuance (existing, keep): variants inherit the regulated PAIR as a unit when
   `dto.trackedCategoryId === undefined` — the sync naturally follows the resolved pair.
2. **`products.service.update`** (raw `{ ...dto }` spread write at ~491-501; effective
   values at ~482-490; the `variantName` force-sync is the in-file precedent):
   - When the structured category is being SET/CHANGED (`dto.trackedSubcategoryId` is a
     non-null string): after validation, fetch its name and force `data.category = name`.
   - When it is being CLEARED (explicit `dto.trackedSubcategoryId === null` OR the existing
     forced clear when the type is removed at ~495-497): if the product's current category
     equals the OLD subcategory's name, also `data.category = null` (the category was
     synced; clearing the source clears the mirror). Requires knowing the old sub's name —
     extend the `existing` fetch's select with
     `trackedSubcategory: { select: { name: true } }` (verify the current select shape and
     add minimally).
   - A `dto.category` explicitly provided in the SAME request as a structured category set:
     the structured name wins (document with a comment). When the product keeps a
     structured category and the dto tries to change ONLY `category`: let the structured
     name win too — force `data.category` back to the sub's name (the form hides free-text
     category for regulated items; imports/legacy clients shouldn't desync the axis).
3. **`tracked-categories.service.assignProducts`** (movers get `trackedSubcategoryId: null`
   today): movers whose current `category` equals their OLD subcategory's name must also
   get `category: null`. `updateMany` can't join — implement as: query the movers
   (`where: { id: { in }, NOT: { trackedCategoryId: id } }`,
   `select: { id, category, trackedSubcategory: { select: { name: true } } }`), partition
   ids where `category != null && category === trackedSubcategory?.name`, run ONE extra
   `updateMany({ where: { id: { in: syncedIds } }, data: { category: null } })` before the
   existing updateMany. Same treatment in **`unassignProducts`** (its where is
   `trackedCategoryId: id` — same partition logic on its target rows).
4. **`updateSubcategory` rename propagation**: after a successful rename (name actually
   changed), propagate to synced products:
   ```ts
   await this.prisma.forTenant().product.updateMany({
     where: {
       trackedSubcategoryId: subId,
       OR: [{ category: oldName }, { category: null }],
     },
     data: { category: name },
   });
   ```
   (`oldName` from the pre-update row `getSubcategoryOrThrow` already fetched — verify it
   selects `name`; extend if not. Products whose category diverged manually — legacy — are
   deliberately left alone until the tidy.)
5. **Specs** (extend existing patterns):
   - create with subcategory → data.category === sub name (dto.category ignored);
     create with type but no subcategory → dto.category preserved; non-regulated create
     unchanged; variant inheriting the pair gets the synced name.
   - update setting a subcategory → category forced to its name; clearing the subcategory
     when category was synced → category null; clearing when category diverged → category
     untouched; category-only change on a structured-category product → forced back.
   - assignProducts clears movers' synced categories only (diverged/free-text survivors
     asserted); unassign same.
   - updateSubcategory rename propagates to `category === oldName` and `category IS NULL`
     rows only.

### WP-B — Tidy script

- **files:** `apps/api/scripts/tidy-regulated-categories.mjs` (new)
- **effort:** low
- **brief:** Follow the house script conventions (`qa-deep-audit-cleanup.js` structure:
  `pg.Client` on `process.env.DATABASE_URL` with the `railway run --service postgres node …`
  hint when missing; dry-run DEFAULT with `--execute` to write;
  `scripts/lib/test-tenants.cjs` guard).
  - Modes: `--tenant <slug>` (single tenant; slug passes through
    `assertTestTenant(slug, "tidy-regulated-categories")` — fail-closed) OR
    `--all-tenants` (skips the per-slug guard — the OWNER's prod-migration mode, run via
    railway; print a loud banner that this touches every tenant and requires `--execute`).
  - Logic per tenant: for products where `trackedCategoryId IS NOT NULL` AND
    `LOWER(TRIM(category)) = LOWER(TRIM(<their TrackedCategory.name>))` (join):
    set `category = <TrackedSubcategory.name>` when `trackedSubcategoryId` is set, else
    `category = NULL`. ALSO: products with a `trackedSubcategoryId` whose `category` is
    NULL or differs from the sub's name → set to the sub's name (aligns legacy rows with
    the new axis). Print per-tenant counts for both classes in dry-run; idempotent.
  - Never print connection strings; parameterized SQL only.

### WP-C — Web forms: one Category axis + regulated-context renames

- **files:** `apps/web/components/ProductCreateModal.tsx`,
  `apps/web/app/(dashboard)/products/[id]/page.tsx`,
  `apps/web/app/(dashboard)/products/_components/SectionEditCell.tsx`,
  `apps/web/components/SubcategoryCombobox.tsx`,
  `apps/web/components/AssignToSectionModal.tsx`,
  `apps/web/components/RegulatedScopeTabs.tsx`
- **brief:**

1. **ProductCreateModal** (free-text Category block at ~481-489; regulated block at
   ~491-527): restructure to ONE Category slot —
   - "Regulated section" label → **"Regulated type"**; option "None (not regulated)" stays.
   - When `form.trackedCategoryId` is EMPTY: render the CategoryCombobox exactly as today
     (label "Category").
   - When a type IS selected: HIDE the free-text CategoryCombobox and render the
     SubcategoryCombobox in its place under the label **"Category"** with helper text
     `Categories for this regulated type — type to create.` (submit payload unchanged —
     the server syncs `category`; do NOT send `category` from the form when a type is set,
     and clear any typed free-text category state when a type is selected so a stale value
     isn't submitted).
2. **products/[id]/page.tsx** edit mode (Category InfoRow ~1513-1527; "Regulated section"
   InfoRow ~1528-1553; "Subcategory" InfoRow ~1554-1568): same consolidation — when
   `editDraft.trackedCategoryId` set, the Category InfoRow renders the SubcategoryCombobox
   (label stays "Category") and the separate Subcategory row disappears; the regulated row
   is relabeled "Regulated type". Read mode: the "Separately handled:" banner (~1379-1396)
   becomes `Regulated type: {type}` (+ `· {category}` when set). Save payload: when a type
   is set, don't send `category` (server-synced); when clearing the type, existing
   semantics (null-clears) stay.
3. **SectionEditCell**: aria/labels "Section…" → "Regulated type…"; its two selects are
   Type + Category (the combobox placeholder already says category after WP renames).
4. **SubcategoryCombobox**: user-visible strings → category wording: placeholder
   "Select or type a category", "Pick a regulated type first", "No categories yet — type
   to create", clear title "Clear category", create row unchanged (`+ Create "…"`).
5. **AssignToSectionModal**: title/copy → "Assign to regulated type", "Choose a regulated
   type…", "None — remove regulated type", helper "…moved between types; their category is
   re-synced." (component/file NAME stays — no identifier churn).
6. **RegulatedScopeTabs**: chip "All sections" → "All types". Tab labels stay
   (All products / Regulated / Non-regulated).

### WP-D — Web pages/hubs rename sweep

- **files:** `apps/web/app/(dashboard)/products/page.tsx`,
  `apps/web/app/(dashboard)/inventory/page.tsx`,
  `apps/web/app/(dashboard)/compliance/page.tsx`,
  `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx`,
  `apps/web/app/(dashboard)/settings/_components/RegulatedSettingsTab.tsx`
- **effort:** low
- **brief:** USER-VISIBLE strings only (never identifiers/keys/routes):
  - products/page.tsx: "Section" column header → **"Type"**; pill fallback "Section" →
    "Type"; "Section updated" toast → "Regulated type updated"; "Assign to section…"
    button → "Assign to type…".
  - inventory/page.tsx: pill title "Regulated section" → "Regulated type"; badge fallback
    "Section" → "Type".
  - compliance/page.tsx: "Tracked Sections"/"Sections"/"Manage sections"/"No regulated
    sections yet." → type wording ("Regulated types", "Manage types", …).
  - compliance/[categoryId]/page.tsx: "Regulated section" → "Regulated type";
    "Subcategories" heading → "Categories"; "No subcategories yet." → "No categories yet.".
  - RegulatedSettingsTab.tsx (~14 strings): "Regulated sections" → "Regulated types",
    "New section" → "New type", subcategory manager strings → category wording
    ('Category "…" added', "Add a category…", "…categories are for reporting." etc.).
  - LEAVE ALONE: `treatmentLabel`'s "Sectioned on invoice" and any invoice-split wording
    (describes invoice layout); all identifiers.

### WP-E — Mobile: form consolidation + hub renames

- **files:** `apps/mobile/components/ProductForm.tsx`,
  `apps/mobile/components/SubcategoryPickerSheet.tsx`,
  `apps/mobile/app/(operator)/regulated/index.tsx`,
  `apps/mobile/app/(operator)/regulated/new.tsx`,
  `apps/mobile/app/(operator)/regulated/[id].tsx`,
  `apps/mobile/app/(operator)/regulated/[id]/edit.tsx`,
  `apps/mobile/app/(operator)/regulated/[id]/assign-products.tsx`
- **brief:**

1. **ProductForm** (Category field ~149-152 in Basics; regulated block ~226-259): when
   `form.trackedCategoryId` is set, the Basics "Category" field hides its free-text
   `CategoryInput` and renders the subcategory picker Pressable (opening
   `SubcategoryPickerSheet`) labeled "Category"; the regulated block keeps only the
   "Regulated type" picker (drop its separate Subcategory row). When no type: free-text
   CategoryInput as today. `buildProductPayload` continues sending
   `trackedSubcategoryId`; when a type is set do NOT send `category` (server syncs) —
   check `lib/product-form.ts` payload builder and gate the category field there if
   needed (that file is NOT in the allowlist — if a change there is unavoidable, report
   it as a deviation instead; prefer clearing the form's category state in ProductForm so
   the built payload naturally omits it).
2. **SubcategoryPickerSheet**: strings → "Category", "Search or type a new category…",
   "Couldn't create category.".
3. **Regulated hub screens** (~20 strings across the 5 files): "Section(s)" → "Regulated
   type(s)" / "Type", "Subcategories" → "Categories", toasts/titles accordingly
   ("Section created" → "Type created", nav title "Section" → "Regulated type", "…add
   subcategories to classify products." → "…add categories to classify products.",
   assign-products copy "…another section moves it here." → "…another type moves it
   here."). Leave `lib/regulated-format.ts` treatment labels untouched.

## Acceptance criteria

1. Creating/updating a product with a structured category syncs `Product.category` to its
   name (server-side, both platforms); clearing it clears a synced category but preserves
   a diverged free-text one; category-only edits cannot desync a structured product.
2. Renaming a category (old "subcategory") propagates to its synced products' `category`;
   bulk type moves/unassigns clear the movers' synced categories.
3. Product forms show ONE Category field: free-text when non-regulated, the structured
   type-ahead when a regulated type is chosen; "Tobacco" can no longer end up as a
   category through these forms.
4. All user-facing wording says Regulated type / Category (per the terminology map);
   invoice-treatment labels and ALL identifiers/API fields/routes unchanged.
5. Tidy script: dry-run default with per-tenant counts; `--tenant` mode fail-closed via
   `assertTestTenant`; `--all-tenants --execute` documented for the owner's railway run;
   idempotent; parameterized SQL.
6. `npm run verify` green; no schema changes; no new deps.

## Verification commands

- `npm run verify`

## Risks & rollback

- The category sync overrides explicit `dto.category` for structured products — reviewers
  should confirm CSV import / variant-resolution paths (which set category directly on
  NON-structured products) are unaffected.
- Buyer-catalog CATEGORY-scoped collections filter on the category STRING: the tidy can
  move products out of a collection scoped to a type name like "Tobacco" (intended — the
  type is not a category — but note it in the PR body as a visible behavior change).
- Analytics `getSalesByCategory` buckets by `product.category` — after sync/tidy,
  regulated items bucket under their real category names (improvement; note it).
- Rollback: revert the commit; the tidy script is separate and only runs manually.
