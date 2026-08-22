# Plan: MSRP (suggested retail price) on invoices

> Authored by Fable 5 on 2026-08-22. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Wholesale clients want the **suggested retail price** printed on the invoices they send
their retailers, so the retailer knows what to sell each product for. MSRP is a universal
value per product, overridable for a single customer. It is **display-only** — it must
never enter any money calculation. It ships behind a per-tenant feature flag (default OFF),
and the resolver must be built so a future middle layer (e.g. per-state MSRP) is additive
rather than a migration.

## Constraints & conventions

- npm + Turbo monorepo: NestJS API (`apps/api`, Prisma 7 + Postgres), Next.js 14 App Router
  web (`apps/web`), Expo/React-Native mobile (`apps/mobile`), shared `packages/*`.
- Prettier: semicolons, double quotes, `printWidth` 100, trailing commas. ESLint flat config
  **per workspace** — never run eslint from the repo root.
- **MSRP NEVER participates in money math.** It is not a price. Do not feed it into
  `computeLineSubtotal`, totals, tax, margin, or promotions. All existing money paths stay
  byte-identical.
- **MSRP is per PIECE** (the retail selling unit) even when the wholesale line is boxed.
  Display as `MSRP $X.XX/pc`. `Product.pricePerUnit` is per SELLING unit (a box for boxed
  products) — do not conflate them.
- **Missing MSRP renders blank, never `$0.00`.** Zero/negative/NaN all normalize to null.
- Prisma money columns are `Decimal @db.Decimal(10, 2)`. Every monetary write goes through
  `roundMoney` from `apps/api/src/common/pricing.ts`.
- Tenant isolation: `prisma.forTenant()` / `tenantTransaction`. Never bypass.
- The global `AuditInterceptor` already logs every mutating HTTP verb — no bespoke audit
  calls needed for ordinary MSRP edits.
- Migrations are **never** auto-applied on deploy; the human applies them to prod. Write the
  migration, do not run it against anything but a local/throwaway DB.

## Verified codebase facts (confirmed by reading the files — trust these)

- **No MSRP field exists anywhere.** Greenfield.
- `Product` (schema.prisma ~L888-997): `pricePerUnit` (= tier 1) + `priceTier2..5`,
  `unitsPerBox Int?`, `averageCost`, `standardCost`.
- `CustomerPrice` (schema.prisma ~L2884-2901): `{id, customerId, productId, pricingTier Int,
notes, createdAt, updatedAt, tenantId}`, `@@unique([customerId, productId])`. **It stores a
  TIER NUMBER, not a price.** CRUD: `customers.controller.ts` GET/PUT/DELETE
  `/customers/:id/prices` → `customers.service.ts` `getCustomerPrices` (~L949),
  `upsertCustomerPrice` (~L974), `deleteCustomerPrice` (~L1007). DTO
  `customers/dto/customer-price.dto.ts` `UpsertCustomerPriceDto`.
- **Every `pricingTier` read is already null-safe** (`?? defaultTier` / `?? 1`) — verified at
  `orders.service.ts` ~L1526, ~L1630, ~L3941; `estimates.service.ts`;
  `buyer-catalog.service.ts` (×3); `buyer-dashboard.service.ts` (×4). This is what makes
  making the column nullable safe.
- Invoice lines are built by `invoices.service.ts` `buildInvoiceItemData` (~L539); its four
  callers are `createSplitInvoices` (~L742), `reconcileOrderDraftInvoice` (~L956),
  `rebuildSiblingDrafts` (~L1234), `createPartialFromOrder` (~L1904). `create()` is ~L145.
  `update()`'s DRAFT edit path builds `itemsData` by ~L2384. `duplicate()` is ~L3145. The
  NSF-fee line (~L4190) is productless.
- `recurring-invoices.service.ts` `generateInvoiceFromTemplate` **delegates to
  `InvoicesService.create()`** — so hooking `create()` covers recurring generation with no
  extra work.
