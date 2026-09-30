# Plan: Regulated per-product UoM — confirmed-finding fix round

> Authored by Fable 5 on 2026-07-30. Status: SHIPPED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

A previous pipeline run implemented `.claude/pipeline/plans/2026-07-30-regulated-product-uom-report-ux.md`
(moving TX Comptroller item type / unit of measure from the regulated section onto the product with
case/unit bucketing, plus a report-UX overhaul). The build gate is now **green** — `npm run
check-types` passes 8/8, `npm run test` passes (API 1685 tests, mobile 570), `npm run lint` exits 0
with zero errors. The run was stopped part-way through its fix phase, leaving five confirmed review
findings unrepaired plus a required code-map update. This plan closes exactly those.

Every finding below was independently confirmed by two adversarial verifiers; none were refuted.
Do not re-litigate them — implement the fixes.

## Constraints & conventions

- Monorepo: API `apps/api` (NestJS, Prisma, Jest), web `apps/web` (Next.js 14 App Router, Radix +
  Tailwind, TanStack Query), mobile `apps/mobile` (Expo). Prettier: semicolons, double quotes,
  `printWidth` 100, trailing commas. Match surrounding style.
- **Do not regress the green gate.** Keep changes minimal and surgical.
- **Do not** re-run `prisma migrate`, start dev servers, or deploy.
- Never name a real client tenant, business, or product in code, comments, or tests.
- The back-compat invariant from the previous plan still stands and must not be touched: in
  `apps/api/src/regulated/tx-report.ts`, when a product's `regUomCase` is null the signed
  `unitBasisQty` passes through **raw, with no `unitsPerBox` multiplication**. No package here
  should modify that file.

## Work packages

File lists are DISJOINT.

---

### WP-F1 — products.service update(): regulatory-config merge defects

- **files:** `apps/api/src/products/products.service.ts`,
  `apps/api/src/products/products.service.spec.ts`
- **brief:** Two confirmed defects in `update()`, both in the block that merges the regulatory trio
  (`regItemType` / `regUomCase` / `regUomUnit`) around lines 576-640.

**Defect 1 — explicit config survives a section clear.** `data` is built as `{ ...dto }`, so a
request that sends `trackedCategoryId: null` **together with** `regItemType: "1"` writes that code.
The auto-clear that should stop it is gated on the product's PREVIOUS value:

```ts
if (effectiveCategoryId == null) {
  if (existing.regItemType != null) data.regItemType = null;
  if (existing.regUomCase != null) data.regUomCase = null;
  if (existing.regUomUnit != null) data.regUomUnit = null;
}
```

When `existing.regItemType` is null the guard does not fire, so the DTO's value persists — a
product carrying regulatory config with **no section**, exactly the state `assertRegConfigValid`
exists to prevent (and which it cannot catch here, because `effectiveRegItemType` was already
forced to null before validation, making the check a no-op).

**exact fix** — make the clear unconditional:

```ts
// Same auto-clear for the regulatory reporting trio — it's only meaningful
// within a regulated section. Unconditional: a request that clears the section
// while ALSO sending reg codes must not persist config with no section to
// validate it against (the effective-value merge above already forced the
// validated values to null, so only the raw DTO spread can leak them through).
if (effectiveCategoryId == null) {
  data.regItemType = null;
  data.regUomCase = null;
  data.regUomUnit = null;
}
```

**Defect 2 — stale config bricks unrelated edits.** `assertRegConfigValid` is called on every
`update()`, with effective values that fall back to `existing.*`. `assertRegConfigValid` throws
when the section's template has `productConfig: null`. So if a section's `reportTemplate` is ever
switched from `TX_COMPTROLLER` to one without per-product config (`GENERIC`, `CA_CDTFA`, `CA_ABC`,
`CALRECYCLE`), **every subsequent PATCH of any field** — a rename, a price change — on every
product in that section returns 400, with an error message about item types that has nothing to do
with what the user edited. The same trap fires for a product left holding config after its
template changed.

**exact fix** — validate only when the request actually touches the regulatory trio or the section:

```ts
// Validate only when this request actually touches the regulatory trio or the
// section it hangs off. Validating stale `existing.*` on every PATCH would brick
// unrelated edits (a rename, a price change) for any product whose section's
// reportTemplate was later switched to one with no per-product config.
const touchesRegConfig =
  dto.regItemType !== undefined ||
  dto.regUomCase !== undefined ||
  dto.regUomUnit !== undefined ||
  dto.trackedCategoryId !== undefined;
if (touchesRegConfig) {
  await this.assertRegConfigValid({
    trackedCategoryId: effectiveCategoryId,
    regItemType: effectiveRegItemType,
    regUomCase: effectiveRegUomCase,
    regUomUnit: effectiveRegUomUnit,
  });
}
```

