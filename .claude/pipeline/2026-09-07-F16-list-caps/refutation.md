# Cause refutation — F16 batch (B12, B80, B89, B100, B110, B117, B144, B169)

> S2 adversarial pass (Opus @ high, READ-ONLY). Every `path:line` below was re-opened in this pass; nothing is
> carried over from the S1 brief on trust. Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`,
> branch `fix/F16-list-caps-numbering`, HEAD `19a419ba` (`docs(registry): spec 29 kpi-race bookkeeping
follow-up for #654 (#655)`) — confirmed with `git -C … log --oneline -3` / `rev-parse --abbrev-ref HEAD`.
> No file was edited, no test run, no install. Commands run: `sed -n`, `grep`, `git log/status/rev-parse`.
>
> **Method.** Each row's suspicion is treated as a claim to be broken. The registry's SUGGESTED FIX is treated
> as a second, separate claim (this registry's suggested fixes have been refuted whole-batch before — F11).
> Where the brief left an "open unknown" that a read could settle, it was read.
>
> **Lessons consulted** (`.claude/lessons/LESSONS.md`, 40,456 bytes, at the byte cap):
>
> - **L-047** (domain, F25) — _"evaluate day boundaries in the TENANT's timezone through the one api helper —
>   never `setHours`, local getters or `toLocaleDateString` on a date-only field"_, and _"a test for any of
>   this must take the zone as DATA: under `TZ=UTC` … a host-clock oracle is green on the buggy body"_.
>   Decisive for **B89** — it partially **refutes the record's own suggested fix**.
> - **L-081** (domain, F09) — _"gate a money write inside the primitive that performs it … sibling primitives
>   and result-injecting mocks bypass a where-only fix"_. Bears on **B100** (four hand-copied minting
>   primitives) and **B110/B12** (aggregate at the source, not at one caller).
> - **L-072** (domain, wave E) — hand-copied mirrors drift invisibly. Bears on **B100** and **B117**
>   (two byte-identical `fetchMatchableBills` copies).
> - **L-060 / L-061** (testing, wave B′ P4) — a spec that calls a handler directly proves nothing about how
>   the framework composes it; a red pin is a live defect report. Bears on every "add a spec" plan here.
> - **L-063 / L-034 / L-083** (tooling) — never split the api jest invocation; regenerate campaign reports.
>   Process-level, carried to close-out only.
> - **The `limit=0` fetch-all sentinel trap** (memory `reference_limit0_fetchall_sentinel_trap`) — checked and
>   **does not apply to this batch**; see Cross-row §3 for the proof.
> - CLAUDE.md money discipline (`packages/pricing`, round every monetary write) and the tenancy rule
>   ("everything is tenant-scoped") bear on **B100** and **B110**.

---

## B12 — Invoice KPI tiles go wrong past 999 invoices

### What the claim says vs. what the tree does

Verified line by line.

`apps/web/app/(dashboard)/invoices/page.tsx:235-236` — the entire KPI bar's data source:

```
235   const { data: allData } = useInvoices({ limit: 999 });
236   const all: Invoice[] = allData?.data ?? [];
```

`PaymentSummaryBar`'s props are `activeFilter / onFilter / dueTodayActive / onDueTodayClick`
(`:226-234`) — **no data is passed in**. The `React.useMemo` at `:238-314` reads `all` and nothing else
(`for (const inv of all)` at `:261`, dep array `[all]` at `:314`), and returns
`{ totalOutstanding, dueToday, dueIn30, overdue, avgDays, awaitingConfirmationCount }` (`:313`). So **yes:
the `limit: 999` fetch is the KPI's only data source** — all six tiles, not five.

The API ceiling: `apps/api/src/common/pagination.ts:11` — `export const MAX_LIST_LIMIT = 1000;`, and
`apps/api/src/invoices/dto/list-invoices.dto.ts:35`:

```
35   @IsOptional() @IsInt() @Min(1) @Max(MAX_LIST_LIMIT) @Type(() => Number) limit?: number;
```

**What happens at exactly 1000+ invoices.** The request is `page` unset → `page=1`, `skip=0`, `take=999`
(`invoices.service.ts:2835-2846`), sorted by the server default `issueDate desc`
(`orderField = validSortFields[sortBy ?? ""] ?? "issueDate"`, `:2831`). At 1,000 invoices exactly, the single
oldest one is dropped from every tile. At 1,500, the 501 oldest are dropped. **The tenant is never told**:
`findAll` returns `meta.total` (`:2846`+), the client holds it in `allData.meta.total`, and the bar renders no
"showing 999 of N" caveat anywhere in `:316-360`.

**Bumping `limit` cannot fix it.** `@Max(MAX_LIST_LIMIT)` is 1000, so the largest legal fetch is 1000 rows.
There is no client-side value that makes the reduce correct past 1000 invoices — this is why the suggested
fix (a server aggregate) is the only shape that works, not merely the tidier one.

**Direction of the error.** Default sort is `issueDate desc`, so the rows dropped are the **oldest**, which
are exactly the long-unpaid and long-overdue ones. `totalOutstanding` and `overdue` therefore **understate**;
`avgDays` (Avg Days to Pay) is computed only over `status === "PAID" && sentAt && paidAt` rows in the window
(`:301-309`), so it silently becomes "average over the 999 most recent invoices" — a different statistic, not
a truncated one.

### Trace: input → wrong output

Tenant has 1,400 invoices, 40 of them unpaid and older than the 999th by `issueDate`. Operator opens
`/invoices` → `useInvoices({limit:999})` → `GET /api/v1/invoices?limit=999` → `findAll` returns rows 1-999 of
1,400 by `issueDate desc` plus `meta.total = 1400` → the memo at `:238` sums `balance` over those 999 →
"Total Outstanding" and "Overdue" omit the 40 oldest open balances → the operator reads a collections number
that is short by the amount most likely to be genuinely delinquent, with `meta.total` sitting unused in the
same response object.

### The record's SUGGESTED FIX

_"Add a server-computed summary endpoint/aggregate for the invoice-list KPI tiles (mirroring
`listAllPayments`' summary pattern)."_ — **Correct in shape, and the named precedent is real**:
`invoices.service.ts:4292-4307` computes `totalReceived` / `advanceBalance` from queries with no
`skip`/`take`, independent of the paginated page, and returns them under `summary`. Two caveats the fix text
does not carry:

1. **`avgDays` and `awaitingConfirmationCount` are not sums.** `avgDays` needs `AVG(paidAt − sentAt)` over
   PAID invoices; `awaitingConfirmationCount` counts DRAFT **payments** (`:271-273`), i.e. it is a count over
   `InvoicePayment`, not `Invoice`. Copying `listAllPayments`' "fetch all rows and reduce in JS" literally
   (`:4294-4298` fetches every PAID payment row with `select: {amount}`) reproduces the same unbounded-scan
   shape the cap exists to prevent — this should be a Prisma `aggregate`/`groupBy` or raw SQL, not a
   `findMany` + `reduce`.
2. **The tile logic is calendar-date logic, not money logic.** The memo compares `due` (`inv.dueDate.slice(0,10)`)
   against `todayLocalIso()` (`:53`, `:246`) — the **viewer's local** calendar day, with an explicit comment
   at `:239-245` saying that choice was deliberate (it must agree with the due-soon chips it triggers). A
   server aggregate evaluates "today" on the **server**. Moving the buckets server-side without threading the
   caller's/tenant's day boundary re-opens exactly the class L-047 closed. This is a real design constraint
   the one-line fix text omits, and it ties B12 to B89.

### Blocking test dependency (verified)

`apps/web/e2e/22-payment-truth.spec.ts:67-72`:

```
67  function summaryBarQuery(page: Page) {
68    return page.waitForResponse(
69      (r) => r.request().method() === "GET" && /\/invoices\?.*\blimit=999\b/.test(r.url()) && r.ok(),
70      { timeout: 30_000 },
71    );
72  }
```

Used at `:107` (`const barLoaded = summaryBarQuery(page);`) and referenced in a comment at `:266`. **Yes — it
depends on the literal URL.** Any fix that stops issuing a `limit=999` invoices request makes this
`waitForResponse` hang to its 30 s timeout and fail the spec. The fix diff must update this helper in the
same change.

