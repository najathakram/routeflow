# Session Handoff — Regulated Sections + Subcategories

> **Status (2026-07-12):** Phase A (backend) **DONE + committed**; Phases B/C/D (web) **NOT started**.
> Branch `feat/regulated-subcategories-api` @ `b1acd59` — **not pushed, not merged, not deployed.**
> Base master `e28a733`. Extends the Phase-4 regulated program (`PHASE-4-PLAN.md`).

## The feature (what & why)

A tenant can already create multiple regulated **sections** (`TrackedCategory`: Tobacco, Liquor, …)
that carry tax rules, license requirements, invoice treatment, and filing templates. This feature adds
a **second level** and the surfaces to drive it:

1. **Subcategories** under each section — Tobacco → {cigarettes, chewing-tobacco}, Liquor → {beer,
   wine, spirits}. When adding a product, the operator picks a **section + subcategory**.
2. A **product-form picker** to set section + subcategory (today the only path is the bulk "Assign
   products" modal, and there is no subcategory at all).
3. Section/subcategory **management in Settings** (a TENANT_ADMIN "Regulated" tab).
4. A **per-section dashboard** — a "Regulated Items" nav group whose children are the tenant's own
   sections; each opens that section's stats + tax filings.

### The one invariant that keeps this safe

The **section = `TrackedCategory`** and keeps ALL compliance semantics. The **subcategory is
classification-only** (name + active) — it carries **no** license/age-ID/invoice/tax logic. Every
regulated consumer (license guard, ledger, filing, invoice split, POD, buyer catalog gate) keys on
`trackedCategoryId` (the section); the new `trackedSubcategoryId` is a **separate, nullable pointer
that no existing query reads**. That is why the whole thing is additive and tobacco/regulated behavior
is byte-identical. **Do not move any compliance logic onto the subcategory.**

### Confirmed product decisions

- **Tax stays at the SECTION level.** Subcategory = classification + (later) reporting breakdown. It
  has **no tax fields**. (Tax *computation* is still the separate, unbuilt W3 block — out of scope.)
- **v1 = Phases A–D.** The subcategory breakdown *inside* the ledger/filings is **Phase E, a deferred
  fast-follow** — it is the only part that touches the compliance-critical ledger schema.

---

## Phase A — DONE (commit `b1acd59`)

Additive migration `apps/api/prisma/migrations/20260719000000_add_tracked_subcategories/` (add-table +
add-nullable-column only, no backfill). Full API suite **974 tests green**, tsc + lint clean.

**Schema (`apps/api/prisma/schema.prisma`):**
- NEW `TrackedSubcategory { id, tenantId, trackedCategoryId (parent, onDelete Cascade), name, active,
  timestamps }`, `@@unique([tenantId, trackedCategoryId, name])`. Back-relations on `Tenant` +
  `TrackedCategory` (`subcategories`).
- Nullable `trackedSubcategoryId String?` (`onDelete: SetNull`) + relation + index on `Product`,
  `OrderItem`, `InvoiceItem`.

**Subcategory CRUD** (`apps/api/src/tracked-categories/`, same `@Roles(OPERATOR)` guard, no addon gate):
- `GET  /tracked-categories/:id/subcategories`
- `POST /tracked-categories/:id/subcategories`
- `PATCH /tracked-categories/:id/subcategories/:subId`
- `PATCH /tracked-categories/:id/subcategories/:subId/toggle`
- Service: `listSubcategories`, `createSubcategory` (P2002→409), `updateSubcategory`,
  `toggleSubcategory`, `getSubcategoryOrThrow` (asserts section+tenant ownership). DTOs
  `create-subcategory.dto.ts` / `update-subcategory.dto.ts` (`name`, `active`).

**Product write-path** (`apps/api/src/products/`):
- `create-product.dto.ts` / `update-product.dto.ts` gained `trackedCategoryId?` +
  `trackedSubcategoryId?` (`@IsOptional() @Transform(emptyToNull) @IsUUID()` — `emptyToNull` lets an
  empty select CLEAR the tag). NEW `emptyToNull` helper in `common/dto-transforms.ts`.
- `products.service.create/update`: `assertSubcategoryInSection` validates the subcategory belongs to
  the chosen section; clearing the section auto-clears the subcategory; a variant inherits the
  parent's section+subcategory pair when the DTO omits the section. `findOne` include now returns
  `trackedSubcategory { id, name, trackedCategoryId }`.

**Refinement vs the original plan:** the OrderItem/InvoiceItem snapshot **population** (setting
`trackedSubcategoryId` at sale time) was **deferred to Phase E**. The columns exist but nothing reads
them yet, so wiring ~10 sites across the money-critical `orders.service`/`invoices.service` for zero
v1 benefit would only add blast radius. Phase E wires them uniformly alongside the ledger column that
consumes them.

Tests: `tracked-categories.service.spec.ts` (subcategory CRUD + section-scoping), `products.service.spec.ts`
("regulated section + subcategory" block: valid tag, cross-section reject, subcategory-without-section
reject, clear-cascades, variant inheritance).

---

## Phases B/C/D — TODO (all web; verify anchors vs current master before editing)

### Phase B — product-form section + subcategory picker
Two dependent selects ("Regulated section" → "Subcategory"; the subcategory list is filtered by the
chosen section and cleared when the section changes; both optional). No shared product-form component —
edit the two places separately.
- Add hook `useTrackedSubcategories(categoryId)` → `GET /tracked-categories/:id/subcategories` in
  `apps/web/lib/api/tracked-categories.ts` (alongside the existing `useTrackedCategories`).
- **CREATE modal** `CreateProductModal` in `apps/web/app/(dashboard)/products/page.tsx` (def ~582-976):
  add the two selects after the Category `CategoryCombobox` (~895-899, before Description ~902); add the
  keys to the `form` state (~598-610) and to the payload built at ~683-696. Hook `useCreateProduct`
  (`lib/api/products.ts` 58-65).
- **EDIT (inline)** `apps/web/app/(dashboard)/products/[id]/page.tsx`: seed the keys into `editDraft` in
  `startEdit` (~375-391); add them to the `saveEdit` PATCH payload (~411-429); insert the picker after
  the Category `InfoRow` (~1480-1494); **replace** the read-only "Separately handled" banner (~1348-1363)
  with the live picker when editing. Hook `useUpdateProduct` (`lib/api/products.ts` 67-77).
- **Bonus (tiny):** the `?action=new` deep-link is dead — `useSearchParams` at `products/page.tsx:~982`
  is never read; the modal only opens via the "New Product" button. Add a `searchParams.get("action")`
  effect to auto-open so `products/create` (a redirect stub) actually works.

### Phase C — Settings "Regulated" tab (TENANT_ADMIN)
`apps/web/app/(dashboard)/settings/page.tsx` (Radix Tabs; `TabTrigger` def ~78-100; `Tabs.Root` ~2924;
`Tabs.List` ~2925-2953; `Tabs.Content` ~2955-2989; deep-linkable via `?tab=regulated`).
- Add a `<TabTrigger value="regulated">` + matching `<Tabs.Content>`, both wrapped in
  `user?.role === "TENANT_ADMIN"` (there is NO per-tab role gate today; `useAuth()` is already imported
  ~73 — pull `user` inside `SettingsPage`).
- Author `RegulatedSettingsTab`: section list with create/edit (reuse `components/CategoryFormModal.tsx`
  + `useCreate/UpdateTrackedCategory`) and, per section, an inline subcategory manager (add / rename /
  toggle via the Phase-A endpoints). Keep `components/AssignProductsModal.tsx` available. Section
  *creation* now lives here; the `/compliance` hub becomes view-only in Phase D.

### Phase D — "Regulated Items" nav group + per-section dashboard
`apps/web/app/(dashboard)/layout.tsx` (nav types `NavLeaf`/`NavGroup` ~65-69; group-with-children
example `Warehouse` ~94-105; renderer `NavGroupSection` ~271-350; `SidebarNav` ~354-409; current
regulated leaves + `hasTobacco` gate in the `DashboardShell` useMemo ~779-794).
- Replace the `hasTobacco` gate (~785) with `useTrackedCategories({active:true})?.length` and build a
  `NavGroup{ label:"Regulated Items", icon: ShieldCheck, children: sections.map(s → { kind:"leaf",
  label: s.name, href: `/compliance/${s.id}`, icon: ShieldCheck }) }`, injected with the existing
  `findIndex('/analytics') + slice` pattern. Add `sections` to the useMemo deps. **Keep the separate
  addon-gated "Tobacco" deep-page leaf as-is.** (Existing tobacco tenants keep their nav — they have a
  Tobacco section, so the group shows.)
- `/compliance` (`compliance/page.tsx`) becomes the **index** — each category card links to
  `/compliance/${c.id}`; its create buttons move to Settings.
- NEW `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx` — reuse the `/tobacco` page shape
  (KPI cards + recharts monthly bar + tabs, `tobacco/page.tsx` ~98-199) but over the **generic,
  un-addon-gated `/regulated/*`** endpoints: `useTrackedCategory(id)` (header — exists),
  `useRegulatedFilings(id)` + `usePrepareFiling` + `fetchRegulatedFilingUrl` (filings — exist,
  category-scoped), and **ONE new hook** `useRegulatedLedger({category, from, to})` over the existing
  `GET /regulated/ledger` (net-sales / tax / by-period for KPIs + chart). Reuse the compliance Filings
  table (`compliance/page.tsx` ~300-357) + `lastCompletedPeriod` (~36-46).
- **Label the "Tax this month" KPI as pending** — `RegulatedSalesLedger.categoryTax` is snapshot 0
  until the separate W3 tax-engine block lands (net sales are real). Ledger currently writes only on
  the split-invoice path (pre-existing gap).

---

## Phase E — subcategory breakdown in stats + filings (DEFERRED fast-follow, NOT v1)
Own PR + adversarial money review. Add nullable `trackedSubcategoryId` to `RegulatedSalesLedger`
(+ composite index) and thread it through `writeSaleEntries` and every reversal builder; **populate
the OrderItem/InvoiceItem snapshots** at the ~10 sites in `orders.service`/`invoices.service` (deferred
from Phase A); add an optional `groupBy=subcategory` to `getLedger` (`regulated.service.ts` ~36-61) and
a "Subcategory" column to `buildFilingCsv` (`filing-csv.ts`, start with the GENERIC template). Render a
subcategory breakdown (grouped table / stacked bar) on the per-section page.

---

## Deploy sequence & caveats
1. Complete B–D on `feat/regulated-subcategories-api`; gate each on local `npm run verify` (typecheck +
   lint + Jest) — the **GitHub Actions billing block is active, so CI will not run**.
2. Ship the whole feature together: **public → apply the migration via
   `railway run --service postgres node apps/api/scripts/prod-migrate.mjs` FIRST → merge → wait for the
   Railway deploy to go ACTIVE while public → `npm run post-deploy-check` → private.** (The
   `POSTGRES_PASSWORD` root cause is fixed, so `prod-migrate.mjs` works normally now.)
3. Migration is additive/reversible; keep money invariants green (`06-critical-paths.spec.ts`).

## Verification checklist (manual, test tenants ONLY — `test` / `e2e-routeflow` / `qa-*`)
- Settings → Regulated → create a "Liquor" section + "beer"/"wine" subcategories → they appear as a
  "Regulated Items" nav group.
- Add a product, pick Liquor + wine on the product form; edit it and change/clear the pair.
- Open `/compliance/[liquor]` → net-sales stats + prepare/download a filing.
- **Regression:** confirm the existing Tobacco flow (license guard on a tobacco order, tobacco report,
  invoice split) is unchanged.

## Quick start for the next session
```
git checkout feat/regulated-subcategories-api      # Phase A is here (b1acd59)
cd apps/api && npx prisma generate                 # refresh client for the new model
# read this doc + .claude/code-map/api.md (tracked-categories → subcategories bullet)
# start Phase B using the anchors above; verify each anchor line still matches
```