Keep the existing `effectiveReg*` merge expressions exactly as they are.

**Spec cases to add** (`products.service.spec.ts`, alongside the existing regulatory-config block):

1. PATCH `{ trackedCategoryId: null, regItemType: "1" }` on a product that had no prior reg config
   → the write persists `regItemType: null` (not `"1"`).
2. PATCH `{ trackedCategoryId: null }` on a product that HAD `regItemType`/`regUomUnit` set →
   all three written as null (the previously passing behavior — keep it green).
3. PATCH `{ name: "Renamed" }` on a product whose section's template is `GENERIC` while the product
   still has a leftover `regItemType` → resolves successfully, does NOT throw, and does not write
   any reg field.
4. PATCH `{ regItemType: "1", regUomUnit: "CP" }` on a product in a `TX_COMPTROLLER` section →
   still validates and persists (the guard must not skip real validation).
5. PATCH `{ regUomUnit: "WO" }` (a code from a different item type) on a product whose stored
   `regItemType` is `"1"` → still 400s, proving the merge still validates against `existing.*` when
   the request DOES touch the trio.

---

### WP-F2 — mobile: switching regulated type keeps stale regulatory codes

- **files:** `apps/mobile/components/ProductForm.tsx`
- **effort:** low
- **brief:** In the regulated-type `OptionPickerSheet`'s `onSelect` (around lines 535-552), the
  handler clears `trackedSubcategoryId` and `category` but leaves `regItemType`, `regUomCase` and
  `regUomUnit` untouched. No effect elsewhere in the file clears them either. The regulatory
  vocabulary is **template-scoped**, so switching from one regulated type to another carries codes
  that are invalid under the new section's template — the form then submits them and the API 400s
  (`"…is not a valid item type for …"`), or, when both templates happen to share a code, silently
  files under the wrong vocabulary. The web equivalent already clears them
  (`apps/web/components/ProductCreateModal.tsx` does this in its section handler); mobile must
  mirror it.

**exact fix** — inside that `onSelect`, after the existing `set("trackedSubcategoryId", "")`:

```tsx
// The regulatory vocabulary is template-scoped, so codes chosen under the
// previous regulated type are meaningless (and rejected) under a new one.
set("regItemType", "");
set("regUomCase", "");
set("regUomUnit", "");
```

Leave the rest of the handler, including the `category` clearing and
`setSectionPickerOpen(false)`, exactly as it is.

---

### WP-F3 — DateRangePicker: range-cap guard and first-click churn

- **files:** `apps/web/components/DateRangePicker.tsx`
- **brief:** The `maxDays` guard is derived from the parent's value rather than from the picker's
  own in-progress selection:

```ts
const anchor = value.from && value.from === value.to ? selectedRange.from : undefined;
```

`value` is always a complete range (the only caller seeds it from `presetRange("last-month")`), so
the guard depends on `handleDaySelect` first round-tripping a degenerate one-day range through the
parent. That round-trip has its own cost: the first click of a new range emits
`{ from: D, to: D }`, which flips the preset to "custom" and fires a preview refetch for a
meaningless one-day window before the user has picked an end date. And when `react-day-picker`
returns `undefined` for a click (deselection), `handleDaySelect` returns early, leaving the guard
disengaged entirely.

**Fix:** own the in-progress anchor locally. Add state, set it on the first click of a new
selection **without** emitting, emit only once both endpoints exist, and clear it then. Derive the
disabled matcher from that state.

```tsx
// The in-progress selection's first endpoint. Owned locally so the range cap does
// not depend on the parent round-tripping a degenerate one-day range, and so the
// first click does not emit (and refetch) a meaningless single-day window.
const [pendingAnchor, setPendingAnchor] = React.useState<Date | undefined>(undefined);

const handleDaySelect = (range: DateRange | undefined, day: Date) => {
  // A click that clears the selection still starts a new range from that day.
  if (!range?.from) {
    setPendingAnchor(day);
    return;
  }
  if (!pendingAnchor) {
    setPendingAnchor(range.from);
    return;
  }
  const from = range.from < pendingAnchor ? range.from : pendingAnchor;
  const to = range.to ?? (range.from > pendingAnchor ? range.from : pendingAnchor);
  setPendingAnchor(undefined);
  onChange({
    preset: "custom",
    range: { from: formatLocalIso(from), to: formatLocalIso(to) },
  });
};

const disabledMatcher = pendingAnchor
  ? (day: Date) => Math.abs(differenceInCalendarDays(day, pendingAnchor)) > maxDays - 1
  : undefined;
```

