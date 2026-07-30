# Plan: Case/Unit dual SKU with either-code scan resolution

**Status:** PLANNED
**Scale:** major (schema + migration, scanning, invoice PDF, web + mobile forms)

## Context

RouteFlow wholesalers sell products as BOXES ("cases") of `unitsPerBox` inner pieces ("units").
Usually the case and its units share one SKU, but sometimes the inner unit has a different
retail SKU/barcode. Retailers who buy from the wholesaler scan the **unit** code at their own
POS, so today's customer invoices — which print the case code — don't scan for them.

Requirements:

- Optional per-product **unit code** (`unitSku`). When unset, the case `sku` applies to units too
  (read-time fallback, NOT a physical copy — so editing the case SKU keeps units in sync).
- Customer invoice PDFs print the **unit** code (`unitSku ?? barcode ?? sku`).
- Scanning EITHER code (case sku, barcode, or unit sku) resolves to the product everywhere.
- Wholesaler-facing surfaces keep the case SKU as primary.

UI naming (user-decided): existing field = "Case code", new field = "Unit code". DB column is
`unitSku` (aligns with the codebase's `unitsPerBox`/"unit" vocabulary for the inner piece).

`Product` variants are ordinary self-related `Product` rows, each owning its own sku/barcode —
so `unitSku` is a plain Product column that composes with variants for free. NO parent→variant
inheritance of unitSku (it's a per-row scannable identity; inheriting would violate uniqueness).

## Current state (verified)

### `apps/api/prisma/schema.prisma` `model Product` (L854-946)

`sku String?` (L858), `barcode String?` (L875), `unitsPerBox Int?` (L882). Uniques:
`@@unique([tenantId, sku])` (L924), `@@unique([tenantId, barcode])` (L925). Indexes include
`@@index([barcode])` (L939). Variants via `parentProductId` self-relation (L919-920).

### `apps/api/src/products/products.service.ts`

- `findAll` search OR (L103-107): `[{name},{sku},{barcode}]` each `contains, mode: "insensitive"`.
- `findByBarcode` (L303-310):
  ```ts
  async findByBarcode(barcode: string) {
    const product = await this.prisma.forTenant().product.findFirst({
      where: { barcode },
      include: { variants: { where: { isActive: true } }, parent: true },
    });
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }
  ```
- `create` (L312-440): SKU autogen when absent (L334-344); else uniqueness check
  `findFirst({ where: { sku: dto.sku } })` → BadRequest (L346-347); barcode uniqueness
  (L349-354). Writes `sku: dto.sku, barcode: dto.barcode` in the create data (L411-412).
- `update` (L442+): sku check `findFirst({ where: { sku: dto.sku, id: { not: id } } })` (L472-477);
  barcode check (L478-483); then `const data: any = ... { ...dto }` spread (L505-506) carries the write.

### DTOs

`create-product.dto.ts` L21-22: `@IsOptional() @IsString() sku?` / `barcode?`. Already imports
`emptyToNull, emptyToUndefined` from `../../common/dto-transforms`.
`update-product.dto.ts` L21-22: same. Same imports available.

### `apps/api/src/invoices/invoice-pdf.service.ts`

- item product select (L48): `{ select: { id: true, name: true, barcode: true, sku: true } }`.
- barcode text (L132): `const barcodeText = (item as any).product?.barcode ?? (item as any).product?.sku;`
  → feeds bwip-js Code128 + caption. This is the ONLY doc renderer that prints a line code
  (buyer statement PDF prints no product codes; tobacco report prints `sku` and is
  regulator/wholesaler-facing → must keep `sku`, do NOT change it).

### `apps/api/src/vendor-bills/product-matcher.ts`

- `CatalogProduct` (L12-19): `{ id, name, sku: string|null, barcode: string|null, parentProductId?, parent? }`.
- exact SKU/barcode block (L108-120):
  ```ts
  for (const p of products) {
    const pSku = p.sku?.toLowerCase() ?? null;
    if (
      (pSku && (pSku === rawLower || (skuLower && pSku === skuLower))) ||
      (p.barcode && (p.barcode === rawTrim || (skuStr && p.barcode === skuStr)))
    ) {
      return {
        matchedProductId: p.id,
        matchedProductName: composedProductName(p),
        confidence: "high",
      };
    }
  }
  ```

### `apps/api/src/vendor-bills/vendor-bills.service.ts`

Catalog `findMany` select that feeds `matchLine` (L706-714): `{ id, name, sku, barcode, parentProductId, parent }`.

### Client resolve ladders (already fall through to `search=` then prefer exact sku)

- `apps/web/lib/barcode-resolve.ts` L39-75 — exact-sku preference at L63-66.
- `apps/mobile/lib/barcode-resolve.ts` L44-82 — exact-sku preference at L69-73.

## Work packages

### WP1 — Schema + migration (API)

**Files:** `apps/api/prisma/schema.prisma`, new
`apps/api/prisma/migrations/20260730000000_add_product_unit_sku/migration.sql`.

- Add after `sku String?` (L858): `unitSku String?` with a short comment
  ("Optional retail-unit (inner piece) code; NULL ⇒ unit shares the case `sku`. Read sites use
  `unitSku ?? sku`.").
- Add `@@unique([tenantId, unitSku])` beside the other uniques (after L925).
- Add `@@index([unitSku])` in the index block.
- Migration SQL:
  ```sql
  ALTER TABLE "Product" ADD COLUMN "unitSku" TEXT;
  CREATE UNIQUE INDEX "Product_tenantId_unitSku_key" ON "Product"("tenantId", "unitSku");
  CREATE INDEX "Product_unitSku_idx" ON "Product"("unitSku");
  ```
  (Postgres allows multiple NULLs in a unique index — safe. Additive + nullable → prod-safe.)
  Run `npx prisma migrate dev` locally + `npx prisma generate` so the client picks up `unitSku`.

### WP2 — Products service: DTOs, scanning, uniqueness, search (API)

**Files:** `apps/api/src/products/dto/create-product.dto.ts`,
`apps/api/src/products/dto/update-product.dto.ts`,
`apps/api/src/products/products.service.ts`. (Depends on WP1's generated client.)

- create DTO (after L22): `@IsOptional() @Transform(emptyToUndefined) @IsString() unitSku?: string;`
- update DTO (after L22): `@IsOptional() @Transform(emptyToNull) @IsString() unitSku?: string | null;`
  (empty string clears it back to "same as case").
- `findAll` search OR (L103-107): add `{ unitSku: { contains: query.search, mode: "insensitive" } }`.
- `findByBarcode` — widen to match any of the three codes, deterministic priority
  barcode > sku > unitSku (each tenant-unique ⇒ ≤3 rows). Keep the method name + route:
  ```ts
  async findByBarcode(code: string) {
    const matches = await this.prisma.forTenant().product.findMany({
      where: { OR: [{ barcode: code }, { sku: code }, { unitSku: code }] },
      include: { variants: { where: { isActive: true } }, parent: true },
    });
    if (matches.length === 0) throw new NotFoundException("Product not found");
    return (
      matches.find((p) => p.barcode === code) ??
      matches.find((p) => p.sku === code) ??
      matches.find((p) => p.unitSku === code)!
    );
  }
  ```
- `create` — after the barcode uniqueness check (L349-354), add a unitSku collision check across
  the whole scannable namespace (a unit code must not collide with any product's sku/barcode/unitSku,
  else a scan resolves ambiguously):
  ```ts
  if (dto.unitSku) {
    const clash = await this.prisma.forTenant().product.findFirst({
      where: { OR: [{ unitSku: dto.unitSku }, { sku: dto.unitSku }, { barcode: dto.unitSku }] },
      select: { id: true },
    });
    if (clash)
      throw new BadRequestException(
        "Unit code already used by another product's SKU, barcode, or unit code",
      );
  }
  ```
  and add `unitSku: dto.unitSku,` to the create `data` (beside `barcode:` L412).
  Do NOT add unitSku to the parent-inheritance selects/writes.
- `update` — after the barcode check (L478-483), add the same collision check with `id: { not: id }`
  in the where. The `{ ...dto }` spread (L505-506) already carries `unitSku` (including `null` to
  clear) into the write — no further change.

### WP3 — Invoice PDF prints the unit code (API)

**Files:** new `apps/api/src/invoices/invoice-item-code.ts`,
`apps/api/src/invoices/invoice-pdf.service.ts`. (Depends on WP1.)

- New pure helper:
  ```ts
  /**
   * Code printed under each invoice line's Code128. Customer invoices show the
   * UNIT (retail) code — retailers scan the inner piece, not the case. Falls back
   * to the legacy barcode→sku chain when no unit code is set.
   */
  export function invoiceItemCode(
    p?: { unitSku?: string | null; barcode?: string | null; sku?: string | null } | null,
  ): string | null {
    return p?.unitSku ?? p?.barcode ?? p?.sku ?? null;
  }
  ```
- `invoice-pdf.service.ts`: add `unitSku: true` to the item product select (L48); change L132 to
  `const barcodeText = invoiceItemCode((item as any).product);`. Template unchanged (already
  prints `barcodeText`).

### WP4 — Vendor-bill scanner matches unit code (API)

**Files:** `apps/api/src/vendor-bills/product-matcher.ts`,
`apps/api/src/vendor-bills/vendor-bills.service.ts`. (Depends on WP1.)

- `CatalogProduct`: add `unitSku?: string | null;`.
- exact block (L108-120): add a `pUnit` clause mirroring `pSku`:
  ```ts
  const pUnit = p.unitSku?.toLowerCase() ?? null;
  // in the if: ... || (pUnit && (pUnit === rawLower || (skuLower && pUnit === skuLower))) || ...
  ```
- `vendor-bills.service.ts`: add `unitSku: true` to the catalog `findMany` select at L707-714
  (the one feeding `matchLine`; leave the productMapping include untouched).

### WP5 — Web product forms (Case code / Unit code)

**Files:** `apps/web/components/ProductCreateModal.tsx`,
`apps/web/app/(dashboard)/products/[id]/page.tsx`, `apps/web/lib/barcode-resolve.ts`,
and the web products API types (`apps/web/lib/api/products.ts` Product/DTO interfaces — add
`unitSku?: string | null`). (Independent of API WPs at the type level; depends on WP2 endpoints
at runtime.)

- ProductCreateModal: relabel the existing SKU field to "Case code (SKU / barcode)"; add a
  "Unit code" text input + `BarcodeScannerButton` (scanner writes to the unitSku field) beneath
  it, with helper text "Code on the individual unit — printed on customer invoices. Leave blank
  if it matches the case code." Add `unitSku: ""` to form state + resets; send
  `unitSku: form.unitSku.trim() || undefined` in the create payload.
- products/[id] detail page: add `unitSku` to the local Product interface; init the edit draft
  `unitSku: product.unitSku ?? ""`; save `unitSku: (draft.unitSku as string)?.trim() || null`; add
  an `InfoRow label="Unit code"` rendering `product.unitSku ?? "— (same as case code)"`. Add the
  same field to the variant add/edit form if present.
- `barcode-resolve.ts` (L63-66): widen the exact-match preference so a unit code is also preferred
  (compare `p.unitSku` case-insensitively alongside `p.sku`).
- Leave every other `/products/barcode/:code` caller unchanged — the server widening (WP2) makes
  them resolve either code with no client change.

### WP6 — Mobile product forms (Case code / Unit code)

**Files:** `apps/mobile/lib/product-form.ts`, `apps/mobile/components/ProductForm.tsx`,
`apps/mobile/lib/barcode-resolve.ts`, and mobile product API types if separate. (Independent of
web WP5.)

- `product-form.ts`: add `unitSku: string` to the form values type, `""` in the empty form,
  `p.unitSku ?? ""` in from-values, `unitSku?: string | null` in the submit payload type, and in
  the payload builder follow the edit-clears pattern:
  `unitSku: mode === "edit" ? form.unitSku.trim() || null : form.unitSku.trim() || undefined`.
- `ProductForm.tsx`: relabel the SKU field "SKU (case code)"; add a "Unit code" FormField + scan
  button after the Barcode field (clone the existing barcode field's pattern).
- `barcode-resolve.ts` (L69-73): widen the exact-match preference to also accept `unitSku`.
- Leave all scan screens unchanged (server widening covers them).

## Acceptance criteria

1. `Product.unitSku` column + `@@unique([tenantId, unitSku])` + `@@index([unitSku])`; migration
   is additive/nullable.
2. `findByBarcode` resolves a case sku, a barcode, OR a unit sku to the product, with barcode >
   sku > unitSku priority; the route/name are unchanged so all existing callers benefit.
3. `findAll?search=` matches unit codes; create/update reject a unitSku that collides with any
   product's sku/barcode/unitSku; clearing unitSku (empty string on edit) writes null.
4. Invoice PDF prints `unitSku ?? barcode ?? sku` for each line; a product without a unit code is
   unchanged; tobacco report + buyer statement unchanged.
5. Vendor-bill scan matches a line whose code equals a product's unitSku (high confidence).
6. Web + mobile product create/edit expose "Case code" + "Unit code"; product detail shows the
   unit code (or "— (same as case code)").

## Verify commands (run from repo root)

- `npx tsc -p apps/api/tsconfig.build.json --noEmit`
- `npm run test -w apps/api` (products.service.spec + product-matcher.spec + new invoice-item-code.spec)
- `npm run lint -w apps/api`
- `npm run check-types -w apps/web` and `npm run check-types -w apps/mobile`
- `npm run lint -w apps/web` and `npm run lint -w apps/mobile`

## Tests to add

- `apps/api/src/products/products.service.spec.ts`: `findByBarcode` — barcode hit; unitSku-only
  hit; priority (findMany returns rows out of order → barcode wins; sku beats unitSku); `[]` →
  NotFound. Extend the search test to assert the OR contains `unitSku`. create/update: unitSku
  colliding with another product's sku → BadRequest (mock `findFirst` sequence; global default
  `findFirst → null` keeps existing tests green).
- `apps/api/src/vendor-bills/product-matcher.spec.ts`: raw text equal to `unitSku` → high;
  per-line scanned code equal to `unitSku` (case-insensitive) → high (extend the `product()`
  fixture with `unitSku: null`).
- new `apps/api/src/invoices/invoice-item-code.spec.ts`: unitSku wins; barcode fallback; sku
  fallback; all-null → null.
- `apps/mobile/__tests__/operator-create-forms.test.ts` (if it exists — else the product-form
  test): payload carries trimmed `unitSku`, omits when blank on create, sends `null` when blank on edit.