**VERDICT: confirmed** — diverging line `apps/web/app/(dashboard)/invoices/page.tsx:235`.

---

## B80 — Payment receipt page reports "not found" for any payment outside the 200 most recent

### Where the receipt page looks the payment up

`apps/web/app/(dashboard)/finance/payments/[id]/page.tsx:27-37` — **a list of 200 plus a client-side find**,
exactly as claimed:

```
27  // Fetch the payment by searching all payments by id — use list with no filters,
28  // since we don't have a single-payment endpoint yet.
29  // We'll fetch a large page and find the matching one.
30  const { data, isLoading } = useInvoicePayments({ limit: 200 });
...
37  const payment = data?.data.find((p) => p.id === id);
```

and `:82-85` renders `Payment not found.` when that `find` misses.

### Does an id endpoint exist?

**Yes, and it is live.** `apps/api/src/invoices/invoices.controller.ts:92-95`:

```
92  @Get("payments/:paymentId")
93  findPayment(@Param("paymentId") paymentId: string) {
94    return this.invoicesService.findPaymentById(paymentId);
95  }
```

Route ordering is safe — `@Get("payments/export")` (`:78`) and `@Post("payments/record")` (`:87`) are declared
**before** it, and `@Get("payments")` (`:123`) is a distinct path. Authorization: the class carries
`@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(UserRole.OPERATOR)` (`:42-43`) and the method adds no
override, so it is OPERATOR-only — the same audience as the `(dashboard)` receipt page.

`invoices.service.ts:4314-4330` — `findPaymentById` is a real single-row lookup:
`this.prisma.forTenant().invoicePayment.findUnique({ where: { id: paymentId }, include: {…} })`, throwing
`NotFoundException` when absent. `forTenant()` post-filters `findUnique` by `tenantId`
(`prisma.service.ts:166-174`), so a cross-tenant id resolves to `null` → 404, not a leak.

`apps/web/lib/api/invoices.ts:706-712` defines `usePaymentDetail(id)` against that route.
`grep -rn "usePaymentDetail" apps/web apps/mobile` returns **exactly one line — its own export at
`invoices.ts:706`**. The hook is dead code.

### The shape question the brief left open — settled

The brief flagged "not diffed in this pass: does `usePaymentDetail`'s response carry every field the page
reads?" It does. The page touches exactly: `amount, bankCharges, createdAt, id, imageKey, invoice.customer,
invoice.id, invoice.invoiceNumber, method, notes, paidAt, paymentNumber, reference, settledAt, status`.
`listAllPayments`' `include` (`invoices.service.ts:4274-4283`) and `findPaymentById`'s `include`
(`:4317-4327`) are **the same object, field for field**: `invoice: { select: { id, invoiceNumber, customerId,
customer: { select: { id, businessName } } } }`. Both return the full `InvoicePayment` row (no `select` on the
payment itself), so every scalar the page reads is present. The swap is shape-safe.

### Trace: input → wrong output

Tenant records its 201st payment. Operator opens `/finance/payments` (which pages the same list) and clicks a
row for an older payment → `router.push('/finance/payments/<id>')` (`finance/payments/page.tsx:789` / `:841`)
→ the detail page fetches `GET /invoices/payments?limit=200` sorted `paidAt desc`
(`invoices.service.ts:4272`) → the target id is at position 300 → `.find` returns `undefined` → `"Payment not
found."` for a row the operator is looking at, while `GET /invoices/payments/<id>` would have returned it.

### The record's SUGGESTED FIX

_"Swap the client-side find for the existing `usePaymentDetail(id)` hook."_ — **Correct and complete.** The
endpoint exists, is wired, is role-correct, and returns a byte-identical `include`. Two mechanical
consequences to carry: `useInvoice(payment?.invoice.id ?? "")` at `:41` and the `getPaymentImageUrl` effect
at `:49-58` both already guard on `payment?` being undefined during load, so they survive the swap unchanged;
and the stale comment at `:27-29` ("we don't have a single-payment endpoint yet") must go with it.

**VERDICT: confirmed** — diverging line `apps/web/app/(dashboard)/finance/payments/[id]/page.tsx:30`
(the `limit: 200` list fetch), realised at `:37`.

---

## B89 — Invoice and payment date filters close the window at server-local end of day

### The four sites (all re-read, all present)

`grep -rn "setHours(23" apps/api/src --include=*.ts | grep -v spec` returns **five**, not four:

| #   | site                                                                              | column                  | column's nature  |
| --- | --------------------------------------------------------------------------------- | ----------------------- | ---------------- |
| 1   | `apps/api/src/invoices/invoices.service.ts:2802` (`findAll`, `dateFrom`/`dateTo`) | `Invoice.issueDate`     | calendar date    |
| 2   | `apps/api/src/invoices/invoices.service.ts:2815` (`findAll`, `dueFrom`/`dueTo`)   | `Invoice.dueDate`       | calendar date    |
| 3   | `apps/api/src/invoices/invoices.service.ts:4253` (`listAllPayments`)              | `InvoicePayment.paidAt` | **real instant** |
| 4   | `apps/api/src/invoices/invoices.service.ts:5381` (`exportPayments`, returns CSV)  | `InvoicePayment.paidAt` | **real instant** |
| 5   | `apps/api/src/import/import.service.ts:1178-1180`                                 | (not in the record)     | —                |

Site 1, verbatim:

```
2798      where.issueDate = {};
2799      if (dateFrom) where.issueDate.gte = new Date(dateFrom);
2800      if (dateTo) {
2801        const end = new Date(dateTo);
2802        end.setHours(23, 59, 59, 999);
2803        where.issueDate.lte = end;
```

The asymmetry is real: `new Date("2026-08-26")` parses as `2026-08-26T00:00:00.000Z` (UTC, per the
ECMAScript date-only form), then non-`UTC` `setHours` mutates the instant by the **Node process's** local
offset. The `gte` side stays true UTC midnight. Confirmed.

### Which timezone should it close on? — the record's fix is HALF WRONG

**There is a tenant timezone**, in two places: `apps/api/prisma/schema/tenancy.prisma:202`
(`timezone String @default("America/New_York")`) and `apps/api/prisma/schema/platform.prisma:389`
(`TenantConfig.timezone String?`). **This very service already reads it** —
`invoices.service.ts:203-214` (`resolveTenantInvoiceDefaults` selects `timezone`) and uses it at `:465`,
`:604`, `:2388`, `:2613`: `startOfCalendarDay(new Date(), tenantDefaults.timezone)`.

**Does the web send an explicit ISO end instant? No.** The invoices page builds `todayStr = todayLocalIso()`
(`invoices/page.tsx:53`, `:449`) and sends bare `YYYY-MM-DD` for `dueFrom`/`dueTo` (`:471-474`); the payments
page's `dateTo` is an `<input type="date">` value (`finance/payments/page.tsx:445`, `:463`, `:630`). The
server therefore owns the end-of-day resolution entirely.

Now the split the record misses:

- **`issueDate` / `dueDate` are calendar dates stored as UTC midnight.** `issueDate` is written by
  `startOfCalendarDay(...)` (a UTC-midnight _symbolic_ stamp — `calendar-date.ts:125-133`), `dueDate` by
  `addCalendarDays(issueDate, dueDays)` or `new Date(dto.dueDate)` (`invoices.service.ts:607-609`, `:2616-2620`).
  For these, **`setUTCHours(23,59,59,999)` is correct** and `endOfCalendarDay(date, tz)` would be **wrong**:
  `calendar-date.ts:145-155` returns _next local midnight − 1 ms_, i.e. `2026-08-27T03:59:59.999Z` for
  `America/New_York`, which would sweep in every invoice stamped `2026-08-27T00:00:00.000Z` — a next-day
  leak. So sites 1 and 2 take the record's fix.
