# B861 — doc changes to apply on top of #2154 (docs/wholesaler-onboarding) once it lands

Owner of the playbook: "Routeflow onboarding process design" session (rebuilds the branded Word/PDF
copies — send it the final stage-7 wording). Apply only after the fix is verified; the live behaviour
changes only on deploy, so the wording says what to do once B861 is live.

## docs/runbooks/wholesaler-onboarding.md

**Stage 7 — Invoice numbering** (replaces the B861 "isn't possible yet" bullet):

> - [ ] **Invoice numbering:** ask which series they want. To carry on from the old system, open
>       **Settings → Import → Document numbering** after the delta load and save the **Invoices** row
>       with their prefix, the next number and the same zero-padding (last `INV-08841` → prefix `INV-`,
>       next `8842`, padding `5`). The card refuses a number that already exists and names the one in
>       the way. Check **Preview** shows the number they expect: the first invoice after that uses it.
>       Do the same for estimates and credit notes if they had them. If RouteFlow's yearly series
>       (`INV-2026-0001`…) suits them, leave the card unsaved. Imported invoices keep their original
>       numbers either way.

**Stage 6 — Invoice look** bullet: "Every new invoice, even a deleted draft, uses up a number
(`INV-<year>-0001`…)." → "…uses up the next number in their series."

**Questionnaire D1:** "The last invoice number you issued, and its format (for example `INV-08841`).
New RouteFlow invoices can carry on from it (`INV-08842` next) or start RouteFlow's yearly series
(`INV-2026-0001`); your existing invoices keep their numbers either way."

**Appendix D checklist, §7:** "- [ ] Told them: new invoices start at INV-<year>-0001" →
"- [ ] Numbering agreed: old sequence saved on the Document numbering card (Preview: …) or yearly
series".

**Known-gaps table:** delete the B861 row ("Numbering card doesn't continue the old sequence…").

## docs/product/tenancy.md

- **TEN-N5** → DONE: "A tenant switching systems continues its invoice, estimate and credit-note
  sequence. `NumberingService`; `GET/PUT /import/numbering`: a saved row IS that type's live series
  (continuous `prefix + pad(n)`, never below an existing number, numeric and `-R` aware; save refuses a
  taken number, stale saves 409) — SA-274 / B861. No saved row → `INV-<year>-####`. Payments are not on
  the card (`PaymentCounter`, `PAY-<tenant>-####`; filed separately)."
- **TEN-M9**: the invoice prefix now lives on the Document numbering card; the Invoicing tab's prefix
  input is still dead (B852).
- The `Document number series` row (~407): "configured but not honoured" → "a saved row drives live
  minting (B861)".
