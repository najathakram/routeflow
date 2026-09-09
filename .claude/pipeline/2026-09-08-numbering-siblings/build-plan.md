# Build plan — numbering siblings Group A (B267 · B268 · B269 · B277-pin)

Mode `bugfix`, scale `major` (money + tenancy). Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`,
branch `fix/numbering-siblings` (off master eb2b815e; merge `origin/master` before landing). Design of record
`cause-ruling.md` §2; tests `bug-test-plan.md`; binding facts `cause-refutation.md`. NO schema change (Group
B with the enum migration is a separate run). Option-B bookkeeping: no map/lessons/ledger edits. Never
Playwright; the DB lane needs the compose Postgres (up). F16b's boundary rule holds: standalone reservations
hold no other lock; nothing nests a `$transaction`.

## Packages

### P1 — `NumberingService` learns CREDIT_NOTE (Opus `high`)

`apps/api/src/import/numbering.service.ts`: `YearScopedDocType` += `CREDIT_NOTE`; literal `CreditNote` branch in
`mintForYear` / `scanMaxForYear` / `findTaken` (table, column, regex from `cause-refutation.md` §1.3);
`DEFAULTS.CREDIT_NOTE` unchanged. F16b pins (`numbering.service.spec.ts`) stay green.

### P2 — credit notes (Opus `high`; dependsOn P1)

`apps/api/src/credit-notes/credit-notes.service.ts` (+ `credit-notes.module.ts` imports `NumberingModule`):
validate-before-reserve, standalone `reserveNext("CREDIT_NOTE", { year, tenantId })` hoisted above the
SERIALIZABLE tx, delete the scan, P2002 → 409. `tenantId` explicit.

### P3 — payments (Opus `high`, money)

`apps/api/src/invoices/invoices.service.ts`: `nextPaymentNumber(tenantId)` helper (tenant required; short
standalone `PaymentCounter` upsert committed before the payment tx; `PAY-<tenantShort>-####` as sites 1/2);
all three sites use it; site 3 passes the payment request's `tenantId`. Read `apps/api/src/payment-requests/payment-requests.service.ts:853`
to confirm the tenant source. Never `"singleton"`.

**Round-1 amendment (D3 narrowed) — 2026-09-08.** One refusal helper (`requirePaymentTenant`) is
shared by all three PAY sites and `"singleton"` is gone everywhere. Site 3 alone hoists its
reservation standalone before its transaction (the settlement-stall fix). Sites 1/2 keep minting on
the caller's transaction: hoisting would take a second pooled connection inside an open tx (F16b
invariant) and would burn a number on every validation failure. Null tenant → BadRequestException at
all three sites.

### P4 — import fallback (Sonnet `high`; dependsOn P1)

`apps/api/src/import/import.service.ts`: source-numberless rows reserve through the service; the
update-live-invoice branch only for rows with a source number; a P2002 on a fallback row is an error row.

### P5 — estimates pin + wiring (Sonnet `medium`)

`apps/api/src/estimates/estimates.service.ts` `create()` P2002 → 409; `NumberingModule` imports where needed;
the 23 `Test.createTestingModule` provider sites (`cause-refutation.md` §8) get the mock provider — report
the list touched.

### TP-DB (Sonnet `high`): `credit-note-numbering.db.spec.ts`, `payment-numbering.db.spec.ts`,

`import-numbering.db.spec.ts` per T1–T3. ### TP-UNIT (Sonnet `high`): T4 pins in the three service specs.

## Gates

Per round: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`; `cd apps/api && npx jest src/import src/invoices src/credit-notes src/estimates src/payment-requests --runInBand`.
Final: `cd apps/api && npx jest --silent`; `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`; `node scripts/validate-lessons.mjs`.
Red gate: the REG-B267/B268/B269 DB-lane specs + the REG unit pins must FAIL before P1–P4.

## Pipeline args — see `pipeline-args.json`.

## Landing (Lead)

Commit (trailer `Bookkeeping-Follow-Up: pending`) → merge origin/master → regen reports → campaign-check →
hook push → draft PR `fix(api): tenant-scoped credit-note, payment and import numbering (B267 B268 B269)` →
window → api SUCCESS → private → PDC → deployment E2E → docs follow-up (B267/B268/B269 done, B277 done as a
pin, B270–B272 noted "Group B, migration ack pending"; lesson: `forTenant()` is not a tenant guarantee —
pass `tenantId` explicitly on every mint; api map).