- `estimates.service.ts` `convertToInvoice` (~L214, items mapped ~L252-261) writes
  `InvoiceItem` rows **directly** — it is a separate write site and must be handled.
- Invoice render surfaces, all currently 4 money columns (qty / unitPrice / discount +
  `originalPrice` strikethrough / subtotal):
  - web operator: `apps/web/app/(dashboard)/invoices/[id]/page.tsx` items table ~L2172-2309,
    which branches on `item.priceType` (STANDARD/SPECIAL/DISCOUNTED/PROMO/MANUAL)
  - buyer portal: `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx` ~L214-243
  - PDF (`@react-pdf/renderer`, NOT puppeteer): `apps/api/src/invoices/invoice-pdf.service.ts`
    `generateAndUpload` (loads items via `include`), template
    `apps/api/src/invoices/invoice-pdf-template.tsx` — `InvoicePdfData` ~L8-88, item row
    render ~L476-511
  - email HTML: `apps/api/src/email/email.service.ts` `buildInvoiceEmail` itemRows ~L815-825,
    fed from `invoices.service.ts` `sendEmail()` item map ~L2687-2692 (and the sibling
    `sendReminder` map — find it and mirror)
- Entitlements: `FLAG_KEYS` + `ADDON_SKUS` + `LEGACY_ADDON_KEY_TO_SKU` + `FLAG_TO_ADDON_SKU`
  in `apps/api/src/billing/plan-catalog.constants.ts`; `EntitlementsService.hasFlag(tenantId,
flag)` (30s cache) in `billing/entitlements.service.ts`; guard
  `@RequirePlanFlag(...)` + `PlanFlagGuard` (`billing/plan-flag.guard.ts`, re-resolves
  server-side); `buildPlanGateBody` in `billing/plan-gate.ts`. `EntitlementsModule` is
  importable anywhere without cycles. Catalog publish script precedent:
  `apps/api/prisma/publish-plan-catalog-v8.ts`.
- Platform-admin addon toggle: `AVAILABLE_ADDONS` array (~L96) in
  `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx` → existing audited
  `POST /platform-admin/tenants/:id/addons/enable|disable`.
- Web addon read hook: `useTenantAddons()` / `useHasAddon(key)` in `apps/web/lib/api/tobacco.ts`
  - `apps/web/lib/api/addons.ts` (`TOBACCO_ADDON` is the naming precedent).
- Bulk-write precedent to copy: `BulkSetCostBasisDto` + `InventoryService.bulkSetCostBasis`
  (validate all ids → one `tenantTransaction` → per-row update).
- Product edit UI: `apps/web/app/(dashboard)/products/[id]/page.tsx` — "Pricing Tiers" view
  section ~L1882, edit block ~L2481. Products list `apps/web/app/(dashboard)/products/page.tsx`
  uses a generic `QuickEditCell` on `pricePerUnit` (~L500) and `priceTier2..5` (~L581-610).
- Customers Special Prices tab: `apps/web/app/(dashboard)/customers/[id]/page.tsx`
  `SpecialPricesTab` (declared ~L750; note a "Default Pricing Tier" card was added at the top
  of it — keep that intact), overrides table ~L850-910. Mobile mirror:
  `apps/mobile/app/(operator)/customers/[id]/catalog.tsx`.

## Work packages

File lists are DISJOINT. WP1 must land before WP3/WP4/WP5 (they import from it), so run WP1
and WP2 first, then the rest in parallel.

### WP1 — Schema + the resolver (foundation)

- **files:** `apps/api/prisma/schema.prisma`,
  `apps/api/prisma/migrations/20260831000000_add_msrp_pricing/migration.sql`,
  `apps/api/src/common/msrp.ts`, `apps/api/src/common/msrp.spec.ts`
