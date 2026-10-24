# Proposal — the money helper refuses ambiguity (Lane U-units, 2026-09-21)

Design only. Nothing built. Against the owner ruling: retire the box-unaware convention for NEW writes;
`unitLabel` is the denomination (no new column); one line-builder choke point; a build-failing meta-spec in
the `no-bare-cron` pattern; a strict sibling of `computeLineSubtotal` that throws; existing rows never rewritten.

## 1. The ambiguity (verified in `packages/pricing/src/pricing.ts:112`)

`computeLineSubtotal` with `unitsPerBox > 1` and NO boxes/pieces silently prices `qty x unitPrice` (per piece).
Given a stored row `{qty:72, unitsPerBox:12, boxes:null}` the helper cannot know whether `unitPrice` is per box
or per piece. The same call with a split is per box. That silent fallback is the B644 shape (12x over-charge).

## 2. Strict sibling: `computeLineSubtotalStrict` (same file, throws `AmbiguousLineError`)

Throws when: `unitsPerBox > 1` and boxes AND pieces both null; `unitLabel` set and boxes null; `pieces >= unitsPerBox`;
non-integer boxes/pieces/qty; `qty !== boxes*upb + pieces` (the axes disagree). Otherwise identical maths.
`computeLineSubtotal` stays lenient forever (display, PDF, duplicate, legacy rows).

## 3. Denomination = `unitLabel` (no column)

null = the pack axis: a boxed line ALWAYS carries the `{boxes, pieces}` split, price per box. Non-null = named unit,
`boxes = count`, `qty = count x factor`, `unitsPerBox = factor` (what steps 4-5 already store). "Qty only on a boxed
product" is not a valid NEW write; a piece sale is `boxes: 0, pieces: n`.

## 4. One choke point: `buildLine()`

One function (pricing package, pure) in: product snapshot + count + unit + unitPrice + discount. Out: the whole
persisted shape (qty, boxes, pieces, unitsPerBox, unitLabel, subtotal) via the STRICT helper. Consolidates what exists
today in three places: `orders/unit-line-build.ts` `buildUnitLine`, `invoices/invoice-unit-line.ts`, and
`buildInvoiceItemData`. Every server write of an OrderItem / InvoiceItem / EstimateItem calls it.

## 5. Meta-spec `no-bare-line-math.spec.ts` (mirrors `no-bare-cron.spec.ts`)

Walks `apps/api/src` non-spec files. Fails the build on: `computeLineSubtotal(` outside `buildLine`; a
`*.create/createMany/update` whose data carries `subtotal:` or `qty:` for a line model outside the builder; a
hand-rolled `qty * unitPrice`. Uses an `EXPECTED_SITES` allowlist (like `EXPECTED_NAMES`) that may only SHRINK.
Honest limit: the scanner reads tokens/AST, so top-level writers are invisible (B635) — extend it before relying on it.

## 6. Rollout (money writes, so dark first)

1. PR-1 strict sibling + pricing spec (pure, no callers). 2. PR-2 `buildLine` + move the three existing builders onto
   it. 3. PR-3 meta-spec, allowlist = today's remaining sites. 4. PR-4..n convert sites by domain (orders, invoices,
   estimates, returns, templates), shrinking the allowlist each PR. 5. Strict ships in WARN mode (log `would-throw` +
   counter) and flips to throwing in its own diff once prod shows zero would-throws. Existing rows never rewritten.

## 7. Scope facts (verified) and what I could not read

- `computeLineSubtotal(` is called at 72 places in 37 non-test files under `apps/` (api 10 files incl. one seed script, web 12, mobile 15;
  counted from a grep of the call pattern, not classified). Only the API writers are in scope; web/mobile compute display and stay lenient.
- I could NOT find Mac Lead's `helper-refuses-ambiguity-BRIEF.md` or Lane B's census on this machine. Predicate and
  site classification (which of the 72 pass `unitsPerBox > 1` with no split) should come from them, not from me.

## 8. Questions for the owner

a) Warn-first then throw (recommended) versus throw immediately? b) Is `pieces` on a boxed product priced pro-rata
of the BOX price the intended piece-sale rule (it is today), or does a piece sale need its own price? c) Should
`buildLine` live in `@routeflow/pricing` (web/mobile could use it for previews) or API-only?