Also:

- `react-day-picker` v9 passes the clicked day as the second argument to `onSelect` — confirm the
  installed version's signature and adapt if it differs; the behavior above (first click anchors,
  second click commits) is the requirement, not the exact argument list.
- Clear `pendingAnchor` whenever the popover closes and when a preset is clicked, so a half-finished
  selection never leaks into the next interaction. Reset it in `handlePresetClick` and in the
  existing close paths (outside-click, Escape, and the `setOpen(false)` in `handlePresetClick`).
- While `pendingAnchor` is set, show the in-progress selection in the calendar (pass
  `selected={{ from: pendingAnchor, to: undefined }}`) so the user sees their first click land.
- Keep `parseLocalDate` / `formatLocalIso` as the only ISO↔Date conversions — never `toISOString()`.

---

### WP-F4 — Custom column layout cannot be reset back to the template

- **files:** `apps/web/components/ReportColumnsPicker.tsx`,
  `apps/web/components/RegulatedReportPanel.tsx`
- **brief:** "Save for this section" is rendered only when `onSave` is truthy
  (`ReportColumnsPicker.tsx:137`), and the panel passes it conditionally:

```tsx
            onSave={selectedColumns !== null ? handleSaveColumns : undefined}
```

"Reset to template" calls `onChange(null)` (`ReportColumnsPicker.tsx:132`), which immediately
removes the Save button. So once a custom layout has been **saved on the section**, there is no way
to save the reverted state — the operator resets, the button vanishes, and the saved custom layout
comes back on the next visit. The reset is purely cosmetic and cannot be persisted.

**Fix:**

- In `RegulatedReportPanel.tsx`, always pass `onSave={handleSaveColumns}`.
- Make `handleSaveColumns` handle the `null` case by **removing** that template's key from the
  category's `reportColumnPrefs` (rather than writing `null` as its value — the API validates that
  every value is a non-empty array of column keys, so a null/empty value would 400). Build the next
  prefs object by omitting the resolved template's key, and PATCH the category with the result
  (send `null` for `reportColumnPrefs` when no keys remain, so the column clears entirely).
- In `ReportColumnsPicker.tsx`, keep the Save button rendered whenever `onSave` is provided, and
  disable it only while `saving` is true. Optionally label it "Save for this section" in both
  states — a reset that is then saved is still a save.
- Do not change the materialize-then-toggle semantics in `toggle()`; they are correct and are a
  required behavior of the previous plan.

---

### WP-F5 — Code map update (hook-enforced)

- **files:** `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/mobile.md`,
  `.claude/code-map/_meta.json`
- **brief:** 32+ source files changed and 6 new modules landed, while `.claude/code-map/` was never
  touched. This repo requires a surgical map update with every change (a Stop hook enforces it).
  **Surgical, not a regeneration** — edit only the entries below.

Read each file first and match its existing density and voice.

**`api.md`** — the WP11 regulated entry (around line 253) is the anchor. Extend it (or add a
sibling bullet directly after it) covering:

- `regulated/template-registry.ts` — `REPORT_TEMPLATES` + `templateByKey` / `defaultColumnKeys` /
  `allColumnKeys` / `isValidItemType` / `isValidUom` / `itemTypeLabel`; the single source for
  report-template vocabulary and column supersets, served by `GET /regulated/templates`; retires
  the hardcoded TX vocab copies in web and mobile.
- `regulated/report-projection.ts` — `projectReportColumns(report, keys)`; projects columns/rows/
  totalsRow through one index map so preview and CSV cannot drift; warnings and
  `csv.preamble`/`footer` pass through untouched.
- `regulated/tx-report.ts` — `buildTxReport` now resolves item type and UoM **per product**
  (`TxProductConfig`) via `linesById`/`productsById`, and groups per
  `(invoiceId, itemType, uom)` — per `(invoiceId, productId, uom)` when `itemDescription` is
  requested. **Record the back-compat rule explicitly:** `regUomCase == null` ⇒ raw passthrough of
  the signed `unitBasisQty`, no `unitsPerBox` conversion, which is what reproduces pre-change
  report numbers. New warnings `UNMATCHED_LEDGER_LINE` (dangling `invoiceItemId` — the ledger has
  no FK and reconcile rotates ids) and `UNLISTED_PRODUCT_LINE`.