- **`paidAt` is a real instant.** `finance.prisma:304` — `paidAt DateTime @default(now())`, written as
  `new Date()` / `new Date(dto.paidAt)` (`invoices.service.ts:4461`, `:4815`). "Payments received on
  2026-08-26" is a wall-clock question, so per **L-047** the correct bound is
  `endOfCalendarDay(dateTo, tenantTimezone)`, **not** `setUTCHours`. `setUTCHours` at sites 3 and 4 is
  correct only for a UTC tenant and silently mis-windows a New York tenant's payments by 4-5 hours at both
  edges. The record's blanket "use `setUTCHours` at all four sites" **fixes 1-2 and leaves 3-4 wrong in a
  new way** (it converts a server-TZ bug into a tenant-TZ bug, which is what L-047 was written about).

**One more convention break, found in this pass:** `finance.prisma:185` — `issueDate DateTime @default(now())`
— and `duplicate()` (`invoices.service.ts:4185-4196`) creates its invoice with **no `issueDate`**, so a
duplicated invoice's `issueDate` is a wall-clock instant, not UTC midnight. That row will fall outside a
`lte 23:59:59.999Z` window only if created after 23:59:59.999Z UTC — i.e. never — so it does not break the
B89 fix, but it does break the "issueDate is always UTC midnight" invariant the fix reasons from, and it is a
live latent defect for anything that compares `issueDate` as a calendar date.

### Latent or live?

`grep -rn "TZ=" apps/api/Dockerfile docker-compose.yml railway.toml apps/api/package.json` → **no matches**.
`apps/api/Dockerfile:2,44` — `FROM node:20-alpine`, which ships no `/etc/localtime` override, so Node runs
**UTC** in the Railway container. **B89 is therefore latent in production and live on any non-UTC developer
machine** (this one is Windows/local-TZ). That does not downgrade it — it means a future `TZ` env var, base
image change, or a locally-run script silently changes reported money windows. It also means **the fix cannot
be validated by observing prod**; the proof has to be a zone-as-data spec.

### The spec that pins the bug (quoted)

`apps/api/src/invoices/invoices.service.spec.ts:3211-3217`:

```
3211    it("passes dueFrom/dueTo through as a dueDate range, widening dueTo to end-of-day", async () => {
3212      await service.findAll({ dueFrom: "2026-08-26", dueTo: "2026-08-26" } as any);
3213
3214      const expectedEnd = new Date("2026-08-26");
3215      expectedEnd.setHours(23, 59, 59, 999);
3216      expect(whereArg().dueDate).toEqual({ gte: new Date("2026-08-26"), lte: expectedEnd });
3217    });
```

