# B861 — cause ruling (S3)

Design decision: **SA-274** (Senior Architect seat, 2026-09-25, on origin/master 21085bcb), received
verbatim below. The mechanical S3 items (§3–§7) are this lane's, derived inside SA-274's frame; any
choice not covered by SA-274 is marked **[lane]** so the pre-merge read can check it.

## 1. Cause verdict

Accepted — S2 `confirmed` (`cause-refutation.md`): `numbering.service.ts:254` routes every live
INVOICE/ESTIMATE/CREDIT_NOTE mint to the per-year series; the card's year-0 row has one writer (card
saves) and no live reader.

## 2. SA-274 (verbatim)

> Q1 — A. A saved year-0 row IS that doc type's live series: prefix + pad(n), continuous, no year
> segment, never resets; no saved row ⇒ today's INV-<year>-#### byte-identical. This AMENDS B100/F16b
> ruling D1 ("exactly INV-<year>-NNNN", January reset) for tenants with a saved row only; the B100 pins
> that assume it (T1i REG-B100-D2b's preview, unit P2's year-0 fast path) change on this ruling. D
> (year-segment toggle) is deferred as a feature; C is refused.
>
> Q2 — ONE guarded primitive, generalised to year 0, and MAX-FIRST for the configured series: every
> mint reserves GREATEST(nextNumber, numericMax + 1) in one statement, so a live number is never issued
> below an existing document of the type. The per-year series keeps its loop unchanged. "Taken" is
> numeric on the regex-ESCAPED prefix, -R aware (`^<esc>0*<n>(-R\d+)?$`); the max-scan drops the year
> segment for the configured series (`^<esc>(\d{1,9})(?:-R\d+)?$`); escape the prefix in the existing
> :417 scan in the same PR. Save: REFUSE next ≤ numericMax with a 400 that names the taken number; the
> mint-time GREATEST stays as the net for imports that land after the save. Imports unchanged. Cost
> accepted (B275 stands).
>
> Q3 — expected-version on the card: the web sends only changed fields plus the nextNumber it loaded;
> the server 409s when the row moved. No silent GREATEST on save — lowering above the numeric max is an
> explicit act and allowed; below it is refused by Q2.
>
> Q4 — read-only count first (year-0 rows per docType, with whether the tenant has live per-year docs,
> counts only), run through the fleet lead's railway-run authorization (never from a lane). It IS a
> merge condition: the result goes on the PR. Count 0 ⇒ nothing to decide. Count > 0 ⇒ the owner decides
> (activate as saved / require a fresh save); SA recommends "require a fresh save".
>
> Q5 — the preview is the TRUE next live number in both modes; T1i REG-B100-D2b's `preview:'INV-0001'`
> expectation changes on this word, `configured` stays year-0-only.
>
> Q6 — drop PAYMENT from the card in this PR (three live types; PUT …/PAYMENT → 400) and file the
> PaymentCounter wiring as its own B-id.
>
> Q7 — an empty prefix is allowed (bare "10543"); the guard's regex on an empty escaped prefix matches
> only bare numerics. Pin it.
>
> Invariant: per tenant and doc type in {INVOICE, ESTIMATE, CREDIT_NOTE}: a saved year-0 row ⇒ live
> numbers are prefix + pad(n), strictly increasing, never numerically equal to and never below any
> existing document number of that type with that prefix (-R aware); no saved row ⇒ the INV-<year>-####
> invariant unchanged. Tenant explicit; standalone reservation before any rollback-able tx; no nested tx
> (L-100). Siblings, not widened: import-zoho's local-counter fallback and backfill-invoices
> (B268-class), the PAYMENT wiring. Pins: real-Postgres for the guard (imported padded block, -R rows,
> max-first jump, the escaped-prefix cases `INV.`/`INV(`, empty prefix), the save 400 and 409, and the
> byte-identical unconfigured path.

## 3. Fix design (files, shape, what must NOT change)

**D1 — `apps/api/src/import/numbering.service.ts` (HIGH).** The ONE place the logic lives.

- `DOCUMENT_NUMBER_TYPES` → `["INVOICE","ESTIMATE","CREDIT_NOTE"]` (Q6). `DEFAULTS` unchanged.
- `escapeRegex(s)` (module-private): backslash-escape `\ ^ $ . | ? * + ( ) [ ] { }` (Postgres ARE).
  `-` is NOT escaped, so the three default prefixes produce byte-identical per-year patterns.
- `scanMaxForYear(db, docType, tenantId, year, prefix)` → the pattern uses `escapeRegex(prefix)`; with
  `year === 0` it drops the `<year>-` segment (`^<esc>(\d{1,9})(?:-R\d+)?$`). Per-year callers keep
  their exact behaviour. **[lane]** a sibling variant returns `{ max, number }` (the stored document
  number holding the max) for the save 400's message — `ORDER BY` the cast capture `DESC LIMIT 1`.
- `isTakenNumeric(db, docType, tenantId, prefix, n)` (new): `"<col>" ~ ^<esc>0*<n>(-R\d+)?$`, tenant
  explicit, `LIMIT 1`, three literal table branches like the scan.
