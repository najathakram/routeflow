# Plan: Subcategory create-on-type combobox + regulated scope tabs

> Authored by Fable 5 on 2026-07-19. Status: IMPLEMENTED (pipeline wf_957f8efd-957 clean; verify green; 1 fix round — mobile 409-race recovery searched a stale closure list, now refetches)
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## Objective

Two operator-facing upgrades to the regulated-products workflow:

**A) Subcategory create-on-type.** In every product add/edit surface, the subcategory field
becomes a type-ahead combobox: typing filters the section's existing subcategories; when the
typed text matches nothing, an explicit **Create "<typed>"** row mints the subcategory inline
(via the existing `POST /tracked-categories/:id/subcategories`) and selects it. Today these
fields are plain dependent `<select>`s and creation only exists in Settings → Regulated
(TENANT_ADMIN UI) — even though the API already allows OPERATOR (class-level
`@Roles(UserRole.OPERATOR)`; TENANT_ADMIN inherits via the RolesGuard hierarchy).

**B) Regulated scope tabs.** Elevate yesterday's Section dropdown into tab-style isolation:
a prominent **All | Regulated | Non-regulated** tab bar (design-system `Tabs` from
`@routeflow/ui/web` — underline style, supports numeric badges) above the Products list and
inside the Inventory Stock tab, with a **per-section chip row** shown when Regulated is
active. Same `?section=` contract (`"" | "any" | "none" | <uuid>`) — deep links keep
working; the two `<select>`s it replaces are removed. Inventory's section filter migrates
from local `useState` to `useUrlFilters({ section: "" })` so it deep-links too.

No migrations. No new dependencies. Mobile isolation chips already shipped (PR #299) — the
only mobile work here is the subcategory create-on-type sheet.

## Constraints & conventions

- Prettier double quotes / printWidth 100; Jest module-boundary mocks; no unrelated
  reformatting. Mobile = pure-logic Jest only.
- Subcategories are ID references (`TrackedSubcategory` rows), NOT free text — unlike
  `CategoryCombobox` (whose typed string IS the value), the new combobox tracks a `query`
  string separately from the selected id and calls the create mutation to mint an id.
- **Uniqueness trap:** `@@unique([tenantId, trackedCategoryId, name])` is case-SENSITIVE and
  the service does no trim/fold — "Cigars" vs "cigars" would both insert. WP1 hardens the
  service (trim + case-insensitive dup → 409); the combobox ALSO pre-guards (never offer
  Create when a case-insensitive match exists — offer selecting it instead).
- Create-vs-edit payload semantics stay in the CALLERS (create omits blanks / edit sends
  null) — the combobox only emits ids via `onChange`.
- Section change ALWAYS clears the subcategory (existing invariant in all four pickers —
  preserve it).
- No DELETE exists for subcategories (toggle = soft-delete) — the combobox must not imply
  deletion.
- All new UI hidden when the tenant has no sections (existing pattern).

## Work packages

### WP1 — API: createSubcategory hardening + spec

- **files:** `apps/api/src/tracked-categories/tracked-categories.service.ts`,
  `apps/api/src/tracked-categories/tracked-categories.service.spec.ts`
- **effort:** low
- **brief:** In `createSubcategory(categoryId, dto)` (~l.207-232): trim the name
  (`const name = dto.name.trim();` — reject empty after trim with BadRequest), then BEFORE
  the create do a case-insensitive dup check:
  ```ts
  const existing = await this.prisma.forTenant().trackedSubcategory.findFirst({
    where: {
      trackedCategoryId: categoryId,
      name: { equals: name, mode: "insensitive" },
    },
  });
  if (existing) {
    throw new ConflictException(
      `A subcategory named "${existing.name}" already exists in this section.`,
    );
  }
  ```
  Keep the existing P2002 catch as the race backstop. Also apply the same trim (+ ci dup
  check excluding self) to `updateSubcategory`'s rename path. Specs: trims before save;
  case-insensitive dup → 409 with the EXISTING row's casing in the message; rename to a
  differing-case dup of a sibling → 409; rename that only changes its own casing → allowed.

### WP2 — Web: SubcategoryCombobox + swap into the three product surfaces

- **files:** `apps/web/components/SubcategoryCombobox.tsx` (new),
  `apps/web/components/ProductCreateModal.tsx`,
  `apps/web/app/(dashboard)/products/[id]/page.tsx`,
  `apps/web/app/(dashboard)/products/_components/SectionEditCell.tsx`
- **brief:**

1. **New `SubcategoryCombobox.tsx`** — modeled on `CategoryCombobox.tsx`'s dropdown
   mechanics (open state, outside-click `mousedown` close, absolute `z-50` list, option
   `<button onMouseDown>`) but ID-based:
   ```tsx
   interface SubcategoryComboboxProps {
     /** Parent section — null/"" disables the field ("Pick a section first"). */
     sectionId: string | null;
     /** Selected subcategory id ("" = none). */
     value: string;
     /** Fires with the picked/created subcategory id ("" = cleared). */
     onChange: (subcategoryId: string) => void;
     disabled?: boolean;
     /** Compact table-cell sizing (SectionEditCell). */
     compact?: boolean;
     className?: string;
     placeholder?: string;
   }
   ```
   Internals:
   - `useTrackedSubcategories(sectionId || undefined)` +
     `subcategoryPickerOptions(subs, value)` (import from `@/lib/regulated-format`) for the
     option list; `useCreateSubcategory()` for minting.
   - Separate `query` state; closed-state input shows the selected option's name (resolve
     from the fetched list; options include the current id even when inactive). Typing
     opens + filters case-insensitively; a clear (×) affordance emits `onChange("")` like
     CategoryCombobox's pattern.
   - Option rows: filtered subs (append " (inactive)" like the selects did). Below them,
     when `query.trim()` is non-empty AND no option's name equals it case-insensitively,
     an explicit create row: `+ Create "<query.trim()>"` (brand-tinted). When a
     case-insensitive match DOES exist, no create row — the match is in the list already.
   - Create action:
     ```ts
     const created = await createSub.mutateAsync({ categoryId: sectionId!, name: query.trim() });
     onChange(created.id);
     setQuery("");
     setOpen(false);
     ```
     Pending state disables the row ("Creating…"). On a 409 (race): refetch is automatic
     via the hook's invalidation — find the case-insensitive match in the refreshed list
     and select it; else toast the server message (`useToast`).
   - Disabled/empty states mirror the old selects: no `sectionId` → disabled with
     placeholder "Pick a section first"; section set but zero subs → the input still works
     (typing anything offers Create) with placeholder "None — type to create".
   - Enter key: exactly one filtered match → select it; no matches + non-empty query →
     trigger Create.
