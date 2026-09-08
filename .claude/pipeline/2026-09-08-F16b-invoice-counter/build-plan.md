# Build plan — B100 (F16b invoice-number counter)

Mode `bugfix`, scale `major` (money + tenancy). Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`,
branch `fix/F16b-invoice-number-counter` (off master; merge `origin/master` before landing). Design of record
`cause-ruling.md` §2; tests `bug-test-plan.md`; binding facts `cause-refutation.md` §7. NO schema change, NO
migration (the `NumberingSequence.year` column already exists). Option-B bookkeeping: no map/lessons/ledger
edits in this run. Never run Playwright; the DB lane needs the compose Postgres (up on this host).

## Packages

### P1 — `NumberingService` learns the year (Opus `high`)

File: `apps/api/src/import/numbering.service.ts` (+ `apps/api/src/import/numbering.module.ts` if P3 extracts it).

- `reserveNext(docType, opts?: { year?: number; tx?: Prisma.TransactionClient; tenantId?: string })`.
- Key `{ tenantId, docType, year: opts.year ?? 0 }` at every query site (`:182, :190, :200, :230`).
- Format: `year > 0` → `${prefix}${year}-${padded}`; else unchanged. `DEFAULTS.INVOICE` unchanged.
- Tenant resolution: request context, else `opts.tenantId`; `requireTenant()` still throws on null.
- Lazy seed when no row for `(tenantId, docType, year)`: inside the caller's tx (or a tenant tx), ONE
  parameterised raw statement
  `SELECT COALESCE(MAX((regexp_match("invoiceNumber", $1))[1]::int), 0) FROM "Invoice" WHERE "tenantId" = $2`
  with the pattern `^INV-<year>-(\d+)(?:-R\d+)?$` (INVOICE only; other docTypes keep today's behaviour) →
  `create { nextNumber: max + 1 }`; on P2002 (concurrent first mint) fall through to the atomic increment.
- Collision-guard path: `SELECT … FOR UPDATE` on the sequence row (raw, inside the tx) before the
  read-modify-write; keep the existence check against `Invoice` for the tenant and the 10,000 cap.
- Fast path (atomic single-statement increment) unchanged.

### P2 — the five mint sites (Opus `high`; dependsOn P1)

Files: `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/estimates/estimates.service.ts`.

- `generateInvoiceNumber(db?)` keeps name and signature; body = `this.numbering.reserveNext("INVOICE",
{ year, tx: db, tenantId })` with `year` derived exactly as today and `tenantId` passed explicitly where the
  caller holds one (`createInvoiceFromOrderWithTenant:2506`). Inject `NumberingService`.
- `create()`: move the mint from `:495` to inside the `tenantTransaction` opened at `:502` (pass `tx`).
  `createSplitInvoices` (`:1222`), `createPartialFromOrder` (`:2701`), `duplicate()` (`:4406`) pass their
  tx/db. Add the P2002 → `ConflictException` catch to `duplicate()` (message identical to `:557-559`).
- `estimates.service.ts:245-252`: delete the inline scan; `this.numbering.reserveNext("INVOICE", { year, tx })`
  inside the existing tx (`:219`); add the P2002 → 409 catch in `convertToInvoice`.
- Untouched: `-R{i}` (`:1234`), every read path in `cause-refutation.md` §5, the P2002 catches at
  `:557/:1294/:2744`, `PaymentCounter`, import writers.

### P3 — module wiring (Sonnet `medium`; dependsOn P1)

Files: `apps/api/src/invoices/invoices.module.ts`, `apps/api/src/estimates/estimates.module.ts`,
`apps/api/src/import/import.module.ts` (+ new `apps/api/src/import/numbering.module.ts`).

- If importing `ImportModule` into `InvoicesModule`/`EstimatesModule` creates a cycle (check
  `ImportModule`'s imports transitively), extract `NumberingModule` (provides + exports the unchanged
  `NumberingService`; `ImportModule`, `InvoicesModule`, `EstimatesModule` import it). No `forwardRef`.
- Every `Test.createTestingModule` in the touched specs gets the `NumberingService` provider (see the
  test plan's harness notes) — the test package owns the spec edits, P3 reports which modules changed.

### TP-DB — DB-lane repro (Sonnet `high`)

File: `apps/api/src/invoices/invoice-numbering.db.spec.ts` — test plan T1 (a, a2, b, c, d, d2); own tenants,
own cleanup; implement nothing.

### TP-UNIT — unit repros + pins (Sonnet `high`)

Files: `apps/api/src/invoices/invoices.service.spec.ts`, `apps/api/src/estimates/estimates.service.spec.ts`,
`apps/api/src/import/numbering.service.spec.ts` — test plan T2 (a, b) and pins P1–P6; harness notes; implement nothing.

## Gates

Per round: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`; `cd apps/api && npx jest src/invoices src/estimates src/import --runInBand`.
Final: `cd apps/api && npx jest --silent`; `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`; `node scripts/validate-lessons.mjs`.
Red gate (must FAIL before P1/P2): the DB-lane REG-B100 specs + the unit REG-B100 specs (see `pipeline-args.json`).

## Pipeline args

See `pipeline-args.json` (mode bugfix; radiusFiles `cause-ruling.md` §4; siblingPatterns §5; probes §7).

## Landing (Lead)

Commit (trailer `Bookkeeping-Follow-Up: pending`) → merge origin/master → regen api/mobile/pricing reports →
campaign-check → hook push → draft PR `fix(api): tenant-scoped per-year invoice numbering through NumberingService (B100)`
→ window → both Railway rows SUCCESS (api rebuilds) → private → PDC (invoice math + reconcile) → deployment E2E
→ docs follow-up (B100 done with the REG names + probe results; sibling rows from §5; lesson: "a primitive that
already exists beats a new table — check the schema for the dimension before designing a store"; code map).
NO new prod migration (20260908000000_campaign_schema_foundation already carries NumberingSequence.year), BUT before opening the window run the read-only drift gate against prod — `railway run --service postgres node apps/api/scripts/schema-drift.mjs` — and require exit 0; a non-zero exit blocks the merge (the change has no fallback if the column is absent).