- **brief:**
  1. `Product`: add `msrp Decimal? @db.Decimal(10, 2)` after `priceTier5`, with a comment
     saying it is per PIECE, display-only, null = blank.
  2. `CustomerPrice`: change `pricingTier Int` → `pricingTier Int?` and add
     `msrp Decimal? @db.Decimal(10, 2)`.
  3. `InvoiceItem`: add `msrp Decimal? @db.Decimal(10, 2)` near `originalPrice`, commented as
     a snapshot taken at line creation.
  4. Write the migration SQL by hand (do NOT run `prisma migrate dev` — it prompts and hangs
     in a non-interactive shell). Then run `npx prisma generate`.
  5. Create `apps/api/src/common/msrp.ts` exactly as specified below, plus a spec covering:
     precedence (customer over segment over product), 0/negative/NaN/""→null, rounding,
     `wholesalePerPiece` for boxed vs loose, `isMsrpBelowWholesale` true/false/null cases.
- **exact code** — `apps/api/src/common/msrp.ts`:

  ```ts
  import { roundMoney } from "./pricing";

  /** 0, negatives and non-numbers all mean "no MSRP" — never render those as $0.00. */
  const normalizeMsrp = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? roundMoney(n) : null;
  };

  export interface MsrpInputs {
    /** CustomerPrice.msrp — highest precedence. */
    customerMsrp?: unknown;
    /**
     * FUTURE middle layer (per-state / per-segment MSRP). Nothing populates this in v1;
     * it exists so the precedence order and every call site are already segment-shaped —
     * adding segments later is one new table plus one lookup in loadMsrpMap, with no
     * migration of existing data and no call-site churn.
     */
    segmentMsrp?: unknown;
    /** Product.msrp — the universal default. */
    productMsrp?: unknown;
  }

  /** customer override → (future) segment → product default. null = no MSRP (render blank). */
  export function resolveMsrp(i: MsrpInputs): number | null {
    return (
      normalizeMsrp(i.customerMsrp) ?? normalizeMsrp(i.segmentMsrp) ?? normalizeMsrp(i.productMsrp)
    );
  }

  /**
   * Wholesale price expressed per PIECE, so it is comparable with MSRP.
   * pricePerUnit is per SELLING unit — a box when unitsPerBox > 1.
   */
  export function wholesalePerPiece(pricePerUnit: unknown, unitsPerBox?: unknown): number | null {
    const p = Number(pricePerUnit);
    if (!Number.isFinite(p) || p <= 0) return null;
    const upb = Number(unitsPerBox);
    return Number.isFinite(upb) && upb > 1 ? roundMoney(p / upb) : roundMoney(p);
  }

  /** Advisory only — the UI warns, it never blocks. */
  export function isMsrpBelowWholesale(
    msrp: unknown,
    pricePerUnit: unknown,
    unitsPerBox?: unknown,
  ): boolean {
    const m = normalizeMsrp(msrp);
    const w = wholesalePerPiece(pricePerUnit, unitsPerBox);
    return m != null && w != null && m < w;
  }

  /**
   * Batch-resolve MSRP for many products for one customer.
   * `db` is any prisma-ish client so this runs inside a tenantTransaction too.
   * FUTURE segment layer: add one more select here and pass it as segmentMsrp.
   */
  export async function loadMsrpMap(
    db: {
      product: { findMany: (a: any) => Promise<any[]> };
      customerPrice: { findMany: (a: any) => Promise<any[]> };
    },
    customerId: string,
    productIds: string[],
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (productIds.length === 0) return out;
    const [products, overrides] = await Promise.all([
      db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, msrp: true },
      }),
      db.customerPrice.findMany({
        where: { customerId, productId: { in: productIds } },
        select: { productId: true, msrp: true },
      }),
    ]);
    const overrideBy = new Map(overrides.map((o) => [o.productId, o.msrp]));
    for (const p of products) {
      out.set(p.id, resolveMsrp({ customerMsrp: overrideBy.get(p.id), productMsrp: p.msrp }));
    }
    return out;
  }
  ```

