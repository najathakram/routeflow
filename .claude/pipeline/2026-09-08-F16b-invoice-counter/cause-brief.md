# Cause brief — B100 F16b-invoice-counter

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals
> beyond quoting the design of record (`cause-ruling.md` §9 from the F16 run, reproduced verbatim below).
>
> Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `fix/F16b-invoice-number-counter`,
> HEAD `8a1f1eab` (`origin/master`). All file:line citations below were re-opened at THIS HEAD — the F16 run
> (`2026-09-07-F16-list-caps/`) verified the same facts at HEAD `19a419ba`; line numbers have shifted (the
> generator moved from `:2726-2729` to `:2773-2783`, etc. — the F16 PR #656/#659 landed in between) but every
> mechanism is unchanged. No file was edited, no test run, no install, no database touched.

## The bug as stated

**Registry row, quoted verbatim** (`.claude/campaign/bugs/B100.md`, state `queued`, batch `F16`, severity
`high`, `sensitive: true` / `sensitiveFor: money,tenancy`):

> **Meant to do.** Each tenant gets its own clean INV-YYYY-NNNN sequence starting at 0001, and invoice creation
> keeps working no matter how many invoices exist.
>
> **Actually does.** New-invoice paths compute next number from the GLOBAL max across all tenants (bare prisma,
> no forTenant), and the desc string sort over pad-4 numbers pins the max at 9999, looping 409s forever past 10000.
>
> **The gap.** No counter table; unscoped scan leaks cross-tenant volume into numbering; string sort makes
> creation permanently fail once any series passes 9999.
>
> **Suggested fix (register).** Add a per-tenant, per-year InvoiceCounter table (like PaymentCounter) updated
> atomically inside the create transaction; or at minimum run the scan through forTenant()/tx and sort
> numerically... Apply the same fix to the EST/CN/BILL/PO/CST/ORD generators.
>
> **Verifier's note.** Verified both mechanisms myself. Nuance: because the invoice scan is global, the 9999
> wall trips on PLATFORM-wide yearly volume, not one tenant's; each tenant then gets exactly one more invoice
> (its own -10000) before permanent 409s. generateInvoiceNumber(db) at :1181 does receive a tx from
> split-invoice callers, so that one path can be scoped — the main create() and createPartialFromOrder paths
> are not. No RLS backstop exists.
>
> History: filed 2026-09-02 (imported from register, Open) → batched to F16 (2026-09-02) → **SPLIT to its own
> run F16b** (2026-09-07): "per-tenant per-year InvoiceCounter (PaymentCounter pattern, called last inside the
> creating transaction, bounded retry) used by all five mint sites incl. estimates.service.ts convertToInvoice;
> migration seeds each (tenantId, year) from the NUMERIC max of existing INV-<year>-* suffixes; owner ack
> required before prod-migrate (cause-ruling.md section 9)."

