# Cause ruling — numbering siblings, Group A (B267 · B268 · B269 · B277-pin)

Fable 5.1, 2026-09-08, over `cause-brief.md` (S1) and `cause-refutation.md` (S2). Branch
`fix/numbering-siblings` off master eb2b815e (rf-registry). Same primitive as F16b (`NumberingService`,
master 85b7d53c); F16b's boundary rule (`fix-round-2b.md`) and money facts bind. **Group B** (B270 bills,
B271 purchase orders, B272 statements) needs `ALTER TYPE "DocumentNumberType" ADD VALUE` ×3 + the owner's
prod-migrate ack → its own run after this one (§9).

## 1. Cause verdicts (accept S2)

- **B267 credit notes — confirmed (HIGH).** `credit-notes.service.ts` `nextCnNumber` = TEXT max+1; `forTenant()`
  returns the UNSCOPED client on a null tenant (`prisma.service.ts:298`) exactly like `tenantTransaction:60`,
  so the scan is cross-tenant whenever no request tenant exists (reachable by a SUPER_ADMIN token); 9999
  wall; no P2002 catch. It mints inside a SERIALIZABLE tx (`:269`) — a blocked counter UPDATE would ABORT
  (40001), so F16b's in-tx `{tx}` shape is wrong here.
- **B268 import fallback — refuted as filed, confirmed worse.** No P2002: `import.service.ts:744-757` finds the
  colliding invoice and UPDATES the tenant's LIVE invoice (status/dueDate/paidAt), counts `updated++`, drops
  the imported row silently. Rows WITH a source `Invoice Number` keep their originals by rule
  (`numbering.service.ts:59-60`); only source-numberless rows must reserve through the service.
- **B269 payments — confirmed, severity raised to HIGH.** `paymentNumber` is `String? @unique` GLOBALLY; site 3
  (`invoices.service.ts` ~`:5282`, the Stripe settlement path via `payment-requests.service.ts:853`) mints
  `PAY-####` from the `"singleton"` counter with no tenant segment → two tenants' first settlements collide;
  the counter upsert sits inside the rolled-back tx, so a redelivered webhook re-mints the SAME number →
  permanent SETTLING stall on a charged card.
- **B277 — refuted as a repro** (`estimates.service.ts:139` is the only writer; the mint is monotonic and
  guarded). Kept as a zero-risk consistency PIN (P2002 → 409), no REG token.

## 2. Fix design

Invariant: every document number in this group is tenant-scoped, minted from a per-tenant sequence, in a
format byte-identical to what the series emits today (credit notes `CN-<year>-####`; payments
`PAY-<tenantShort>-####` as sites 1/2 already emit; imported invoices `INV-<year>-####`), never from a null
tenant, and a rolled-back write never re-issues a number.

**D1 — widen the year-scoped path (Opus `high`).** `numbering.service.ts`: `YearScopedDocType` +=
`CREDIT_NOTE`; `mintForYear`/`scanMaxForYear`/`findTaken` gain the LITERAL `CreditNote.creditNoteNumber`
branch (table, column, regex `^CN-<year>-(\d+)$` — take the exact names/format from `cause-refutation.md`
§1.3; no `Prisma.raw`, no data-driven map — finding (2) of `fix-round-2b.md` stands). `DEFAULTS.CREDIT_NOTE`
stays the current prefix/padding. Nothing else in the service changes.

**D2 — credit notes (Opus `high`).** `credit-notes.service.ts`: delete `nextCnNumber`'s scan; validate first
(everything that can throw before the mint), then `this.numbering.reserveNext("CREDIT_NOTE", { year,
tenantId })` STANDALONE (hoisted above the SERIALIZABLE tx — a race loser burns a number; a validation
failure burns none because validation precedes the reservation), then the existing tx; P2002 → 409 catch
with the invoices wording. `tenantId` explicit from the caller's context; null → the service throws.

**D3 — payments (Opus `high`, money).** One helper `nextPaymentNumber(tenantId: string)` in
`invoices.service.ts` used by all three PAY sites: requires a non-empty `tenantId` (site 3 passes the
payment request's own `tenantId`; sites 1/2 pass the request tenant; null → `BadRequestException`, never
`"singleton"`), upserts the tenant's `PaymentCounter` row in a SHORT STANDALONE transaction (committed
before the payment tx opens), and formats `PAY-<tenantShort>-####` exactly as sites 1/2 do today. Site 3's
legacy `PAY-####` rows stay (global unique, distinct format → no collision). Effect: no cross-tenant
collision; a rolled-back settlement burns a number instead of repeating it. Do NOT route PAYMENT through
`reserveNext` (it would move sites 1/2 onto a different format).

