# Fix ruling — F16 (B12 · B80 · B89 · B110 · B117 · B144 · B169; B100 SPLIT to its own run) list caps, pagination, date windows

> Fable @ high, 2026-09-07, over `cause-brief.md` (S1) and `refutation.md` (S2) in this dir, both against master
> 19a419ba. Worktree `rf-registry`, branch `fix/F16-list-caps-numbering`. AGENT-SAFE (owner's blanket go for the
> backlog waves, 2026-09-06). ONE PR for the seven rows below; **B100 is NOT built here** (§9).

## 1. Cause verdicts (all confirmed by S2; every cited line re-opened)

| Bug  | Verdict                                                                                | Diverging line                                                                                                                                                                                                                                               | Record's suggested fix                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B12  | confirmed                                                                              | `apps/web/app/(dashboard)/invoices/page.tsx:235` — `useInvoices({ limit: 999 })` is the only source of all six KPI tiles; `@Max(MAX_LIST_LIMIT)`=1000 makes it unfixable client-side; drops the OLDEST (most delinquent) rows                                | right shape (server aggregate); must not copy `listAllPayments`' findMany+reduce; must keep the tiles' calendar-day semantics (L-047)                                                                                        |
| B80  | confirmed                                                                              | `finance/payments/[id]/page.tsx:30` (list of 200 + client find) while `GET /invoices/payments/:paymentId` (`invoices.controller.ts:92-95`, OPERATOR) and `usePaymentDetail` (`lib/api/invoices.ts:706`, dead) already exist with a field-identical `include` | right and complete                                                                                                                                                                                                           |
| B89  | confirmed                                                                              | `invoices.service.ts:2802, :2815` (issueDate/dueDate `setHours(23,…)`), `:4253, :5381` (paidAt)                                                                                                                                                              | HALF WRONG: `setUTCHours` is right for the UTC-midnight calendar columns, wrong for `paidAt` (a real instant → tenant-local day bounds via `endOfCalendarDay(dateTo, tz)`, L-047)                                            |
| B110 | confirmed                                                                              | `customers.service.ts:877` (`take:100` invoices), `:889`/`:903` (`take:50` credit notes / advances), `:272` (`getMyStatement`), plus the web twin `customers/[id]/page.tsx:1959` (`limit:50` reduce)                                                         | incomplete: leaves credit/advance capped, DRAFT-payment basis unsettled, the 50-row web twin untouched; "every surface" REFUTED (monthly statement PDF `buyer/statement.service.ts:62-77` is uncapped and correct)           |
| B117 | confirmed                                                                              | `supplier-statements.service.ts:543-554` and the deliberate byte-copy `statement-apply.service.ts:447-458` — `take:500`, no `orderBy` (index/heap order = oldest tend to win)                                                                                | sound except `totalOwed > totalPaid`, which contradicts the file's own "never trust the denormalised `totalPaid` / `bill.status`" rule; "books unreconciled activity" REFUTED (hard 400 at `statement-apply.service.ts:242`) |
| B144 | confirmed                                                                              | `orders/page.tsx:340-349` (no `search` sent), `:357-363` (page-local filter), `:999`/`:1018` (pager hidden); server `orders.service.ts:331-333` matches `businessName` only and drops `search` under `customerId` or the CUSTOMER role                       | insufficient as written: sending `search` regresses order-number matching unless the server side is widened and the `else if` chain restructured                                                                             |
| B169 | confirmed                                                                              | `orders.service.ts:370`, `invoices.service.ts:2833`, `customers.service.ts:173` — single-key `orderBy`; `issueDate` ties are STRUCTURAL (UTC-midnight stamps)                                                                                                | right; use Prisma's ARRAY form; add `invoices.service.ts:4272` (`listAllPayments`) as a fourth site                                                                                                                          |
| B100 | confirmed (two defects: unscoped scan + lexicographic max; five mint paths; real race) | `invoices.service.ts:2726-2729` reached from `:444`, `:1171`, `:2650`, `:4187`; copy at `estimates.service.ts:247-249`                                                                                                                                       | directionally right, incomplete (year in the key, numeric max-seq BACKFILL migration, single primitive per L-081, retry) — **needs a prod migration → own run, §9**                                                          |

## 2. Fix design — one rule, seven rows

**The rule:** a total, a lookup, a match or a search is computed by the database over the WHOLE set (or the whole
_open_ set), or it is labelled a partial view. A `take`/`limit` is a rendering budget, never an arithmetic boundary.

