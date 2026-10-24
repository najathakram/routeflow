# Web landing 2026-10-18, fixes-4 (#3511)

Range `127bac4ce..32fbe0542`; web side. Paths under `apps/web/` unless noted. Api: `api/landing-2026-10-18-fixes-4.md`. Tests not indexed.

## K10e units: add the missing Piece, default-unit undo

- `app/(dashboard)/products/[id]/units-v2/units/AddUnitPanel.tsx` takes `pieceMissing`, `prefillPiece`. While the product has no 1-piece unit, "Contains 1 of {base}" is allowed (`min` 1): the name box locks to the base name (`readOnly`, hint `units-v2-add-name-hint`). Once a Piece exists the "2 or more" rule stands.
- `units-v2/structure/UnitStructure.tsx` `UnitStructureControls` computes `pieceIsMissing(rows)` (the locked base row while another row is editable; a family, recipe or variant locks every row so never reads missing). A capture-phase click on the grid's `addUnitPointer` makes the next open prefill as that Piece.
- `lib/generic-toast-copy.ts` `ONE_PIECE_NAME` turns the units service's uncoded 400 "A 1-piece unit is always named ..." into a copy line that names the tenant's piece word (shown back only if it is a short plain name).
- `app/(dashboard)/products/[id]/ProductUnitsCard.tsx` default order unit (F18): `changeDefault(target|null)` writes then shows an inline note with Undo (`undoDefault`) and Dismiss, no timer; `data-testid` `units-default-note`; any other mutation in the cache clears the note (`getMutationCache().subscribe`).
- `ProductUnitsCard.tsx` default radios: `radioKeys(commit)` (arrows only move focus, Space or Enter commits), `aria-disabled` instead of `disabled` so the checked radio keeps focus, a `refocus` effect returns focus to the checked radio, an sr-only hint `units-default-hint`.

## K11 L1 jump strip, customer view, products list