**D4 — import fallback (Sonnet `high`).** `import.service.ts:541/631`: for rows with no source number,
replace `INV-${year}-${seq++}` with `this.numbering.reserveNext("INVOICE", { year, tenantId })` (standalone,
per row; the importer runs outside a tx — confirm; if inside one, use `{ tx }`); rows with a source number
unchanged. The "update the colliding live invoice" branch (`:744-757`) may only run for rows WITH a source
number (that is the upsert-by-number feature); for fallback rows a P2002 is a real error → count it as an
error, never update a live invoice. `ImportModule` already provides the service.

**D5 — estimates pin (Sonnet `low`).** `estimates.service.ts create()`: P2002 → `ConflictException` with the
same wording as `convertToInvoice`. No REG token.

**D6 — module wiring + test harness (Sonnet `medium`).** `CreditNotesModule` (and any module of a touched
service) imports `NumberingModule`; the 23 `Test.createTestingModule` provider sites listed in
`cause-refutation.md` §8 get the `NumberingService` mock provider (mechanical; report the list).

What must NOT change: `PaymentCounter`'s schema and the `"singleton"` row; the visible formats; the credit
note tx isolation; `estimateNumber` minting; `numbering.service.ts` behaviour for INVOICE/ESTIMATE (F16b
pins stay green); the import writers' original-number rule.

## 3. Regression tests (REG-B267 / REG-B268 / REG-B269) — bug-test-plan.md

DB lane (compose Postgres): CN cross-tenant on a null tenant → tenant-scoped series; CN wall past 9999;
CN validate-before-reserve burns nothing on a rejected create; PAY two tenants' first settlements distinct;
PAY rollback does not repeat a number; import fallback rows get reserved numbers and never touch a live
invoice. Unit: helper pins (tenant required, format), P2002 → 409 pins.

## 4. Blast radius (radiusFiles)

`apps/api/src/import/numbering.service.ts`, `apps/api/src/credit-notes/credit-notes.service.ts` (+ module),
`apps/api/src/invoices/invoices.service.ts` (PAY sites + helper), `apps/api/src/payment-requests/payment-requests.service.ts:853`
(read: the settlement path), `apps/api/src/import/import.service.ts`, `apps/api/src/estimates/estimates.service.ts`,
`apps/api/prisma/schema/finance.prisma` (read: `PaymentCounter`, `CreditNote`), the specs.

## 5. Sibling pattern — Group B rows stay filed (B270/B271/B272 → their own run); `orderBy:\s*\{\s*\w*[Nn]umber:\s*"desc"` hits outside this group are already rows.

## 6. Data repair

None automatic. Report-only question for the owner: any live `PAY-####` rows minted by site 3 for a tenant
whose sites-1/2 numbers exist — cosmetic; leave. A stalled SETTLING payment request (B269) may exist in
prod — the fix lets the next webhook redelivery succeed; a read-only report script is the follow-up's call.

## 7. Probe plan

`revertFix: true`: `numbering.service.ts` → REG-B267 seed/wall red; `credit-notes.service.ts` → REG-B267
cross-tenant red; `invoices.service.ts` → REG-B269 red; `import.service.ts` → REG-B268 red.

## 8. Sequencing

Engine after the B263 run (one engine on the host); DB lane needs the compose Postgres (up). No migration,
no prod-migrate for Group A. Landing: api rebuild → PDC (invoice math + reconcile) → deployment E2E.

## 9. Group B (deferred — owner ack needed)

B270 vendor bills, B271 purchase orders, B272 commission statements: `DocumentNumberType` += `VENDOR_BILL`,
`PURCHASE_ORDER`, `COMMISSION_STATEMENT` (one additive migration, dir name sorted after `20260910000000`;
`packages/types/api/enums.ts` parity; `DEFAULTS` entries; `prisma generate`; Squawk clean), then the same
D1/D2 shape per series. Prod flow: fresh backup → `railway run --service postgres node
apps/api/scripts/prod-migrate.mjs` BEFORE the code window → drift gate exit 0. Their everyday defect is the
mint/create race (500, no P2002 catch) — the interim mitigation, if the owner wants it before the migration,
is the P2002 → 409 catch alone.
