# Cause brief — #2031 (B294 web half) · base origin/master 0671706c · branch fix/2031-vendor-bill-legacy-tax-rate

## Issue
#2031 (retitled): web invoice edit loads legacy header-tax lines at 0% and saves without sales tax. Source: Opus #938 review of #1334 (B294, SA-141/141a): "web edit page.tsx:429 loads legacy lines at 0 rate". Tier 1 (invoice money). Lead ruling: design A (hydratedLineTax into @routeflow/pricing; mobile + web import it).

## Repro (claimed, not yet executed)
Legacy order-derived invoice: subtotal 100.00, taxAmount 8.25, every InvoiceItem.taxRate = 0 (pre-#725 rows; B294 backfill `apps/api/scripts/backfill-b294-order-line-taxrate.mjs` may or may not have run in prod — owner's question).
Open /invoices/<id>/edit on web → each line hydrates taxRate 0 → on-screen taxTotal 0 → Save sends items[].taxRate 0 → server recomputes tax = Σ line.subtotal × line.taxRate = 0. Expected: rate 0.0825 per line, taxTotal 8.25, saved taxAmount 8.25.

## Suspected cause (CLAIM)
apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx:454 `taxRate: Number(it.taxRate ?? 0)` (blame d19d6cd3b7, 2026-07-06). taxTotal :476 = Σ lineTotal(it) × it.taxRate. Save :554 sends `taxRate: Number(it.taxRate)`.

## Prior fix (mobile only, #1334 merge 30e1c995)
apps/mobile/lib/invoice-edit-tax.ts `hydratedLineTax(invoice)` → per line {taxRate, taxable}: stored>0 wins else verified inferredFlatRate({subtotal,taxAmount,lines}).rate else 0. Used at apps/mobile/app/(operator)/(tabs)/invoices/[id]/edit.tsx:128. Tests: apps/mobile/__tests__/invoice-edit-tax.test.ts (4 cases).
packages/pricing/src/inferred-flat-rate.ts `inferredFlatRate` (null unless ALL lines taxRate 0, regularTax = taxAmount − Σ categoryTaxAmount > 0, subtotal > 0; verified iff roundMoney(subtotal×rate)===regularTax). Spec: inferred-flat-rate.spec.ts.
Server: apps/api/src/invoices/invoices.service.ts:6109 applyPriceAdjustment uses inferredFlatRate. UNKNOWN: whether update() (the web save path) also re-infers — if it does, the web bug may not drop tax on save.

## Existing web tests
apps/web/app/(dashboard)/invoices/[id]/edit/{page.test.tsx, line-id-locked.pins.test.ts, pack-hydration.pins.test.ts}.

## Lessons
L-072 never hand-declare a client mirror (shared package + pin). L-205 assert behavior, not source text. L-176 worktree needs own npm ci / rebuild pricing dist after packages change.