- `regulated-report.service.ts` — the TX join gained `invoiceItem` + `product` lookups; `columns`
  query param → registry validation → include-set → projection; custom layouts set
  `csv.includeHeader = true`, `report.custom = true`, and a `-custom` filename token, while the
  official TX default stays headerless.
- `Product.regItemType` / `regUomCase` / `regUomUnit` and `TrackedCategory.reportColumnPrefs`
  (migration `20260801000200_product_regulatory_reporting_config`, additive + two COALESCE
  backfills; `regUomCase` deliberately left NULL). Note `TrackedCategory.txItemType`/`txUom` are
  now **deprecated shadows** — no reader, still accepted by the DTOs for one release because
  `forbidNonWhitelisted` would otherwise 400 older clients.
- `products.service.ts` — `assertRegConfigValid` (registry-driven), variant inheritance of the
  trio, and the section-clear auto-clear.

**`web.md`** — update/extend the regulated + products entries for: `components/DateRangePicker.tsx`
(new; `react-day-picker` v9 two-month range calendar + preset rail in a hand-rolled popover — the
repo's first date picker, and the reason `date-fns` is no longer a dead dependency),
`components/ReportColumnsPicker.tsx` (new; column show/hide with materialize-then-toggle so the
first change never resets the other columns), `RegulatedReportPanel.tsx` (date picker + custom
format state machine + `reportColumnPrefs` persistence + template list from
`useRegulatedTemplates`), `CategoryFormModal.tsx` (TX item type/UoM selects REMOVED — config is
per product now), the compliance page (Prepare filing moved from the page header into the Filings
card header), and the product create/detail regulatory-reporting block.

**`mobile.md`** — the product form's regulatory pickers (item type / unit UoM / case UoM, case only
when boxed), `RegulatedCategoryForm` losing its TX fields, and template lists sourced from the
templates hook. Note mobile never sends a `columns` param.

**`_meta.json`** — set `mappedSha` to the current `git rev-parse HEAD` and `generatedAt` to the
current UTC timestamp. Read the file first and preserve every other key exactly.

---

## Acceptance criteria

1. `products.service.update()` clears all three regulatory fields **unconditionally** when the
   effective section is null; a request sending `{ trackedCategoryId: null, regItemType: "1" }`
   persists `regItemType: null`.
2. `assertRegConfigValid` runs during `update()` only when the request supplies at least one of
   `regItemType`, `regUomCase`, `regUomUnit`, `trackedCategoryId`. A PATCH of an unrelated field on
   a product whose section template has no per-product config resolves without throwing.
3. Validation still fires — and still rejects — when the request does touch the trio, including
   codes that are invalid for the product's stored item type.
4. Mobile's regulated-type picker clears `regItemType`, `regUomCase` and `regUomUnit` when the
   section changes.
5. `DateRangePicker` tracks its in-progress anchor in local state; the first click of a new range
   does not call `onChange`, the second click emits the complete ordered range, and while an anchor
   is pending, days more than `maxDays - 1` away are disabled. The anchor is cleared when a preset
   is chosen and when the popover closes.
6. `DateRangePicker` performs no `toISOString()` date conversion.
7. "Save for this section" is visible after "Reset to template", and saving in that state removes
   the template's entry from `reportColumnPrefs` (sending `null` when nothing remains) rather than
   writing an empty/null value that the API would reject.
8. `.claude/code-map/{api,web,mobile}.md` describe the new modules and the changed behavior listed
   in WP-F5, and `_meta.json.mappedSha` matches `git rev-parse HEAD`.
9. `npm run check-types`, `npm run test` and `npm run lint` all still pass.
10. `apps/api/src/regulated/tx-report.ts` is unchanged by this round — the raw-passthrough
    back-compat rule is untouched.

## Verification commands

Run from the repo root, in this order:

- `npm run check-types`
- `npm run test`
- `npm run lint`

Do not run `prisma migrate`, dev servers, or any deploy/Railway command.

## Risks & rollback

- **Over-narrowing validation (WP-F1 defect 2)**: skipping `assertRegConfigValid` when the request
  does not touch the trio is intentional, but it must still fire on every request that does.
  Criterion 3 is the guard.
- **`react-day-picker` v9 `onSelect` signature** may differ from the sketch; the required behavior
  is first-click-anchors / second-click-commits, however the arguments arrive.
- **Code map drift**: keep edits surgical. Regenerating the map would bury unrelated history.
- **Rollback**: `git revert` this round's commit; the previous round's green gate is unaffected
  since no package here touches the report builder.