2. **`ProductCreateModal.tsx`** (~l.492-543): replace the subcategory `<select>` block
   with `<SubcategoryCombobox sectionId={form.trackedCategoryId || null} value={form.trackedSubcategoryId} onChange={(id) => set("trackedSubcategoryId", id)} />`.
   Keep the label + the section `<select>` unchanged (section change still resets
   `trackedSubcategoryId: ""`).
3. **`products/[id]/page.tsx`** (~l.1560-1581 InfoRow): same swap using
   `editDraft.trackedCategoryId` / `editDraft.trackedSubcategoryId` and
   `setEditDraft((d) => ({ ...d, trackedSubcategoryId: id }))`. The unused
   `subcategoryOptions`/`useTrackedSubcategories` wiring in the page can be removed IF no
   longer referenced (check before deleting).
4. **`SectionEditCell.tsx`**: replace its subcategory `<select>` with the combobox in
   `compact` mode; on pick/create call the cell's existing
   `onSave({ trackedCategoryId, trackedSubcategoryId: id || null })`. Section-change
   behavior (clear sub in the same PATCH) unchanged.

### WP3 — Web: RegulatedScopeTabs on Products + Inventory

- **files:** `apps/web/components/RegulatedScopeTabs.tsx` (new),
  `apps/web/app/(dashboard)/products/page.tsx`,
  `apps/web/app/(dashboard)/inventory/page.tsx`
- **brief:**

1. **New `RegulatedScopeTabs.tsx`** — the shared scope control:
   ```tsx
   interface RegulatedScopeTabsProps {
     /** Current ?section= value: "" | "any" | "none" | <sectionId>. */
     value: string;
     onChange: (next: string) => void;
     /** ACTIVE sections (chips + badge). Component renders null when empty. */
     sections: Array<{ id: string; name: string; productCount?: number }>;
     className?: string;
   }
   ```

   - Derive scope: `value === "" ? "all" : value === "none" ? "none" : "regulated"`
     (both `"any"` and a uuid are the regulated scope, uuid = a chip narrowed).
   - Render the design-system `Tabs` (`import { Tabs } from "@routeflow/ui/web"` — props
     `{ tabs: {key,label,badge?}[], activeKey, onChange }`): tabs
     `all → "All products"`, `regulated → "Regulated"` with
     `badge = Σ sections.productCount` (omit badge when the sum is 0/undefined — it's a
     section-membership total, fine for this purpose), `none → "Non-regulated"`.
     Tab clicks: all→`onChange("")`, regulated→`onChange("any")`, none→`onChange("none")`.
   - Below, ONLY when scope === "regulated": a chip row styled exactly like the products
     page's stock-status chips (`rounded-full border px-3 h-7 text-xs`, active =
     `border-navy bg-navy text-white`): first chip `All sections → "any"`, then one chip
     per section (`name` + small `productCount` when > 0) → `onChange(section.id)`.
   - Wrap the whole thing in a subtle container when scope !== "all"
     (`rounded-lg border border-brand-200 bg-brand-50/40 px-3 pt-1 pb-2` vs plain) so the
     isolated view is visually distinct — keep it light, not shouty.
2. **`products/page.tsx`**: DELETE the Section `<select>` block (~l.1158-1173). Render
   `<RegulatedScopeTabs value={sectionFilter} onChange={(v) => setUrlFilter("section", v)} sections={activeSections.map(s => ({ id: s.id, name: s.name, productCount: s.productCount }))} />`
   directly ABOVE the toolbar container (~l.1098) — full-width, `mb-2.5`. Everything else
   (useUrlFilters wiring, useProducts `section:` param, pills, bulk assign) is already in
   place from PR #299 and stays untouched. `hasSections` gating unchanged (component
   self-hides on empty sections anyway).