- **exact SQL** — `migration.sql`:

  ```sql
  -- MSRP (suggested retail price) — display-only, never money math.
  -- Product.msrp = universal default per PIECE; CustomerPrice.msrp = per-customer override.
  -- InvoiceItem.msrp = the value snapshotted when the line was created, so an issued
  -- invoice never changes when the product's MSRP is later edited.
  -- CustomerPrice.pricingTier becomes nullable: a row may now carry only an MSRP override.
  -- Every pricingTier reader already falls back (`?? customer default`), so null is safe.
  ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "msrp" DECIMAL(10,2);
  ALTER TABLE "CustomerPrice" ADD COLUMN IF NOT EXISTS "msrp" DECIMAL(10,2);
  ALTER TABLE "CustomerPrice" ALTER COLUMN "pricingTier" DROP NOT NULL;
  ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "msrp" DECIMAL(10,2);
  ```

### WP2 — Feature flag wiring

- **files:** `apps/api/src/billing/plan-catalog.constants.ts`,
  `apps/api/prisma/publish-plan-catalog-v9.ts`,
  `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`
- **effort:** low
- **brief:** add `"flag.msrp"` to `FLAG_KEYS`; add an `"MSRP"` entry to `ADDON_SKUS` with
  `grantsFlags: ["flag.msrp"]` and `includedAtPlan: null`; map `msrp: "MSRP"` in
  `LEGACY_ADDON_KEY_TO_SKU` and `"flag.msrp": "MSRP"` in `FLAG_TO_ADDON_SKU`. Create
  `publish-plan-catalog-v9.ts` by cloning v8's draft→publish flow, adding **only** the new
  SKU — **no plan grants the flag, so it is OFF for every tenant** until an admin enables the
  addon. Add `{ key: "msrp", name: "MSRP on invoices", description: "..." }` to
  `AVAILABLE_ADDONS` so the existing audited enable/disable endpoints work unchanged.

### WP3 — API: snapshot writes + product/customer endpoints

- **files:** `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.module.ts`,
  `apps/api/src/estimates/estimates.service.ts`, `apps/api/src/estimates/estimates.module.ts`,
  `apps/api/src/products/products.service.ts`, `apps/api/src/products/products.controller.ts`,
  `apps/api/src/products/dto/create-product.dto.ts`, `apps/api/src/products/dto/update-product.dto.ts`,
  `apps/api/src/products/dto/bulk-set-msrp.dto.ts`,
  `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/dto/customer-price.dto.ts`
- **brief:**
  1. Add the private orchestrator to `invoices.service.ts` (exact code below) and call it at
     every line-creating site: `create()` (after `itemsData` is built, ~L258 — this also
     covers recurring generation, which delegates here), the four `buildInvoiceItemData`
     callers listed in the facts, `update()`'s DRAFT edit path, and `duplicate()` (which
     instead copies `msrp` verbatim from the source line, like `promoFreeUnits`). Have
     `buildInvoiceItemData` default `msrp: null`. Leave the productless NSF-fee line alone.
  2. `estimates.service.ts convertToInvoice`: inject `EntitlementsService`, call
     `loadMsrpMap(tx, est.customerId, productIds)` and set `msrp` in the item map.
  3. Both modules import `EntitlementsModule`.
  4. Product DTOs gain `msrp?: string | null` — optional, decimal-string, `""` clears (copy
     the `unitSku` empty-to-null transform already in these DTOs). `products.service.ts`
     persists it on create and update, normalizing 0 → null. **Gate inside the service**:
     when `dto.msrp !== undefined` and the tenant lacks `flag.msrp`, throw
     `ForbiddenException(buildPlanGateBody("flag.msrp", ...))`. Do NOT decorate the whole
     route — that would 403 ordinary product edits for tenants without the flag.
  5. New `POST /products/msrp/bulk` — `BulkSetMsrpDto { items: {productId, msrp|null}[] }`,
     `@ArrayMaxSize(500)`, mirroring `bulkSetCostBasis`: validate every id belongs to the
     tenant, then one `tenantTransaction`. This route (and only this one) carries
     `@RequirePlanFlag("flag.msrp")`. Return `{ updated, warnings }` where warnings lists
     rows whose MSRP is below `wholesalePerPiece` — warn, never block.
  6. `UpsertCustomerPriceDto`: make `pricingTier` optional, add `msrp?: number | null`
     (`@Min(0.01)` when a number; explicit `null` clears). At least one of the two must be
     present. `upsertCustomerPrice` becomes a partial update (only touch fields that are
     present); if a row ends up with both fields null, delete it instead. Flag-gate msrp
     writes the same way as products. Add `msrp: true` to the product select in
     `getCustomerPrices`.
