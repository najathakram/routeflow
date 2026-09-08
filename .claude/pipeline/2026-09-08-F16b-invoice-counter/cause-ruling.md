# Cause ruling — B100 (F16b invoice-number counter)

Fable 5.1, 2026-09-08, over `cause-brief.md` (S1) and `cause-refutation.md` (S2). Supersedes the F16
`cause-ruling.md` §9 design of record (InvoiceCounter table): that premise is REFUTED — the per-tenant,
per-year sequence already exists as `NumberingSequence` (`platform.prisma:455-471`, `year` added for B100 by
name) with `NumberingService.reserveNext` (`import/numbering.service.ts:172-234`) exported "so the invoices
wiring can consume it without duplicating it" (`import.module.ts:58-62`).

## 1. Cause verdict — ACCEPT S2 (confirmed)

Two independent defects in one generator (`invoices.service.ts:2773-2783`, unchanged since 2026-03-31):

- cross-tenant candidate: `:2774` `db ?? this.prisma` + `:2778` `where` without `tenantId`;
- lexicographic wall: `:2779` `orderBy { invoiceNumber: "desc" }` on TEXT (`padStart(4)` is NOT the defect).
  Plus: the mint at `:495` runs before the tx opens at `:502`; `duplicate()` (`:4345-4432`) and
  `estimates convertToInvoice` have no P2002 catch (500, not 409); the 409 is transient below 9999 and
  permanent above it. No second question to S2.

## 2. Fix design — wire into the EXISTING primitive; no new model, no DDL

