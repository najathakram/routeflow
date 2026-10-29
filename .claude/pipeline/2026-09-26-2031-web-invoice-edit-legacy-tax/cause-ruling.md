# S3 — fix ruling = SA-368 (SA seat, 2026-09-26 ~04:15Z), confirms Routeflow Lead's design A
Cause: CONFIRMED (s2-refutation.md).
Fix design:
- Move apps/mobile/lib/invoice-edit-tax.ts hydratedLineTax VERBATIM into packages/pricing/src/invoice-edit-tax.ts, exported from index.ts. DELETE the mobile lib copy (no shim). Mobile edit.tsx imports from @routeflow/pricing. Move apps/mobile/__tests__/invoice-edit-tax.test.ts → packages/pricing/src/invoice-edit-tax.spec.ts.
- Web invoices/[id]/edit/page.tsx hydrates each line's taxRate via hydratedLineTax(invoice)[i].taxRate.
(1) EXCISE: add categoryTaxAmount to BOTH client InvoiceItem types (web apps/web/lib/api/invoices.ts; the mobile equivalent) and pass it to the helper.
(2) RE-PRICE ON SAVE accepted as mobile's behaviour, gated by an IDEMPOTENCE PIN: a no-op web save of a legacy invoice (plain AND regulated, live category config unchanged) persists taxAmount byte-equal to the stored header.
(3) UNVERIFIED: inferredFlatRate non-null && !verified → the web edit page shows a blocking notice ("sales tax could not be inferred — set each line's rate") and disables Save until no 0-rate line remains. Playwright 1440/768/390 for that state. Mobile's identical gap = its own new B-id, NOT this PR.
Red-first: plain (subtotal 100, tax 8.25, all 0 → 0.0825, saves 8.25) + regulated (subtotal 100, tax 13.25, one line categoryTaxAmount 5 → regular 8.25 → 0.0825 verified) + unverified (notice shown, Save disabled).
PR body: read-only prod count per tenant id (no slugs, R-030) of legacy invoices split verified/unverified — observed, never estimated. Needs owner/lead-approved railway run (warn-then-approve).
Data repair: none in this PR (report only). Sibling pattern: `taxRate: Number\(it\.taxRate \?\? 0\)` across apps/web + apps/mobile invoice/estimate/recurring edit hydration.
Tier 1: two PASSes on #938 at the merging sha + real green CI + Playwright.
Sibling sweep: 1 hit, RecurringInvoiceForm.tsx:222 → SA-370 UNRELATED (RecurringInvoice has no header tax/subtotal; RecurringInvoiceItem.taxRate NOT NULL default 0; no template built from an invoice). No B-id, no follow-up.

## SA-368a (amends (3); literal "until no 0-rate line remains" WITHDRAWN) · ~05:00Z
(i) block only when inferredFlatRate non-null && !verified; (ii) only HYDRATED 0-rate lines need a decision — lines added/typed this session are decided by construction; (iii) decision = "0% — exempt" confirmed OR a typed rate, client state only (no schema, not persisted, not sent); (iv) notice shows stored header tax vs tax the current lines compute; Save enables when every hydrated 0-rate line is decided, whatever the total; (v) pins: undecided ⇒ disabled; confirm-exempt all ⇒ enabled, save carries taxRate 0; typed rate ⇒ enabled + carried; verified invoice never shows the block; Playwright 1440/768/390 blocked + decided.
New B-id (MED, both clients, inherited SA-141/#1334): blended verified rate stamped on exempt lines; repro subtotal 200 = 100 @8% + 100 exempt, tax 8.00 → 0.04 verifies, delete exempt line → saves 4.00 not 8.00. NOT this PR.