- **exact code** — the orchestrator in `invoices.service.ts`:

  ```ts
  /**
   * Stamp each line's MSRP at creation time. Snapshot, not a live read: an issued invoice
   * must never change because someone later edited the product's MSRP. No-ops (leaving
   * msrp null) when the tenant does not have flag.msrp, so a tenant that turns the feature
   * off simply stops emitting MSRP on NEW invoices while old ones keep what they printed.
   */
  private async applyMsrpSnapshots<T extends { productId?: string | null; msrp?: number | null }>(
    db: any,
    customerId: string,
    itemsData: T[],
  ): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId || !(await this.entitlements.hasFlag(tenantId, "flag.msrp"))) return;
    const ids = [...new Set(itemsData.map((i) => i.productId).filter(Boolean))] as string[];
    if (ids.length === 0) return;
    const map = await loadMsrpMap(db, customerId, ids);
    for (const it of itemsData) {
      if (it.productId) it.msrp = map.get(it.productId) ?? null;
    }
  }
  ```

### WP4 — Web UI

- **files:** `apps/web/lib/api/products.ts`, `apps/web/lib/api/invoices.ts`,
  `apps/web/lib/api/customers.ts`, `apps/web/lib/api/addons.ts`,
  `apps/web/app/(dashboard)/products/[id]/page.tsx`,
  `apps/web/app/(dashboard)/products/page.tsx`,
  `apps/web/app/(dashboard)/customers/[id]/page.tsx`,
  `apps/web/app/(dashboard)/invoices/[id]/page.tsx`,
  `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx`
- **brief:**
  - Types: `Product.msrp`, `InvoiceItem.msrp`, `CustomerPrice.pricingTier: number | null` +
    `CustomerPrice.msrp`. Export `MSRP_ADDON = "msrp"` beside the tobacco addon constant.
  - Product detail: MSRP row in the view "Pricing Tiers" section and an input in the edit
    block, helper text "per piece — even for boxed products", plus an amber (non-blocking)
    warning when MSRP is below `pricePerUnit / (unitsPerBox || 1)`. Gate the input on
    `useHasAddon(MSRP_ADDON)`.
  - Products list: an MSRP column using the existing generic `QuickEditCell`
    (`field="msrp" type="number"`), matching how `priceTier2..5` are wired. This is the
    primary bulk-edit path.
  - Customers Special Prices tab: add an MSRP-override column beside the tier badge in the
    same grid. A row may now be tier-only, msrp-only, or both — render the tier badge only
    when `pricingTier != null` (msrp-only rows show "Default tier"). Support clearing either
    field independently (send explicit null). **Keep the "Default Pricing Tier" card at the
    top of this tab exactly as it is.**
  - Invoice detail + buyer portal: under the unit-price cell, when `item.msrp != null`, render
    a muted `MSRP $X.XX/pc` sub-line. It must appear across every `priceType` branch. Key off
    data presence, not the flag — that way issued invoices keep rendering correctly even if
    the tenant later loses the addon.
  - **No change to the invoice create/edit forms** — the server resolves MSRP on write.

### WP5 — PDF, email, and mobile

- **files:** `apps/api/src/invoices/invoice-pdf-template.tsx`,
  `apps/api/src/email/email.service.ts`,
  `apps/mobile/lib/api/invoices.ts`,
  `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`,
  `apps/mobile/app/(customer)/invoices/[id].tsx`