**Yes, it pins the wrong behavior — and worse, it is a self-referential oracle**: the expectation is built
with the _same_ local `setHours` the production line uses, so it is green under every TZ on both the buggy and
a wrongly-"fixed" body. This is verbatim the failure mode L-047 names ("a host-clock oracle is green on the
buggy body"). Any fix must replace it with an oracle that states the instant literally
(`new Date("2026-08-26T23:59:59.999Z")`) and, for `paidAt`, drives the tenant timezone as **data**. Note
L-047's second half: an in-file `process.env.TZ` pin is **inert** under Jest — the zone must come from the
tenant record, not the host.

**VERDICT: confirmed** — diverging lines `apps/api/src/invoices/invoices.service.ts:2802`, `:2815`, `:4253`,
`:5381`. The record's suggested fix is **correct for `:2802`/`:2815` and wrong for `:4253`/`:5381`**, which
need `endOfCalendarDay(dateTo, tenantTimezone)` per L-047.

---

## B100 — Invoice numbers minted from unscoped cross-tenant max+1; pad-4 string sort jams at 9999

### (a) Is the mint query really unscoped, and what is the unique constraint?

**Unscoped: yes.** `apps/api/src/invoices/invoices.service.ts:2722-2732`, full body:

```
2722  private async generateInvoiceNumber(db?: any): Promise<string> {
2723    const client = db ?? this.prisma;
2724    const year = new Date().getFullYear();
2725    const prefix = `INV-${year}-`;
2726    const last = await client.invoice.findFirst({
2727      where: { invoiceNumber: { startsWith: prefix } },
2728      orderBy: { invoiceNumber: "desc" },
2729    });
2730    const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
2731    return `${prefix}${String(seq).padStart(4, "0")}`;
2732  }
```

The `where` is `{ invoiceNumber: { startsWith: prefix } }` — **no `tenantId`**. And `this.prisma` is the bare
client: `prisma.service.ts:296-300` shows `forTenant()` is opt-in (`if (!tenantId) return this;` then
`this.$extends(...)`), so the un-extended `this.prisma` applies **no** tenant filter. There is **no RLS
backstop** — `grep -rli "row level security" apps/api/prisma/migrations` returns **0 files**
(`| wc -l` → `0`). `tenantTransaction` does set `app.current_tenant_id` (`prisma.service.ts:54-58`) but with
no policies that session GUC is inert.

**Unique constraint: per-tenant, not global.** `apps/api/prisma/schema/finance.prisma:218` —
`@@unique([tenantId, invoiceNumber])`. So the constraint is correct; the _candidate_ computation is what is
broken. This asymmetry — global scan, per-tenant constraint — is what produces the "one more, then permanent
409" shape below.

### (c) How many mint sites, and do they share a helper?

**Five distinct minting code paths; four are the same helper, one is a hand-copy. Every path that does not
receive a tenant-wrapped `tx` scans globally.** The brief left the `db`-argument path as an open unknown;
this pass settles it:

| #   | site                                                                            | how it gets `db`                       | scoped?                                                                         |
| --- | ------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | `invoices.service.ts:444` — `create()` via `nextInvoiceNumber()` (`:220-222`)   | none                                   | **unscoped** (minted at `:444`, the transaction opens at `:451`)                |
| 2   | `invoices.service.ts:1171` — `createSplitInvoices`, `generateInvoiceNumber(db)` | `db` from the caller                   | **unscoped in the default path** — see below                                    |
| 3   | `invoices.service.ts:2650` — `createPartialFromOrder()`                         | none                                   | **unscoped** (transaction opens at `:2710`)                                     |
| 4   | `invoices.service.ts:4187` — `duplicate()` via `nextInvoiceNumber()`            | none                                   | **unscoped**; the `create` at `:4185` uses `forTenant()`, the _number_ does not |
| 5   | `estimates.service.ts:245-252` — inline copy inside `convertToInvoice()`        | `tx` from `tenantTransaction` (`:219`) | **scoped** (via `_wrapTxWithTenant`), same 9999 wall                            |

Site 2 resolved: `createInvoiceFromOrder` sets `const db = txClient ?? this.prisma;`
(`invoices.service.ts:540`) and passes that `db` into `createSplitInvoices` (`:666-671`); the
fire-and-forget caller passes `db: this.prisma` **explicitly**, with a comment saying so
(`:2448-2454`: _"db = unscoped prisma with an explicit tenantId"_). And `:1238-1240` confirms the author knew
`db` is usually the bare client: `return db === this.prisma ? await this.prisma.tenantTransaction(runCreation)
: await runCreation(db);` — the **create** is wrapped, the **number** (minted at `:1171`, before that line)
is not. So site 2 is unscoped on every path except one that already holds a tenant-wrapped tx.

Sibling generators with the same padded-desc-string shape:
`estimates.service.ts:15-24` (`nextEstNumber`, `forTenant()` — correctly scoped, `padStart(4)`) and
`orders.service.ts:2230-2238` (inside a `tenantTransaction` tx, `padStart(5)`). **No shared helper exists** —
each is an independent reimplementation (L-072's exact failure mode: independent hand-copies drift and are
fixed one at a time).

Two robustness deltas worth carrying: orders guards the parse (`Number.isFinite(seq) ? seq : 1`, `:2238`)
and **retries** (`MAX_RETRIES = 3` loop at `:2143-2287`, catch at `:2289`, with an explicit RF-014 comment at
`:2227-2229` saying the number is minted _inside_ the transaction precisely so a P2002 can be retried).
Invoices does **neither**: `generateInvoiceNumber` has no `isFinite` guard, and both P2002 handlers
(`:2692-2695` and `:1242-1246`) convert the collision straight into
`ConflictException("Invoice number conflict — please retry.")` with no retry.

### (b) Does the pad-4 string ordering jam at 9999, or wrap/duplicate?

**It jams — after exactly one successful mint per tenant.** The sort is `orderBy: { invoiceNumber: "desc" }`
on a `TEXT` column (`finance.prisma:157` — `invoiceNumber String`; `0_init/migration.sql` shows a plain TEXT
column plus `CREATE UNIQUE INDEX "Invoice_tenantId_invoiceNumber_key"` — **no Postgres `SEQUENCE` backs
numbering anywhere**). `padStart(4,"0")` does not truncate, so the 10000th number is the 10-character string
`INV-2026-10000`, and lexicographically `'INV-2026-9999' > 'INV-2026-10000'` (first differing byte `'9'`
0x39 vs `'1'` 0x31 — true under both C and ICU digit ordering).

Step by step, with the global scan and the per-tenant constraint interacting:

1. Platform-wide, the highest `INV-2026-####` reaches `INV-2026-9999` (owned by any tenant — the scan is
   global, so all tenants share one climbing sequence).
2. Tenant A mints: `findFirst` returns `INV-2026-9999` → `seq = 10000` → candidate `INV-2026-10000`. Tenant A
   has no such row → **the create succeeds**.
3. Tenant A mints again: `findFirst` still returns `INV-2026-9999` (it out-sorts `…-10000`) → candidate
   `INV-2026-10000` again → violates `@@unique([tenantId, invoiceNumber])` → P2002 → `ConflictException` at
   `:2692-2695`.
4. Retry re-runs the identical unscoped scan → identical candidate → **409 forever**. Not transient.

So: no wrap, no silent duplicate — a hard, permanent 409 on invoice creation for every tenant, one mint after
the platform crosses 9999 in a calendar year. The verifier's nuance ("each tenant then gets exactly one more
invoice (its own -10000)") is exactly right.

Note the split-invoice suffix does **not** break the parse: siblings are `${baseNumber}-R${i}`
(`:1182`), so `split("-")[2]` still yields the padded digits.

### (e) Is there a race today, and what would prove it?

**Yes, and it is a distinct defect from the 9999 wall.** In `create()` the number is minted at `:444` and the
transaction opens at `:451`; in `createPartialFromOrder` minted at `:2650`, transaction at `:2710`; in
`duplicate()` there is no transaction at all. Two concurrent creates for the same tenant both read the same
`last`, both compute `N+1`, both attempt the write; one wins, the other gets P2002 → a **user-facing 409 on
an ordinary concurrent save**. The message string "Invoice number conflict — please retry." is itself
evidence the authors met this. (Two concurrent creates in _different_ tenants both succeed with the same
number — harmless per-tenant, but it proves the "sequence" is global.)

**What would prove it** (none of it run here): (i) a DB-lane spec (`*.db.spec.ts`, run by
`npm run local:test:db`) firing two `create()` calls concurrently against real Postgres for one tenant and
asserting today's behaviour is one 409 — per **L-061**, a unit test that injects the `findFirst` result proves
nothing about how Prisma/Postgres actually serialise; (ii) for the cross-tenant scan specifically, a two-tenant
DB spec asserting tenant B's first-ever invoice is `INV-YYYY-0001` (today it is `globalMax+1`); (iii) for the
9999 wall, a deterministic unit test seeding a `findFirst` mock with `INV-2026-9999` and asserting the
returned candidate is `INV-2026-10000` — then the same mock returning `INV-2026-10000` and asserting the
candidate is `…-10001` (red today).

**Existing coverage: none.** No spec in `invoices.service.spec.ts` names `generateInvoiceNumber`,
`invoiceNumber`, `9999` or `10000`.

### (d) Is the PaymentCounter pattern safe to reuse for invoices?

The pattern (`invoices.service.ts:4445-4452`, one of three call sites — `:4447`, `:4743`, `:5042`):

```
4445    const counterKey = this.prisma.getTenantId() ?? "singleton";
4446    const tenantShort = counterKey.slice(0, 6).toUpperCase();
4447    const counter = await tx.paymentCounter.upsert({
4448      where: { id: counterKey },
4449      update: { next: { increment: 1 } },
4450      create: { id: counterKey, next: 2 },
4451    });
4452    const paymentNumber = `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;
```

Model: `finance.prisma:349-357` — `PaymentCounter { id String @id @default("singleton") next Int @default(1)
tenantId String? … }`. The key is the **tenant id used as the primary key**, so it is per-tenant by
construction. It runs inside a `tenantTransaction` tx.

**Verdict on reuse: yes, with four conditions the record's fix text does not state.**

1. **Transaction/lock semantics — sound.** `update: { next: { increment: 1 } }` is an atomic
   `SET next = next + 1`, and an `upsert` on the PK compiles to `INSERT … ON CONFLICT ("id") DO UPDATE …
RETURNING`, which takes a row lock: a concurrent transaction blocks on that row and reads the post-commit
   value. Two committed transactions therefore cannot receive the same `next`. Worst case (a non-native
   upsert fallback on a first-ever insert) is a P2002 **on the counter row**, which is retryable and never
   yields a duplicate number — strictly better than max+1, which yields a duplicate _candidate_ by design.
   The cost is that all invoice creation for one tenant serialises on one row for the life of the
   transaction; acceptable, but it should be taken deliberately, and the counter read should be the **last**
   statement in the transaction, not the first, to shorten the lock hold.
2. **The tx proxy handles `upsert` specially and this is load-bearing.** `prisma.service.ts:141-154`
   deliberately does **not** tenant-scope an upsert's `where`, with a comment recording that scoping it makes
   a legacy `tenantId = NULL` `PaymentCounter` row resolve to `null` and 500 the caller; only `create` gets
   `tenantId` injected (`:152-153`). An `InvoiceCounter` must therefore key on a value that is unique on its
   own (the tenant id, or a compound) and never rely on a scoped `where`.
3. **The key must include the year.** Invoice numbers are `INV-${year}-` (`:2725`), so a counter keyed on
   `tenantId` alone continues across the year boundary instead of restarting at `0001` — which contradicts
   the record's own "Meant to do" ("its own clean INV-YYYY-NNNN sequence starting at 0001"). Key on
   `${tenantId}:${year}`.
4. **A backfill is mandatory and is missing from the fix text.** Every existing tenant already has invoices;
   a fresh counter starting at 1 re-mints `INV-2026-0001…` and P2002s against the existing rows on every
   create until it climbs past that tenant's current max. The migration must seed each
   `(tenantId, year)` counter from `MAX(seq)` of that tenant's existing `INV-<year>-*` numbers, and the
   seeding must parse the _numeric_ suffix (not the string max, which is the very bug being fixed). This is
   the largest unstated piece of work in the row, and it is a **prod data migration** — CLAUDE.md's Railway
   rules apply (`prod-migrate.mjs`, Squawk, drift gate).

Also note per **L-081**: fixing only `generateInvoiceNumber` leaves `estimates.service.ts:245-252`'s inline
copy on the old scheme, so two invoices in the same tenant could then be minted by two different schemes and
collide. The counter must be reached from a **single primitive that every mint site calls** — this is the row
where L-081's "gate it inside the primitive that performs the write" applies most directly.

**Minimal alternative (worth pricing against the counter).** Scoping the scan (`forTenant()`/tx) and sorting
numerically fixes both stated mechanisms with no migration: replace the string `orderBy` with a numeric
extraction, or keep max+1 but wrap the mint **inside** the transaction with the orders-style bounded retry
(`orders.service.ts:2143`, `:2289`). This does **not** close the concurrent-mint 409 as cleanly as a counter
does, and it leaves the pad-4 display convention in place. Both options are defensible; the record presents
only the counter and only as a sketch.

**VERDICT: confirmed** — two independent defects at one diverging line, `apps/api/src/invoices/invoices.service.ts:2726-2729`
(the unscoped `where` and the lexicographic `orderBy`), reached from `:444`, `:1171`, `:2650`, `:4187`, and
re-implemented at `apps/api/src/estimates/estimates.service.ts:247-249`. The record's suggested fix is
**directionally right but incomplete**: it omits the year in the counter key, the max-seq backfill, the
single-primitive requirement, and the fact that a P2002 retry today is a no-op.

---

## B110 — Customer statement Outstanding/Overdue silently drops unpaid invoices past a 100-invoice cap

### The caps, quoted

`apps/api/src/customers/customers.service.ts:873-912` — four parallel reads, three of them capped:

```
874      this.prisma.forTenant().invoice.findMany({
875        where: { customerId },
876        orderBy: { createdAt: "desc" },
877        take: 100,
...
888      this.prisma.forTenant().creditNote.findMany({
889        where: { customerId }, orderBy: { createdAt: "desc" }, take: 50,
...
902      this.prisma.forTenant().advancePayment.findMany({
903        where: { customerId }, orderBy: { receivedAt: "desc" }, take: 50,
...
914      this.prisma.forTenant().order.findMany({   // pendingOrders — NO take, NO orderBy
```

and the in-memory reduces at `:933-944` (`outstanding`, `overdue`) run over only those 100 rows.

### What the totals then omit — broader than the record says

`:1001-1007` returns `{ outstandingAmount, overdueAmount, availableCredit, advanceBalance,
pendingOrdersAmount, transactions }`. Every one of the first four is capped, in **two opposite directions**:

- `outstandingAmount` / `overdueAmount` (`:933-944`) — over the newest 100 invoices → **understated**
  (a receivable looks smaller than it is; ageing invoices are exactly the ones that fall out).
- `availableCredit` (`:950-959`) — over the newest 50 credit notes → **understated** (a customer's wallet
  looks smaller than it is: money the tenant owes the customer disappears).
- `advanceBalance` (`:961`) — over the newest 50 advance payments → **understated**.
- `transactions` (`:965-998`) — the statement ledger itself is the same 100/50/50 rows, so the list a
  collections call is read off is truncated with no marker.

So this is not one-directional: the same screen can simultaneously overstate what a customer owes (missing
credits) and understate it (missing old invoices). `pendingOrdersAmount` is the only figure computed over a
complete set — and its query has neither `take` nor `orderBy`, which is its own (opposite) problem.

`getMyStatement` (`:264-297`) is the same shape at `take: 50` for both invoices and credit notes, with no
advance-payment read at all.

### Is the statement also exported or emailed from this query? — **No. This partially refutes the record.**

The record's gap says the figure is wrong "on every surface". It is not. The **monthly statement PDF** —
the artefact a customer actually receives — is built by a different, **uncapped** method:
`apps/api/src/buyer/statement.service.ts:62-77`, `db.invoice.findMany({ where: { customerId, status: { notIn:
["DRAFT","VOID"] }, issueDate: { lt: to } }, orderBy: { issueDate: "asc" }, select: {…} })` — **no `take`**
(`grep -n "take:" statement.service.ts` → no matches; only three `orderBy` lines at `:68`, `:90`, `:203`).
It is consumed by `statement-pdf.service.ts:26` (`buildMonthlyStatement`). Its own comment at `:107-108`
says it deliberately reproduces _"getStatementForOperator.outstandingAmount semantics"_ — i.e. the correct
implementation of the same figure already exists in the repo, uncapped, and is the reference the fix should
be measured against.

The affected surfaces are the **live tiles**, and there are more of them than the record lists (verified by
`grep -rn outstandingAmount apps/web apps/mobile`): `customers/[id]/page.tsx:2390`, `:3694`, `:3853`, `:3971`
(four tiles on the operator customer page alone), `buyer/portal/[seller]/payments/page.tsx:260`,
`apps/mobile/app/(customer)/payments.tsx:120`, and — not in the record —
`apps/mobile/app/(operator)/customers/[id]/statement.tsx:118`. The buyer **finances** page consumes
`statement.availableCredit` (`buyer/portal/[seller]/finances/page.tsx:105`, `:181`), i.e. the 50-credit-note
cap, not `outstandingAmount`. Buyers reach the **operator** method:
`apps/api/src/buyer/buyer.controller.ts:248-255` — `getStatement(@CurrentBuyerCustomer() ctx)` returns
`this.customersService.getStatementForOperator(ctx.customerId)`. Confirmed.

### The second, separately-computed "Outstanding" on the same page — resolved

The brief flagged `customers/[id]/page.tsx:3531-3548` as untraced. It reads `invoicesData?.data`, whose
source is `:1956-1960`:

```
1956  const { data: invoicesData, isLoading: invoicesLoading } = useInvoices({
1957    customerId: params.id,
1958    status: invoiceFilter === "paid" ? "PAID" : invoiceFilter === "void" ? "VOID" : undefined,
1959    limit: 50,
1960  });
```

**It is a third instance of the same bug, at a third cap.** The Overview tab's "Outstanding" tile
(`:2390`) is the statement's 100-invoice figure; the Invoices tab's "Outstanding" card (`:3531-3541`) is a
client-side reduce over 50 rows. **On one page, two cards with the same label can print two different
numbers**, and both are wrong past their own cap. That is the most demonstrable symptom in this row and the
cheapest repro (a customer with > 50 invoices makes them disagree; > 100 makes both wrong).

### The record's SUGGESTED FIX

_"Compute outstanding/overdue with grouped SQL aggregates over ALL non-PAID/VOID/WRITTEN_OFF invoices …
keeping the take:100 list purely for display; apply the same to getMyStatement."_ — **Right direction,
incomplete in three ways.** (i) It addresses only outstanding/overdue and leaves `availableCredit` and
`advanceBalance` capped at 50 — same class, same screen, opposite sign. (ii) A grouped aggregate over
`Invoice.total` alone is **not** the figure: `outstanding` is `total − amountPaid` where `amountPaid`
excludes VOID payments (`:928-931`) and, per **L-081** and the F03 convention used in
`statement.service.ts:84-88` (`CONFIRMED_PAYMENT`), must exclude DRAFT payments too — this reduce currently
excludes VOID but **not DRAFT** (`:929` filters `p.status !== "VOID"` only), which is a separate,
already-present divergence from the statement PDF's basis. Any aggregate rewrite must pick one status set and
per L-081 that set belongs in `apps/api/src/invoices/invoice-status-sets.ts`, not hand-rolled a fifth time.
(iii) It does not mention the web-side 50-row twin at `customers/[id]/page.tsx:3531`, which no server change
fixes.

Existing coverage: `customers.service.spec.ts:991-1078` tests VOID-payment exclusion and credit expiry with a
handful of fixtures; **nothing exercises the cap boundary** and nothing pins the two page-level tiles against
each other.

**VERDICT: confirmed** — diverging lines `apps/api/src/customers/customers.service.ts:877` (`take: 100`),
`:889` and `:903` (`take: 50`), `:272` (`getMyStatement`, `take: 50`), and the client twin
`apps/web/app/(dashboard)/customers/[id]/page.tsx:1959` (`limit: 50`). The "every surface" wording is
**refuted** for the emailed/exported monthly statement, which is uncapped and correct.

---

## B117 — Statement bill matching caps candidates at 500 with no orderBy

### The caps and the missing orderBy, quoted

Both copies re-read; they are still identical, `take: 500`, **no `orderBy` at all**.

`apps/api/src/supplier-statements/supplier-statements.service.ts:541-554`:

```
541  private async fetchMatchableBills(supplierId: string | null): Promise<MatchableBill[]> {
542    if (!supplierId) return [];
543    const bills = await this.prisma.forTenant().vendorBill.findMany({
544      where: { supplierId, status: { not: "VOID" } },
545      select: { id: true, billNumber: true, supplierInvoiceNumber: true,
                   totalOwed: true, billDate: true, status: true },
553      take: 500,
554    });
```

`apps/api/src/supplier-statements/statement-apply.service.ts:445-458` — the same query, same `select`, same
`take: 500`, no `orderBy`, under a comment (`:435-443`) stating it _"Mirrors
`SupplierStatementsService.fetchMatchableBills` (WP2) exactly"_ and that it was **duplicated on purpose**.
Classic L-072 shape: a fix applied to one copy silently leaves the other.

**What "no orderBy" means concretely.** `VendorBill` has `@@index([supplierId])` (`finance.prisma:653`), so
Postgres will typically satisfy `WHERE supplierId = $1 AND status <> 'VOID' LIMIT 500` from that index — the
returned 500 are in index/ctid order, i.e. **roughly physical insertion order, not recency**, and mutable
(a non-HOT update or VACUUM moves a tuple). So the operator's mental model — "the matcher looked at my recent
bills" — is wrong in the worst possible direction: it is the **oldest** 500 that tend to win, and old bills
are the ones already paid. "Non-deterministically" is a mild overstatement (within one plan and one heap
state it is stable); "arbitrary, and not the recent ones" is the accurate and more damning statement.

### What the totals then omit / what actually happens

Verified end-to-end, and it **supports the verifier's downgrade rather than the record's original wording**:

1. Scan time — `matchAgainstBills` (`supplier-statements.service.ts:528-539`) hands the capped pool to
   `matchStatementLines`, so a line backed by an excluded bill reports `UNMATCHED`.
2. Apply time — `statement-apply.service.ts:176-179` **re-derives** the pool (`const matchableBills = await
this.fetchMatchableBills(supplierId); const matches = matchStatementLines(lines, matchableBills);`);
   it does not reuse a persisted scan result. Confirmed.
3. The write loop (`:202-…`) looks each confirmed bill up directly by id
   (`tx.vendorBill.findUnique({ where: { id: line.billId } })`, `:204`), so the cap does **not** silently
   redirect money. But every confirmed line must resolve a backing statement line:

```
241        const match = this.resolveBackingLine(matches, bill.id, line.lineIndex);
242        if (!match) {
243          throw new BadRequestException(
244            `No line on this statement backs the confirmed amount for bill ${bill.billNumber}.`,
```

and `resolveBackingLine` (`:402-416`) requires the bill to be among `chosen.candidates` (with
`lineIndex`) or among `matches`' primaries/candidates (without) — all of which come from the capped pool.
**So an excluded bill can never back a confirmed line: the apply throws a 400.** Money is never
mis-booked; the reconciliation is simply impossible. The verifier's correction to the record is right, and
the review UI compounds it — the picker offers `candidates`, which is the same capped pool, so the
operator cannot even hand-pick the correct bill.

No statement _totals_ are corrupted by this row (opening/closing balance reconciliation runs on the parsed
statement, not the bill pool); the damage is "false UNMATCHED + an unresolvable apply".

### The record's SUGGESTED FIX

_"Remove the cap or raise it with `orderBy: { billDate: 'desc' }` and, better, restrict candidates to bills
with outstanding balance (`totalOwed > totalPaid`) … apply the same change to both copies."_ — **Sound, with
one trap.** `totalOwed > totalPaid` cannot be expressed as a Prisma column-to-column comparison in a
`findMany` `where`, and `totalPaid` is a **denormalised** column the codebase explicitly distrusts:
`statement-apply.service.ts:256-258` computes `alreadyPaid` from the `payments` ledger and its comment
(`:255-256`) says _"never the denormalised totalPaid column, and never bill.status (landmine 1)"_. Filtering
candidates on `totalPaid` would contradict that rule and could hide a genuinely open bill whose denormalised
column is stale. The safe narrowing is `status: { notIn: ["VOID", "PAID"] }` plus `orderBy: { billDate:
"desc" }` — or dropping the cap outright, which is defensible: the `select` is six scalar columns and the
row set is one supplier's bills.

The two copies must change together, and — per L-072 — this is the moment to collapse them into one exported
helper rather than editing the duplicate a second time.

**VERDICT: confirmed** — diverging lines `apps/api/src/supplier-statements/supplier-statements.service.ts:543-554`
and `apps/api/src/supplier-statements/statement-apply.service.ts:447-458` (the `take: 500` with no `orderBy`).
The record's "the apply step books unreconciled activity" framing is **refuted** (already corrected by the
verifier): the apply hard-fails with a 400 at `statement-apply.service.ts:242-245`.

---

## B144 — Orders search filters only the loaded page and then hides the pager

### Is the search client-side over the loaded page only? — yes

`apps/web/app/(dashboard)/orders/page.tsx:340-349` — the fetch sends **no `search`**:

```
340  const { data, isLoading, isError } = useOrders({
341    status: statusFilter || undefined,
342    urgent: urgentOnly || undefined,
343    deliveryDateFrom: dateFrom || undefined,
344    deliveryDateTo: dateTo || undefined,
345    productId: productIdFilter || undefined,
346    fulfillPath: (fulfillPathFilter as "ROUTE" | "SHIP" | "") || undefined,
347    page,
348    limit,
349  });
```

and `:355-364` filters `orders` (the already-fetched page) in a `useMemo` on
`businessName` OR `orderNumber`. Default page size is 20 (`:196` — `React.useState(20)`), matching the
server default. So the search sees **20 of N orders**.

`apps/web/lib/api/orders.ts:174-185` — `useOrders`'s param type has no `search` field at all, so the miss is
type-level, not a forgotten argument.

### Does the API list endpoint already accept `search`? — yes, quoted

`apps/api/src/orders/dto/list-orders.dto.ts:14` — `@IsOptional() @IsString() search?: string;`

But the server's handling has **two** defects of its own, `apps/api/src/orders/orders.service.ts:322-333`:

```
323    if (user.role === UserRole.CUSTOMER) {
324      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
327      if (!customer) throw new ForbiddenException("Customer record not found");
328      where.customerId = customer.id;
329    } else if (customerId) {
330      where.customerId = customerId;
331    } else if (search) {
332      where.customer = { businessName: { contains: search, mode: "insensitive" } };
333    }
```

(i) `search` is dropped whenever `customerId` is present **or the caller is a CUSTOMER** — the verifier said
"no live UI currently triggers" the `customerId` case, which holds for this page (it sends no `customerId`),
but the **CUSTOMER-role branch is unconditional**: any buyer-side order search through this endpoint is
silently ignored. (ii) The server matches only `customer.businessName`, never `orderNumber` — while the input's
own placeholder is `"Search customer or order #…"` (`orders/page.tsx:631-637`) and the client-side filter does
match `orderNumber` (`:358`). So sending the current client query straight to the server would **narrow**
what matches today. Both must be fixed in the same diff or the fix regresses order-number search.

### Why does the pager hide?

`apps/web/app/(dashboard)/orders/page.tsx:999` and `:1018` — two unconditional `!customerSearch` guards:

```
 976              {customerSearch ? (
 977                filtered.length > 0 ? ( … Showing {filtered.length} of {meta.total} … (filtered) )
 985                ) : ( "No orders match your search" )
 999            {!customerSearch && ( …per-page <select>… )}
1018            {!customerSearch && (meta.totalPages ?? 1) > 1 && ( …prev/next buttons… )}
```

The guards were presumably added because the counts under a client-side filter are meaningless — but their
effect is that the moment a search returns nothing on page 1, **the only control that could reach page 2 is
removed**. The user sees "No orders match your search" with no navigation. The verifier's read (the count is
"ambiguous rather than a lie"; the unreachable-match half is the real defect) is correct and confirmed at
`:976-986`.

There is a **third** copy of the same client-side filter: the CSV export path at `:392-415` fetches
`limit: EXPORT_LIMIT` (`:392` — `const EXPORT_LIMIT = 1000;`) and re-filters in JS (`:406-415`), warning
"Exported first 1000 rows" when `total > EXPORT_LIMIT` (`:440-443`). So the export is capped **and**
client-filtered — a fix that moves `search` server-side should carry this call too, or the export and the
list will disagree about what "matching" means.

### One more thing found while verifying — an unrelated but adjacent gap

`apps/api/src/orders/dto/list-orders.dto.ts:17-18`:

```
17  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
18  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
```

**`limit` has no `@Max(MAX_LIST_LIMIT)`** — `grep -rn MAX_LIST_LIMIT apps/api/src` shows the cap applied on
`list-invoices.dto.ts:35`, `list-customers.dto.ts:10` and `sales-agents.controller.ts:107`, but **not** on
orders. `pagination.ts:1-10` states list endpoints must cap `limit` (security F9-001/002/003). Orders is the
one list in this batch that a caller can force an unbounded scan on (`GET /orders?limit=999999`). Out of
B144's stated scope, but it is the same file the fix touches and it is one decorator.

**VERDICT: confirmed** — diverging lines `apps/web/app/(dashboard)/orders/page.tsx:340-349` (no `search`
sent), `:357-363` (page-local filter), `:999` and `:1018` (pager hidden). The record's suggested fix is
**correct but insufficient as written**: dropping the guards and sending `search` regresses order-number
matching unless `orders.service.ts:331-333` is widened to an `OR` over `orderNumber`, and the `else if` chain
is restructured so `search` composes with `customerId` and with the CUSTOMER-role scope instead of being
swallowed by them.

---

## B169 — Orders, invoices and customers paginate on a non-unique sort column with no id tiebreaker

### The three `orderBy` sites, each quoted, none with a tiebreaker

1. `apps/api/src/orders/orders.service.ts:370` — inside the `findMany` at `:352-371`:
   `orderBy: { createdAt: "desc" },` — hardcoded, no client sort at all.
2. `apps/api/src/invoices/invoices.service.ts:2831-2833`:
   ```
   2831    const orderField = validSortFields[sortBy ?? ""] ?? "issueDate";
   2832    const orderDir = sortOrder === "asc" ? "asc" : "desc";
   2833    const orderBy: any = { [orderField]: orderDir };
   ```
   passed to `findMany` at `:2836-2845` with `skip`/`take`. The allowlist (`:2821-2830`) exposes `issueDate`
   (default), `dueDate`, `total`, `createdAt`, `status`, `invoiceNumber`.
3. `apps/api/src/customers/customers.service.ts:173`:
   `const orderBy: any = orderField ? { [orderField]: dir } : { createdAt: "desc" };`
   passed at `:186-188`. Allowlist (`:155-163`): `businessName`, `contactName`, `displayName`,
   `customerType`, `pricingTier`, `createdAt`, `updatedAt`.

Every one is a **single-key object literal**. Confirmed by reading each `findMany` in full.

### Concrete duplicate-value scenario, and how a row is skipped or repeated

The invoices list is the sharp case, and the tie is **structural, not incidental**: `issueDate` is written as
`startOfCalendarDay(new Date(), tenantTimezone)` (`invoices.service.ts:465`, `:604`, `:2388`, `:2613`) — a
UTC-midnight stamp. **Every invoice issued on the same calendar day therefore carries a byte-identical
`issueDate`.** A tenant issuing 25 invoices in a day, at the default page size, produces 25 exact ties across
the page-1/page-2 boundary.

Concretely, with 25 invoices all at `issueDate = 2026-08-26T00:00:00.000Z`, `limit = 20`:

- Page 1 → `… ORDER BY "issueDate" DESC OFFSET 0 LIMIT 20`. Postgres orders ties arbitrarily (a `top-N
heapsort` over 20, or index/heap order); say it returns invoices `{A…T}`.
- Page 2 → a **separate statement, separate snapshot** → `… OFFSET 20 LIMIT 20`. Nothing in SQL obliges the
  second execution to break the ties the same way. Two mechanisms make it differ in practice: (i) the plan
  itself changes with the different `LIMIT+OFFSET` bound (top-20 vs top-40-then-skip-20 select different
  members of an equal-key set); (ii) any UPDATE between the two requests rewrites the tuple — a non-HOT
  update relocates it in the heap, so a seq-scan or index-then-heap order changes. Ordinary traffic supplies
  those updates: `invoice.updateMany` at `invoices.service.ts:5446`, `orders.service.ts:5287`,
  `customers.service.ts:1599`, and every `recordPayment` status recompute.
- Net effect: if the tie order on the second execution promotes invoice `U` (previously position 21) into the
  first 20, then page 2 starts at what is now position 21 — which may be `T`, already shown on page 1
  (**repeated**) — and `U` is **never shown** (skipped). No signal to the operator; the row count in the
  footer still says "Showing 21 to 40 of 25".

The same argument applies with even more force to `sortBy=status` (≈8 distinct values → 100+ ties on a
200-invoice list) and `sortBy=total` (round amounts repeat), both of which the invoices allowlist exposes
(`:2827-2828`).

For orders, the verifier's caveat is right but the bar is lower than "same-transaction batch creation":
`Order.createdAt` is `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` (`0_init/migration.sql:209` and
siblings), and `CURRENT_TIMESTAMP` is the **transaction** timestamp — so any path creating more than one row
in one transaction produces exact ties, and even separate transactions collide at millisecond precision under
load. The invoices analogue is concrete and shipping: `createSplitInvoices`' sibling invoices are all created
inside one `runCreation(tx)` (`invoices.service.ts:1179-1235`), so base/`-R1`/`-R2` share a `createdAt` — and
`createdAt` is in the invoices sort allowlist.

### The record's SUGGESTED FIX

_"Append `{ id: 'desc' }` — matching the primary direction — as the final `orderBy` element in all three
`findAll` implementations; a one-line change per service with no API surface change."_ — **Correct, and the
cheapest correct fix.** Three notes: (i) Prisma needs the **array** form (`orderBy: [{ [orderField]:
orderDir }, { id: orderDir }]`), not a second key on the same object literal, or key order is not guaranteed
to be honoured as intended; (ii) `Invoice.id`/`Order.id`/`Customer.id` are `String` cuids, so the tiebreak is
lexicographic, not chronological — that is fine (it only needs to be _total_ and _stable_), but the direction
should follow the primary as the record says so the visible order does not invert within a tie group;
(iii) it is not free at scale — a composite `(sortcol, id)` ordering can drop an index-only plan on
high-row-count tenants. `Invoice` has `@@index([tenantId, issueDate])` (`finance.prisma:231`) but no
`(tenantId, issueDate, id)`; worth measuring, not worth blocking on.

There is a **fourth** site with the identical exposure that the row does not list: `listAllPayments`
(`invoices.service.ts:4266-4272`, default `{ paidAt: "desc" }`, allowlist including `amount` and
`createdAt`), which backs the paginated payments list B80 also touches. And `fetchMatchableBills` (B117) has
no `orderBy` at all — strictly worse than a missing tiebreaker.

Existing coverage: none. No spec in `orders.service.spec.ts`, `invoices.service.spec.ts` or
`customers.service.spec.ts` asserts the `orderBy` passed to `findMany`. A spec that asserts the argument
shape is cheap and, per **L-061**, honest about what it proves — it pins the _call_, not Postgres's
behaviour; the behavioural proof needs the DB lane.

**VERDICT: confirmed** — diverging lines `apps/api/src/orders/orders.service.ts:370`,
`apps/api/src/invoices/invoices.service.ts:2833`, `apps/api/src/customers/customers.service.ts:173`.
The suggested fix is right; use the array form and consider adding `apps/api/src/invoices/invoices.service.ts:4272`
(`listAllPayments`) as a fourth site.

---

## Cross-row

### 1. Shared root causes (same helper, same constant, same copy)

- **`MAX_LIST_LIMIT = 1000` (`apps/api/src/common/pagination.ts:11`) is the shared constant behind B12.** Its
  own doc comment (`:5-7`) blesses the idiom: _"well above every real UI call (the dashboard's largest
  'fetch-all' idiom is ~999)"_. The idiom is repo-wide, not invoice-specific — the identical
  `useX({ limit: 999 })` shape sits at `credit-notes/page.tsx:556`, `estimates/page.tsx:702`,
  `vendor-bills/page.tsx:1058` and `:2326`. **Fixing B12 alone leaves four siblings with the same latent
  wrongness**, and the doc comment will then describe a pattern the codebase is moving away from. Whether to
  sweep them is a scoping decision for the fix ruling; they are not in this batch's ids.
- **B12 / B80 / B110 / B117 / B144 are one defect class: an aggregate, a lookup, a match, or a search
  computed over a _capped page_ instead of over the _set_.** Six different caps —
  999 (`invoices/page.tsx:235`), 200 (`finance/payments/[id]/page.tsx:30`), 100 and 50
  (`customers.service.ts:877,889,903,272`), 50 (`customers/[id]/page.tsx:1959`), 500
  (`supplier-statements.service.ts:553` ×2), and page-size 20 (`orders/page.tsx:196`) — none of which is ever
  surfaced to the user as a limit. The generalizable lesson this batch should file (per the lessons routine)
  is one rule, not five: _a total, a lookup, or a search is computed by the database over the whole set, or it
  is labelled as a partial view; a `take`/`limit` is a rendering budget and must never be an arithmetic
  boundary._
- **B100 and B117 are both L-072 hand-copy failures.** B100 has five independent reimplementations of
  "parse `<PREFIX>-<year>-<padded int>`, `orderBy desc`, `+1`, `padStart`"
  (`invoices.service.ts:2722-2732`; `estimates.service.ts:245-252`; `estimates.service.ts:15-24`;
  `orders.service.ts:2230-2238`) with **no shared helper**; B117 has two byte-identical `fetchMatchableBills`
  copies that the code comment says were duplicated deliberately
  (`statement-apply.service.ts:435-443`). Both fixes must collapse the copies or the next fix repeats.
- **B89 and B169 both stem from the same storage convention** — calendar dates stored as UTC-midnight
  instants (`calendar-date.ts:1-8`). It is why `issueDate` ties are structural (B169) and why the `lte`
  bound must be a UTC day-end for `issueDate`/`dueDate` but a tenant-local day-end for `paidAt` (B89).
  A fix ruling that treats "date column" as one thing will get one of the two rows wrong.

### 2. Rows whose fix changes another row's path — ordering

Three collisions, all in `findAll` bodies:

- **`apps/api/src/invoices/invoices.service.ts` `findAll`** is touched by **B89** (`:2797-2818`, the `where`
  build), **B169** (`:2831-2833`, the `orderBy` build) and **B12** (a new aggregate, which will either live
  in this method or beside it and must reuse the same `where`). Land **B89 → B169 → B12**: B89 and B169 are
  small, adjacent, independent edits to the same block; B12's aggregate must be written against the
  _already-corrected_ `where` (otherwise the new server tiles inherit the local-`setHours` window and the fix
  ships a second wrong number) and against the _already-tiebroken_ ordering.
- **`apps/api/src/orders/orders.service.ts` `findAll`** is touched by **B144** (`:322-333`, the `else if`
  chain + widening `search` to `orderNumber`) and **B169** (`:370`, the `orderBy`). Same method, non-
  overlapping lines — one diff, either order. B144 should land the missing `@Max(MAX_LIST_LIMIT)` on
  `list-orders.dto.ts:18` at the same time, since a server-side `search` makes an uncapped `limit` more
  attractive to abuse.
- **`apps/api/src/customers/customers.service.ts`** is touched by **B110** (`:873-912`, `:933-944`, `:272`)
  and **B169** (`:173`, a different method) — no collision.

Independent of everything else: **B80** (one hook swap, `finance/payments/[id]/page.tsx:30`) and **B117**
(two `findMany` options objects) touch nothing another row touches. **B100** touches
`invoices.service.ts:2722-2732` plus `estimates.service.ts` and — if the counter route is taken — a Prisma
migration and a data backfill; it is the only row in the batch that requires a **prod migration**, so under
CLAUDE.md's deploy flow it must be sequenced first in its own PR (migration applied via
`prod-migrate.mjs` before the deploy) or last, but never bundled with the web-only rows.

### 3. The `limit: 0` fetch-all sentinel trap — checked, does not apply

Re-verified rather than carried over. `useOrders`, `useInvoices`, `useCustomers` and `useInvoicePayments`
all sit behind DTOs whose `limit` carries `@Min(1)`
(`list-invoices.dto.ts:35`, `list-orders.dto.ts:18`, `list-customers.dto.ts:10`), so a `0` sentinel would be
rejected by validation — the sentinel idiom lives only on the product hooks. **None of the eight rows'
endpoints can be reached with `limit: 0`**, and no fix here should introduce it. Flagged only so the fix
ruling does not "helpfully" reach for it.

### 4. Test-harness facts the fix ruling needs

- **One hard blocker**: `apps/web/e2e/22-payment-truth.spec.ts:67-72` waits on the literal
  `/\/invoices\?.*\blimit=999\b/` URL and is used at `:107`. **B12's fix breaks this spec** unless the helper
  changes in the same diff. It is the only cross-row test dependency in the batch.
- **One spec pins a bug**: `apps/api/src/invoices/invoices.service.spec.ts:3211-3217` (B89) — and its oracle
  is host-derived, so it cannot go red on the buggy body under any TZ (L-047).
- **Everything else is uncovered.** Greps found no test touching: `generateInvoiceNumber` / `9999` / `10000`
  (B100), `findPaymentById` (B80), the 100/50 statement caps (B110 — `customers.service.spec.ts:991-1078`
  tests adjacent semantics with a handful of fixtures), `take: 500` or `fetchMatchableBills` (B117), the
  orders `search` param or the `customerId`/`search` `else if` (B144), or any `orderBy` argument shape
  (B169).
- **Per L-061**, the B100 tenant-scoping and race claims and the B169 skip/repeat claim can only be _proven_
  in the DB lane (`npm run local:test:db`, `*.db.spec.ts`); a unit test that injects the `findFirst` result
  or asserts the `orderBy` argument pins the call, not the behaviour. State that distinction in the test plan
  rather than letting a green unit test stand in for it.
- **Per L-063 / L-034**, run `apps/api`'s suite unsplit (`npx jest --maxWorkers=2`) and regenerate the
  campaign report before `campaign-check` at close-out.

---

## Summary

| row  | verdict       | diverging `path:line`                                                                             | is the record's suggested fix right?                                                                                                                                                                        |
| ---- | ------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B12  | **confirmed** | `apps/web/app/(dashboard)/invoices/page.tsx:235`                                                  | right shape; must not copy `listAllPayments`' JS-reduce, and must resolve "today" the way the tiles do (L-047)                                                                                              |
| B80  | **confirmed** | `apps/web/app/(dashboard)/finance/payments/[id]/page.tsx:30`                                      | **right and complete** — endpoint live, role-correct, `include` identical                                                                                                                                   |
| B89  | **confirmed** | `apps/api/src/invoices/invoices.service.ts:2802, 2815, 4253, 5381`                                | **half wrong** — `setUTCHours` is right for `issueDate`/`dueDate`, wrong for `paidAt` (needs `endOfCalendarDay(…, tenantTz)`, L-047)                                                                        |
| B100 | **confirmed** | `apps/api/src/invoices/invoices.service.ts:2726-2729` (5 mint paths)                              | right direction, **incomplete** — omits year in the counter key, the max-seq backfill, and the single-primitive requirement (L-081)                                                                         |
| B110 | **confirmed** | `apps/api/src/customers/customers.service.ts:877, 889, 903, 272` + `customers/[id]/page.tsx:1959` | incomplete — leaves `availableCredit`/`advanceBalance` capped, the DRAFT-payment basis unsettled, and the 50-row web twin untouched; "every surface" is **refuted** (the monthly statement PDF is uncapped) |
| B117 | **confirmed** | `supplier-statements.service.ts:543-554` and `statement-apply.service.ts:447-458`                 | sound, but `totalOwed > totalPaid` contradicts the file's own "never trust `totalPaid`" rule; the "books unreconciled activity" framing is **refuted** (hard 400 at `statement-apply.service.ts:242`)       |
| B144 | **confirmed** | `apps/web/app/(dashboard)/orders/page.tsx:340-349, 357-363, 999, 1018`                            | **insufficient** — sending `search` regresses order-number matching unless `orders.service.ts:331-333` is widened and the `else if` chain restructured                                                      |
| B169 | **confirmed** | `orders.service.ts:370`, `invoices.service.ts:2833`, `customers.service.ts:173`                   | right; use Prisma's array form, and add `invoices.service.ts:4272` as a fourth site                                                                                                                         |

No row is refuted outright. Three rows carry a **refuted sub-claim** (B89's fix, B110's "every surface",
B117's "books unreconciled activity"), and four rows have suggested fixes that are incomplete or wrong as
written (B12, B89, B100, B110, B144). Nothing here is undetermined; the two facts this pass could not
establish (live tenant invoice/payment/bill counts, and the running container's `TZ`) affect _how soon_ each
row is observable, not whether the code diverges from intent.