- **B12 — server KPI summary.** New `InvoicesService.getKpiSummary(today: string)` → `{ totalOutstanding, dueToday,
dueIn30, overdue, avgDays, awaitingConfirmationCount }` (money rounded with `roundMoney`). `today` is the
  VIEWER's calendar day `YYYY-MM-DD` passed by the client (the tiles must agree with the due-soon chips, page.tsx
  `:239-245`; L-047 — the server never derives "today" from its clock). Buckets compare `dueDate` (UTC-midnight
  stamp) against `T = new Date(today + "T00:00:00.000Z")`: overdue `dueDate < T`, dueToday `== T`, dueIn30
  `T < dueDate <= T+30d`. Basis: the OPEN set and the balance basis are EXACTLY the memo's at page.tsx `:238-314`
  (read it; `balance` is whatever findAll's enrichment gives — reproduce that basis from `invoice-status-sets.ts`,
  adding a named set there if none matches, never a hand-rolled status list). Implementation: one `findMany` over
  the tenant's OPEN invoices only with a minimal `select` (`total, dueDate, payments{amount,status}`) — bounded
  by business reality, not by a cap — plus `invoicePayment.count({ status: "DRAFT" })` for
  `awaitingConfirmationCount`, plus ONE `$queryRaw` (tenantId bound as a parameter) for
  `avgDays = AVG((paidAt − sentAt) in days)` over PAID invoices with both stamps. Controller: `@Get("kpi-summary")`
  declared BEFORE any `:id` route, OPERATOR guard as the class. Shared response type `InvoiceKpiSummary` in
  `packages/types/api/invoices.ts`. Web: `useInvoiceKpiSummary(today)` in `lib/api/invoices.ts`; `PaymentSummaryBar`
  reads it; delete `useInvoices({ limit: 999 })` and the memo. **Harness (mandatory in the same diff):**
  `apps/web/e2e/22-payment-truth.spec.ts:67-72` `summaryBarQuery` waits on `/invoices/kpi-summary` instead of
  `limit=999`. The four sibling `limit: 999` pages (credit-notes, estimates, vendor-bills ×2) are FILED, not fixed.
- **B80.** `finance/payments/[id]/page.tsx`: `usePaymentDetail(id)` replaces `useInvoicePayments({ limit: 200 })` +
  `.find`; the stale comment `:27-29` goes; the `payment?` guards at `:41` and `:49-58` stay.
- **B89.** Sites `:2802`/`:2815` (issueDate/dueDate, UTC-midnight stamps): `lte = new Date(dateTo + "T23:59:59.999Z")`
  (or the calendar-date helper that yields exactly that instant; `gte` unchanged). Sites `:4253`/`:5381` (`paidAt`,
  a real instant): BOTH bounds tenant-local — `gte = startOfCalendarDay(dateFrom, tz)`, `lte =
endOfCalendarDay(dateTo, tz)` with `tz` from `resolveTenantInvoiceDefaults` (already read by this service).
  Also `duplicate()` (`:4185-4196`): set `issueDate: startOfCalendarDay(new Date(), tz)` so the UTC-midnight
  invariant holds (one line, same invariant). `import.service.ts:1178-1180` is NOT in the record → FILED.
- **B110.** In `getStatementForOperator` (and `getMyStatement`), the four money figures come from UNCAPPED reads
  over the OPEN sets: outstanding/overdue over invoices in the open status set (from `invoice-status-sets.ts`)
  with payments restricted to the CONFIRMED basis used by `buyer/statement.service.ts:84-88` (exclude DRAFT and
  VOID — this aligns the live tile with the emailed statement; note it in the PR body); `availableCredit` over
  ALL unexpired credit notes with remaining balance; `advanceBalance` over ALL advance payments with remaining
  balance. Minimal `select`s; no `take` on these reads. The `take:100/50/50` reads STAY for the `transactions`
  ledger only, and the response gains `transactionsTruncated: boolean` (true when the capped list is shorter than
  the count) so the UI can label the partial view. Web twin: `customers/[id]/page.tsx` Invoices-tab "Outstanding"
  card (`:3531-3541`) reads `statement.outstandingAmount` (same number as the Overview tile); the 50-row reduce
  goes. Mobile/buyer surfaces read the API → inherit.
