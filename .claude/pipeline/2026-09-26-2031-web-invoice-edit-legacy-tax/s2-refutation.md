# S2 — cause refutation (Opus 5.5 @ high, read-only) · verdict: CONFIRMED
Path: web edit page.tsx:454 hydrates taxRate 0 (effect :425-466 never reads invoice.taxAmount/subtotal) → taxTotal :476 = 0 → save :554 sends taxRate 0 → useUpdateInvoice (apps/web/lib/api/invoices.ts:361-368) PATCH /invoices/:id → InvoicesService.update() invoices.service.ts:3308 → buildEditedLines/matchEditLines :3342-3350; 0 matches stored 0 (invoice-edit-plan.ts:84) → row kept, taxRate 0 (:246-254) → editInvoiceTotals invoice-edit-plan.ts:405-417, regularTax = Σ subtotal×taxRate (:414) → header taxAmount: taxTotal invoices.service.ts:3406 = 0. inferredFlatRate is NOT on this path (only applyPriceAdjustment ~:6109).
Impact: any save, even a no-op save, destroys the header sales tax. Not display-only.
Client: no invoice-level tax field, default rate or taxAmount read; only the per-line input :826-834.
Design A caveats:
1. Excise: web InvoiceItem type (apps/web/lib/api/invoices.ts:58-96) lacks categoryTaxAmount although the API returns it; the helper must receive it, or excise is counted as regular tax (unverified → 0, or an inflated rate). Web taxTotal :476 ignores excise (existing display gap).
2. Once the inferred rate is filled, the line no longer matches stored 0 (:84) → it is re-priced (:306-347) and categoryTaxAmount is recomputed from the LIVE category config.
3. Partial-rated invoices: null inference by SA-141 design; 0-rate lines stay 0.
4. Unverified rate → fill 0 → tax still silently dropped on save, no warning.
5. The web has no taxable flag; only .taxRate is needed.
6. Basis: the server applies rate × Σ line.subtotal; the inference basis is header subtotal.
