# PR-B — tax-rate unit fix + tenant-safe product mapping

**Status:** IMPLEMENTED — shipped 2026-08-18/19; see the PR for the verified final shape
**Scale:** major (api-only; money-affecting + a live cross-tenant bug)
**Source of truth:** `.claude/pipeline/decisions/2026-08-18-batch-architecture.md` §A1 and §PR-5 (commit 1). Read it if anything here is ambiguous — it wins.

## Context

Two API defects block the rest of the mobile UX batch.

1. **`settings.taxRate` unit mismatch.** Every client treats the stored SystemConfig value as a PERCENT (0–100) and divides by 100; `orders.service.getTaxRate()` alone treats it as a FRACTION. PR-4 will route the mobile invoice builder's default save through `POST /orders/sell` → `orders.create`, so a tenant with `taxRate = "5"` would be taxed 500%. **Decision: PERCENT is canonical; the API changes.** Verified production state: live tenant stores `"0"`, one QA tenant stores `"150"`, and there is not one taxed invoice line in the database — so this is latent, and there is nothing to backfill.
2. **`saveProductMapping` upserts on a GLOBAL unique key** (`@@unique([supplierName, rawDescription])`, no tenantId) — a live cross-tenant bug: tenant B correcting the same (supplier, description) as tenant A either 500s on P2002 or overwrites A's mapping.

Both are API-only and independent of the mobile PRs, so they ship first.

## Non-goals / do not touch

- No Prisma migration. No schema change of any kind.
- Do NOT write to any tenant's stored `settings.taxRate` (the QA tenant's `"150"` stays; it is made inert by a read-side clamp + write-side validation).
- Do NOT change any client (`apps/web`, `apps/mobile`) — they are already correct.
- Do NOT touch `pricing.ts` in any workspace.
- Do NOT retire the legacy `ProductMapping` read tier (later cleanup).

## Work packages

### WP1 — tax-rate helper + adoption (`apps/api`)

**Files owned:** `apps/api/src/common/tax-rate.ts` (new), `apps/api/src/common/tax-rate.spec.ts` (new), `apps/api/src/orders/orders.service.ts`, `apps/api/src/order-templates/order-templates.service.ts`, `apps/api/src/config/configuration.ts`

1. Create `apps/api/src/common/tax-rate.ts` with EXACTLY this helper (contract is fixed):

```ts
/** SystemConfig "settings.taxRate" stores a PERCENT (0–100, string). Returns a FRACTION. */
export function taxRateFractionFrom(stored: string | null): number {
  if (stored === null || stored === "") return 0;
  const pct = parseFloat(stored);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(Math.max(pct, 0), 100) / 100;
}
```

Add a file-header comment explaining WHY (every client divides by 100; this is the one server reader that did not), and that the clamp exists because the settings PATCH historically accepted unvalidated values.

2. `orders.service.ts`: `getTaxRate()` (~lines 155-159) returns `taxRateFractionFrom(<the stored string>)`. Keep its existing SystemConfig read; only the parsing changes. Do not alter the call sites (758/971/1427/2664/3430) — they already multiply by a fraction.

3. `order-templates.service.ts` (~lines 30-40, 376): currently taxes template-generated orders with `env TAX_RATE ?? 0.1` — a **second latent bug** (10% regardless of tenant settings). Inject `SystemConfigService` and read the tenant value per-request through `taxRateFractionFrom`; drop the constructor-cached env field. Follow how `orders.service` obtains SystemConfig; add the module import if needed.

4. `configuration.ts`: remove the now-unused `taxRate` key. **First** `grep -rn "taxRate" apps/api/src --include=*.ts` for other readers; if any consumer outside orders/order-templates exists, LEAVE the config key in place and just ensure orders/templates no longer read it. Report what you found either way.

5. `apps/api/src/common/tax-rate.spec.ts` must pin: `"10"→0.10`, `"0"→0`, `""→0`, `null→0`, `"150"→1` (clamped), `"-5"→0` (clamped), `"abc"→0`, `"0.5"→0.005`.

