# Landing batch 2026-09-28 — evening (after #2711)

Docs-only bookkeeping (Option B) for the code PRs landed on master after `cc2380f7`, one bullet per
PR, each grepped in the merged tree.

## api — invoices and money

- **#2673 (closes #2656, B876) NSF follow-ups: one goods-only inferred rate, the NSF line never taxed, b294 REVIEW shape, `297a9887`:** `packages/pricing/src/nsf-line.ts` `inferredGoodsFlatRate` (excludes NSF lines and their money, rounds `subtotal − ΣNSF` to cents) beside `isNsfLine`; the API's `applyPriceAdjustment`, mobile `lib/invoice-edit-tax.ts` `hydratedLineTax` and the b294 backfill all call it (the API copy is deleted; `no-mirrors-nsf.spec` forbids redefining it). New `invoices/nsf-line-tax-guard.ts` `assertNsfLinesUntaxed` / `nsfSafeTaxRate`: invoice `create()`/`update()` and recurring `create()`/`update()` refuse a taxed NSF line with 400 `NSF_LINE_UNTAXED` before any write (on update the stored row decides); `duplicate()` copies it at 0. Web and mobile edit lock the NSF rate at 0. Specs `invoices.service.nsf-untaxed-2656.spec.ts`, `recurring-invoices.nsf-untaxed-2656.spec.ts`, `inferred-goods-flat-rate.spec.ts`, `inferred-goods-rate-parity-script.spec.ts`. SA-549.
