# Migration & Batch Import — Implementation Spec

> Moving from another platform (Zoho Books, QuickBooks, CSV, paper) with numbering continuity,
> zero duplicates, and batch AI invoice import with variant resolution. Designs:
> `unified/migration.html`, `unified/batch-import.html`, `unified/onboarding.html` (entry point),
> plus the existing import wizard. Mobile: `mobile-new-features.md` §H.

## 1. Numbering continuity

- `numbering_sequences` per tenant per doc type (invoice, estimate, credit_note, payment):
  `prefix`, `next_number`, `padding`. Set during migration from the source's last number
  ("last Zoho invoice INV-08841 → RouteFlow starts at INV-08842"); editable later in
  Settings → Invoicing.
- Collision guard: on issue, if the number exists (e.g. imported later), skip to the next free
  number and surface a notice on the document ("numbering advanced past an imported invoice").
- Applies everywhere a number is minted: builder, portal orders that invoice, batch import
  (imported bills keep their ORIGINAL numbers; sequences only govern new documents).

## 2. Duplicate prevention (idempotent migration)

- Every migrated record stores `external_source` + `external_id` (e.g. `zoho:inv_884412`).
  Re-running a migration UPSERTS by external id, never duplicates.
- Secondary invoice match: `(normalized number, total, issue date ±1 day)` catches the same
  document arriving via two paths (CSV + connector, or re-uploaded scan).
- Skipped duplicates are always listed with a link to the record they matched, never silent.

## 3. Migration flow (`migration.html`)

1. Pick source: Zoho Books / QuickBooks (OAuth, read-only) · CSV files · paper/PDF (routes to
   batch import).
2. Scope checklist with live counts: customers, products, open invoices, paid history (24 mo),
   balances + unapplied credits. Chart of accounts intentionally excluded.
3. Numbering setup (prefix / next number / padding) prefilled from source.
4. Fetch → **staging area** (nothing live): review counts, spot-check, resolve flags (dupes,
   unmatched tax rates, missing SKUs reuse the import wizard's dry-run patterns).
5. Confirm → live, with 24 h undo (same mechanism as import wizard).
- Open invoices post to AR with original numbers/dates/balances; paid history is queryable for
  reports and seeds price memory.

## 4. Batch invoice import (`batch-import.html`)

- **Upload many, review later**: drop N files (PDF/photos/CSV, mixed OK). Queue processes in
  background; user leaves; notification when done ("48 processed: 41 clean, 4 review, 3 dupes").
- Per-file pipeline: AI extract → supplier match → line match (SKU/barcode/name/alias) →
  duplicate check (§2) → status: `CLEAN` (auto-ready), `NEEDS_REVIEW` (any line unmatched or
  low-confidence totals), `DUPLICATE` (skipped, linked).
- **Review UI**: queue list with status filters; per-invoice side-by-side (scan preview with the
  active line highlighted vs extracted table). Fix only flagged lines; "Finish: post N bills"
  commits all clean+resolved at once. Posting receives stock and updates costs (per costing
  method); regulated categories post to their ledgers.
- **Metering**: counts against AI scans; estimated usage shown before starting; hitting the cap
  finishes the current file, pauses the queue, prompts a pack inline. Queue never loses files.

## 5. Variant resolution (new items inside scanned invoices)

Unmatched line → three explicit choices:
1. **New variant of an existing product** (default when name-similarity finds a family, e.g.
   "CLOUD CHIPS JALAPENO 12CT" → Cloud Chips 1.5oz family): inherits case config, price tiers,
   supplier, category, tax; user supplies variant name + SKU (auto-suggested). Product model:
   `products.parent_id` + `variant_label`; variants are full products that share family defaults.
2. **Brand new product**: minimal create (name, SKU, cost from the line); flagged
   `details_incomplete` and listed on Products under a "Finish setup" filter until price/units
   confirmed. It can sell immediately at list = cost + default margin, clearly labeled.
3. **Match to existing product**: alias mapping; the alias is remembered so the next scan
   auto-matches (`product_aliases`: supplier, raw text → product/variant).
- Non-product lines (deposits, fees) map to expense categories instead; also remembered.
- Generalized terms ("COKE 2L ASST") resolve to a picker of the family's variants with qty
  split UI if the delivery mixes variants.

## 6. Onboarding & UX standards (this round's additions)

- **First-run checklist** (`onboarding.html`): workspace → products → customers → first order →
  first route; progress persists; "Start migration" card routes to §3. Dismissible, revivable
  from Settings.
- **Undo standard** (`ux-standards.html`): reversible actions execute immediately + 8 s Undo
  toast (soft-delete window server-side); confirm dialogs only for irreversible acts.
- **Session expiry**: re-auth sheet in place, drafts untouched, "Switch account" secondary.
- **Language**: per-user `locale` (en/es first); customer-facing messages use the customer's
  own locale, independent of operator locale.
- **Help affordance**: "How X works" dashed links on costing, regulated, splits, credit limits,
  settlement, migration; each opens a 60-second plain-language card with a worked example.

## Acceptance
- [ ] Sequences continue from source; collisions skip forward with a visible notice; imported
      docs keep original numbers.
- [ ] Re-running any migration/import produces zero duplicates (external-id upsert + secondary
      match); skips are listed and linked.
- [ ] Batch: 50 mixed files process unattended; statuses correct; review fixes only flagged
      lines; finish posts all; stock/costs/regulated ledgers update.
- [ ] Variant create inherits family defaults and receives stock in the same action; aliases
      auto-match next time; incomplete products surface under "Finish setup".
- [ ] Undo toast restores exactly; session sheet preserves drafts; es locale renders driver app
      and buyer portal fully.