### WP2 — spec contract flip + settings validation (`apps/api`)

**Files owned:** `apps/api/src/orders/orders.service.spec.ts`, `apps/api/src/system-config/settings.controller.ts`, `apps/api/src/system-config/settings.controller.spec.ts` (create if absent)

1. `orders.service.spec.ts`: the SystemConfig mock returns `"0.1"` at ~lines 483, 972, 997, 1023, 1135 meaning "10%". Change those to `"10"`. Expected money values must NOT change — that is the point: same 10% tax, correct unit. If any expectation shifts, STOP and report; it means a call site was misread.
2. `settings.controller.ts` `PATCH /settings` (~lines 116-125) writes `String(dto[k])` with no validation — how `"150"` was stored despite the web form's `min(0).max(100)` (a direct API call bypasses the form). Add validation for the `taxRate` key only: reject unless `Number.isFinite(n) && n >= 0 && n <= 100`, throwing `BadRequestException("Tax rate must be between 0 and 100 (percent)")`. Leave every other key's handling untouched.
3. Spec the new validation: `"10"` accepted, `"150"` rejected 400, `"-1"` rejected 400, `"abc"` rejected 400, and a non-taxRate key still writes unchanged. Follow the file's existing `Test.createTestingModule` style; mock at the module boundary.

### WP3 — tenant-safe `saveProductMapping` (`apps/api`)

**Files owned:** `apps/api/src/vendor-bills/vendor-bills.service.ts` (only `saveProductMapping` + its DTO import), `apps/api/src/vendor-bills/dto/save-product-mapping.dto.ts` (new), `apps/api/src/vendor-bills/vendor-bills.service.spec.ts`

1. New `dto/save-product-mapping.dto.ts` — `SaveProductMappingDto` with `class-validator` decorators matching the current inline shape (supplierName, rawDescription, productId nullable for "clear"). Match the DTO style used elsewhere in this module.
2. Rewrite `saveProductMapping` to be tenant-safe: **no `upsert`** (its compound key `supplierName_rawDescription` is globally unique and has no tenantId, so an upsert can hit another tenant's row). Instead: `findFirst` scoped through `this.prisma.forTenant()` on (supplierName, rawDescription) → if found `update` by `id`, else `create`. Wrap the create in a try/catch that **swallows P2002 only** (another tenant holds the global key; log at debug and return gracefully — never 500 the operator's correction). Any other error rethrows.
3. Extend `vendor-bills.service.spec.ts`: (a) existing row for this tenant ⇒ update-by-id, no create; (b) no row ⇒ create; (c) create throwing P2002 ⇒ resolves without throwing; (d) create throwing anything else ⇒ rethrows. The prisma mock may need a `productMapping.findFirst`.

## Acceptance criteria

- [ ] `taxRateFractionFrom` exists in `apps/api/src/common/tax-rate.ts` with exactly the specified body and is the ONLY parser of `settings.taxRate` in orders + order-templates.
- [ ] `orders.service.getTaxRate()` returns a fraction derived by dividing the stored percent by 100, clamped to 0–100 before division.
- [ ] `order-templates.service` no longer reads `env TAX_RATE`; it uses the tenant's SystemConfig value via the helper.
- [ ] `PATCH /settings` rejects a `taxRate` outside 0–100 (or non-numeric) with a 400 and the specified message; other keys unaffected.
- [ ] `saveProductMapping` contains no `upsert`; it is tenant-scoped and swallows P2002 on create only.
- [ ] New specs: `tax-rate.spec.ts` (8 cases above), settings-validation cases, 4 saveProductMapping cases. `orders.service.spec.ts` mocks read `"10"` with unchanged money expectations.
- [ ] No file under `apps/web`, `apps/mobile`, `prisma/`, or any `pricing.ts` is modified.

## Verification

```
npx turbo run check-types lint test --filter=@routeflow/api --force
npm run verify
```

Both must pass. `npm run verify` is the pre-push gate and runs types+lint+tests across all workspaces.
