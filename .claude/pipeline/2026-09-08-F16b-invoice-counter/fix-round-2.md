# Light loop — round 2 (Fable ruling over the engine's final pass) — F16b / B100

Fable 5.1, 2026-09-08. Engine `wf_16afcfe2-549` ended with one fix round (20 fixes, 1 deferral), all three
revert probes caught, harness checks valid, final gate green — and a final pass (Opus read, Fable verdicts)
that named three real design-level findings the round could not address. Tree = rf-registry
`fix/F16b-invoice-number-counter`, uncommitted. Binding facts: `cause-refutation.md` §7; design of record
`cause-ruling.md` §2 as AMENDED here.

## Rulings

| Final-pass finding                                                                                                                                                                                               | Ruling                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counter row lock held until COMMIT → lock-order inversion with the driver stop-completion tx (40P01, no retry) and full-body serialization under the 5 s interactive-tx budget (#57.0 major, #57.2 major, #55.0) | **FIX — D1**: the reservation runs in its OWN short transaction, immediately before the insert; the caller's tx never holds the counter lock. A rollback after reservation leaves a gap (accepted, documented). REG-B100-G ("no rollback burns a number") is retired; a non-blocking pin replaces it. |
| `nextEstNumber` (estimates.service.ts:22) is the condemned generator in a file this change edits, in a class that now injects NumberingService (#55.1 major)                                                     | **FIX — D2**: route estimates through `reserveNext("ESTIMATE", …)`; same shape, no schema change.                                                                                                                                                                                                     |
| payment-requests allocation tiebreak is a TEXT sort now that 5-digit numbers are reachable (#55.3/#57.3 minor, money-adjacent)                                                                                   | **FIX — D3**: `createdAt asc` before `invoiceNumber asc`; policy comment + P6 pin updated.                                                                                                                                                                                                            |
| db-migrations.yml path-gates the only proof of the invariants (#57.1)                                                                                                                                            | **FIX — D4**: add the three service paths to the workflow's `paths`.                                                                                                                                                                                                                                  |
| commission-statements.service.ts:67 dangling comment (#57.4)                                                                                                                                                     | **FIX — D5** (one line).                                                                                                                                                                                                                                                                              |
| `nextCnNumber` cross-tenant when `tx` is the raw client (#55.2)                                                                                                                                                  | **FILE** (HIGH, tenancy) in the docs follow-up; outside radius.                                                                                                                                                                                                                                       |
| `-R{i}` siblings not collision-checked (#55.4); `scanMaxForYear` per-row regex on first mint/collision (#55.5); user-facing list sort textual past 9999 (S2 §5.5)                                                | **FILE** (LOW ×3).                                                                                                                                                                                                                                                                                    |
| vendor-bills / PO / statement generators (S2 §14)                                                                                                                                                                | **FILE** (LOW, one row each).                                                                                                                                                                                                                                                                         |

## Designs

**D1 — reservation in a short standalone transaction (E1, Opus `high`).** `NumberingService.reserveNext`
no longer takes `tx` for the reservation itself: it opens `this.prisma.$transaction` (tenant-scoped via the
existing `forTenant()`/`opts.tenantId` resolution) around exactly: lazy seed (`scanMaxForYear` + create, P2002
→ fall through), the atomic increment, and the collision-guard jump with its `FOR UPDATE` — then COMMITS and
returns the number. Existence checks against `Invoice` read committed rows (imported numbers); in-flight
mints cannot collide because the increment is atomic. Callers (`create()`, `createSplitInvoices`,
`createPartialFromOrder`, `duplicate()`, `createInvoiceFromOrderWithTenant`, `convertToInvoice`) call it
right before their invoice insert, inside their own flow; their transactions stay as they are otherwise.
Docblock states: "a rollback after reservation leaves a gap; never hold this lock across caller work
(deadlock with OrderItem locks on the driver path, 2026-09-08 final pass)". Keep every REG-B100 A–F
expectation; REG-B100-G is deleted (E3 owns the spec file); the year-0 series and every other caller are
unchanged. Invariant: no caller transaction ever holds a `NumberingSequence` row lock.

**D2 — estimates on the same primitive (E1).** `nextEstNumber` → `this.numbering.reserveNext("ESTIMATE",
{ year, tenantId })` with the estimate's current visible format preserved exactly (read the current generator:
prefix, year segment or not, padding — if the format has no year segment, use year 0 with the existing prefix;
if it has one, pass the year). Confirm `DocumentNumberType.ESTIMATE` exists (`platform.prisma:473-482`); if it
does not, STOP and report (schema change = out of scope). Delete the inline scan; P2002 → 409 catch stays.

**D3 — allocation tiebreak (E2, Sonnet `medium`).** `payment-requests.service.ts:106` `orderBy` →
`[{ issueDate: "asc" }, { createdAt: "asc" }, { invoiceNumber: "asc" }]`; the ALLOCATION POLICY comment at
`:56-60` gains "then createdAt (numbers are minted in creation order; the text tiebreak only decides split
siblings)". Update the P6 pin in `payment-requests.service.spec.ts` to the new three-key array.

**D4 — CI trigger (E2).** `.github/workflows/db-migrations.yml` `paths` (both push/pull_request lists if
present) += `apps/api/src/import/numbering.service.ts`, `apps/api/src/invoices/invoices.service.ts`,
`apps/api/src/estimates/estimates.service.ts`.

**D5 — comment (E2).** `commission-statements.service.ts:67`: replace the "copies generateInvoiceNumber's
max+1 scan" sentence with "same max+1 scan class as B100 (fixed for invoices in #F16b); statement numbering
is tracked as its own registry row".

**D6 — tests (E3, Sonnet `high`, owns `apps/api/src/invoices/invoice-numbering.db.spec.ts` and
`apps/api/src/estimates/estimates.service.spec.ts`).**

- Delete REG-B100-G. Add pin `B100 reservation does not block a concurrent mint` (DB lane): open tx A via
  `tenantTransaction` that calls `reserveNext` then awaits a 1500 ms sleep before committing; while A sleeps,
  `reserveNext` from tx B must resolve within 500 ms with the next number. Today (in-tx lock) it blocks until
  A commits → the assertion on elapsed time fails; after D1 it passes.
- REG-B100-EST-A (DB lane): tenant B holds the estimate max; tenant A's first estimate number is the first in
  its own series (today: derived from B's). REG-B100-EST-B: past 9999 the next estimate number is 10001
  (today: 409/collision). Use the estimate's real format (read it). Own tenants, own cleanup.
- Keep T1a–T1e, T2a/b, P1–P6 as they are (P6 moves per D3).

## Execution

E1 Opus `high` (D1, D2) — files: `apps/api/src/import/numbering.service.ts`, `apps/api/src/invoices/invoices.service.ts`,
`apps/api/src/estimates/estimates.service.ts`. E2 Sonnet `medium` (D3, D4, D5) — `apps/api/src/payment-requests/payment-requests.service.ts`

- `.spec.ts`, `.github/workflows/db-migrations.yml`, `apps/api/src/sales-agents/commission-statements.service.ts`.
  E3 Sonnet `high` (D6) — the two spec files. Disjoint; run together. Gates per executor: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`;
  scoped `npx jest` on touched suites; E3 also runs the DB lane on its spec (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- src/invoices/invoice-numbering.db.spec.ts"`)
  AFTER E1 lands (E3 writes first, then re-runs once E1 reports). Then ONE scoped Opus `high` re-check of D1–D6
  (lock-order invariant, gap semantics, estimate format byte-identical, allocation order) + final gates
  (`cd apps/api && npx jest --silent`; full DB lane; `validate-lessons`) → SHIP or back to Fable (max one more round).