- `reserveNext`, year-scoped docTypes, evaluation order (first hit wins), all on the caller's `tx` if
  given, else ONE own short `tenantTransaction` (unchanged D7 rule):
  1. year-0 row for `(tenant, docType)` exists → **configured path**;
  2. else `opts.year > 0` → `mintForYear` **unchanged** (per-year loop; only the scan's prefix escaping);
  3. else → `BadRequestException` **[lane]**: a mint never creates a year-0 row (that row now means
     "the tenant saved the card"); no live caller omits the year.
     Non-year-scoped docTypes (RETURN/ORDER/PAYMENT) keep the fast path byte-identical.
- Configured path (**max-first**, ≤ 5 attempts → `ConflictException`): `max = scan(prefix, year 0)`;
  ONE statement `UPDATE "NumberingSequence" SET "nextNumber" = GREATEST("nextNumber", max+1) + 1,
"updatedAt" = NOW() WHERE tenant/docType/year 0 RETURNING "nextNumber","prefix","padding"`;
  `reserved = nextNumber − 1`; candidate `format(prefix, reserved, padding)` (no year); prove it free
  with `isTakenNumeric` → return; taken (an import committed after the scan) → loop (re-scan). Warn-log a
  jump past the stored next, as `mintForYear` does.
- `getSettings()`: `requireTenant()`; rows read exactly as today (`where: { year: 0 }`); three rows.
  Configured → stored `prefix/nextNumber/padding` (the stored `nextNumber` is the Q3 version token) and
  `preview = format(prefix, max(nextNumber, numericMax+1), padding)`. Unconfigured → defaults,
  `nextNumber: 1`, `configured: false`, `preview` = the true next per-year number (per-year row's
  `nextNumber`, else `scanMax+1`; mirror the loop's jump while the exact candidate is taken, ≤ 5).
  Scans run inside one short `tenantTransaction` (same clients/RLS as the mint path) **[lane]**.
- `updateSettings(docType, dto)`: `requireTenant()`; (a) Q3 — when `dto.expectedNextNumber` is given,
  the write is a compare-and-set on the stored `nextNumber` (`updateMany … where nextNumber = expected`,
  0 rows → `ConflictException` naming the current next; absent row: expected must equal the default 1,
  create P2002 → 409); (b) Q2 — when `dto.nextNumber` is given and `≤ numericMax` for the EFFECTIVE
  prefix (`dto.prefix ?? stored ?? default`) → `BadRequestException` naming the stored document number
  and the lowest allowed next; (c) only provided fields are written (unchanged). Returns the row with the
  true preview. A save without `nextNumber` is never refused by (b) **[lane]** (the tenant typed no
  number; mint-time GREATEST covers it).
- `peekNext`/`seedFromSource`: unchanged bodies (they inherit the new behaviour).

**D2 — `apps/api/src/import/dto/update-numbering.dto.ts`:** `expectedNextNumber?` (`@IsOptional @IsInt
@Min(1) @Max(2_000_000_000)`). **D3 — `numbering.controller.ts`:** doc comments only ("three").

**D4 — web.** `apps/web/lib/api/numbering.ts`: `DocumentNumberType` → three; `UpdateNumberingInput`
gains `expectedNextNumber`. `settings/import/page.tsx` NumberingCard: drop PAYMENT; each draft records
the values it was seeded from (`loaded`); dirty = draft ≠ loaded; save sends only fields that differ
from `loaded` plus `expectedNextNumber: loaded.nextNumber`; on 409 → toast + re-seed from a refetch;
success re-seeds from the returned row. Copy: continuity + "until you save, the yearly series
(INV-2026-0001…) is used" + "new numbers always continue after the highest one on file"; drop "and note
it on the document".

**Must NOT change:** the per-year loop, lazy seed, `DEFAULTS`, the `-R{i}` convention, every caller's
call shape (`reserveNext(type, { year, tenantId?, tx? })`), the standalone-vs-`tx` rule, import writers,
`PaymentCounter`, `@@unique` constraints, the schema (no migration).

## 4. Regression tests (REG-B861) — see `bug-test-plan.md`

Unit (mocked, the engine red gate) + DB lane (real Postgres, prover-run, SA pins) + web RTL.

## 5. Blast radius

`fix` on numbering.service.ts: `radius: [8, 20]` (call sites in invoices/estimates/credit-notes/returns/
import services). Web fix: `radius: [5, 10]`.

## 6. Sibling patterns (engine sweep)

- `regexp_match\(|"\s*~\*?\s*\$\{` — raw-SQL regex built from an interpolated value (unescaped class).
- `numberingSequence\.(upsert|update|create|updateMany)` — sequence writers outside numbering.service.
- `(INV|EST|CN)-\$\{` — document numbers built by hand outside NumberingService (import-zoho class).

## 7. Data repair

None in this PR. Q4 read-only count (`apps/api/scripts/report-b861-numbering-config.mjs`) is a MERGE
CONDITION, run by the fleet lead via `railway run`; count > 0 → owner decides before merge.

## 8. Probe plan

`revert-probe` numbering.service.ts → the unit REG command must go red; web page.tsx → the web REG
test must go red.
