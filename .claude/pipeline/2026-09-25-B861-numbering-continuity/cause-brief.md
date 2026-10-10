# B861 — cause brief (S1, evidence only)

Base: `origin/master` 21085bcb. Branch `bug/2158-b861-numbering-card-never-reaches-live-invoice-num (board #2158)`. Registry record lives on the
unmerged local branch `docs/wholesaler-onboarding` (f97966f6 / daba1adb, worktree `rf-docs-onboarding`,
no PR, not on origin) — B852–B862 filed there on 2026-09-25.

## Registry row (verbatim)

B861 · medium · F29 · sensitiveFor money · "Numbering card promises 'continue where your old system left
off', but live invoices, estimates and credit notes ignore it and mint INV-<year>-#### from defaults".
Evidence: "reserveNext for INVOICE/ESTIMATE/CREDIT_NOTE uses a per-tenant-year series that lazy-seeds
from built-in DEFAULTS … the year-0 row the Numbering card writes … is never read on that path, and
seedFromSource has no callers. A migrating wholesaler who sets 'next invoice 10543' still gets
INV-2026-0001, and the card's preview shows a number live minting will never produce. Either the card
drives the per-year series or its copy stops promising continuity."

## Repro (input → wrong value)

Tenant with no invoices this year. `PUT /import/numbering/INVOICE {prefix:"INV-", nextNumber:10543,
padding:5}` → 200, toast "Next invoices will be INV-10543". Then any live mint (`POST /invoices`,
estimate convert, delivery auto-invoice, CSV fallback row) → **`INV-2026-0001`**. Expected per the
card: `INV-10543`. Same shape for ESTIMATE (`EST-2026-0001`) and CREDIT_NOTE (`CN-2026-0001`).

## Suspected cause (a CLAIM)

`NumberingService.reserveNext` (`apps/api/src/import/numbering.service.ts:244-283`): every live caller
passes `opts.year = new Date().getFullYear()` (> 0), and for `isYearScoped` types (`:39-42`, INVOICE/
ESTIMATE/CREDIT_NOTE) it goes to `mintForYear` (`:293-376`), keyed `(tenantId, docType, <year>)`. That
row, when absent, is seeded from `DEFAULTS` (`:16-26`) + `scanMaxForYear` over `^<DEFAULT PREFIX><year>-
(\d{1,9})(?:-R\d+)?$` (`:410-442`). The card's row is `(tenantId, docType, 0)` (`updateSettings`
`:124-153`); nothing on the live path reads year 0.

## Code excerpts

- `getSettings` (`:102-121`) reads `where: { year: 0 }`; unconfigured → `nextNumber 1`, preview
  `format(prefix, 1, padding)` = `INV-0001` — never the live number.
- `updateSettings` upserts `tenantId_docType_year {…, year: 0}` with an ABSOLUTE `nextNumber`.
- `seedFromSource` (`:161-174`) — zero callers in `apps/api/src`/`scripts`.
- `peekNext` (`:177-180`) — zero callers.
- `format(prefix, n, padding, year)` (`:78-82`): `year>0` → `${prefix}${year}-${padded}`.
- `mintForYear` reads `current.prefix/padding` from the per-year row (always the DEFAULT, no writer
  customises it); collision guard = exact-string `findTaken` (`:379-393`) + jump via
  `GREATEST("nextNumber", max+1)` (`:364-370`), ≤ 5 attempts, else 409.
- `scanMaxForYear` interpolates `prefix` into a regex UNESCAPED (safe today: always a default).

## Live callers of reserveNext (all pass year > 0)

`invoices.service.ts:2872-2873` generateInvoiceNumber (create/split/partial/delivery/duplicate) ·
`estimates.service.ts:97-101` nextEstNumber · `estimates.service.ts:442-443` convertToInvoice ·
`credit-notes.service.ts:437-441` · `returns/inline-returns.service.ts:385-390` (CREDIT_NOTE, `tx`) ·
`import/import.service.ts:949` (CSV fallback INVOICE) · `returns.service.ts:102` + `inline-returns
.service.ts:252` (RETURN — not year-scoped → fast path, per-year row, no guard; not on the card).

## Sibling on the same card (not in the filed row)

The card lists FOUR rows (`DOCUMENT_NUMBER_TYPES` `:8-13`): PAYMENT too. Payments never touch
`NumberingService`: `invoices.service.ts:5272-5310` `nextPaymentNumber[InTx]` use `PaymentCounter`,
format `PAY-<tenantShort>-####`. The card's PAYMENT row is equally dead.

## Web

`apps/web/app/(dashboard)/settings/import/page.tsx:338-545` NumberingCard; copy `:495-499` "Continue
where your old system left off … if a number already exists we skip to the next free one and note it on
the document" (nothing notes it on the document — the skip is a server log line, `:348-350`).
`apps/web/lib/api/numbering.ts` `formatDocumentNumber` mirrors `format()` with no year. No web test
covers the card. Mobile has no numbering surface.

## History

- `dba30e06` 2026-07-08 #135 — service + card created (phase 1); never wired to a live minter.
- `85b7d53c` 2026-09-08 #671 B100/F16b — live INVOICE/ESTIMATE wired to the per-YEAR series; ruling
  D1 kept "the year-0 series … exact behaviour"; invariant "INV-<year>-NNNN — exactly today's format".
- `1dca1242` 2026-09-09 #678 B267 — CREDIT_NOTE joins the per-year series.
- So this is not a regression: the card has never reached a live number.

## Tests today

`numbering.service.spec.ts` — getSettings defaults + "ignores the per-year INVOICE rows (B100)";
updateSettings upsert/preview; seedFromSource; reserveNext P1/P2/P3/D7/jump/cap (P2 pins year-0 fast
path = no year segment). `invoice-numbering.db.spec.ts` T1i **REG-B100-D2b** pins the unconfigured
card at `configured:false / nextNumber:1 / preview 'INV-0001'` after a per-year mint at 414 (i.e. it
pins today's non-live preview). DB lanes: `credit-note-numbering.db.spec.ts`,
`import-numbering[-pins].db.spec.ts`.

## Other facts for the ruling

- `@@unique([tenantId, invoiceNumber])` (`finance.prisma:241`); `-R{i}` siblings `${base}-R${i}`
  (`invoices.service.ts:1241`). No code outside numbering parses the `INV-<year>-` shape (grep) —
  imported numbers are already arbitrary text.
- Gaps accepted (SA-261: US wholesale, no gapless requirement).
- B852 (Settings → Invoicing prefix input is dead) points at this card as the prefix's real home.
- Docs: `docs/product/tenancy.md` TEN-N5/TEN-M9 on master are stale; the docs branch rewrites them.
  Playbook `docs/runbooks/wholesaler-onboarding.md` (docs branch only) stage 7 + questionnaire D1 +
  checklist + known-defects table tell clients "new invoices start at INV-<year>-0001 (B861)".

## Lessons that apply

L-096 (archived: reuse the existing primitive, no second store) · L-100 (archived: mint through
`reserveNext` with explicit tenantId, standalone before any rollback-able tx, P2002→409; green pins
never carry `REG-`) · L-167 (one shared builder for a filter used by several paths) · L-200 (grep
every client entry point before removing a control) · L-202 (zero-target verification must error).

## Production evidence

None gathered (no prod access from this lane). Unknown: how many tenants already saved a year-0
INVOICE/ESTIMATE/CREDIT_NOTE row — matters if the fix makes a saved row live.
