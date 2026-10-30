# Red gate (repro-test, Sonnet 5 @ high) · 2026-09-26 ~04:20Z · worktree at 0671706c, no source edits
File: apps/web/app/(dashboard)/invoices/[id]/edit/legacy-header-tax.b2031.test.tsx
Cmd: cd apps/web && JEST_MAX_WORKERS=4 npx jest --maxWorkers=4 "legacy-header-tax.b2031"
- REG-2031 hydrate — FAIL: toHaveValue("0.0825") received "0.0000" (behavioral: the bug's own 0)
- REG-2031 save (no-op) — FAIL: item.taxRate toBe(0.0825) received 0 (behavioral)
- pin stored 0.05 unchanged — PASS
- pin untaxed invoice stays 0 — PASS
Owed by SA-368: regulated red case (100 / 13.25 / categoryTaxAmount 5 → 0.0825) and unverified notice/Save-disabled case — added in the build step, red before the fix.

## Build (Sonnet 5 @ high) + revert probe · ~04:45Z
Regulated + unverified REG cases added and red BEFORE source edits. Fix green: pricing 15 suites/440; mobile invoice 18/143; web edit 4 suites/19 (b2031 6/6); api b2031 spec 2/2 (plain 8.25, regulated 13.25, real matchEditLines/buildEditedLines/editInvoiceTotals, no DB needed).
Correction: the moved payload pin had been inlined (tautology) → restored in apps/mobile/__tests__/invoice-edit-tax.test.ts on the real invoiceLineDto (1/1).
Revert probe page.tsx → HEAD: 4 REG-2031 FAIL (received 0 / "0.0000" / notice missing), 2 pins pass; restore hash 64ea7131 == 64ea7131 (verified).
