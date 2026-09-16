# `order-templates/`

> Split from [`../feature-modules-3.md`](../feature-modules-3.md) (verbatim, lines 202-253 of the pre-split file) on 2026-09-16. Originally itself split from `.claude/code-map/api.md` (verbatim, lines 1344-1592) on 2026-09-13. See [`../../INDEX.md`](../../INDEX.md).


- **controller** `order-templates` — get/patch/delete, items add/remove, `:id/generate`.
- **service** — `findAll`, `findOne`, `update`, `delete`, `addItem`, `removeItem`, `generateOrder` (draft Order from template). side effects: OrderTemplate(+Item)/Order writes. **Tax on `generateOrder` reads the TENANT's `settings.taxRate` per-request via `SystemConfigService` + `common/tax-rate.ts` `taxRateFractionFrom` — it used to be a constructor-cached `env TAX_RATE ?? 0.1`, i.e. a flat 10% regardless of tenant settings. `OrderTemplatesModule` therefore imports `SystemConfigModule` (without it the app fails to boot on the new constructor arg).**
- **DRIVER removed from every mutation (B133, F14 2026-09-02)** — `create`/`update`/`removeItem`
  admitted `@Roles(OPERATOR, CUSTOMER, DRIVER)` and `addItem` admitted
  `@Roles(OPERATOR, DRIVER)`; the driver screens that motivated the original grant (commit
  `028f86b0`) were deleted long ago, leaving driver-written template content (create/update/
  addItem/removeItem) writable by any driver token and then materialized into a BILLED order by
  the template's daily-cron `generateOrder` (06:00), which was already `[OPERATOR, CUSTOMER]` and
  never itself admitted DRIVER. DRIVER dropped from all four; the matrix is now `[OPERATOR,
CUSTOMER]` for create/update/removeItem (unchanged for generateOrder) and **`[OPERATOR]`** for
  `addItem` (CUSTOMER was never admitted there even before this fix). `findAll`/`findOne` carry no `@Roles` at all — a DRIVER
  can still LIST/READ templates; recorded as an intentional residual, not fixed here (out of
  scope — see `pin (B133)` in the roles spec). **`addItem` now delegates to a new ownership
  wrapper `addItemForUser(templateId, dto, user)`** (`service.addItem` itself is unchanged and
  now private in effect — the controller never calls it directly), which calls the existing
  `findOneForUser` ownership check (F2-003 — throws for a CUSTOMER who doesn't own the template)
  before delegating to `addItem`. For OPERATOR this is a pass-through today (no ownership branch
  fires), but it closes the door on a future CUSTOMER grant on `addItem` shipping unguarded —
  uniformity with its siblings `removeItemForUser`/`generateOrderForUser`, which already had this
  shape. Specs: `order-templates.controller.roles.spec.ts` (new — role-decorator matrix + the
  controller delegates to `addItemForUser` not `addItem`), `order-templates.service.spec.ts`
  (`addItemForUser` ownership cases).
- **REG-B48 (F13) — `generateOrder` prices through the SHARED buyer resolver.** Every template line
  used to bill raw `Number(product.pricePerUnit)`, so a standing order ignored the customer's
  pricing tier, per-product `CustomerPrice` overrides, active promotions (incl. `BUY_N_GET_M` free
  units) and the sticky-upsell price memory that every interactive order already applies. It now
  loads `customer.pricingTier`, the `CustomerPrice` rows for the line products (`pricingTier: null`
  = MSRP-only, falls through to the default tier), `ordersService.loadActivePromotions(CUSTOMER)`
  and `ordersService.getCustomerPriceHistory(customerId)`, then calls
  **`ordersService.resolveBuyerLinePrice(...)`** per line and `computeLineSubtotal({unitPrice, qty,
freeUnits})`; the line persists `priceType`/`originalPrice`/`promoFreeUnits` like the interactive
  path. A template qty is a SELLING-UNIT count, so `qtyPieces = qty × unitsPerBox` is passed for
  promo thresholds while `qty` still bills as whole units. **`OrdersService.loadActivePromotions`
  and `resolveBuyerLinePrice` were made public for this — they are now a shared contract, not
  orders-private.** Spec: `order-templates.pricing-and-items.spec.ts` (REG-B48 T9–T16, run against
  the REAL resolver and the REAL `computeLineSubtotal`); `order-templates.service.spec.ts` gains the
  matching `generateOrder` pins (the resolver is called once per line, tax still reads the tenant's
  `settings.taxRate`).
- **REG-B09 (F13) — `PATCH :id` can replace items.** `UpdateOrderTemplateDto` gains
  `items?: OrderTemplateItemDto[]` (`@IsArray @ArrayMinSize(1) @ValidateNested @Type`), reusing the
  now-**exported** `OrderTemplateItemDto` from `dto/create-order-template.dto.ts`; without the field
  the whitelist pipe silently 400'd/dropped the customer page's "Edit Standing Order" item edits.
  `update()` keeps the scalar-only path untouched and, when `items` is present, validates every
  `productId` in-tenant BEFORE any write, then does `orderTemplateItem.deleteMany` +
  `orderTemplate.update` with nested `create` (each row stamped with `tenantId`) inside ONE
  `tenantTransaction`, so a failure can never leave a template with zero items. `items: null` is
  treated as absent (class-validator skips every validator for null); `items: []` is a 400. Specs:
  `dto/update-order-template.dto.spec.ts` (REG-B09 T23 + whitelist pins — no client `unitPrice` on a
  template item), `order-templates.pricing-and-items.spec.ts` (REG-B09 T25/T26).