- `units-v2/nav/ProductJumpLinks.tsx` rewritten around `SECTIONS` (`label`, `short` for phones, `fallback`): sets `--jump-offset` on `#main-content` and `--jump-inset` on headings so a landed section clears the sticky strip; a jump settles while late sections load (`SETTLE_WINDOW_MS`), stops on wheel, touch, pointer or key.
- `ProductJumpLinks.tsx` also: `aria-current` follows an IntersectionObserver; a reload with a `#h-...` hash keeps settling and waits up to `HASH_WAIT_MS` for a section not yet mounted; `prefers-reduced-motion` skips smooth scroll; unmount removes what it stamped.
- `units-v2/customer/CustomerPicker.tsx`: the list starts shut (opens on focus or typing, blur closes); `localMatches(rows, text)` filters the rows already loaded on every keystroke until the debounced server answer lands; "No customer matches" shows only for a fresh answer; the active row is a brand tint plus left bar.
- `units-v2/customer/CustomerPriceView.tsx` (product-page mode only): `useCustomerParam(enabled)` -> `{fromUrl, write}` keeps `?customer=<id>` (id only) via `history.replaceState`, no history entry; a 400, 403 or 404 on that id drops it from the URL and `lastChoice`; a 5xx keeps it. The card fills its column when `productId` is set (`single`).
- `CustomerPriceView.tsx` tier caption: the old tier column is gone; `TierFigure` prints "· {Tier}: $x" in the caption of a row not priced by the tier (customer, customer-shape and history rows of a special tier), hidden below `sm`.
- `app/(dashboard)/products/_components/ProductNameLink.tsx` gains `data-product-name-link` and an inset focus ring (the card's `overflow-hidden` clipped it); `app/(dashboard)/products/page.tsx` search box: ArrowDown focuses the first `a[data-product-name-link]` (ignored while an IME composes).

## K11 L3 the product page (`app/(dashboard)/products/[id]/`)

- `MoneyFigure.tsx` (NEW) `MoneyFigure({value, className})`: `formatMoney` text in tabular figures (`$0.00`, never a dash); the page's prices, tier cells and family rows print through it.
- `FamilyPriceSection.tsx` (NEW) `FamilyPriceSection({price, isEditing, children})`: on a family the Price each and Pricing Tiers block folds under a "Family price $x" disclosure (`aria-expanded`); Edit opens it and keeps it open.
- `FamilySalesCards.tsx` (NEW) `FamilySalesCards({productId, unitsPerBox})`: a family shows Sales (`compactEmpty`, `hideCreateOrder`) and adds `DemandCard` only once `useProductSales` reports sales. `SalesHistoryCard.tsx` takes `compactEmpty` (shorter empty box, family copy).
- `ProductMerchandising.tsx` (NEW) `ProductMerchandising({product, isEditing, pending, onToggle})`, `MerchFlag` (`isFeatured`, `isNew`, `isDeal`): the Buyer merchandising switches, moved out of `page.tsx` to the end of the Details body; each switch saves at once.
- `ProductHeaderControls.tsx`: below `sm` Make variant, Deactivate or Reactivate, tobacco and Delete fold into one "More actions" Radix menu (Delete last, red); `sm` and up keep the buttons (CSS switch, no width hook). A lone action stays a button. New prop `deleteOpen`: closing the delete confirm returns focus to the opener.
- `page.tsx`: at `lg` a three-column grid placed by grid lines (Image and stock left, Details and the rest right), DOM order = phone reading order; Details header is one row on phones. Buyer merchandising and the family branches now go through the components above.
- `lib/product-tier-patch.ts` `PriceDraftKey`, `detailsPricePatch(stored, draft, seeded)`, `detailsPriceMoves(...)`, `cascadeTiers(...)`: the Details form and the variant modal send a price only when the draft differs (in cents) from what the form was SEEDED with; a list-price change moves only untouched tiers that still track the list. `page.tsx` keeps `pricesWhenEditStartedRef` and `variantPricesWhenOpenedRef`.
- `ProductUnitsCard.tsx` save sends only price fields whose draft differs from the row's seed (`dirtyPrice(i)`), so a stale unit price is never written back.
- `lib/api/usePriceWrites.ts`: Save and Undo on success invalidate every cached `["products", ...]` query except the price grid (`queryKey[2] !== "price-grid"`) and `productUnitsKey(productId)`.
- `components/family/FamilyVariantsGrid.tsx` read-only: Name and Price columns stay on phones (`core`), the rest return from `sm`; money columns print `formatMoney` right-aligned; a variant name with an id links to `/products/:id`.

## New product dialog (K11-26/27/28)

- `components/ProductCreateModal.tsx`: optional piece price (`pricePerPiece`) shown when `usePricesV2Enabled()` and `useUnitsEnabled()`, the unit is a pack with a whole Units per box of 2 or more and no parent. `validateSetPrice` blocks Create before any write; `savePiecePrice(productId, to)` = POST `/products/:id/units` (Piece, factor 1), `fetchPriceGrid`, POST `/products/:id/prices` (Retail, S9).
- `ProductCreateModal.tsx` also: any failed step keeps the product and becomes ONE warning toast naming what missed; exactly one toast per create, `CREATED_TOAST_MS` (5 s); `baselineRef` + `setFormProgrammatic` so only typing makes the form dirty; Escape closes it only while pristine and not when meant for an open list (`listOpenInDialog`).
- `ProductCreateModal.tsx` also: the parent pre-fill is keyed on the parent being found (Add variant mounts before the catalog loads) and fills only untouched fields; focus starts on `product-variant-name` or `product-name`; the form has `pb-20` to clear the pinned footer; titles "New product" / "Create product".
- `components/product-create/product-create-draft.ts` `EMPTY_DRAFT_FORM` gains `pricePerPiece: ""`.

## Password policy

- `lib/password-policy.ts` (NEW) `PASSWORD_RULES` (`length`, `upper`, `lower`, `digitOrSymbol`; `_` counts as a symbol, `[\d\W_]`), `missingRules(pw)`, `missingMessage(rules)` ("Add an uppercase letter and a number or symbol."), `newPasswordSchema` (zod, one issue naming every missing rule), `passwordErrorMessage(err, newPassword?, fallback?)`, `PASSWORD_ERROR_FALLBACK`.
- `passwordErrorMessage` looks the API text up in a table (policy, length, wrong current, same-as-current, Google-only account, already has a password), reads an array `message`, and never renders unknown server text (B986): unknown falls back to "Your password couldn't be changed. Try again."
- `components/auth/PasswordChecklist.tsx` (NEW, exported from `components/auth/index.ts`) `PasswordChecklist({value, id})`: live met or missing list under a New password field; a polite sr-only summary announced after `CHECKLIST_ANNOUNCE_DELAY_MS` of no typing. The field's `aria-describedby` points at `id`.
- Used with `newPasswordSchema` and `passwordErrorMessage` by `app/change-password/page.tsx`, `app/buyer/change-password/page.tsx` and `PasswordCard` in `app/(dashboard)/settings/page.tsx`.
- Underscore now counts as a symbol in `app/(auth)/signup/page.tsx`, `app/(auth)/reset-password/page.tsx`, `app/buyer/register/page.tsx`, `app/buyer/reset-password/page.tsx` and the admin create-tenant check in `app/(platform-admin)/admin/tenants/new/page.tsx` (regexes only).

## Copy, admin, e2e

- `lib/generic-toast-copy.ts` `CODE_COPY[CUSTOMER_PRICES_UNAVAILABLE]`: "Customer prices couldn't be loaded. Nothing was saved. Try again in a moment." (the api's 503 when a typed-price customer's flag read fails).
- `app/(platform-admin)/layout.tsx` `main` is `relative` (BO-01): its sr-only spans no longer stretch the page into a blank band. `admin/tenants/[id]/_features/profile-errors.ts` `profileErrorCopy` handles `FULFILMENT_CARRIER_IN_TRANSIT` (reads `count`; says to apply the profile once the orders are delivered).
- `playwright.config.ts`: the `units-v2` project matches `/(units-v2-|k11-).*\.spec\.ts/`; new `bo-web` project (`bo-web-*.spec.ts`, super-admin storage state). `e2e/k11-l3-support.ts` (NEW) shared plumbing for the K11 L3 specs: `openFixtureProduct`, `seedImages`, `ensureFamily`, `viewportHeight`, `focusedPageTop`, `pageTopOf`, `UNITS_SKU`, `BASE`, re-exports `VIEWPORTS`, `shot`.