Invariant: for every tenant and calendar year, invoice numbers are `INV-<year>-NNNN` (zero-padded to 4,
wider only past 9999 — exactly today's format), strictly increasing per tenant-year, minted inside the same
transaction that inserts the invoice, from a per-tenant-year sequence that no other tenant can influence, and
never for a null tenant.

D1 — `apps/api/src/import/numbering.service.ts` (Opus, HIGH): `reserveNext(docType, opts?)` grows
`opts: { year?: number; tx?: Prisma.TransactionClient; tenantId?: string }`.

- Key = `{ tenantId, docType, year: opts.year ?? 0 }` at all four query sites (`:182, :190, :200, :230`); the
  year-0 series and every existing caller keep their exact behaviour.
- Format: when `year > 0`, emit `${prefix}${year}-${padded}` (`INV-2026-0038`); `DEFAULTS.INVOICE` stays
  `{ prefix: "INV-", padding: 4 }`. No stored per-year prefix, nothing to roll in January.
- Tenant: `opts.tenantId` is used when the request context has none (the fire-and-forget delivery path,
  `createInvoiceFromOrderWithTenant:2506`); `requireTenant()` still THROWS on null — never a sentinel
  (`PaymentCounter`'s `?? "singleton"` is the anti-pattern, `docs/IMPROVEMENTS.md:508-510`).
- Lazy seed (replaces the design of record's backfill migration): when no row exists for
  `(tenantId, INVOICE, year)`, compute inside the caller's tx with ONE raw statement
  `SELECT COALESCE(MAX((regexp_match("invoiceNumber", '^INV-<year>-(\d+)(?:-R\d+)?$'))[1]::int), 0)` scoped by
  `"tenantId" = $tenant` (parameterised; `-R{i}` siblings share the base, so MAX(base) is right; non-matching
  imported numbers are ignored by the regex and handled by the guard) → `create { nextNumber: max + 1 }`; on
  P2002 (a concurrent first mint) fall through to the atomic increment. Runs once per tenant-year.
- Fast path unchanged (atomic single-statement increment). Collision-guard path: take the sequence row with
  `SELECT … FOR UPDATE` (raw, inside the tx) before the read-modify-write; keep the existence check against
  `Invoice` for the tenant (imported numbers share the namespace — S2 §3) and the 10,000 cap.
- Uses `tx` when given, else `forTenant()` as today.

D2 — `apps/api/src/invoices/invoices.service.ts` (Opus, HIGH): `generateInvoiceNumber(db?)` keeps its
name and signature (existing spies keep working) but its body becomes ONE call:
`this.numbering.reserveNext("INVOICE", { year, tx: db, tenantId: <explicit when the caller has one> })`,
where `year` is derived exactly as today (same `Date` call). Move the mint at `:495` inside the
`tenantTransaction` opened at `:502` (pass `tx`); `createSplitInvoices` (`:1222`), `createPartialFromOrder`
(`:2701`), `duplicate()` (`:4406`) pass their tx/db the same way. Keep `nextInvoiceNumber()`. Add the P2002 →
409 catch to `duplicate()` (same message as `:557-559`). Do not touch the `-R{i}` suffix at `:1234`, the six
read paths (S2 §5), or any list sort.

D3 — `apps/api/src/estimates/estimates.service.ts:245-252` (Opus, HIGH): delete the inline copy; call
`this.numbering.reserveNext("INVOICE", { year, tx })` inside the existing `tenantTransaction` (`:219`); add
the P2002 → 409 catch in `convertToInvoice`. All five sites move together (L-081) — no exceptions.

D4 — modules (Sonnet, medium): `InvoicesModule` and `EstimatesModule` import the module that exports
`NumberingService`. If `ImportModule` (transitively) imports `InvoicesModule`, do NOT `forwardRef`: extract
`apps/api/src/import/numbering.module.ts` (provides + exports the unchanged service), have `ImportModule`,
`InvoicesModule`, `EstimatesModule` import it. Still one service, one store.

What must NOT change: number format (`INV-<year>-####`, wider past 9999), `-R{i}`, the `@@unique` on
`Invoice`, `NumberingSequence`'s schema (no migration), the year-0 series, `PaymentCounter`, every read path
in S2 §5, the import writers (`import.service.ts:631`, `import-zoho.js:397` keep original numbers by rule).

## 3. Regression tests (REG-B100) — behavioural red bar

DB lane (`*.db.spec.ts`, `npm run local:test:db`, compose Postgres; L-061 — the tenancy and concurrency
claims are only provable there), each with its wrong value TODAY:

- REG-B100-A cross-tenant: tenant B holds `INV-2026-0037`, tenant A mints → expect `INV-2026-0001`
  (today `INV-2026-0038`).
- REG-B100-B wall: tenant A holds `…-9999` and `…-10000`, mints → expect `INV-2026-10001` (today: 409/P2002,
  candidate `…-10000` again).
- REG-B100-C concurrency: 10 parallel `create()` in one tenant → 10 distinct consecutive numbers, zero 409
  (today ≥ 1 P2002).
- REG-B100-D seed: tenant with `INV-2026-0412` and `INV-2026-0412-R1` and an imported `INV-08841`, no sequence
  row → first mint is `INV-2026-0413` (today: unscoped max+1 of whatever the platform holds).
  Unit (`invoices.service.spec.ts` / `numbering.service.spec.ts`):
- REG-B100-E `duplicate()` P2002 → 409 (today: 500). REG-B100-F `convertToInvoice` P2002 → 409 (today 500).
  Pins (no REG token): format + padding unchanged incl. `INV-2026-10001` past the wall; `-R{i}` untouched;
  year-0 `reserveNext` callers unchanged; null tenant throws `BadRequestException`; `generateInvoiceNumber`
  delegates (a spy on it still short-circuits the five sites).

## 4. Blast radius (radiusFiles)

`apps/api/src/import/numbering.service.ts`, `apps/api/src/import/import.module.ts`,
`apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.module.ts`,
`apps/api/src/estimates/estimates.service.ts`, `apps/api/src/estimates/estimates.module.ts`,
(`apps/api/src/import/numbering.module.ts` if extracted), `apps/api/src/payment-requests/payment-requests.service.ts:106`
(read-only: allocation order must be unaffected), the specs above.

## 5. Sibling pattern (grep, file rows — do not fix here)

`orderBy:\s*\{\s*\w*[Nn]umber:\s*"desc"\s*\}` and `parseInt\([^)]*split\("-"\)` — expected hits:
`estimates:15` (`nextEstNumber`), `credit-notes:34`, `vendor-bills:172`, `commission-statements:68`,
`inventory.service.ts:1025` (PO), `scripts/backfill-invoices.js:17` (third verbatim copy + hardcoded localhost
DSN), and `invoices.service.ts:5282` (`PAY-####` without the tenant segment). Each = one registry row.

## 6. Data repair — NONE

No duplicate rows exist (the tenant-scoped unique held); leaked numbers are merely high or gapped. The lazy
seed continues each tenant-year from its true numeric max. NULL-tenant invoices: none live (prod census
2026-09-05); the code path refuses them. The prod migration the F16 design required is NOT needed: no DDL,
no `prod-migrate.mjs`, no backup step — the owner's "migration ack" is discharged as moot (report it).

## 7. Probe plan

`revertFix: true` on `numbering.service.ts` → REG-B100-B and REG-B100-D must go red; on
`invoices.service.ts` (`generateInvoiceNumber` body) → REG-B100-A red; on `estimates.service.ts` → a
convert-path variant of REG-B100-A red. Harness note for the test author: every existing
`invoices.service.spec.ts` mock of `prisma.invoice.findFirst` for numbering becomes dead; the module now needs
a `NumberingService` provider (mock it at the module boundary in unit specs, real in the DB lane).

## 8. Sequencing

Owner order: B246-C engine first, then this run (engine in bugfix mode, packages P1 numbering (Opus high),
P2 invoices + estimates wiring (Opus high), P3 tests (Sonnet high), P4 modules (Sonnet medium); red gate = the
four DB-lane REG specs + two unit REGs). Compose Postgres must be up for the DB lane.
