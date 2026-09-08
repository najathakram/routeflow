# Cause refutation — B100 F16b-invoice-counter

> S2 (Opus @ high, read-only). Method: **assume the suspicion is wrong**. Every claim below was re-opened
> independently at HEAD `8a1f1eab` in worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`.
> No file edited, no test run, no install, no database touched, no server started.
> Where I could not disprove the claim I say what I tried and why it failed; where I _could_, I say so.

---

## 0. Verdict table

| #     | Sub-claim                                                                    | Verdict                                                | Diverging line / disproof                                                                                                                                                |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **a** | Cross-tenant leak (two tenants, same year)                                   | **confirmed**                                          | `invoices.service.ts:2774` `const client = db ?? this.prisma;` + `:2778` `where` carries no `tenantId`                                                                   |
| **b** | 9999 wall (one tenant past 9999)                                             | **confirmed**, arithmetic corrected                    | `invoices.service.ts:2779` `orderBy: { invoiceNumber: "desc" }` on a `TEXT` column. **`padStart(4)` is NOT part of the defect**                                          |
| **c** | Concurrent mints → P2002 → 409, no retry                                     | **confirmed**, two corrections                         | `:495` mints 7 lines _before_ the tx opens at `:502`. Correction 1: a sub-9999 retry **does** succeed. Correction 2: `duplicate()` has **no P2002 catch → 500, not 409** |
| **1** | `PaymentCounter` is a sound pattern to copy                                  | **confirmed mechanism / refuted as a template**        | Mechanism race-safe; the model as written is unsafe in 4 ways (`:4676`, `finance.prisma:350`, `prisma.service.ts:141-154`, `:5282`)                                      |
| **2** | 5 mint sites + estimates + commission-statements share the shape             | **partly refuted**                                     | The 5 invoice sites: confirmed, must move together. `commission-statements.service.ts:68` — **refuted, sibling to file**. **3 mint sites the brief missed**              |
| **3** | `-R{i}` and other formats parse for the backfill                             | **refuted for `-R{i}` / confirmed for imports**        | `-R{i}` parses correctly. The real hazard is `import.service.ts:631` + `import-zoho.js:397` writing arbitrary external numbers                                           |
| **4** | Nullable `Invoice.tenantId` risk                                             | **confirmed as a schema risk / refuted as a live one** | `finance.prisma:203`; **prod census 2026-09-05 lists 16 NULL-holding tables and `Invoice` is not one** (`docs/IMPROVEMENTS.md:520-531`)                                  |
| **5** | Read paths sort/search numbers as strings                                    | **confirmed — 6 sites, one money-affecting**           | `payment-requests.service.ts:106` under the documented ALLOCATION POLICY at `:56-60`                                                                                     |
| **6** | _(not asked; found)_ The design of record needs a NEW `InvoiceCounter` table | **REFUTED**                                            | `platform.prisma:455-471` already has it, its `year` column comment literally cites **B100**                                                                             |

**Overall verdict: `confirmed`.** Both defects are real, at the lines the register names, reachable from the
five paths the design of record names. **But the design of record's fix is built on a false premise** (§6) and
must be re-ruled before build.

---

## a. Cross-tenant leak — CONFIRMED

**The path, walked.** `create()` `:495` → `nextInvoiceNumber()` `:271-273` → `generateInvoiceNumber()` with no
argument → `:2774` `const client = db ?? this.prisma` → `db` is `undefined` → `client === this.prisma` →
`:2777-2780` `client.invoice.findFirst({ where: { invoiceNumber: { startsWith: "INV-2026-" } }, orderBy: {
invoiceNumber: "desc" } })`. **No `tenantId` anywhere in that `where`.**

### Four refutation attempts, all failed

1. **Is `this.prisma` globally tenant-scoped by a constructor extension?** No.
   `prisma.service.ts:21-25` — the constructor builds a `PrismaPg` adapter and calls `super({ adapter })`.
   No `$extends`, no `$use`. `forTenant()` (`:296-300`) is **opt-in** and returns bare `this` when the
   tenant id is null.
2. **Is there a Prisma middleware anywhere?** No. Grep for `\$use\(` across `apps/api/src` → **"No matches found."**
3. **Is there an RLS backstop?** No. `tenantTransaction` sets the GUC (`prisma.service.ts:55-59`
   `set_config('app.current_tenant_id', …)`), but grep for `COLLATE|ROW LEVEL SECURITY|CREATE POLICY|icu_`
   across **all** of `apps/api/prisma/migrations` → **"No matches found."** Nothing consumes the GUC.
4. **Does the unique constraint save it?** No — and it was never supposed to.
   `finance.prisma:218` `@@unique([tenantId, invoiceNumber])` is correctly tenant-scoped. It constrains the
   _write_; the bug is in how the _candidate_ is computed. Confirms the brief.

**Repro (a) traced end-to-end.** Tenant B holds `INV-2026-0037`. Tenant A has none. Tenant A calls
`POST /invoices` → `:495` → global `findFirst` returns tenant B's `INV-2026-0037` → `:2781`
`parseInt("0037") + 1 = 38` → `:2782` `"INV-2026-0038"` → written at `:503` inside the tenant tx, so the ROW
is tenant-correct but the NUMBER is derived from a foreign tenant's volume.
**Y = `INV-2026-0038`; Z = `INV-2026-0001`.** Confirmed.

### NEW — the scoping is _mixed_, not uniformly absent (resolves brief open unknown #1)

The brief calls site 3 "unscoped in the default path". More precisely, `createSplitInvoices`'s `db` comes from
`createInvoiceFromOrder:591` `const db = txClient ?? this.prisma`, and that method has **both** kinds of caller:

- `invoices.controller.ts:59` → no tx → **unscoped**.
- `orders.service.ts:2483` → `createInvoiceFromOrder(order.id, undefined, {…})` → **unscoped**.
- `invoices.service.ts:4810` → `await this.createInvoiceFromOrder(orderId, tx)` inside
  `applyPaymentToOrdersInTx(tx, …)` (`:4759-4760`) → **a tx IS passed** (traced one level; whether that
  particular `tx` is tenant-wrapped depends on its own origin, which I did not exhaustively walk).
- `createInvoiceFromOrderWithTenant` `:2501-2506` passes **`db: this.prisma`** explicitly, with the in-code
  comment at `:2499-2500`: _"db = unscoped prisma with an explicit tenantId, exactly as this method already used
  it."_ So on the fire-and-forget delivery path the **write** is tenant-correct while the **number it writes**
  came from a global scan.

**Why this matters to the ruling:** one generator that is scoped on some call paths and not others is worse
than one that is never scoped — the same tenant's numbers come from two different populations depending on how
the invoice was raised. A fix must remove the ambiguity, not patch the default.

---

## b. The 9999 wall — CONFIRMED, with the arithmetic corrected

### Refutation attempt: is the sort actually lexicographic?

`finance.prisma:157` `invoiceNumber String` carries **no `@db.` annotation** → plain `TEXT` at the database's
default collation. Grep for `COLLATE|icu_|deterministic` across all migrations → **"No matches found"**; no
column-level or index-level collation is ever set, so no ICU numeric-aware ordering (`kn-true`) is in play.
And the `startsWith` filter at `:2778` guarantees every compared value shares the `INV-<year>-` prefix, so the
comparison reduces to `"9999"` vs `"10000"` — under both `C` and glibc `en_US.UTF-8`, `'9' (U+0039) > '1'
(U+0031)` at the first differing position. **Refutation fails; the claim holds.**

### CORRECTION — `padStart(4, "0")` is not the defect

`String(10000).padStart(4, "0") === "10000"`. `padStart` never truncates and never throws; and
`parseInt("INV-2026-10000".split("-")[2], 10) === 10000`. So the **format degrades gracefully past 9999** —
only the ORDER breaks. The register's phrase "pad-4 string sort" fuses two things.

> **A ruling that "widens the padding" fixes nothing** — pad-6 moves the wall to 999999 and, worse, changes the
> format of every number the system emits (see §5, where six read paths depend on the current fixed width).
> The wall must be closed at the _source of `last`_, never at the padding.

### Repro (b) traced

Platform-wide max is `INV-2026-9999`. Tenant A creates → candidate `INV-2026-10000`; `@@unique([tenantId,
invoiceNumber])` is per-tenant so it commits. Tenant A creates again → `findFirst … desc` returns
`INV-2026-9999` **again** (lexicographically greater than A's own `…10000`) → candidate `INV-2026-10000` →
collides with A's own row → `P2002` → `:557-559` → 409. Nothing in `:2777-2780` differs on a second call, so
**Y = a permanently repeating 409; Z = `INV-2026-10001`, `…10002`, climbing.** Each tenant gets **exactly one**
invoice past the wall, then is permanently blocked — matching the registry verifier's note verbatim. Confirmed.

---

## c. Concurrent mints — CONFIRMED, with two corrections the ruling must carry

**Mechanism.** `create()` mints at `:495`; `this.prisma.tenantTransaction` does not open until `:502`. The read
and the write are **not in the same transaction at all**. Two concurrent same-tenant creates read the same
`last`, build the same candidate, and one loses on `@@unique([tenantId, invoiceNumber])` → `P2002` → `:557-559`
`ConflictException("Invoice number conflict — please retry.")`. The author knew: `:333-339` records
_"RF-026: Previously, concurrent invoice creates both read the same last invoice number and one crashed with
Prisma P2002 → HTTP 500. Now catches P2002 and returns 409 Conflict instead."_ Confirmed.

### CORRECTION 1 — a sub-9999 retry _does_ succeed

The brief's sentence _"A retry after any of these 409s re-runs the identical unscoped/lexicographic scan and
gets the identical candidate"_ is **too strong** for the ordinary case (its following clause hedges correctly,
but the strong reading must not reach the ruling). Below the wall, the winning row is committed by the time the
loser retries, so `findFirst` returns the NEW max and the retry mints the next number. **The 409 is transient
below 9999 and permanent only above it.** Two different failure modes at one line.

### CORRECTION 2 — `duplicate()` has no P2002 catch at all (NEW)

`grep -n "P2002"` on `invoices.service.ts` returns exactly five lines: `:337`, `:338` (the RF-026 comment),
`:557`, `:1294`, `:2744`. `duplicate()` spans `:4345-4432` and calls
`this.prisma.forTenant().invoice.create({ data: { invoiceNumber: await this.nextInvoiceNumber(), … } })` at
`:4404-4406` with **no `try`/`catch` anywhere in the method**. So the fourth unscoped mint site raises a raw
`P2002` → **HTTP 500, not 409**. The brief lists three catch sites but does not draw this conclusion.

### Also unguarded: the estimates copy

`estimates.service.ts:245-252` mints _inside_ `tenantTransaction` (opened `:219`), so it is tenant-scoped — but
`findFirst` under READ COMMITTED takes **no row lock**, so two concurrent converts of _different_ estimates
still race, and there is **no P2002 catch** in `convertToInvoice` → 500. (The `updateMany` claim at `:223-226`
serializes converts of the _same_ estimate only.)

**Advisory lock**: none exists and none is needed. `common/db-locks.ts` `LOCK_FAMILIES = ["order-merge", "cron"]`
is a closed list; `withAdvisoryLock` throws for anything else. Confirms the brief; also confirms CLAUDE.md's
"**Never add a second in-process lock**" is not at risk here.

---

## 1. Is `PaymentCounter` a sound pattern to copy?

### Mechanism — sound

`invoices.service.ts:4678-4682`:
`tx.paymentCounter.upsert({ where: { id: counterKey }, update: { next: { increment: 1 } }, create: { id: counterKey, next: 2 } })`.
`increment` compiles to `SET next = next + 1`; a simple PK upsert with no nested writes compiles to
`INSERT … ON CONFLICT ("id") DO UPDATE … RETURNING`, so a concurrent transaction **blocks on the row lock**
rather than racing, and each caller gets a distinct value. Race-safe for uniqueness. Confirms the F16 refutation.

### The model as written — REFUTED as a template, four ways

1. **No year in the key.** `finance.prisma:349-357` — `id String @id @default("singleton")`, keyed
   `getTenantId() ?? "singleton"` at `:4676`, `:4972`, `:5272`. A straight copy carries the sequence across
   January, contradicting the bug's own "meant to do" (`INV-YYYY-0001` restarts each year). Confirms the design
   of record's `${tenantId}:${year}`.
2. **Null-tenant collapse — the fix would re-create B100 inside itself.** `?? "singleton"` means every
   null-tenant context shares ONE counter row. `docs/IMPROVEMENTS.md:508-510` records the prod consequence
   verbatim: _"The `PaymentCounter` row is the literal `singleton` id, the pre-multi-tenant global counter. It
   is left alone **by design**: giving it a tenant would hand that tenant a counter whose `next` was advanced by
   every other tenant's payments."_ **An invoice counter must REFUSE on a null tenant, never fall back to a
   sentinel** — otherwise the fix reproduces the exact cross-tenant leak it is closing.
3. **The upsert `where` is not tenant-scoped.** `prisma.service.ts:141-154` — re-read at this HEAD, unchanged.
   The key must be unique on its own. `${tenantId}:${year}` as a PK satisfies this.
4. **The precedent has already drifted (L-072's shape).** Of PaymentCounter's three call sites, `:4683` and
   `:4979` mint `PAY-${tenantShort}-####` but **`:5282` mints `PAY-####` with no tenant segment** —
   `PAY-${String(counter.next - dto.allocations.length + i).padStart(4, "0")}`. Two payment-number formats in
   one tenant. Real defect, **off-radius — sibling to file, not to fix here.**

---

## 2. Do the five mint sites (+ estimates, + commission-statements) really share the shape?

### The five — CONFIRMED, and they must move together

`:495`, `:1222`, `:2701`, `:4406` all reach `generateInvoiceNumber` (`:2773`); `estimates.service.ts:245-252`
is an **independent hand-copy** writing the SAME column on the SAME model via `tx.invoice.create` (`:254`).

**Why "all five or none" is load-bearing (L-081):** mixed schemes collide _by construction_. If `create()` mints
from a counter and returns `0005`, `convertToInvoice`'s scan sees max `0005` and mints `0006`; the counter's own
`next` is also `0006` → the next `create()` collides → `P2002`. A fix that patches one primitive and leaves the
other **introduces a new collision that does not exist today**.

### `commission-statements.service.ts` — REFUTED as a member of this set

`:68-77` mints `statementNumber` on `CommissionStatement`, **not `invoiceNumber` on `Invoice`.** Its single
caller `:182` passes the `tx` from `this.prisma.tenantTransaction(…)` opened at `:95`, so it is **already
tenant-scoped**; it shares only the lexicographic wall. Its own docstring `:67` (_"Copies
generateInvoiceNumber's max+1 scan pattern (invoices.service.ts)"_) is what makes it look in-scope — it is a
**sibling to file**, and `DocumentNumberType` (`platform.prisma:473-482`) carries no `COMMISSION_STATEMENT`
member, so routing it needs an enum value in a separate diff. Same for `nextEstNumber`
(`estimates.service.ts:15-24`), `nextCnNumber` (`credit-notes.service.ts:34-43`), `nextBillNumber`
(`vendor-bills.service.ts:172-181`) — all scoped, all walled, all out of scope.

### THREE `Invoice.invoiceNumber` writers the brief missed

| writer                                     | file:line                                               | shape                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| import fallback                            | `import/import.service.ts:631-632`, write at `:764-766` | `first["Invoice Number"] \|\| ` INV-${year}-${String(seq++).padStart(4,"0")} ` with **`let seq = 1`at`:541`, never seeded from the max** → a fallback import into a tenant that already holds `INV-2026-0001`throws P2002, swallowed as a row error at`:807` |
| Zoho importer                              | `scripts/import-zoho.js:397`, `:479`                    | `zohoInvNumber \|\| ` INV-${year}-… ` — arbitrary external numbers                                                                                                                                                                                           |
| **a THIRD verbatim copy of the generator** | `scripts/backfill-invoices.js:17-22`, used `:67`        | same unscoped `findFirst` / `orderBy desc` / `padStart(4)`; **hardcoded localhost connection string at `:13`**; `prisma.invoice.create` writes **no `tenantId`**                                                                                             |

(`scripts/demo-seed.js:1440` reproduces the `-R${i}` suffix but takes its base elsewhere.)
`apps/web` and `apps/mobile` contain **no writer** of `Invoice.invoiceNumber` — every hit is display, or the
distinct `supplierInvoiceNumber` field on vendor bills.

---

## 3. Would every format in the data parse for the backfill?

### `-R{i}` — REFUTED as a hazard

`invoices.service.ts:1234` `const invoiceNumber = i === 0 ? baseNumber : ` ${baseNumber}-R${i} ``.
`"INV-2026-0038-R1".split("-")` → `["INV","2026","0038","R1"]` → `[2] === "0038"` → `38`. It parses correctly
under today's generator **and** under the brief's proposed `^INV-<year>-(\d+)(-R\d+)?$`. R-siblings do not
consume base numbers, so `MAX(base seq)` is the right seed. Keep the `(-R\d+)?` alternative — a naive
`^INV-<year>-(\d+)$` anchor would drop them.

### Imported numbers — CONFIRMED, and the manual-review list is mandatory

`import.service.ts:631` takes `first["Invoice Number"]` **verbatim**; `import-zoho.js:397` takes
`zohoInvNumber` verbatim. Corroborating evidence that this is real, not theoretical:

- `import/duplicate-match.service.ts:151-152` normalizes numbers before comparing
  (`this.normalizeNumber(c.invoiceNumber)`) — a normalizer only exists because imported numbers do not follow
  the house format.
- `import/numbering.service.ts:69-74` `parseDocumentNumber` documents the foreign shape it must accept:
  _`"INV-08841" ⇒ { "INV-", 8841, 5 }`_ — five digits, no year segment.
- `numbering.service.ts:47-51`: _"Imported documents keep their ORIGINAL numbers and must NOT call `reserveNext`."_

**Consequence for the ruling:** the counter's namespace is **shared with numbers it never issued**. That is the
real reason a bounded P2002 retry / collision guard is still required after the counter lands — **answering
brief open unknown #4: yes, still needed**, not because the counter races, but because it can walk onto an
imported number. The "separately identify, never silently coerce" bullet in the brief is mandatory, not defensive.

---

## 4. Nullable `Invoice.tenantId` — schema risk CONFIRMED, live risk REFUTED

**Schema.** `finance.prisma:203` `tenantId String?`; `finance.prisma:218` `@@unique([tenantId, invoiceNumber])`.
In Postgres a UNIQUE index treats NULLs as **distinct**, so **two NULL-tenant invoices with the same number do
not violate the constraint** — for null-tenant rows the unique is no backstop whatsoever.

**Rows can still be created.** `createSplitInvoices:1245` and `createPartialFromOrder:2733` both write
`...(tenantId ? { tenantId } : {})` — a null-tenant context writes no `tenantId` at all.

**But the live population is zero, per a dated read-only prod census — brief open unknown #2 is answered
without DB access.** `docs/IMPROVEMENTS.md:520-531`: _"112 tables carry a `tenantId` column; 16 hold NULL rows
(12,357 rows total)"_ — the sixteen are `RefreshToken`, `VendorBillItem`, `PurchaseOrderItem`, `PaymentCounter`,
`AuditLog`, `ExpenseCategory`, `User`, `Expense`, `CreditNote`, `Return` (+`ReturnItem`), `RecurringInvoice`
(+item), `RouteRun`, `RouteRunStop`, `StockLot`. **`Invoice` is not among them.**

They _did_ exist historically: `docs/qa/audit-2026-04-29.md:2971` (RF-147) records
_"INV-2026-0010 was created with `tenantId: null`"_; the fix is annotated in-code at `invoices.service.ts` ~`:575`
(_"RF-147: tenantId is now explicitly set on the Invoice record"_). Created, then gone — consistent with the census.

**What the backfill must do.** `GROUP BY tenantId` with `tenantId IS NULL` **excluded and reported**, never
folded into a sentinel bucket — `docs/IMPROVEMENTS.md:508-510`'s `singleton` PaymentCounter ruling is both the
precedent and the reason. And note the repo's only null-tenant repair tool,
`apps/api/scripts/backfill-legacy-tenant-ids.mjs`, covers exactly four tables — _"Tables, in write order:
RouteRun, RouteRunStop, PaymentCounter, CreditNote"_ (`:163`, `TABLES` at `:303-396`) — **`Invoice` is not one
of them**, so a null-tenant invoice would have no existing repair path.

**Rules quoted.** `db-migration` skill: _"**Multi-tenant**: new models/columns must carry/relate to `tenantId`;
every query stays tenant-scoped."_ Note `NumberingSequence.tenantId` is `String` — **NOT NULL**
(`platform.prisma:457`) — strictly better than a new `InvoiceCounter` copying `PaymentCounter`'s `tenantId String?`.

**Lessons register.** Grep of `.claude/lessons/LESSONS.md` for `null-tenant|nullable|tenantId|tenanc` returns
**one** hit — `:417`, inside L-060, about `findUniqueOrThrow` and the tenancy layers. There is **no** lesson on
null-tenant rows and (re-confirming the brief) none on migrations. The null-tenant program lives in
`docs/IMPROVEMENTS.md:485-535`, not the register.

---

## 5. Read paths that sort or search invoice numbers as strings — CONFIRMED, six sites

| #   | Site                                         | What it does                                                                                                                                                                                                                                                            | Compatibility constraint                                                                                                                                      |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `payment-requests.service.ts:106`            | `orderBy: [{ issueDate: "asc" }, { invoiceNumber: "asc" }]` under the **ALLOCATION POLICY** documented at `:56-60`: _"every buyer payment … settles the OLDEST invoices first (issueDate asc, then invoiceNumber asc), partially covering the last invoice it reaches"_ | **MONEY-AFFECTING.** Past 9999, `INV-2026-10000` sorts _before_ `INV-2026-9999`, changing which invoice a buyer payment settles among same-issueDate invoices |
| 2   | `invoices.service.ts:4836`                   | `orderBy: [{ createdAt: "asc" }, { invoiceNumber: "asc" }]` — oldest-first payable ordering in `applyPaymentToOrdersInTx`                                                                                                                                               | Money-ordering, tiebreak only                                                                                                                                 |
| 3   | `invoices.service.ts:1958`                   | same, with the reason at `:1956-1957`: _"invoiceNumber tiebreak: split siblings share a createdAt (one tx timestamp), so createdAt alone is non-deterministic for picking the primary/base"_                                                                            | **Depends on `-R{i}` sorting after its base** (`INV-2026-0038` < `INV-2026-0038-R1` — true today). **The `-R{i}` suffix at `:1234` must NOT change**          |
| 4   | `credit-notes.service.ts:945`                | `orderBy: { invoiceNumber: "asc" }` — credit shrink/apply loop order                                                                                                                                                                                                    | Ordering only                                                                                                                                                 |
| 5   | `invoices.service.ts:2881` + `:2892`         | user-facing list sort: `validSortFields` maps `invoiceNumber: "invoiceNumber"`, `orderBy = [{ [orderField]: orderDir }, { id: orderDir }]`                                                                                                                              | Cosmetic, but the user-visible half of the same defect                                                                                                        |
| 6   | `scripts/sales-gap-analysis.js:27,52,90,105` | `orderBy: { invoiceNumber: "desc" }`                                                                                                                                                                                                                                    | Read-only reporting; same assumption                                                                                                                          |

**No constraint** from `invoices.service.ts:2844` (`contains`, substring search) or `import.service.ts:746`/`:840`
(exact-match `findFirst`) — both format-agnostic.

**Net constraint on the fix:** keep the **prefix-stable, fixed-width, zero-padded** format so these six orderings
stay meaningful; keep the `-R{i}` suffix exactly as `:1234` writes it. This is a second, independent reason the
padding must not be widened.

---

## 6. THE PREMISE OF THE DESIGN OF RECORD IS REFUTED — a per-tenant, per-year numbering table already exists

The design of record (`cause-ruling.md` §9) directs: _"single primitive `nextInvoiceNumber(tx, tenantId, year)`
backed by `InvoiceCounter { id = "<tenantId>:<year>", next }` (PaymentCounter pattern)"_. **That table already
exists under another name, and its year column was added for B100 by name.**

**`apps/api/prisma/schema/platform.prisma:455-471`:**

```
model NumberingSequence {
  id         String             @id @default(uuid())
  tenantId   String                                   // ← NOT NULL
  docType    DocumentNumberType
  prefix     String             @default("")
  nextNumber Int                @default(1)
  padding    Int                @default(4)
  // F01/B100: per-year series (INV-2026-0001 restarts each January). 0 = the
  // year-agnostic series, which is what every pre-existing row means — so the
  // default keeps them valid and the widened unique key cannot collide them.
  year       Int                @default(0)
  …
  @@unique([tenantId, docType, year])
}
```

- The `year` column and the widened unique index shipped in
  `apps/api/prisma/migrations/20260908000000_campaign_schema_foundation/migration.sql`
  (`:13` DROP `NumberingSequence_tenantId_docType_key`; `:42` ADD `"year" INTEGER NOT NULL DEFAULT 0`;
  `:48` CREATE `NumberingSequence_tenantId_docType_year_key`). Blame: `60d10e66a`, 2026-09-05.
- `enum DocumentNumberType` (`:473-482`) already has `INVOICE`, and `:478-479` says the remaining minters
  _"get routed through NumberingService by **F16**"_.
- **`apps/api/src/import/import.module.ts:58-62`, verbatim:** _"NumberingService is exported so the deferred
  invoices/orders wiring (which must call `reserveNext` at mint time) can consume it **without duplicating it**."_
- **`numbering.service.ts:20-24`, verbatim:** _"F01/G6: match the series the ad-hoc minters emit today … so
  **F16** can route them through `reserveNext` without renumbering anything."_
- `numbering.service.ts:44-51`: _"`reserveNext(docType)` is the collision-guarded contract that LIVE minting
  (invoices/orders) **will** consume — wiring it into those call sites is a deferred cross-module change."_

**The primitive already satisfies most of the design of record's conditions:** tenant-scoped through
`forTenant()` (`:180`, `:188`); an **atomic single-statement increment** on the fast path (`:186-193`, _"Fast
path: atomic single-statement increment — safe under concurrency"_); a collision-guard path with a 10,000-cap
that _"never returns an unverified number"_ (`:205-227`); and `requireTenant()` (`:236-240`) that **throws
`BadRequestException("A tenant context is required.")`** rather than falling back to a sentinel — precisely the
null-tenant behavior `PaymentCounter` lacks (§1.2).

### Three real obstacles the ruling must not paper over

1. **Format mismatch — the biggest one.** `format(prefix, n, padding)` (`:59-62`) emits `prefix + padded digits`,
   and `DEFAULTS.INVOICE = { prefix: "INV-", padding: 4 }` (`:16`) ⇒ **`INV-0001`, not `INV-2026-0001`.**
   Routing invoices through `reserveNext("INVOICE")` **as written changes the visible number format**, which §5
   forbids. Either the per-year row stores `prefix = "INV-2026-"` (and something must roll it each January), or
   `reserveNext` grows a year parameter.
2. **`reserveNext` ignores its own `year` column.** All four query sites hardcode `year: 0`
   (`:182`, `:190`, `:200`, `:230` — `where: { tenantId_docType_year: { tenantId, docType, year: 0 } }`).
   The schema dimension B100 caused to be added is **unused by the service**. Closing that gap is the actual
   work — and it is a _code_ change plus at most a data seed, **not a new table and not a new model in
   `MODEL_DOMAIN`**.
3. **The collision-guarded path is NOT race-safe, and invoices need it.** `numbering.service.ts:163-169`,
   verbatim: _"the collision path is a read-modify-write inside a tenant transaction that does NOT take a row
   lock (default READ COMMITTED), so two concurrent minting calls could still race. When wiring this into live
   invoice/order minting, run it at SERIALIZABLE isolation (or add a `SELECT … FOR UPDATE` on the sequence row)
   and rely on the invoice-number unique constraint as the final backstop."_ Per §3, invoices **do** need the
   `exists` guard (imported numbers), so this note is load-bearing, not hypothetical.

**Wiring cost.** `InvoicesModule` (`invoices.module.ts:18-29`) does **not** import `ImportModule` today, and
`EstimatesModule` (`estimates.module.ts:7-8`) imports only `PrismaModule` + `EntitlementsModule`. Both need the
import; `ImportModule` already exports the service. Check for a cycle before ruling.

**Why this is a §6 finding and not a §2 one:** building `InvoiceCounter` would create a **second numbering
store** in a repo whose code comments have already ruled against exactly that — the L-072 shape (independently
hand-copied logic drifting invisibly) at the schema level, which is strictly worse than the six drifted
generators B100 is about. **This must go back to Fable before build.**

---

## 7. Facts the fix ruling must not get wrong

1. **Two defects at two lines, not one.** Cross-tenant: `:2774` (`db ?? this.prisma`) + `:2778` (no `tenantId`).
   Lexicographic wall: `:2779` (`orderBy … "desc"`). They are independent and need independent proof.
2. **`padStart(4, "0")` is not the defect.** It never truncates; `parseInt` handles 5 digits. Widening the pad
   fixes nothing and breaks §5's six read paths. Fix the source of `last`.
3. **The 409 is transient below 9999 and permanent above it.** Two failure modes at one line — the red set needs
   both, and the sub-9999 one must not be written as "permanent".
4. **`duplicate()` (`:4345-4432`) has NO P2002 catch** — a concurrent duplicate is a **500**, not a 409. Three
   catches (`:557`, `:1294`, `:2744`) for four unscoped mint sites. `estimates.service.ts convertToInvoice` has
   none either.
5. **The scoping is mixed, not absent.** `createInvoiceFromOrder:591` `db = txClient ?? this.prisma` has callers
   of both kinds; `createInvoiceFromOrderWithTenant:2506` passes `db: this.prisma` **deliberately**, so the write
   is tenant-correct while the number is not.
6. **All five mint sites move together or none.** A counter in `create()` beside a max+1 scan in
   `convertToInvoice` _creates_ a collision that does not exist today (L-081).
7. **`NumberingSequence` already is the per-tenant/per-year counter, and its `year` column cites B100**
   (`platform.prisma:462-465`; migration `20260908000000…:42,48`). `import.module.ts:58-62` says to consume it
   _"without duplicating it"_. **Do not add `InvoiceCounter` without ruling on this first.**
8. **`reserveNext` hardcodes `year: 0`** at `:182`, `:190`, `:200`, `:230` — the year dimension is unused; that
   is the gap. And **`DEFAULTS.INVOICE.prefix = "INV-"`** (`:16`) would mint `INV-0001`, changing the format.
9. **A collision guard / bounded retry is still required after any counter** — not for races, but because
   `import.service.ts:631` and `import-zoho.js:397` write arbitrary external numbers into the same namespace
   (brief open unknown #4: **yes, keep it**).
10. **Null-tenant: refuse, never sentinel.** `PaymentCounter`'s `?? "singleton"` (`:4676`) is the anti-pattern
    `docs/IMPROVEMENTS.md:508-510` documents. `NumberingService.requireTenant()` (`:236-240`) already throws —
    keep that behavior.
11. **No live NULL-tenant `Invoice` rows** per the 2026-09-05 prod census (`docs/IMPROVEMENTS.md:520-531`), but
    the schema still permits them (`finance.prisma:203`), NULLs defeat the unique, and two writers
    (`:1245`, `:2733`) can still create one. Backfill: **exclude and report**, never coerce.
12. **Do not change the `-R{i}` suffix** (`:1234`) — `:1958`'s primary/base selection depends on it sorting
    after its base. `-R{i}` parses correctly for the backfill; keep `(-R\d+)?` in the regex.
13. **Three extra `Invoice.invoiceNumber` writers exist** — `import.service.ts:631`, `import-zoho.js:397`,
    `scripts/backfill-invoices.js:17` (a **third verbatim copy** of the generator). Any sibling grep that omits
    `apps/api/scripts/**` misses two of them.
14. **Sibling generators are OUT of scope but should be filed**: `nextEstNumber` (`estimates:15`), `nextCnNumber`
    (`credit-notes:34`), `nextBillNumber` (`vendor-bills:172`), `nextStatementNumber` (`commission-statements:68`),
    the PO generator (`inventory.service.ts:1025`), and the drifted `PAY-####` at `invoices.service.ts:5282`.
15. **Zero existing coverage** of the real generator (re-confirmed): every reference in
    `invoices.service.spec.ts` is a fixture string, a `jest.spyOn(… "generateInvoiceNumber").mockResolvedValue`,
    or `prisma.invoice.findFirst.mockResolvedValue(null)`. Per **L-061**, the concurrent-mint and cross-tenant
    claims can only be _proven_ in the DB lane (`*.db.spec.ts`, `npm run local:test:db`); the 9999 wall alone is
    unit-provable, since a mocked `findFirst` returning `{ invoiceNumber: "INV-2026-9999" }` twice reproduces
    `INV-2026-10000` twice deterministically.
16. **Migration mechanics** (unchanged from the brief, re-verified): schema is a FOLDER; a new model needs a
    `MODEL_DOMAIN` entry (`split-prisma-schema.mjs:184` `PaymentCounter: "finance",`) — **but §6 may mean no new
    model at all**, in which case `--check` is unaffected. Squawk gates 9 of 40 rules; keep any DDL additive.
    Prod applies only via `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`, after a fresh
    backup, with **owner ack**, then the drift gate at exit 0.

---

## 8. Verdict

**`confirmed`** — for the bug. Both mechanisms reproduce from the code at the lines the register names, on all
the paths the design of record names, and every attempt to disprove them (global middleware, RLS, numeric
collation, the unique constraint, graceful pad overflow) failed against a cited line or an empty grep.

**Sub-verdicts:** (a) confirmed · (b) confirmed, `padStart` exonerated · (c) confirmed, retry-permanence and
`duplicate()`'s missing catch corrected · (1) mechanism confirmed / template refuted · (2) five sites confirmed,
commission-statements refuted, three writers added · (3) `-R{i}` refuted as a hazard, imports confirmed ·
(4) schema risk confirmed / live risk refuted · (5) confirmed, six sites, one money-affecting ·
**(6) the design of record's premise REFUTED.**

**One question back to Fable (S3), not to S2:** given `NumberingSequence`
(`platform.prisma:455-471`, `year` added _for B100_), `NumberingService.reserveNext`
(`import/numbering.service.ts:172-234`) and `import.module.ts:58-62`'s explicit _"without duplicating it"_ —
does B100 wire the five mint sites into the **existing** primitive (teaching `reserveNext` the `year` it already
has a column for, and settling the `INV-` vs `INV-<year>-` prefix), or does it still add `InvoiceCounter`? This
is a design decision over evidence, not missing evidence; the cause itself is **confirmed** either way and the
build should not start until it is ruled.