3. **`inventory/page.tsx`**: migrate the Stock-tab section filter to the URL —
   replace `const [sectionFilter, setSectionFilter] = React.useState("")` (~l.2265) with
   the products-page pattern: `const [urlFilters, setUrlFilter] = useUrlFilters({ section: "" });`
   `const sectionFilter = urlFilters.section;` (import the hook). DELETE the Section
   `<select>` (~l.2594-2608) and render `<RegulatedScopeTabs …/>` at the TOP of the Stock
   tab's content (above the valuation cards/toolbar, inside `Tabs.Content value="stock"`),
   passing `activeSections` the same way. `StockTable` wiring (`sectionFilter` prop, pills,
   client-side filter) unchanged. Do NOT touch the Radix functional tabs (Stock/Count/…) —
   the scope axis stays inside the Stock tab. NOTE: `useUrlFilters` resets a `page` param
   on change — inventory has no `page` URL param, harmless; verify the hook import doesn't
   introduce a Suspense/CSR bailout (the page already uses client-side hooks; products page
   uses this hook with no issue).

### WP4 — Mobile: subcategory create-on-type sheet

- **files:** `apps/mobile/components/SubcategoryPickerSheet.tsx` (new),
  `apps/mobile/components/ProductForm.tsx`
- **effort:** low
- **brief:**

1. **New `SubcategoryPickerSheet.tsx`** — a variant of `OptionPickerSheet` (copy its
   Modal/backdrop/list structure — do NOT modify the shared `OptionPickerSheet.tsx`, other
   pickers use it): props
   `{ visible, sectionId: string | null, selectedId?: string, onClose, onSelect(id: string | "") }`.
   Internals: `useTrackedSubcategories(sectionId || undefined)` +
   `subcategoryPickerOptions` (mobile `lib/regulated-format.ts`) + `useCreateSubcategory`
   (mobile `lib/api/tracked-categories.ts`, mutate `{categoryId, name}`). A `TextInput`
   header ("Search or type a new subcategory…") filters case-insensitively; a "None" row
   (nullable behavior like the old sheet); when the trimmed query matches nothing
   case-insensitively, a `+ Create "<query>"` row → `mutateAsync` → `onSelect(created.id)`
   → close. 409 → find ci-match in refreshed list and select, else inline error text.
   Style rows/checkmark exactly like `OptionPickerSheet`.
2. **`ProductForm.tsx`**: swap the subcategory `OptionPickerSheet` usage (~l.353-385
   region) for `SubcategoryPickerSheet` (same open-state plumbing; the subcategory
   `Pressable` row and its `disabled={!form.trackedCategoryId}` stay; section select still
   clears `trackedSubcategoryId`). Display label for the selected sub keeps resolving from
   the fetched list as today.

## Acceptance criteria

1. API: subcategory create/rename trims names; a case-insensitive duplicate within the
   section 409s with the existing row's casing in the message; same-row case-only rename
   allowed; P2002 backstop retained.
2. Web: in ProductCreateModal, product detail edit, and Quick Edit's SectionEditCell, the
   subcategory field is a type-ahead listing the section's subcategories; typing an unknown
   name offers `+ Create "…"`, which mints + selects it inline (operator role suffices); a
   case-insensitive existing match is offered for selection instead of Create; disabled
   until a section is chosen; section change still clears the subcategory.
3. Products page shows All | Regulated (badge = membership count) | Non-regulated scope
   tabs above the toolbar; Regulated scope reveals per-section chips; selection maps to the
   same `?section=` values (`""`/`"any"`/uuid/`"none"`) so existing deep links (e.g. the
   Compliance KPI link `?section=<id>`) land on the Regulated tab with the right chip
   active; the old dropdown is gone.
4. Inventory Stock tab has the same scope tabs; its section filter is now URL-driven
   (`?section=` on the inventory route); StockTable filtering/pills unchanged; the
   functional tabs (Stock/Count/…) untouched.
5. Mobile ProductForm's subcategory sheet supports search + inline create with the same
   dup guard; other `OptionPickerSheet` consumers untouched.
6. All new UI hidden for tenants with no sections. `npm run verify` green; no migrations;
   no new deps.

## Verification commands

- `npm run verify`

## Risks & rollback

- The combobox replaces working `<select>`s on three surfaces — reviewers should walk each
  surface's save path (create=omit vs edit=null semantics live in callers and must be
  unchanged).
- `useUrlFilters` on the inventory page: confirm no Next.js CSR-bailout/Suspense warning
  (products page precedent says fine).
- Scope-tab mapping must round-trip every `?section=` value, including deep links to a
  specific uuid (Regulated tab + chip active) and stale uuids of deactivated sections
  (treat as regulated scope; chip row shows active sections only — the filter still
  applies; acceptable).
- Rollback: revert the commit — UI + one service guard; no schema changes.