**Repro (as stated in the registry + re-derived from the live code below)**:
(a) **Cross-tenant leak** — tenant A creates its first-ever invoice while tenant B already has invoices in the
same calendar year → A's next number is computed from `MAX` across BOTH tenants' invoices (input: tenant B has
`INV-2026-0037` as its highest; tenant A has none) → **A's first invoice mints as `INV-2026-0038`, not
`INV-2026-0001`** (Y = `0038`; expected Z = `0001`).
(b) **9999 wall** — once the platform-wide (not one tenant's) count of `INV-2026-####` invoices reaches 9999 in
one year: input = a create call when the current max row is `INV-2026-9999` → `parseInt("9999")+1 = 10000` →
candidate `INV-2026-10000` (Y, succeeds once) → the NEXT create call re-runs the same scan, `findFirst` +
`orderBy desc` on the `TEXT` column again returns `INV-2026-9999` (lexicographically `'9' > '1'` at the first
differing character) → candidate is **`INV-2026-10000` again** → collides with the row just created →
`P2002` → `ConflictException("Invoice number conflict — please retry.")` → **retry re-derives the identical
candidate → permanent 409, forever, for every tenant** (Y = repeating 409; expected Z = `INV-2026-10001`,
`…10002`, … climbing cleanly).

**Suspected cause (claim, unverified by this agent — this is what S2 must re-open)**: the registry's own
"Actually does" text, i.e. (1) `generateInvoiceNumber`'s `where` carries no `tenantId` and its default client
is the bare, unscoped `this.prisma`; (2) `orderBy: { invoiceNumber: "desc" }` sorts a `TEXT` column
lexicographically, and pad-4 zero-padding stops working once a 5-digit number appears. The F16 batch's S2 pass
(`refutation.md`, verdict table) already returned a verdict of **confirmed** for this exact claim, against
HEAD `19a419ba` — quoted in full under "Design of record" below. This brief re-opened the same lines at the
CURRENT HEAD (`8a1f1eab`) independently, listed next, and found the mechanism unchanged.

## Code path (re-verified at HEAD `8a1f1eab`)

**Generator — `apps/api/src/invoices/invoices.service.ts:2769-2783`:**

```
2769  /**
2770   * Generate next invoice number. Accepts optional tx client for
2771   * transactional safety inside $transaction blocks.
2772   */
2773  private async generateInvoiceNumber(db?: any): Promise<string> {
2774    const client = db ?? this.prisma;
2775    const year = new Date().getFullYear();
2776    const prefix = `INV-${year}-`;
2777    const last = await client.invoice.findFirst({
2778      where: { invoiceNumber: { startsWith: prefix } },
2779      orderBy: { invoiceNumber: "desc" },
2780    });
2781    const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
2782    return `${prefix}${String(seq).padStart(4, "0")}`;
2783  }
```

`client = db ?? this.prisma` — when no `db` is passed, `this.prisma` is the bare (unscoped) client. `git blame
-L 2773,2783` shows this entire body is UNCHANGED since commit `c620aae0c` (Najath Akram, **2026-03-31**) —
over five months untouched, through every later PR.

**Every caller (re-grepped at current HEAD):**

| #   | site                          | line                                                           | `db` arg                                        | scoping                                                                                                                                                                       |
| --- | ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `nextInvoiceNumber()` wrapper | `:271-273`                                                     | n/a (calls `generateInvoiceNumber()` with none) | —                                                                                                                                                                             |
| 2   | main `create()`               | `:495` (`invoiceNumber = await this.nextInvoiceNumber()`)      | none                                            | **unscoped** — `create()` opens at `:340`; the `tenantTransaction` doesn't open until `:502`, i.e. the number is minted 7 lines before the tx starts                          |
| 3   | `createSplitInvoices()`       | `:1222` (`baseNumber = await this.generateInvoiceNumber(db)`)  | caller-supplied `db`                            | **unscoped in the default path** — same conclusion as F16's trace (site 2 below)                                                                                              |
| 4   | `createPartialFromOrder()`    | `:2701` (`invoiceNumber = await this.generateInvoiceNumber()`) | none                                            | **unscoped** — function opens at `:2567`; `runCreation`/tx defined at `:2709` but not opened until later; the number is minted before any tx exists                           |
| 5   | `duplicate()`                 | `:4406` (`invoiceNumber: await this.nextInvoiceNumber()`)      | none (via `nextInvoiceNumber()`)                | **unscoped**; the surrounding `.create()` call itself IS tenant-scoped (`this.prisma.forTenant().invoice.create(...)`, `:4404`) but the **number** is computed unscoped first |

Site 3's `db` resolution (unchanged mechanism from the F16 trace, re-confirmed structurally at this HEAD):
`createSplitInvoices` is called with a `db` that is `this.prisma` on the normal (non-nested-tx) path, so it
hits the same bare-client branch as sites 2/4/5 on every path except one that already holds a tenant-wrapped
`tx`.

**A sixth-known, same-shape reimplementation inside `estimates.service.ts` — `convertToInvoice()`,
`:245-252`:**

```
218  async convertToInvoice(id: string) {
219    return this.prisma.tenantTransaction(async (tx) => {
...
245      const year = new Date().getFullYear();
246      const prefix = `INV-${year}-`;
247      const last = await tx.invoice.findFirst({
248        where: { invoiceNumber: { startsWith: prefix } },
249        orderBy: { invoiceNumber: "desc" },
250      });
251      const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
252      const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;
```

This `tx` comes from `this.prisma.tenantTransaction(...)` opened at `:219`, so (per the tenant-wrapping
mechanics below) this copy IS tenant-scoped — but it shares the identical `TEXT`/`orderBy desc`/`padStart(4)`
9999 wall, and it is an independent hand-copy of `generateInvoiceNumber`, not a call to it.

**Tenant-scoping mechanics — `apps/api/src/prisma/prisma.service.ts`:**

- `forTenant()` (`:296-300`) is opt-in:
  ```
  296  forTenant() {
  297    const tenantId = this.tenantCtx?.getOrNull() ?? null;
  298    if (!tenantId) return this;
  299    return this.$extends(this._tenantExtension(tenantId)) as unknown as this;
  300  }
  ```
  The un-extended `this.prisma` (used by every unscoped call site above) applies no tenant filter at all.
- `tenantTransaction()` (`:48-63`) DOES auto-wrap its `tx` via `_wrapTxWithTenant` (`:61`, `:70-165`) when a
  tenant is set. `findFirst` is one of the `SCOPED_METHODS` (`:80-92`) that gets `{ ...args.where, tenantId }`
  injected (`:160-165`) — so a `tx` obtained FROM INSIDE `tenantTransaction` is safe; a bare `this.prisma`
  obtained BEFORE one opens (sites 2/4/5 above) is not.
- **`upsert` is deliberately NOT tenant-scoped on `where`** — `:141-154`:
  ```
  141                } else if (method === "upsert") {
  142                  // `where` is deliberately NOT tenant-scoped here: Prisma compiles an
  143                  // extra non-unique filter in an upsert `where` into the
  144                  // `ON CONFLICT DO UPDATE … WHERE` predicate, so a row whose `tenantId`
  145                  // column is NULL (legacy `PaymentCounter` rows, created before the
  146                  // create-side injection landed) makes the upsert resolve `null` and the
  147                  // caller 500s. Scoping `where` needs (1) a null guard throwing
  148                  // `tenantNotFound` and (2) a backfill migration for legacy rows —
  149                  // tracked follow-on; today every tx-proxy upsert caller keys on the
  150                  // tenant id or a compound unique, so the gap is unexploited.
  151                  args = {
  152                    ...args,
  153                    create: { ...args.create, tenantId },
  154                  };
  155                }
  ```
  This is load-bearing for any fix that reuses the `PaymentCounter`-style upsert pattern: a future
  `InvoiceCounter` counter row must key on something unique on its own (never rely on a scoped `where`).
- No RLS: `tenantTransaction` sets the `app.current_tenant_id` session GUC (`:56-58`) but no Postgres RLS
  policy consumes it anywhere in this schema.

**Unique constraint — `apps/api/prisma/schema/finance.prisma:155-224` (`Invoice` model), key lines:**

```
155  model Invoice {
156    id                     String        @id @default(uuid())
157    invoiceNumber          String
...
203    tenantId               String?
...
218    @@unique([tenantId, invoiceNumber])
219    @@index([customerId])
220    @@index([orderId])
221    @@index([deliveryBatchId])
222    @@index([status])
223    @@index([dueDate])
224    @@index([createdAt])
```

The constraint IS tenant-scoped (a `P2002` on collision only fires within one tenant's own numbers) — the bug
is entirely in how the candidate number is _computed_, not in the constraint. Note `tenantId String?` is
**nullable** on `Invoice` (relevant to the backfill shape below).

**Sibling generators sharing the identical pad-4/pad-5 desc-string-sort shape** (grepped `padStart\(4|5, "0"\)`
across `apps/api/src`; each independently re-opened this pass):

| generator                        | file:line                                                                                            | scoping                                                                                                                | prefix / pad                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextEstNumber()`                | `estimates.service.ts:15-24`                                                                         | `this.prisma.forTenant()` (`:18`) — **scoped**                                                                         | `EST-${year}-`, pad-4                                                                                                                              |
| `convertToInvoice()` inline copy | `estimates.service.ts:245-252`                                                                       | `tx` from `tenantTransaction` (`:219`) — **scoped**                                                                    | `INV-${year}-`, pad-4 (see above)                                                                                                                  |
| `nextCnNumber(db)`               | `credit-notes.service.ts:34-43`                                                                      | called as `this.nextCnNumber(tx)` at `:244`, inside `this.prisma.tenantTransaction(...)` opened at `:102` — **scoped** | `CN-${year}-`, pad-4                                                                                                                               |
| `nextBillNumber()`               | `vendor-bills.service.ts:172-181`                                                                    | `this.prisma.forTenant()` (`:175`) — **scoped**                                                                        | `BILL-${year}-`, pad-4                                                                                                                             |
| `nextStatementNumber(db)`        | `sales-agents/commission-statements.service.ts:68-77`                                                | takes caller-supplied `db`, not traced this pass                                                                       | `CST-${year}-`, pad-4; **the file's own comment at `:67` reads** `/** Copies generateInvoiceNumber's max+1 scan pattern (invoices.service.ts). */` |
| order number generator           | `orders.service.ts:2230-2246` (approx., inside a `tenantTransaction` tx)                             | scoped via tx-wrap                                                                                                     | `ORD-`, pad-5; guards the parse (`Number.isFinite(seq) ? seq : 1`) and retries (`MAX_RETRIES` loop) — invoices does neither                        |
| a PO-numbering generator         | located in `inventory.service.ts` (grep hit for `padStart(4, "0")` at `:1025`; not traced this pass) | not verified                                                                                                           | not verified                                                                                                                                       |

This list matches the registry's own suggested-fix note verbatim: "Apply the same fix to the EST/CN/BILL/PO/CST/ORD
generators." **Only the five sites named in the design of record (§9 below) are in this run's committed
scope** — `invoices.service.ts` `:495`, `:1222`, `:2701`, `:4406`, and `estimates.service.ts:245-252`. The
other siblings (own-number generators for EST/CN/BILL/PO/CST/ORD, as opposed to the `convertToInvoice` copy
that mints an _invoice_ number) are the same shape but are NOT part of B100's fix per the design of record —
whether they get filed as siblings is an S2/sibling-sweep question, not this brief's to decide.

## Transaction / locking around the mint

- **No Postgres advisory lock covers invoice-number minting today.** `apps/api/src/common/db-locks.ts` defines
  a CLOSED allow-list of lock families — `export const LOCK_FAMILIES = ["order-merge", "cron"] as const;`
  (`:83-84`) — `withAdvisoryLock` throws a `TypeError` for any other family (`:196-200`). Invoice-number minting
  uses neither family; it relies solely on whatever serialization `tenantTransaction`/Postgres itself provides
  (none, for the four sites minted OUTSIDE a transaction) plus a `P2002` catch with NO retry.
- **P2002 handling — three sites, identical shape, no retry:**
  - `:333-339` (doc comment above the `create()` catch): _"RF-026: Previously, concurrent invoice creates both
    read the same last invoice number and one crashed with Prisma P2002 → HTTP 500. Now catches P2002 and
    returns 409 Conflict instead."_ — the author's own historical note that this race was already known.
  - `:556-559` (`create()`): `// RF-050: duplicate invoiceNumber under concurrent requests` →
    `if (err?.code === "P2002") throw new ConflictException("Invoice number conflict — please retry.");`
  - `:1293-1296` (`createSplitInvoices`, same ternary the F16 pass cited, now at `:1290-1292`:
    `return db === this.prisma ? await this.prisma.tenantTransaction(runCreation) : await runCreation(db);`):
    identical `P2002` → `ConflictException` catch, no retry.
  - `:2743-2746` (`createPartialFromOrder`): identical catch, no retry.
    A retry after any of these 409s re-runs the identical unscoped/lexicographic scan and gets the identical
    candidate — for the 9999-wall case this makes the failure permanent, not transient (confirmed by re-reading
    the generator body above: nothing about a second call changes `last`).
- **The `PaymentCounter` pattern — the only atomic-counter precedent in this codebase** —
  `apps/api/prisma/schema/finance.prisma:349-357`:
  ```
  349  model PaymentCounter {
  350    id       String  @id @default("singleton")
  351    next     Int     @default(1)
  352    tenantId String?
  353
  354    tenant Tenant? @relation(fields: [tenantId], references: [id])
  355
  356    @@index([tenantId])
  357  }
  ```
  used at `invoices.service.ts:4683` / `:4979` / `:5282` (three call sites, grepped this pass), pattern:
  `tx.paymentCounter.upsert({ where: { id: counterKey }, update: { next: { increment: 1 } }, create: { id:
counterKey, next: 2 } })` where `counterKey = this.prisma.getTenantId() ?? "singleton"`. `update: { next: {
increment: 1 } }` compiles to an atomic `SET next = next + 1`; the `upsert` on the PK compiles to `INSERT …
ON CONFLICT ("id") DO UPDATE … RETURNING`, which takes a row lock — a concurrent transaction blocks on that
  row rather than racing it. This is the pattern the design of record (§9 below) directs reuse of, with the
  `upsert`-`where`-is-not-scoped caveat above as a load-bearing condition on the key shape.

## History

`git log -5 --format="%h %ad %s" --date=short --`:

- **`apps/api/src/invoices/invoices.service.ts`**:
  ```
  4d977168 2026-09-07 fix(api,web): kpi awaiting-confirmation basis; spec 37 token (#659)
  e02851af 2026-09-07 fix(api,web,mobile): list caps, pagination and date windows (f16) (#656)
  151c3f70 2026-09-06 fix(api,web,mobile): credit-note wallet integrity (f09 b66 b67 b18 b19) (#636)
  1f6483ec 2026-09-05 fix(api,web,mobile): calendar dates render and compare in the right zone (F25) (#617)
  22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  ```
  None of the last 5 commits touched `generateInvoiceNumber`/`nextInvoiceNumber` — `#656` (F16) touched other
  parts of this same file (the list-caps/pagination/KPI rows) and left the generator untouched, consistent with
  the cause-ruling's explicit "B100 is NOT built here" carve-out.
- **`apps/api/prisma/schema/finance.prisma`**: exactly **one** commit in history —
  `60d10e66 2026-09-05 fix(types,api,mobile,web): wave E — shared enums/DTOs (10b) + schema folder split (10a) (#621)`
  — the commit that split the single `schema.prisma` into the domain-file folder. The `Invoice` and
  `PaymentCounter` models were relocated by that split, not modified.
- **`git blame -L 2773,2783` on `generateInvoiceNumber`'s full body**: every line attributes to
  `c620aae0c (Najath Akram 2026-03-31)` — the function has been byte-for-byte unchanged for over five months,
  through every later PR touching this file.
- **`git blame -L 218,218` on the `@@unique([tenantId, invoiceNumber])` line**: attributes to `60d10e66a
2026-09-05` — the schema-split commit (a mechanical relocation, not a substantive change; `finance.prisma`'s
  single-commit history above confirms nothing else touched it).

## Existing tests around this behavior

- **`apps/api/src/invoices/invoices.service.spec.ts`** (6,900+ lines) references `invoiceNumber` and
  `generateInvoiceNumber` extensively, but **every** reference is one of two shapes, neither of which exercises
  the generator's own scoping/sort logic:
  1. A hardcoded fixture string (`invoiceNumber: "INV-2026-0001"`, `"INV-1"`, etc.) used as input data for
     unrelated behavior (totals, statuses, PDF rendering) — dozens of occurrences, e.g. `:210`, `:231`, `:259`,
     `:340`, `:3413`.
  2. `jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue(...)` (e.g. `:1726`, `:1792`,
     `:1840`, `:6617`, `:6642`, `:6665`, `:6711`, `:6912`) — this REPLACES the real method, so it proves nothing
     about the real method's cross-tenant scoping or its lexicographic-sort behavior.
  3. `prisma.invoice.findFirst.mockResolvedValue(null); // for nextInvoiceNumber` (e.g. `:243`, `:539`, `:698`,
     `:3425`, `:6439`) — a trivial null stub so `generateInvoiceNumber` falls into its `seq = 1` branch; it
     never seeds a `9999`/`10000`-shaped row or a cross-tenant row, so it cannot observe either defect.
  - Re-checked this pass with a direct grep for `9999`, `10000`, and `cross-tenant` inside this spec file: **no
    matches** — confirms the F16-era refutation's "existing coverage: none" claim still holds at the current
    HEAD.
- No `*.db.spec.ts` (the DB-backed lane, `npm run local:test:db`) exists for `invoices.service.ts` numbering.
- `apps/api/src/common/enum-parity.spec.ts` is not relevant here — `invoiceNumber` is a free-text `String`
  column, not a Prisma enum; nothing in this bug touches an enum mirror.

## How migrations are laid out

- **Schema is a folder**, not a file: `apps/api/prisma/schema/{_base,tenancy,catalog,sales,finance,platform,compliance}.prisma`.
  `apps/api/prisma.config.ts` (`:1-20`, full file):
  ```
  4  export default defineConfig({
  5    earlyAccess: true as any,
  6    // Multi-file schema (item 10a): every *.prisma under this folder is one datamodel.
  7    // Split/verified by `node scripts/split-prisma-schema.mjs --check`.
  9    schema: path.join("prisma", "schema"),
  10   migrations: {
  14     path: path.join("prisma", "migrations"),
  15     seed: "npx tsx ./prisma/seed.ts",
  16   },
  ```
  Both `Invoice` and `PaymentCounter` live in `apps/api/prisma/schema/finance.prisma` — a new `InvoiceCounter`
  model belongs in that same file.
- **`MODEL_DOMAIN` map** — `apps/api/scripts/split-prisma-schema.mjs:184`: `PaymentCounter: "finance",` — an
  unmapped model fails `--check` (no "misc" bucket). A new `InvoiceCounter` model needs its own entry in this
  map, mapped to `"finance"`, or `--check` fails.
- **Newest migration folder** (alphabetical == chronological for the zero-padded timestamp prefix):
  `apps/api/prisma/migrations/20260910000000_order_idempotency/migration.sql` (full file, 15 lines) —
  representative shape for an additive migration in this repo: a header comment explaining WHY and confirming
  no backfill/no reader-writer race, then plain DDL:
  ```
  -- F30/R8: additive-only idempotency support for POST /orders. ...
  -- AlterTable
  ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;
  -- CreateIndex
  CREATE UNIQUE INDEX "Order_tenantId_idempotencyKey_key" ON "Order"("tenantId", "idempotencyKey");
  ```
- **Squawk (`npm run lint:migrations` → `node scripts/lint-migrations.mjs`)**: wraps `squawk-cli`, config at
  `apps/api/.squawk.toml`. Only **9 of 40** rules are gated (rest are advisory-only, excluded deliberately —
  see the file's header comment): `ban-drop-table, ban-drop-column, ban-drop-database, changing-column-type,
adding-required-field, renaming-column, renaming-table, ban-truncate-cascade, syntax-error`. A pure `CREATE
TABLE "InvoiceCounter" (...)` migration trips none of these; `adding-required-field` would trigger only if
  the fix also added a non-nullable column to an EXISTING table. `lint-migrations.mjs` additionally requires
  every `-- squawk-ignore <rule>` line to be immediately preceded by a `-- reason: <why>` line, checked BEFORE
  invoking squawk itself (`lint-migrations.mjs:26-29`).
- **Prod apply path**: `railway run --service postgres node apps/api/scripts/prod-migrate.mjs` (CLAUDE.md,
  quoted below) — never a bare `prisma migrate deploy` from the repo root (schema-folder resolution is
  cwd-relative to `apps/api`).

## CLAUDE.md — "Deployment & DB safety" (quoted, the lines this run must follow)

> Docker `CMD` is **only** `node dist/main.js` — **never** auto-migrate on deploy.
>
> **The Prisma schema is a FOLDER, not a file** ... Add a model to the domain file it belongs to **and** to the
> `MODEL_DOMAIN` map in `apps/api/scripts/split-prisma-schema.mjs` — an unmapped model fails `node
apps/api/scripts/split-prisma-schema.mjs --check` (there is no "misc" bucket).
>
> Schema changes apply to prod **only** via `railway run --service postgres node
apps/api/scripts/prod-migrate.mjs` (a bare `prisma migrate deploy` only resolves the schema folder +
> `prisma.config.ts` when run from `apps/api` — cwd-relative — so this script `cd`s there internally instead of
> relying on the caller's cwd); locally `npx prisma migrate dev` against docker-compose.
>
> **Never** `--force-reset`; **never** run the destructive scripts listed in `CLAUDE_SESSION_PREAMBLE.md`; seed
> additively.
>
> Destructive migrations are blocked in CI by Squawk (`npm run lint:migrations`); whitelist a statement with
> `-- reason:` + `-- squawk-ignore <rule>`.
>
> `npm run db:drift -w apps/api` (`apps/api/scripts/schema-drift.mjs`) is the drift gate: read-only `prisma
migrate status` + `migrate diff … --exit-code` against the target DB, exit 0 = no drift. Any schema PR runs it
> against prod after deploy ... and requires exit 0.

Also the money-discipline rule bearing on any counter/backfill write: _"All line/tax/total math lives in
`packages/pricing` ... Round every monetary write"_ — not directly load-bearing for invoice NUMBERING (not a
money amount), but the surrounding invariant that every persisted numeric write in this codebase is expected to
be deliberate and auditable applies equally here.

## `db-migration` skill — hard rules (quoted, `.claude/skills/db-migration/SKILL.md`)

> - **Never auto-migrate on deploy.** The Docker `CMD` is only `node dist/main.js`. Pushing code to
>   `master`/`develop` redeploys app code; it must NOT touch the Railway database.
> - **Prod migrations only via** `railway run npx prisma migrate deploy` (controlled, by a human).
> - **Never** `prisma migrate reset` / `db push --force-reset` against any DB with real data.
> - **Never** call the destructive scripts named in `CLAUDE_SESSION_PREAMBLE.md` ...
> - **Multi-tenant**: new models/columns must carry/relate to `tenantId`; every query stays tenant-scoped.
> - Destructive migrations are blocked in CI by Squawk ...
>
> Commit the generated migration **with** the code that uses it (same PR, separate commit from impl).
>
> Seeding (QA / test data): Additive only: `INSERT ... ON CONFLICT DO NOTHING` style; idempotent.

The "new models/columns must carry/relate to `tenantId`" line is directly on point: a new `InvoiceCounter`
model must carry `tenantId` (as `PaymentCounter` already does, `finance.prisma:352`) — consistent with the
design of record's `${tenantId}:${year}` key below.

## Lessons register — entries this run must carry (`.claude/lessons/LESSONS.md`, IDs + Lesson lines quoted)

- **L-072** (`domain`, wave E `imp-10b`) — _"Never hand-declare a client mirror of a server (Prisma) enum —
  derive one const-array union per enum from a shared package and pin it set-equal to `Object.values()` of the
  real enum in a spec, never against a second hand-typed 'expected' list."_ Symptom was enum drift, but the
  underlying shape — independently hand-copied logic drifting invisibly — is exactly B100's shape: six
  hand-copied number generators (`generateInvoiceNumber`, `nextEstNumber`, the `convertToInvoice` inline copy,
  `nextCnNumber`, `nextBillNumber`, `nextStatementNumber`), no shared helper.
- **L-081** (`domain`, F09) — _"gate a money write inside the primitive that performs it, on the row it just
  read ... sibling primitives and result-injecting mocks bypass a where-only fix."_ Directly on point for
  B100: five mint call sites currently call two different implementations (`generateInvoiceNumber` vs. the
  `estimates.service.ts` inline copy); a fix that patches only one primitive leaves the others on the old
  scheme, and two invoices in the same tenant could then be minted by two different numbering schemes and
  collide.
- **L-061** (`testing`, wave B′ P4) — _"A client-extension catch-all cannot coexist with a named map ... And a
  spec that calls an extension handler directly proves nothing about how the framework COMPOSES it: exercise
  the composed chain (a real client, or the DB lane)."_ Bears on how B100's regression tests must be built: a
  unit test that injects a `findFirst` mock result (as every existing invoice-number test does today, per
  "Existing tests" above) cannot prove concurrent-mint serialization — only a DB-lane spec (`*.db.spec.ts`, run
  via `npm run local:test:db`) against real Postgres can.
- **L-089** (`domain`, #656 — the F16 batch this bug was split out of) — _"a total, a lookup, a match or a
  search is computed by the database over the whole (open) set, or the view is labelled partial; a cap is a
  rendering budget and never an arithmetic boundary; every paginated order carries an id tiebreaker."_ Adjacent
  context, not directly about counters, but the sibling bug batch B100 was split from; establishes the "L-072
  hand-copy" and "L-081 gate-the-primitive" pattern is the SAME reviewing lens that will apply here.
- Grepped `.claude/lessons/LESSONS.md` case-insensitively for `migrat` — **zero matches**. No existing lesson
  discusses Prisma migrations specifically; this run would be the first to record one if the fix surfaces a
  transferable migration-specific lesson.

## Data repair — what a backfill must compute (query SHAPE only; nothing run)

Design of record §9 (quoted below) requires: _"a migration adds the table AND seeds each `(tenantId, year)`
from the NUMERIC max of existing `INV-<year>-*` suffixes (never the string max)."_ The shape this implies,
read against `finance.prisma:155-224`'s actual columns (`id`, `invoiceNumber`, `tenantId String?`,
`createdAt`) — described, not executed:

- **Group existing `Invoice` rows by `(tenantId, year)`**, where `year` is extracted from the `invoiceNumber`'s
  own `INV-<year>-` prefix (not from `createdAt` — an invoice created in December and paid/edited in January
  keeps its ORIGINAL minted year in the number). For each group: **parse the numeric suffix** of every
  `invoiceNumber` matching `^INV-<year>-(\d+)(-R\d+)?$` (the split-invoice sibling suffix `-R{i}`, confirmed
  still produced at `:1234` today, must be stripped before parsing — `split("-")[2]` as the generator itself
  does) and take the **MAX** of the parsed integers as that `(tenantId, year)`'s seed value for the new
  counter's `next`.
- **Separately identify (not silently coerce) any `invoiceNumber` under a given tenant that does NOT match the
  expected pattern** — a non-`INV-` legacy value, a malformed suffix, anything `parseInt` on today's generator
  would already choke on silently. These need a manual-review list, not an automatic fold into the MAX.
- **Open question this pass could not resolve (flagged for S2/Fable, not answered here):** `Invoice.tenantId`
  is nullable (`finance.prisma:203`, `String?`). Whether any live `Invoice` rows currently have `tenantId IS
NULL` was NOT checked in this pass (no database access) — if any exist, the backfill's `GROUP BY tenantId`
  needs an explicit decision for the null-tenant bucket (exclude, or a dedicated sentinel key) before it can
  run. This is a data-integrity fact to check against prod (read-only) before the ruling finalizes the
  migration's exact `GROUP BY`/seed logic.
- This is a **prod data migration** — CLAUDE.md's Railway rules apply in full (fresh backup →
  `prod-migrate.mjs` → deploy → drift gate; owner ack required before the migration is applied, per the
  design of record).

## Production evidence

None gathered. This agent has no database access (explicit constraint on this run) and did not query Railway
logs or row counts. The registry row's own evidence section (quoted above, "Evidence…") is CODE evidence
(file:line citations), not runtime/production evidence — no log lines, corrupted-row counts, or affected-tenant
counts have been collected by anyone for this bug yet. Any prod-side evidence (e.g., whether any tenant has
actually crossed the platform-wide 9999 mark, or whether any non-`INV-<year>-####`-shaped `invoiceNumber`
already exists) would have to come from the read-only backfill-report script the design of record and the
db-migration skill both require before any repair runs.

## Design of record (quoted verbatim — do not re-design; this run implements this and only this)

**From `.claude/pipeline/2026-09-07-F16-list-caps/cause-ruling.md` §9, "B100 — split, not dropped":**

> Own run (`fix/F16b-invoice-number-counter`) after this PR merges: single primitive `nextInvoiceNumber(tx,
tenantId, year)` backed by `InvoiceCounter { id = "<tenantId>:<year>", next }` (PaymentCounter pattern,
> upsert+increment under the row lock, called LAST inside the creating transaction, bounded retry on P2002),
> used by ALL five mint paths (`:444`, `:1171`, `:2650`, `:4187`, `estimates.service.ts:245`), migration adds
> the table AND seeds each `(tenantId, year)` from the NUMERIC max of existing `INV-<year>-*` suffixes (never
> the string max). Prod: fresh backup → `prod-migrate.mjs` → deploy → drift gate. **Owner ack required before
> the migration is applied.** DB-lane specs (L-061) for the race and the cross-tenant scan; unit spec for the
> 9999 wall.

(Line numbers `:444`/`:1171`/`:2650`/`:4187` are as they stood at F16's HEAD `19a419ba`; this brief's
"Code path" section above re-locates the same five call sites at the current HEAD `8a1f1eab`: `:495`, `:1222`,
`:2701`, `:4406`, and `estimates.service.ts:245-252`.)

**From `cause-ruling.md` §1 (verdict table row) and §2 ("Must NOT change"):**

> B100 | confirmed (two defects: unscoped scan + lexicographic max; five mint paths; real race) |
> `invoices.service.ts:2726-2729` reached from `:444`, `:1171`, `:2650`, `:4187`; copy at
> `estimates.service.ts:247-249` | directionally right, incomplete (year in the key, numeric max-seq BACKFILL
> migration, single primitive per L-081, retry) — **needs a prod migration → own run, §9**
>
> **Must NOT change:** `MAX_LIST_LIMIT`; the `limit=0` sentinel ... `buyer/statement.service.ts`;
> `matchStatementLines`; `resolveBackingLine`; any Prisma schema (no migration in **that** PR — B100's schema
> change is explicitly deferred to THIS run); the numbering mint (B100) [was excluded from F16's own PR].

**From `refutation.md` (S2, Opus @ high) — the four conditions on reusing `PaymentCounter`, verdict CONFIRMED:**

> 1. Transaction/lock semantics — sound (atomic `SET next = next + 1`, row lock via `upsert` on the PK); the
>    counter read should be the LAST statement in the transaction to shorten the lock hold.
> 2. The tx proxy handles `upsert` specially [not tenant-scoping `where`] and this is load-bearing — an
>    `InvoiceCounter` must key on a value unique on its own, never rely on a scoped `where`.
> 3. The key must include the year — key on `${tenantId}:${year}`.
> 4. A backfill is mandatory ... must seed each `(tenantId, year)` counter from `MAX(seq)` of that tenant's
>    existing `INV-<year>-*` numbers, and the seeding must parse the NUMERIC suffix (not the string max, which
>    is the very bug being fixed). This is a PROD DATA MIGRATION — CLAUDE.md's Railway rules apply.
>
> VERDICT: confirmed — two independent defects at one diverging line ... reached from [the five sites]. The
> record's suggested fix is directionally right but incomplete: it omits the year in the counter key, the
> max-seq backfill, the single-primitive requirement, and the fact that a P2002 retry today is a no-op.

## Open unknowns (what S2 most needs to check, beyond re-confirming the above at this HEAD)

1. Whether `createSplitInvoices`'s `db` argument (site 3) is EVER called with an already-tenant-wrapped `tx`
   in production traffic (the F16 refutation flagged this as traced-but-not-exhaustively-confirmed; this pass
   did not re-trace every upstream caller either).
2. Whether any live `Invoice.tenantId IS NULL` rows exist (this pass had no DB access to check) — directly
   gates the backfill's `GROUP BY` shape.
3. Whether `nextCnNumber`'s and `nextStatementNumber`'s `db`-parameter scoping (credit-notes, commission
   statements) needs to be pulled into THIS run's radius or stays filed separately — the design of record's
   §9 names exactly five mint paths and does not include these.
4. Whether a bounded-retry loop (the `orders.service.ts:2143-2287`-style `MAX_RETRIES` pattern) is still
   needed on top of the counter, or whether the counter's row-lock alone makes a `P2002` on `InvoiceNumber`
   structurally unreachable post-fix (the design of record's §9 says "bounded retry on P2002" — worth
   S2 re-confirming why a retry is still needed if the counter is race-free by construction).

## Facts the ruling needs

1. The generator (`invoices.service.ts:2773-2783`) has been byte-identical since `c620aae0c`, 2026-03-31 —
   this is not a recent regression; it has been present through every intervening release.
2. Five mint call sites at current HEAD `8a1f1eab`: `:495` (`create()`), `:1222` (`createSplitInvoices`),
   `:2701` (`createPartialFromOrder`), `:4406` (`duplicate()`) — all four unscoped — plus the tenant-scoped but
   same-walled inline copy at `estimates.service.ts:245-252`. These map 1:1 to the design of record's five
   `:444`/`:1171`/`:2650`/`:4187`/`estimates:245` citations (F16-era line numbers); nothing has been added or
   removed from the set.
3. `Invoice.tenantId` is **nullable** (`finance.prisma:203`) — the backfill's tenant grouping must have an
   explicit answer for a null-tenant row, and whether any exist in prod is unverified by this pass (no DB
   access).
4. No advisory-lock family exists for invoice numbering — `db-locks.ts`'s `LOCK_FAMILIES` is a closed
   `["order-merge", "cron"]`; the design of record's counter approach does not need a new family (it uses a
   `PaymentCounter`-style row-lock via `upsert`, not `withAdvisoryLock`), but if the ruling ever considered the
   advisory-lock module as an alternative, it is not currently wired for this use.
5. The `upsert`-`where`-not-tenant-scoped behavior (`prisma.service.ts:141-154`) is load-bearing for the
   counter's key design — an `InvoiceCounter` row MUST be addressable by a value unique on its own
   (`${tenantId}:${year}`), never by a scoped `where`.
6. Zero existing tests exercise `generateInvoiceNumber`'s real scoping or sort behavior — every current
   reference either hardcodes a fixture string or mocks/spies the method away. A regression test that seeds
   real `findFirst`-shaped data (a `9999` row, or a second tenant's row) has never existed for this function.
   Per L-061, the concurrent-mint and cross-tenant claims can only be PROVEN by a DB-lane spec — a mocked unit
   test proves nothing about actual Postgres serialization.
7. `PaymentCounter` (`finance.prisma:349-357`) is the only atomic-counter precedent in this schema, used at
   three call sites in `invoices.service.ts` (`:4683`, `:4979`, `:5282`) for PAYMENT numbers — its `key =
tenantId ?? "singleton"` shape does NOT include a year, which is why the design of record requires
   `InvoiceCounter`'s key to be `${tenantId}:${year}` instead (a straight copy of `PaymentCounter`'s key shape
   would carry the sequence across year boundaries, contradicting "starting at 0001" each year).
8. A new `InvoiceCounter` model must be added to `apps/api/prisma/schema/finance.prisma` (where `Invoice` and
   `PaymentCounter` already live) AND registered in the `MODEL_DOMAIN` map at
   `apps/api/scripts/split-prisma-schema.mjs:184`-adjacent (`PaymentCounter: "finance",` is the existing
   precedent line) — `--check` fails on an unmapped model with no "misc" bucket.
9. Squawk's gated rule set (9 of 40, `apps/api/.squawk.toml`) does not block a pure `CREATE TABLE
"InvoiceCounter"` migration; it WOULD block `adding-required-field` if the fix also added a non-nullable
   column to an existing table, so the migration shape should stay additive-only (new table, no altered
   columns) to avoid needing a `-- squawk-ignore` justification.
10. The three P2002 catch sites (`:556-559`, `:1293-1296`, `:2743-2746`) all convert the collision straight to
    a 409 with **no retry today** — `RF-026`'s own doc comment (`:335-339`) shows the author already knew about
    the concurrent-mint race when writing the 409 path, but never closed the loop with a retry.
11. This run needs an owner acknowledgment before the migration is applied to prod — both the design of record
    (§9: "Owner ack required before the migration is applied") and CLAUDE.md's general Railway rules require
    a human-run `prod-migrate.mjs`, never an automated deploy-time migration.
12. Open, unresolved by this pass (no DB access): whether any live `invoiceNumber` values exist that do NOT
    match the `INV-<year>-####` pattern at all (would need to surface in the backfill's manual-review list
    rather than being silently folded into a MAX computation).