- **B117.** One exported helper `apps/api/src/supplier-statements/matchable-bills.ts`
  (`fetchMatchableBills(prisma, supplierId)`) used by BOTH services (the byte-copy at `statement-apply.service.ts`
  is deleted, L-072): `where: { supplierId, status: { not: "VOID" } }` (unchanged — the file forbids trusting
  `status`/`totalPaid`, so NO further status narrowing), `orderBy: [{ billDate: "desc" }, { id: "desc" }]`,
  **no `take`** (six scalar columns, one supplier's bills).
- **B144.** Server `orders.service.ts:322-333`: role scope, `customerId` and `search` COMPOSE (no `else if`
  swallowing); `search` → `OR: [{ orderNumber: { contains, mode: "insensitive" } }, { customer: { businessName:
{ contains, mode: "insensitive" } } }]`; `ListOrdersDto.limit` gains `@Max(MAX_LIST_LIMIT)`. Web
  `orders/page.tsx`: send `search` (deferred/debounced via the repo's existing pattern — grep `useDebounce`; else
  `useDeferredValue`), reset `page` to 1 when the search changes, delete the page-local `filtered` memo and BOTH
  `!customerSearch` guards (`:999`, `:1018`) so the pager always renders; "Showing X of N" reads `meta`; the CSV
  export at `:392-415` sends the same `search` instead of re-filtering. `useOrders` params gain `search`.
- **B169.** Array-form `orderBy` with the id tiebreaker in the primary's direction at `orders.service.ts:370`,
  `invoices.service.ts:2833`, `customers.service.ts:173` AND `invoices.service.ts:4272` (`listAllPayments`).
- **Must NOT change:** `MAX_LIST_LIMIT`; the `limit=0` sentinel (does not apply here, S2 §3 — never introduce it);
  `buyer/statement.service.ts`; `matchStatementLines`; `resolveBackingLine`; any Prisma schema (no migration in
  this PR); the numbering mint (B100).
- **Invariant:** every figure a tile, a statement or a receipt shows is computed over the whole (open) set with a
  tenant-bound query; every paginated list has a total, stable order; every day-window bound is derived from the
  column's own convention (UTC-midnight stamp vs tenant-local instant).

## 3. Regression tests — `bug-test-plan.md` (T1–T9). REG tokens `REG-B12 REG-B80 REG-B89 REG-B110 REG-B117 REG-B144 REG-B169`.

## 4. Blast radius (`radiusFiles`, read-only neighbours)

`apps/api/src/common/pagination.ts`, `apps/api/src/common/calendar-date.ts`, `apps/api/src/invoices/invoice-status-sets.ts`,
`apps/api/src/buyer/statement.service.ts`, `apps/api/src/buyer/buyer.controller.ts`, the module that exports
`matchStatementLines`, `apps/web/lib/api/invoices.ts`, `apps/web/lib/api/orders.ts`,
`apps/mobile/app/(customer)/payments.tsx`, `apps/mobile/app/(operator)/customers/[id]/statement.tsx`, `packages/types/api/invoices.ts`.

## 5. Sibling patterns (Sonnet grep → Opus judge)

- `limit: 999` — the fetch-all-then-reduce idiom (expected hits: credit-notes, estimates, vendor-bills pages → FILE, not fix).
- `setHours\(23, 59` — host-local day-end on a date column (expected: `import.service.ts` → FILE).
- `take: (50|100|200|500),` — a cap feeding arithmetic or a lookup (judge each: display budget = fine; arithmetic = defect).
- `orderBy: \{ [a-zA-Z]+: (dir|orderDir|"desc"|"asc") \}` near `skip:` — a paginated single-key order (judge: defect when the column is non-unique).

## 6. Data repair — none (nothing persisted wrong by these seven; B100's backfill belongs to its own run).

## 7. Probe plan (`revertFix: true`)

| File                                                              | REG test that must go red   |
| ----------------------------------------------------------------- | --------------------------- |
| `apps/api/src/invoices/invoices.service.ts`                       | REG-B89 (T1), REG-B169 (T2) |
| `apps/api/src/orders/orders.service.ts`                           | REG-B144 (T3)               |
| `apps/api/src/customers/customers.service.ts`                     | REG-B110 (T4)               |
| `apps/api/src/supplier-statements/supplier-statements.service.ts` | REG-B117 (T5)               |
| `apps/web/app/(dashboard)/finance/payments/[id]/page.tsx`         | REG-B80 (T7)                |

## 8. Close-out bindings

Registry: prove B89/B169/B117/B144 (T1 api specs), B110 (T1 api + T2 spec 37), B12 (T1 api + T2 spec 37, pending-deploy),
B80 (T1 RTL + T2 spec 37); F16 stays OPEN until B100 lands. File: four `limit:999` siblings; `import.service.ts` setHours;
plus anything the sibling sweep judges `defect`. Lesson (one, the rule in §2; archive one guarded entry) + code map in the
docs follow-up. Spec number for the T2: **37** (`37-list-caps.spec.ts`, project `list-caps`; 36 = marketing).

## 9. B100 — split, not dropped

Own run (`fix/F16b-invoice-number-counter`) after this PR merges: single primitive `nextInvoiceNumber(tx, tenantId, year)`
backed by `InvoiceCounter { id = "<tenantId>:<year>", next }` (PaymentCounter pattern; upsert+increment under the row lock,
called LAST inside the creating transaction, bounded retry on P2002), used by ALL five mint paths (`:444`, `:1171`,
`:2650`, `:4187`, `estimates.service.ts:245`); migration adds the table AND seeds each `(tenantId, year)` from the NUMERIC
max of existing `INV-<year>-*` suffixes (never the string max). Prod: fresh backup → `prod-migrate.mjs` → deploy →
drift gate. **Owner ack required before the migration is applied.** DB-lane specs (L-061) for the race and the
cross-tenant scan; unit spec for the 9999 wall.