- **brief:**
  - PDF: add `msrp?: DecimalLike | null` to `InvoicePdfData`'s item type and, in the item row
    (~L476-511), wrap the Unit Price cell so it can carry a second line rendering
    `MSRP {fmt(item.msrp)}/pc` at ~6.5pt in a muted grey when set. Keep the 4-column layout.
    **Do NOT touch `invoice-pdf.service.ts`** — it loads items via `include`, so the column
    flows automatically, and it must read the line snapshot rather than the live product.
  - Email: extend `buildInvoiceEmail`'s item type and add a muted `MSRP $X.XX/pc` line under
    the unit price cell. In `invoices.service.ts`'s `sendEmail` item map (~L2687-2692) and its
    `sendReminder` counterpart, pass `msrp: it.msrp != null ? Number(it.msrp) : null`.
    (`invoices.service.ts` is owned by WP3 — make ONLY the two map additions here and let WP3
    own the rest; if that risks a conflict, hand these two lines to WP3 instead.)
  - Mobile: add `msrp` to the `InvoiceItem` type and render the same muted sub-line under the
    `qty × price` line on the operator and customer invoice detail screens. Nothing else on
    mobile in v1.

## Acceptance criteria

1. `Product.msrp`, `CustomerPrice.msrp`, `InvoiceItem.msrp` exist as nullable
   `Decimal(10,2)`; `CustomerPrice.pricingTier` is nullable; one hand-written migration adds
   all four changes.
2. `resolveMsrp` resolves customer override → segment (unused in v1) → product default, and
   returns null for 0, negative, NaN, empty and missing values — never 0.
3. MSRP is **snapshotted onto `InvoiceItem` at line creation** by every write path: from-order
   invoices (all four `buildInvoiceItemData` callers), standalone `create()`, recurring
   generation, DRAFT edits, estimate conversion, and `duplicate()` (copied verbatim).
   Editing a product's MSRP afterwards does **not** change an already-issued invoice.
4. No money value changes anywhere: totals, tax, discounts, promotions, margins and
   `computeLineSubtotal` results are identical with and without MSRP set.
5. With `flag.msrp` OFF for a tenant: no MSRP inputs appear, new invoice lines snapshot null,
   and ordinary product/customer-price edits still succeed (no 403).
6. MSRP renders as `MSRP $X.XX/pc` on the web invoice detail, the buyer portal, the PDF, the
   invoice email, and both mobile invoice screens — and renders nothing at all when null.
7. A customer-level MSRP override beats the product default; clearing it falls back.
8. A `CustomerPrice` row may hold a tier only, an MSRP only, or both; a row cleared of both is
   deleted; existing tier-only rows keep working (tier resolution unchanged).
9. `npm run check-types`, `npm run lint` and `npm run test` all pass; new specs cover the
   resolver and the snapshot behaviour.

## Verification commands

Run from the repo root:

- `npm run check-types`
- `npm run lint`
- `npm run test`

Migration check (never against the working dev DB, which is stale):
`docker exec routeflow_postgres psql -U user -d postgres -c "CREATE DATABASE msrp_check;"`
then `DATABASE_URL=<same creds, /msrp_check> npx prisma migrate deploy` from `apps/api`, then
drop it.

## Risks & rollback

- **Making `CustomerPrice.pricingTier` nullable touches tier pricing**, the highest-risk part
  of this change. Every reader was verified null-safe, but any new code must keep the
  `?? customer default` fallback. Add a spec proving a `{pricingTier: null, msrp: 5}` row
  still prices at the customer's default tier.
- The snapshot must never be re-read from the live product at render time — that would make
  historical invoices mutate. The PDF service is the easiest place to get this wrong.
- Prisma 7 does not auto-load `.env` when `prisma.config.ts` exists; export `DATABASE_URL`
  explicitly for any prisma CLI call. `prisma migrate dev` hangs non-interactively — write
  migration SQL by hand.
- Rollback: the feature is flag-gated and every column is nullable and additive, so reverting
  the code leaves harmless unused columns.
