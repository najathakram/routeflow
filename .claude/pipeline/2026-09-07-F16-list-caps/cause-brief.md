# Cause brief — F16 batch (B12, B80, B89, B100, B110, B117, B144, B169) list-caps-numbering

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals.
>
> Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `fix/F16-list-caps-numbering`,
> HEAD `19a419bafb127f813d51447809215f0c153a615` (= master; `docs(registry): spec 29 kpi-race bookkeeping
follow-up for #654 (#655)`). All commands below ran against this worktree. Line numbers below are current
> on this HEAD and in several places differ from the line numbers quoted in the registry records (the records
> were verified against older shas — `roundSha` in `.claude/campaign/status/F16.jsonl`: B12 `2d0270fd`,
> B80/B89 `e5b0af8e`, B100/B110/B117 `0cd59277`, B144/B169 `0b2c3a0a`); the underlying code shape is
> unchanged in every case checked.

---

## B12 — Invoice KPI tiles go wrong past 999 invoices

### The bug as stated

- **Source** (`.claude/campaign/bugs/B12.md`, adversarially verified Aug 28 2026 @ master `2d0270fd`), quoted
  verbatim:
  - **Meant to do.** "Invoice-list KPI tiles (Total Outstanding, Due Today, Due in 30, Overdue, Avg Days to
    Pay) should reflect every invoice accurately and stay fast as the tenant's invoice volume grows."
  - **Actually does.** "`PaymentSummaryBar` in apps/web/app/(dashboard)/invoices/page.tsx calls
    `useInvoices({ limit: 999 })` (line 235) and reduces the client-side array in a `useMemo` (lines 238-305)
    to compute every KPI tile. The API's own hard ceiling is `MAX_LIST_LIMIT = 1000`
    (apps/api/src/common/pagination.ts:11), so 999 is deliberately just under that cap — any tenant with more
    invoices than that silently drops the oldest ones (default sort is `issueDate desc`) from every tile."
  - **The gap.** "Past 999 invoices the tiles quietly become wrong (undercounted outstanding/overdue) with no
    error or indication."
  - **CLAIM — suggested fix (register).** "Add a server-computed summary endpoint/aggregate for the
    invoice-list KPI tiles (mirroring listAllPayments' summary pattern) instead of fetching up to 999 full
    invoice records and reducing client-side."
- **Repro (as stated)**: tenant has > 999 invoices → oldest invoices (sorted by `issueDate desc`) are excluded
  from the `useInvoices({ limit: 999 })` fetch → every KPI tile (Total Outstanding, Due Today, Due in 30,
  Overdue, Avg Days to Pay) undercounts; **expected**: tiles reflect every invoice regardless of count.

### Code path

- `apps/web/app/(dashboard)/invoices/page.tsx:235` — `PaymentSummaryBar` fetch:
  ```
  235   const { data: allData } = useInvoices({ limit: 999 });
  236   const all: Invoice[] = allData?.data ?? [];
  ```
- `apps/web/app/(dashboard)/invoices/page.tsx:238-314` — `React.useMemo` reduces `all` client-side into
  `totalOutstanding`, `dueToday`, `dueIn30`, `overdue`, `avgDays`, `awaitingConfirmationCount` (confirmed
  full body read; loop at 261-309, `[all]` dep array at 314).
- `apps/api/src/common/pagination.ts:1-28` (full file) — `MAX_LIST_LIMIT = 1000` (line 11), with its own doc
  comment: _"well above every real UI call (the dashboard's largest 'fetch-all' idiom is ~999)"_ — i.e. the
  999-cap-just-under-1000 idiom is a documented, repo-wide convention, not unique to invoices (see Cross-row
  observations).
- `apps/api/src/invoices/dto/list-invoices.dto.ts:35` — `@IsOptional() @IsInt() @Min(1) @Max(MAX_LIST_LIMIT)
@Type(() => Number) limit?: number;` — server enforces the 1000 ceiling; `page` has no `@Max` (line 34).
- Contrast pattern — `apps/api/src/invoices/invoices.service.ts:4216-4312` (`listAllPayments`), full body
  read:
  ```
  4285   const [data, total] = await Promise.all([
  4286     this.prisma.forTenant().invoicePayment.findMany({ where, skip, take: limit, orderBy, include }),
  4287     this.prisma.forTenant().invoicePayment.count({ where }),
  4288   ]);
  4292   // Summary: total received (PAID only) and advance balance
  4293   const summaryWhere = { ...where, status: "PAID" };
  4294   const paidPayments = await this.prisma.forTenant().invoicePayment.findMany({
  4295     where: summaryWhere, select: { amount: true },
  4296   });
  4298   const totalReceived = paidPayments.reduce((s, p) => s + Number(p.amount), 0);
  4307   return { data, meta: {...}, summary: { totalReceived, count: paidPayments.length, advanceBalance } };
  ```
  This is a genuine server-side aggregate query (unbounded by `take`/`skip`) computed independently of the
  paginated `data` page — the "summary" pattern the bug's suggested fix references. No equivalent aggregate
  exists for `Invoice.findAll`.
- `apps/web/lib/api/invoices.ts:199-224` — `useInvoices` param type has `limit?: number` (219) alongside
  `dateFrom`/`dateTo`/`dueFrom`/`dueTo`/`sortBy`/`sortOrder`; no server-summary hook exists for invoices
  (contrast `useInvoicePayments` at :272-277 which surfaces `PaymentListResponse.summary` from
  `listAllPayments`).

### History

```
$ git log -3 --format='%h %ad %s' --date=short -- "apps/web/app/(dashboard)/invoices/page.tsx"
f1599490 2026-08-31 fix(invoices): confirmed-payment truth across sums, documents and surfaces (F03) (#564)
53bda4b4 2026-08-26 fix: audit P0 batch — orders 403, overdue truth, impersonation integrity (#457)
de1d2b6f 2026-08-26 fix(orders): settle stock on edits; terms-date linkage; UTC badges (#449)

$ git blame -L 235,235 --date=short "apps/web/app/(dashboard)/invoices/page.tsx"
c26ed3748 (Najath Akram 2026-03-29 235)   const { data: allData } = useInvoices({ limit: 999 });

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/src/common/pagination.ts
1e11624d 2026-07-13 Regulated leftovers + security hardening (9 fixes) (#247)
```

`limit: 999` dates to the KPI bar's original authoring (2026-03-29) and has not been touched since —
untouched through F03 (#564, confirmed-payment truth), which changed adjacent lines in the same file but not
the fetch itself.

### Existing tests around this behavior

- `apps/web/e2e/22-payment-truth.spec.ts:61-71` — a helper `summaryBarQuery(page)` explicitly `waitForResponse`s
  a request matching `/\/invoices\?.*\blimit=999\b/` before reading tile values:
  ```
  61  /**
  62   * The PaymentSummaryBar's own list query (`useInvoices({ limit: 999 })`). Every
  63   * tile is derived from it and the bar renders zeros until it resolves...
  67  function summaryBarQuery(page: Page) {
  68    return page.waitForResponse(
  69      (r) => r.request().method() === "GET" && /\/invoices\?.*\blimit=999\b/.test(r.url()) && r.ok(),
  70      { timeout: 30_000 },
  71    );
  72  }
  ```
  This is load-bearing on the exact `limit=999` literal — any fix that changes the KPI fetch shape (a
  different limit, or a server aggregate with no `limit=999` request at all) will hang this `waitForResponse`
  until its 30s timeout. Used in test `REG-B11 Payment History badges an unconfirmed DRAFT payment...`
  (line 101) and referenced again at `apps/web/e2e/22-payment-truth.spec.ts:266`.
- No Jest/RTL unit test exists for `apps/web/app/(dashboard)/invoices/page.tsx` or `PaymentSummaryBar`
  (`find apps/web -iname "*.test.tsx"` under `invoices` returned nothing).
- No API spec asserts a KPI-relevant cap on `InvoicesService.findAll` (grepped
  `apps/api/src/invoices/invoices.service.spec.ts` for `it(...limit...)`/`999`/`1000` — no matches beyond the
  DTO's own `@Max` which has no dedicated spec either).

### Production evidence (if any)

None cited in the record beyond the code-level count-threshold reasoning (999-cap vs. `MAX_LIST_LIMIT`=1000).
No prod log lines or tenant invoice counts are given in the source record.

### Open unknowns

- Whether any live tenant currently exceeds 999 invoices (would make this observable today, not just latent)
  — not established by the record or by this pass (no prod query run; read-only agent).
- Whether `awaitingConfirmationCount` (DRAFT-payment badge count) needs the same server-aggregate treatment
  as the money tiles, or can stay client-derived from a smaller page.

---

## B80 — Payment receipt page reports "not found" for any payment outside the 200 most recent

### The bug as stated

- **Source** (`.claude/campaign/bugs/B80.md`, Round 2 hunt, adversarially verified Aug 29 2026 @ master
  `e5b0af8e`, sweep C15), quoted verbatim:
  - **Meant to do.** "Clicking any payment row — including from a filtered or older view — opens that
    payment's receipt page."
  - **Actually does.** "The page fetches useInvoicePayments({limit:200}) (default sort paidAt desc) and does
    a client-side `find(p => p.id === id)`. A dedicated usePaymentDetail(id) hook hitting the working GET
    /invoices/payments/:paymentId endpoint exists and is never called from this page."
  - **The gap.** "Any payment beyond the 200 most recent renders 'Payment not found' even though the row that
    linked to it is directly reachable and the correct single-fetch endpoint already exists, unused."
  - **CLAIM — suggested fix (register).** "Swap the client-side find for the existing usePaymentDetail(id)
    hook."
- **Repro (as stated)**: any `InvoicePayment` older than the 200 most-recently-paid (by `paidAt desc`) is
  opened via its row link → `/finance/payments/[id]` renders "Payment not found"; **expected**: the receipt
  renders regardless of the payment's recency.

### Code path

- `apps/web/app/(dashboard)/finance/payments/[id]/page.tsx:21-91` (full function read):
  ```
  27  // Fetch the payment by searching all payments by id — use list with no filters,
  28  // since we don't have a single-payment endpoint yet.
  29  // We'll fetch a large page and find the matching one.
  30  const { data, isLoading } = useInvoicePayments({ limit: 200 });
  ...
  37  const payment = data?.data.find((p) => p.id === id);
  ...
  82  if (!payment) {
  83    return (
  84      <div className="p-6 text-center space-y-3">
  85        <p className="text-navy/70">Payment not found.</p>
  ```
  The comment at line 28 ("since we don't have a single-payment endpoint yet") is stale — the endpoint exists
  (see below) and was added after this page.
- `apps/web/lib/api/invoices.ts:272-277` (`useInvoicePayments`) — hits `GET /invoices/payments` (list,
  paginated).
- `apps/web/lib/api/invoices.ts:706-712` (`usePaymentDetail`, unused by the receipt page):
  ```
  706 export function usePaymentDetail(id: string) {
  707   return useQuery<AllPayment>({
  708     queryKey: ["invoices", "payments", id],
  709     queryFn: () => apiClient.get(`/invoices/payments/${id}`).then((r) => r.data),
  710     enabled: !!id,
  711   });
  712 }
  ```
  `grep -rn "usePaymentDetail" apps/web` (not shown in full above but run as part of this pass) found no
  callers other than its own export.
- `apps/api/src/invoices/invoices.controller.ts:92-95` — the endpoint `usePaymentDetail` would hit already
  exists and is wired:
  ```
  92  @Get("payments/:paymentId")
  93  findPayment(@Param("paymentId") paymentId: string) {
  94    return this.invoicesService.findPaymentById(paymentId);
  95  }
  ```
  and `apps/api/src/invoices/invoices.service.ts:4314-4330` (`findPaymentById`) does a plain `findUnique` by
  id with `NotFoundException` if absent — a real single-record lookup, not capped by any list limit.
- `apps/api/src/invoices/invoices.service.ts:4216-4256` (`listAllPayments`) — `limit = clampLimit(query.limit,
25)` (line 4241, capped at `pagination.ts`'s `MAX_LIST_LIMIT`=1000 via `clampLimit`'s default `max`
  param), `skip`/`take: limit`, default `orderBy = { paidAt: "desc" }` (line 4272) confirmed. `200` (the
  page's request) is within the 1000 ceiling but the page still only sees the first `skip=0..200` window by
  `paidAt desc`.
- Two entry points route into the buggy page — `apps/web/app/(dashboard)/finance/payments/page.tsx:789` and
  `:841`, both `router.push(\`/finance/payments/${p.id}\`)`.

### History

```
$ git log -3 --format='%h %ad %s' --date=short -- "apps/web/app/(dashboard)/finance/payments/[id]/page.tsx"
c16c3f60 2026-08-23 style(web): demote duplicate page-level h1s to h2, wrap clipped tables (audit L0+L1) (#410)
de557140 2026-08-22 feat(payments): add Zelle, share method constants, surface customer price tier (#408)
4f5ed09b 2026-08-07 feat: duplicate invoice detection, backdated orders, payment bank date, mobile scan rework (#322)

$ git blame -L 27,37 --date=short "apps/web/app/(dashboard)/finance/payments/[id]/page.tsx"
6537a009d (Najath Akram 2026-04-01 27-31,36,37)  ...useInvoicePayments({ limit: 200 }); ... .find(...)
a96713982 (najathakram  2026-06-19 33-35)        React.useEffect(() => setTitle(...))
```

The `limit:200` + client `.find` shape dates to the page's original authoring (2026-04-01) and was never
revisited when `usePaymentDetail`/`GET /invoices/payments/:paymentId` were later added — no commit in the
3-commit window touches lines 27-37.

### Existing tests around this behavior

- No Jest/RTL test file exists for this page (`find apps/web -iname "*.test.tsx"` under `finance/payments`
  returned nothing).
- `apps/web/e2e/22-payment-truth.spec.ts` exercises `PaymentSummaryBar`/badge behavior on the invoices list
  but does not navigate to `/finance/payments/[id]` or assert receipt-page reachability.
- No API spec (`invoices.service.spec.ts`) contains a test titled around `findPaymentById` (grepped, no
  matches).

### Production evidence (if any)

None cited — the record's evidence is entirely code-level (limit constant, unused hook, live route).

### Open unknowns

- Whether any tenant currently has > 200 `InvoicePayment` rows (would make this observably reachable today).
- Whether `usePaymentDetail`'s `AllPayment` response shape matches every field the receipt page currently
  reads off the `useInvoicePayments` list item (e.g. joined `invoice` fields) — not diffed in this pass.

---

## B89 — Invoice and payment date filters close the window at server-local end of day

### The bug as stated

- **Source** (`.claude/campaign/bugs/B89.md`, Round 2 hunt, adversarially verified Aug 29 2026 @ master
  `e5b0af8e`, sweep C28, "verified PARTIAL"), quoted verbatim:
  - **Meant to do.** "A dateTo filter closes a UTC-consistent window so results don't depend on the server
    process's local timezone — as every other date-range query in the API does."
  - **Actually does.** "Four blocks parse dateTo as a UTC-midnight Date then call local-time
    `.setHours(23,59,59,999)` on it, producing an `lte` bound shifted by the server's UTC offset while the
    `gte` side stays true UTC midnight."
  - **The gap.** "Asymmetric boundary construction (local setHours over a UTC-parsed base, against
    setUTCHours everywhere else). Verified direction: for any non-UTC server timezone the bound lands EARLIER
    than true UTC end-of-day, so legitimate rows late in the target day silently drop out of filtered reports
    — it does not leak next-day rows in."
  - **Verifier's note.** "Latent rather than currently observable if the Railway container runs UTC — worth
    confirming the container TZ before prioritising... invoices.service.spec.ts:2978-2984 asserts the buggy
    local expectation, so no test catches it."
  - **CLAIM — suggested fix (register).** "Use `.setUTCHours(23,59,59,999)` at all four sites and update the
    spec expectation."
- **Repro (as stated)**: server process running in a non-UTC timezone (e.g. `America/Los_Angeles`) + a
  `dateTo`/`dueTo` filter of `"2026-08-26"` → `lte` bound resolves to `2026-08-26T06:59:59.999Z` (should be
  `2026-08-26T23:59:59.999Z`) → invoices/payments legitimately dated late on 2026-08-26 UTC are excluded;
  **expected**: `lte` bound is `2026-08-26T23:59:59.999Z` regardless of server TZ.

### Code path

All four sites confirmed present and unchanged in shape on this HEAD (line numbers differ from the record's
`e5b0af8e` citations; re-located by `grep -n "setHours(23, ?59, ?59, ?999)"`):

- `apps/api/src/invoices/invoices.service.ts:2797-2805` — `findAll`, `issueDate` window:
  ```
  2797  if (dateFrom || dateTo) {
  2798    where.issueDate = {};
  2799    if (dateFrom) where.issueDate.gte = new Date(dateFrom);
  2800    if (dateTo) {
  2801      const end = new Date(dateTo);
  2802      end.setHours(23, 59, 59, 999);
  2803      where.issueDate.lte = end;
  ```
- `apps/api/src/invoices/invoices.service.ts:2810-2818` — `findAll`, `dueDate` window (`dueFrom`/`dueTo`):
  ```
  2813    if (dueTo) {
  2814      const dueEnd = new Date(dueTo);
  2815      dueEnd.setHours(23, 59, 59, 999);
  2816      where.dueDate.lte = dueEnd;
  ```
- `apps/api/src/invoices/invoices.service.ts:4248-4256` (inside `listAllPayments`) — `paidAt` window:
  ```
  4248    if (dateFrom || dateTo) {
  4249      where.paidAt = {};
  4250      if (dateFrom) where.paidAt.gte = new Date(dateFrom);
  4251      if (dateTo) {
  4252        const end = new Date(dateTo);
  4253        end.setHours(23, 59, 59, 999);
  4254        where.paidAt.lte = end;
  ```
- `apps/api/src/invoices/invoices.service.ts:5378-5384` (a second `paidAt` window site, in a different
  method) — identical shape: `end.setHours(23, 59, 59, 999)` at line 5381.
- `new Date(dateTo)` where `dateTo` is a plain `"YYYY-MM-DD"` string parses as UTC midnight per the ECMAScript
  date-time string spec; `.setHours(...)` (no `UTC` prefix) then mutates the instant using the **Node
  process's local timezone offset**, not tenant timezone and not any value from the request. No tenant/request
  timezone parameter reaches any of these four call sites — `dto.dateTo`/`dto.dueTo` are plain strings off
  `ListInvoicesDto`/`listAllPayments`'s inline query type.
- Contrast pattern (correct, `setUTCHours`) — `apps/api/src/bookkeeping/bookkeeping.service.ts` has 17
  `setUTCHours` call sites (`grep -c setUTCHours` → 17); sample:
  ```
  90:        d.setUTCHours(23, 59, 59, 999);
  399:        d.setUTCHours(23, 59, 59, 999);
  ```
  Also `analytics.service.ts` (1 site), `inventory.service.ts` (1 site), `tobacco.service.ts` (1 site) all use
  `setUTCHours`.
- A third, distinct pattern also exists in the repo and is used by neither side of this contrast:
  `apps/api/src/common/calendar-date.ts:145` `endOfCalendarDay(date, timeZone)` — a purpose-built,
  tenant-timezone-aware "last instant of the calendar day" helper (added for F25, "calendar dates render and
  compare in the right zone", commit `1f6483ec` 2026-09-05). None of the four buggy sites, nor the
  `setUTCHours` contrast sites, call it.
- Container timezone: `grep -rn "TZ=" apps/api/Dockerfile docker-compose.yml railway.toml` returned no
  matches (no explicit `TZ` env var found in this pass) — consistent with the verifier's note that the bug is
  latent if the container defaults to UTC (unset `TZ` defaults most Node base images to UTC).

### History

```
$ git blame -L 2797,2805 --date=short apps/api/src/invoices/invoices.service.ts
8fdedad77 (Najath Akram 2026-03-30 2797-2805)   issueDate window — original authoring

$ git blame -L 2810,2818 --date=short apps/api/src/invoices/invoices.service.ts
ada152eac (najathakram  2026-08-25 2810-2818)   dueDate window — added later, #442
```

`git log -3` for `apps/api/src/invoices/invoices.service.ts` (full file):

```
151c3f70 2026-09-06 fix(api,web,mobile): credit-note wallet integrity (f09 b66 b67 b18 b19) (#636)
1f6483ec 2026-09-05 fix(api,web,mobile): calendar dates render and compare in the right zone (F25) (#617)
22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
```

Note: **F25 (#617, "calendar dates render and compare in the right zone")** landed 2026-09-05 and touched
this file, and is the commit that introduced `startOfCalendarDay`/`endOfCalendarDay` as reusable helpers
elsewhere in the codebase (`apps/api/src/common/calendar-date.ts`) — but did not touch any of the four
`setHours` sites above. The `issueDate` site (2797-2805) is original (2026-03-30, commit `8fdedad77`); the
`dueDate` site (2810-2818) was added five months later (2026-08-25, commit `ada152eac`, PR #442) by copying
the same already-buggy local-`setHours` pattern rather than the `setUTCHours` convention used elsewhere in
the codebase at the time.

### Existing tests around this behavior

- `apps/api/src/invoices/invoices.service.spec.ts:3203-3217` — `describe("WP3 — findAll due-date window
(dueFrom/dueTo)")`, test `"passes dueFrom/dueTo through as a dueDate range, widening dueTo to end-of-day"`
  **asserts the buggy local-time expectation**:
  ```
  3211  it("passes dueFrom/dueTo through as a dueDate range, widening dueTo to end-of-day", async () => {
  3212    await service.findAll({ dueFrom: "2026-08-26", dueTo: "2026-08-26" } as any);
  3214    const expectedEnd = new Date("2026-08-26");
  3215    expectedEnd.setHours(23, 59, 59, 999);
  3216    expect(whereArg().dueDate).toEqual({ gte: new Date("2026-08-26"), lte: expectedEnd });
  3217  });
  ```
  This test passes today (Jest runs the test process in whatever local TZ the CI/dev machine has — the
  expectation is built with the same local `setHours` the production code uses, so the test can never catch
  the asymmetry regardless of the runner's TZ; it would only start failing if the fix changes only the
  production code and not this expectation). No test exists for the `issueDate` (`dateFrom`/`dateTo`) window
  on `findAll`, nor for the `paidAt` window on `listAllPayments` (grepped `dateFrom.*dateTo` in the spec file
  — no matches).

### Production evidence (if any)

None — the record's own "Live check" is a code-level computation (`America/Los_Angeles` →
`2026-08-26T06:59:59.999Z`, `Asia/Kolkata` → `18:29:59.999Z`), not a captured prod log line.

### Open unknowns

- The actual Railway container timezone (this pass found no explicit `TZ=` in Dockerfile/compose/railway.toml
  but did not query the running prod container).
- Whether `apps/api/src/bookkeeping/bookkeeping.service.ts`'s 17 `setUTCHours` sites and the four buggy sites
  ever compose in the same request (e.g. a report that filters both bookkeeping and invoices by the same
  `dateTo`) — would make the asymmetry directly user-visible as inconsistent results across two panels of one
  screen.

---

## B100 — Invoice numbers minted from unscoped cross-tenant max+1; pad-4 string sort jams the series at 9999

### The bug as stated

- **Source** (`.claude/campaign/bugs/B100.md`, Round 3 hunt, Fable-verified Aug 29 2026 @ master `0cd59277`),
  quoted verbatim:
  - **Meant to do.** "Each tenant gets its own clean INV-YYYY-NNNN sequence starting at 0001, and invoice
    creation keeps working no matter how many invoices exist."
  - **Actually does.** "New-invoice paths compute next number from the GLOBAL max across all tenants (bare
    prisma, no forTenant), and the desc string sort over pad-4 numbers pins the max at 9999, looping 409s
    forever past 10000."
  - **The gap.** "No counter table; unscoped scan leaks cross-tenant volume into numbering; string sort makes
    creation permanently fail once any series passes 9999."
  - **Verifier's note.** "Verified both mechanisms myself. Nuance: because the invoice scan is global, the
    9999 wall trips on PLATFORM-wide yearly volume, not one tenant's; each tenant then gets exactly one more
    invoice (its own -10000) before permanent 409s. generateInvoiceNumber(db) at :1181 does receive a tx from
    split-invoice callers, so that one path can be scoped — the main create() and createPartialFromOrder
    paths are not. No RLS backstop exists."
  - **CLAIM — suggested fix (register).** "Add a per-tenant, per-year InvoiceCounter table (like
    PaymentCounter) updated atomically inside the create transaction; or at minimum run the scan through
    forTenant()/tx and sort numerically... Apply the same fix to the EST/CN/BILL/PO/CST/ORD generators."
- **Repro (as stated)**: (a) tenant A creates an invoice while tenant B already has invoices in the same
  calendar year → A's next number is computed from the max across BOTH tenants' invoices, not A's own; (b)
  once the platform-wide (not per-tenant) count of `INV-<year>-####` invoices reaches 9999 in one year,
  `'INV-2026-9999' > 'INV-2026-10000'` lexicographically (`'9' > '1'` at the differing position), so
  `orderBy: { invoiceNumber: "desc" }` keeps returning the `9999` row and every subsequent create attempt
  re-mints `10000`, collides on the `@@unique([tenantId, invoiceNumber])` constraint, and 409s forever;
  **expected**: each tenant has its own clean 0001-based sequence per year, and creation keeps working past
  9999 invoices/year.

### Code path

- **Generator** — `apps/api/src/invoices/invoices.service.ts:2718-2732` (full body):
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
  `client = db ?? this.prisma` — when no `db` is passed, `this.prisma` is the **bare** (unscoped) client, not
  `this.prisma.forTenant()`.
- **Every caller** (`grep -n "generateInvoiceNumber(\|nextInvoiceNumber("` over the file):
  | call site                              | line    | `db` arg                                        | scoping                                                                                                                                                                                                                                                              |
  | -------------------------------------- | ------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `nextInvoiceNumber()` wrapper          | 220-222 | n/a (calls `generateInvoiceNumber()` with none) | —                                                                                                                                                                                                                                                                    |
  | main `create()` path                   | 444     | none                                            | **unscoped**, called _before_ entering `tenantTransaction` (confirmed: line 443 `resolveTenantInvoiceDefaults()`, 444 `nextInvoiceNumber()`, transaction opens later inside `runCreation`)                                                                           |
  | split-invoice path (multi-group order) | 1171    | `db` (a tx client passed in by the caller)      | scoped **only if** that caller's `db` is itself a tenant-wrapped tx — confirmed the wrapping mechanism exists (`_wrapTxWithTenant`, see below) but this pass did not trace the specific upstream caller of this `db` argument to confirm it is always tenant-wrapped |
  | `createPartialFromOrder()`             | 2650    | none                                            | **unscoped**, called before `this.prisma.tenantTransaction(runCreation)` opens at line 2710                                                                                                                                                                          |
  | `duplicate()`                          | 4187    | none (via `nextInvoiceNumber()`)                | **unscoped**; the invoice `.create()` itself uses `.forTenant()` (line 4185) but the **number** is computed unscoped first                                                                                                                                           |
- **Tenant scoping mechanics** — `apps/api/src/prisma/prisma.service.ts`:
  - `forTenant()` (lines 296-300) is **opt-in**: `if (!tenantId) return this;` — the bare `this.prisma` (used
    by every unscoped call site above) applies **no** tenant filter at all.
  - `tenantTransaction()` (lines 48-63) DOES auto-wrap its `tx` via `_wrapTxWithTenant` (line 61) when a
    tenant is set — `findFirst` is one of the `SCOPED_METHODS` (line 82) that gets `tenantId` injected. This
    means a `tx` obtained _from inside_ `tenantTransaction` is safe; a bare `this.prisma` obtained _before_
    one opens (as at lines 444 and 2650) is not.
  - No RLS: `grep -rn "ROW LEVEL SECURITY" apps/api/prisma/migrations` — not re-run in this pass but the
    record's own evidence states it returns nothing; `apps/api/prisma/migrations/0_init/migration.sql` and
    the newest migration were grepped for `invoiceNumber`/`SEQUENCE` in this pass and show only a plain
    `TEXT` column + `CREATE UNIQUE INDEX "Invoice_tenantId_invoiceNumber_key" ON "Invoice"("tenantId",
"invoiceNumber")` (line 2727 of `0_init/migration.sql`) — no Postgres `SEQUENCE` object backs invoice
    numbering anywhere.
- **Unique constraint** — `apps/api/prisma/schema/finance.prisma:218` — `@@unique([tenantId,
invoiceNumber])`. The constraint itself IS tenant-scoped (a P2002 on collision only fires within one
  tenant's own numbers); the bug is in how the _candidate_ number is computed, not the constraint.
- **A fourth, previously uncited generator site**, same bug shape, found in this pass —
  `apps/api/src/estimates/estimates.service.ts:245-252`, inside `convertToInvoice()` (opens at line 218 with
  `this.prisma.tenantTransaction(async (tx) => {` at line 219, so `tx` here **is** tenant-scoped via
  `_wrapTxWithTenant`, unlike the three sites above):
  ```
  245    const year = new Date().getFullYear();
  246    const prefix = `INV-${year}-`;
  247    const last = await tx.invoice.findFirst({
  248      where: { invoiceNumber: { startsWith: prefix } },
  249      orderBy: { invoiceNumber: "desc" },
  250    });
  251    const seq = last ? parseInt(last.invoiceNumber.split("-")[2], 10) + 1 : 1;
  252    const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;
  ```
  This is an independent inline reimplementation of `generateInvoiceNumber` (not a call to it) — correctly
  tenant-scoped (because `tx` is wrapped) but it shares the identical pad-4 desc-string-sort 9999 wall.
- **P2002 handling** (unscoped create path) — `apps/api/src/invoices/invoices.service.ts:2692-2696`:
  ```
  2692  } catch (err: any) {
  2693    if (err?.code === "P2002")
  2694      throw new ConflictException("Invoice number conflict — please retry.");
  2695    throw err;
  ```
  A retry after this 409 re-derives the SAME wedged `9999`-max via the same unscoped scan, so the loop is
  permanent, not transient.
- **Sibling generators** (verified in this pass, matching the record's citations):
  - `apps/api/src/estimates/estimates.service.ts:15-24` (`nextEstNumber`, called from `create()`) — uses
    `this.prisma.forTenant().estimate.findFirst(...)` (line 18) — **correctly tenant-scoped**, but same
    pad-4 desc-string-sort wall (`EST-${year}-`, `padStart(4, "0")` at line 23).
  - `apps/api/src/orders/orders.service.ts:2230-2238` (inside a transaction, comment at 2227-2229: _"RF-014:
    generate order number inside the transaction so a P2002 on the @@unique([tenantId, orderNumber])
    constraint can be caught and retried"_) — `tx.order.findFirst({ where: { orderNumber: { startsWith:
"ORD-" } }, orderBy: { orderNumber: "desc" } })` — same tenant-scoping-via-tx-wrapping as above (not
    independently re-verified whether this specific `tx` originates from `tenantTransaction`), pad-5
    (`String(seq).padStart(5, "0")`, line 2238) — five digits pushes the wall to 99999 instead of 9999 but
    the same string-sort mechanism applies.
- **Existing atomic-counter precedent** (relevant to any future fix, recorded as fact only) —
  `apps/api/prisma/schema/finance.prisma:349-357` `model PaymentCounter { id String @id @default("singleton")
next Int @default(1) tenantId String? ... }`, used at `apps/api/src/invoices/invoices.service.ts:4447-4452`
  (one of 3 call sites, `grep -n "paymentCounter" invoices.service.ts` → lines 4447, 4743, 5042):
  ```
  4445  const counterKey = this.prisma.getTenantId() ?? "singleton";
  4447  const counter = await tx.paymentCounter.upsert({
  4448    where: { id: counterKey },
  4449    update: { next: { increment: 1 } },
  4450    create: { id: counterKey, next: 2 },
  4451  });
  4452  const paymentNumber = `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;
  ```
  This is an already-working, atomic (`upsert` + `increment`), per-tenant-keyed counter pattern that exists
  in the same file as the buggy invoice-number generator — no equivalent `InvoiceCounter` model exists in
  `finance.prisma` (grepped `model.*Counter` in the schema — only `PaymentCounter` found).

### History

```
$ git blame -L 2722,2732 --date=short apps/api/src/invoices/invoices.service.ts
c620aae0c (Najath Akram 2026-03-31 2722-2732)   generateInvoiceNumber — unchanged since authoring

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/src/prisma/prisma.service.ts
22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
72069288 2026-04-17 fix(ci): make lint, type check, and tests pass
b0efee95 2026-04-12 fix: resolve all CI lint and type-check failures

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/prisma/schema/finance.prisma
60d10e66 2026-09-05 fix(types,api,mobile,web): wave E — shared enums/DTOs (10b) + schema folder split (10a) (#621)
```

The generator (`generateInvoiceNumber`) has not been touched since its original authoring on 2026-03-31
(`c620aae0c`) — it predates `forTenant()`/`tenantTransaction()`'s current shape and was never migrated to use
them. `finance.prisma`'s only recent history entry is the schema-folder split (#621, 2026-09-05), a
mechanical move with no content change to the `Invoice`/`PaymentCounter` models (per `CLAUDE.md`'s recorded
lossless-split guarantee).

### Existing tests around this behavior

- `apps/api/src/invoices/invoices.service.spec.ts` — grepped for `it(...)` titles containing
  `invoiceNumber|generateInvoiceNumber|9999|10000|nextInvoiceNumber` — **no matches**. No test exercises
  `generateInvoiceNumber`'s tenant-scoping or its numeric-vs-string sort behavior at all.
- No test asserts cross-tenant isolation of invoice numbering (e.g. two tenants both minting in the same
  year).

### Production evidence (if any)

None — the record's evidence is entirely code-level (query shape, string comparison of
`'INV-2026-9999' > 'INV-2026-10000'`, migration grep for `SEQUENCE`).

### Open unknowns

- Whether the `db` passed into `generateInvoiceNumber(db)` at line 1171 (split-invoice path) is, at every
  call site, guaranteed to be a `tenantTransaction`-wrapped `tx` (this pass located the definition and the
  wrapping mechanism but did not trace every upstream caller of that specific code path).
- Current platform-wide yearly invoice volume (whether the 9999 wall has already been approached in
  production) — not queried in this read-only pass.
- Whether `orders.service.ts`'s `orderNumber` generation at line 2230 runs inside a `tenantTransaction`-opened
  `tx` (making it tenant-scoped) or some other transaction helper — not traced back to its opening call in
  this pass.

---

## B110 — Customer statement Outstanding/Overdue silently drops unpaid invoices past a 100-invoice cap

### The bug as stated

- **Source** (`.claude/campaign/bugs/B110.md`, Round 3 hunt, Fable-verified Aug 29 2026 @ master `0cd59277`),
  quoted verbatim:
  - **Meant to do.** "The Outstanding/Overdue balance on the operator's customer page and the buyer's
    Payments/Finances screens reflects every unpaid invoice the customer has, regardless of invoice count."
  - **Actually does.** "getStatementForOperator fetches only the 100 newest invoices (50 credits/advances)
    and reduces in memory; any still-unpaid invoice older than the newest 100 is silently omitted from
    Outstanding/Overdue on every surface, with no partial-data flag."
  - **The gap.** "Aggregate figures computed over a capped page instead of a SQL aggregate; error grows
    silently with tenant history."
  - **Verifier's note.** "Confirmed on more surfaces than claimed — buyer web Payments and Finances pages also
    consume the same figure. Downgraded critical→high: it is a reporting/collections figure (invoice lists
    and billing remain correct), though at ~2 invoices/week the 100-cap is crossed within a year, and old
    unpaid invoices are exactly the ones that age past the window."
  - **CLAIM — suggested fix (register).** "Compute outstanding/overdue with grouped SQL aggregates over ALL
    non-PAID/VOID/WRITTEN_OFF invoices... keeping the take:100 list purely for display; apply the same to
    getMyStatement."
- **Repro (as stated)**: a customer with > 100 invoices, where at least one unpaid invoice is older (by
  `createdAt`) than the 100 most recent → that invoice's balance is excluded from `outstandingAmount` /
  overdue on the operator customer page, the buyer Payments page, the buyer Finances page, and mobile buyer
  Payments; **expected**: the figure sums every open invoice regardless of age/count.

### Code path

- **Operator statement** — `apps/api/src/customers/customers.service.ts:870-923` (full relevant body):
  ```
  870  async getStatementForOperator(customerId: string) {
  873    const [invoices, creditNotes, advancePayments, pendingOrders] = await Promise.all([
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
  ```
  Reduces (in-memory, over only the fetched 100/50/50 rows):
  ```
  933  const outstanding = invoicesWithPaid
  934    .filter((i) => !["PAID", "VOID", "WRITTEN_OFF"].includes(i.status))
  935    .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);
  937  const overdue = invoicesWithPaid
  938    .filter((i) => !["PAID","VOID","WRITTEN_OFF"].includes(i.status) && i.dueDate && new Date(i.dueDate) < new Date())
  944    .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);
  ```
  Returned as `outstandingAmount: outstanding` (`grep -n "outstandingAmount" customers.service.ts` → lines
  366, 1002).
- **Buyer statement** — `apps/api/src/customers/customers.service.ts:264-300` (`getMyStatement`, buyer's own
  version, same shape but `take: 50` for invoices, no separate advance-payment fetch shown in this range):
  ```
  264  async getMyStatement(user: JwtPayload) {
  270    const [invoices, creditNotes] = await Promise.all([
  271      this.prisma.forTenant().invoice.findMany({
  272        where: { customerId: customer.id }, orderBy: { createdAt: "desc" }, take: 50,
  ```
- **Buyer reuses the OPERATOR statement, not getMyStatement, for its main "Get statement" route** —
  `apps/api/src/buyer/buyer.controller.ts:250-255`:
  ```
  253  @ApiOperation({ summary: "Get buyer's account statement at the selected seller" })
  254  getStatement(@CurrentBuyerCustomer() ctx: any) {
  255    return this.customersService.getStatementForOperator(ctx.customerId);
  ```
  i.e. buyers hit the `take: 100`/`take: 50` path, not the separate `getMyStatement` (`take: 50`) path — both
  are capped, just at different thresholds.
- **Rendering surfaces** (existence confirmed, not deep-read — display consumers only):
  - `apps/web/app/(dashboard)/customers/[id]/page.tsx:2390` — `value={fmt(statement?.outstandingAmount ?? 0)}`.
  - `apps/web/app/buyer/portal/[seller]/payments/page.tsx:260` — `value={fmt(statement?.outstandingAmount ?? 0)}`.
  - `apps/web/app/buyer/portal/[seller]/finances/page.tsx` — file exists (`find` confirmed); not
    line-verified in this pass.
  - `apps/mobile/app/(customer)/payments.tsx:120` — `value={money(statement?.outstandingAmount)}`.
  - The operator customer page also independently computes an "outstanding" figure client-side elsewhere
    (`apps/web/app/(dashboard)/customers/[id]/page.tsx:3531-3548`, `outstanding =
allInvoices.filter(...).reduce(...)`) — a **second**, separately-derived outstanding total on the same
    page; not traced back to its own data source in this pass (flagged for S2).

### History

```
$ git blame -L 873,891 --date=short apps/api/src/customers/customers.service.ts
79e761745 (Najath Akram 2026-03-29 875-877,889-891)  where/orderBy/take:100 and take:50 — original
da5e89faa (Najath Akram 2026-04-08 874,888)           .forTenant() wrapper added
dfdb4419d (Najath Akram 2026-03-30 878-886)           select fields
15115b142 (Najath Akram 2026-04-28 873)               Promise.all wrapper

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/src/customers/customers.service.ts
151c3f70 2026-09-06 fix(api,web,mobile): credit-note wallet integrity (f09 b66 b67 b18 b19) (#636)
22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
24421170 2026-09-02 fix(api,web): close the F14 authorization and tenancy matrix (#598)

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/src/buyer/buyer.controller.ts
f60bd27c 2026-09-04 fix(api): customer-keyed advisory lock for order merges (imp-02) + wave D (#609)
e6d1ab34 2026-09-01 fix(orders): updateOrderItems authorization and line build (F06) (#573)
5219e620 2026-08-31 fix(scan): mobile scan-loss hardening + order idempotency (F30) (#555)
```

The `take: 100`/`take: 50` caps date to original authoring (2026-03-29) and have been touched only for
unrelated concerns since (tenant-scoping wrapper 2026-04-08, `Promise.all` restructuring 2026-04-28) — no
commit in the recent history revisits the cap value itself.

### Existing tests around this behavior

- `apps/api/src/customers/customers.service.spec.ts` — tests exist for `getMyStatement`/
  `getStatementForOperator` around VOID-payment exclusion and credit-expiry (`991-1078`: `"getMyStatement:
availableCredit sums only open, non-expired, non-VOID remainders"`, `"getStatementForOperator: a VOID
payment does not reduce outstanding/overdue"`, etc.) — **none of these tests exercise more than a handful
  of fixture invoices**, so none assert or exercise the 100/50-row cap boundary itself.
- No test asserts that an invoice beyond position 100 (or 50, for `getMyStatement`) is included in or
  excluded from the totals.

### Production evidence (if any)

None cited beyond the record's own reasoning ("at ~2 invoices/week the 100-cap is crossed within a year").

### Open unknowns

- The data source and correctness of the second, separately-computed "outstanding" total at
  `apps/web/app/(dashboard)/customers/[id]/page.tsx:3531-3548` relative to `statement.outstandingAmount` —
  not traced in this pass; if it reads from a different (possibly unpaginated) source it may already be
  correct, or it may be a second instance of the same bug.
- Whether `getMyStatement`'s separate `take: 50` cap (distinct from `getStatementForOperator`'s `take: 100`)
  is ever reached by an actual buyer request, given buyers are routed to `getStatementForOperator` for the
  main statement endpoint.

---

## B117 — Statement bill matching caps candidates at 500 with no orderBy

### The bug as stated

- **Source** (`.claude/campaign/bugs/B117.md`, Round 3 hunt, Fable-verified Aug 29 2026 @ master `0cd59277`),
  quoted verbatim:
  - **Meant to do.** "A supplier statement line should match its real corresponding vendor bill no matter how
    many historical bills the supplier has accumulated."
  - **Actually does.** "Both fetchMatchableBills copies query vendorBill.findMany with take: 500 and no
    orderBy; past 500 non-VOID bills (PAID included, so the set grows forever) the candidate pool is capped
    and DB-order-arbitrary, so real bills become invisible to the matcher."
  - **The gap.** "Lines backed by excluded bills report UNMATCHED as false discrepancies,
    non-deterministically; the apply step re-derives from the same capped pool."
  - **Verifier's note.** "One overstatement: applying doesn't 'book new/unreconciled activity' — the apply
    flow only writes operator-confirmed BillPayments, and a bill outside the capped pool can't back a
    confirmed line at all (the re-derived matcher cap rejects it), so the line simply cannot be reconciled.
    Scale-gated (>500 non-VOID bills per supplier ≈ 2+ years of frequent billing), hence medium not high. No
    register duplicate (B52 is the unrelated cross-tenant scan-read bug)."
  - **CLAIM — suggested fix (register).** "Remove the cap or raise it with orderBy: { billDate: 'desc' } and,
    better, restrict candidates to bills with outstanding balance (totalOwed > totalPaid)... apply the same
    change to both copies."
- **Repro (as stated)**: a supplier with > 500 non-VOID `VendorBill` rows → `fetchMatchableBills` returns an
  arbitrary (DB-order, unordered) 500-row subset → a statement line whose true matching bill falls outside
  that subset reports `UNMATCHED`, non-deterministically (which 500 win depends on Postgres's unspecified
  default scan order); **expected**: the matcher considers every non-VOID bill for that supplier.

### Code path

Two byte-identical copies (confirmed both `take: 500`, no `orderBy`, identical `select` shape):

- `apps/api/src/supplier-statements/supplier-statements.service.ts:528-554`:
  ```
  528  private async matchAgainstBills(
  534    const bills = await this.fetchMatchableBills(supplierId);
  535    return matchStatementLines(lines, bills, {...});
  541  private async fetchMatchableBills(supplierId: string | null): Promise<MatchableBill[]> {
  542    if (!supplierId) return [];
  543    const bills = await this.prisma.forTenant().vendorBill.findMany({
  544      where: { supplierId, status: { not: "VOID" } },
  545      select: { id: true, billNumber: true, supplierInvoiceNumber: true, totalOwed: true, billDate: true, status: true },
  553      take: 500,
  554    });
  ```
- `apps/api/src/supplier-statements/statement-apply.service.ts:435-458` (comment at 435-443 explicitly says
  it mirrors the above "WP2" method "exactly"):
  ```
  435  /**
  436   * The candidate bills `matchStatementLines` needs, fetched fresh (never
  437   * from the scan's own snapshot)... Mirrors
  438   * `SupplierStatementsService.fetchMatchableBills` (WP2) exactly — VOID
  439   * bills excluded...
  441   * private to WP2's service, and the query is small enough that copying it
  442   * is cheaper than exporting a new cross-file contract for it.
  443   */
  445  private async fetchMatchableBills(supplierId: string | null): Promise<MatchableBill[]> {
  447    const bills = await this.prisma.forTenant().vendorBill.findMany({
  448      where: { supplierId, status: { not: "VOID" } },
  457      take: 500,
  458    });
  ```
  and re-run at apply time: `apps/api/src/supplier-statements/statement-apply.service.ts:176-179`:
  ```
  176  const supplierId = scan.supplierId;
  177  const lines = this.parseStatementLines(scan.extractedPayload);
  178  const matchableBills = await this.fetchMatchableBills(supplierId);
  179  const matches = matchStatementLines(lines, matchableBills);
  ```
  — confirms the record's "the apply step re-derives from the same capped pool" claim: apply doesn't reuse a
  persisted match result, it re-queries the same capped/unordered set and re-runs the matcher.

### History

```
$ git blame -L 541,554 --date=short apps/api/src/supplier-statements/supplier-statements.service.ts
2499b95b6 (najathakram 2026-08-20 541-554)  fetchMatchableBills — unchanged since authoring

$ git blame -L 445,458 --date=short apps/api/src/supplier-statements/statement-apply.service.ts
2499b95b6 (najathakram 2026-08-20 445-458)  fetchMatchableBills copy — same commit as above

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/src/supplier-statements/supplier-statements.service.ts
22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
5cb71545 2026-08-29 feat(api): wire AI usage metering; unify Anthropic key resolution (#475)
2499b95b6 2026-08-20 feat(finance): reconcile supplier statements on one review screen (#376)

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/src/supplier-statements/statement-apply.service.ts
22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
2499b95b6 2026-08-20 feat(finance): reconcile supplier statements on one review screen (#376)
```

Both copies were born together in the same commit (`2499b95b6`, PR #376, 2026-08-20 — the feature's original
introduction) and have not been touched since except by the unrelated pricing-package refactor (`22372911`).

### Existing tests around this behavior

- `apps/api/src/supplier-statements/supplier-statements.service.spec.ts` — grepped for
  `it(...500|take|matchAgainstBills|fetchMatchableBills|cap...)` — **no matches**.
- `apps/api/src/supplier-statements/statement-apply.spec.ts` — a fixture-builder comment at lines 38-43
  explicitly documents the shared shape (_"reused as-is, as one of the `vendorBill.findMany` candidates
  `fetchMatchableBills` hands to the real `matchStatementLines` (which only reads
  id/billNumber/supplierInvoiceNumber/totalOwed/billDate/status off it)"_) but the spec's test fixtures use a
  small, fixed set of bills (e.g. a single `vendorBill({...})` builder) — no test constructs > 500 bills or
  asserts an `orderBy`.
- `apps/api/src/supplier-statements/statement-matcher.spec.ts` — tests the pure `matchStatementLines`
  function directly, independent of how the candidate pool is fetched; not relevant to the cap/order bug
  itself.

### Production evidence (if any)

None — `sensitive: false` on this record (not money/tenancy-flagged), and no prod counts are cited.

### Open unknowns

- Actual per-supplier non-VOID `VendorBill` counts in production (whether any live supplier has already
  crossed 500) — not queried in this read-only pass.
- Whether Postgres's actual default scan order for this query is stable enough in practice to make the
  "non-deterministic" claim observable as flapping results across two applies of the same scan, or merely
  stable-but-arbitrary within one Postgres version/plan.

---

## B144 — Orders search filters only the loaded page and then hides the pager, so off-page matches are unreachable

### The bug as stated

- **Source** (`.claude/campaign/bugs/B144.md`, Rounds 4-5, adversarially verified Aug 29 2026 @ master
  `0b2c3a0a`, round4 R4-4-2), quoted verbatim:
  - **Meant to do.** "Typing a customer name or order number into 'Search customer or order #…' finds that
    order anywhere in the tenant's history, like every other filter on the same toolbar."
  - **Actually does.** "useOrders is called without any search param; the query filters one page of data in a
    useMemo, and both the per-page selector and the page buttons are hidden while a search is active."
  - **The gap.** "An order past page 1 reports 'No orders match your search' and the pager needed to reach it
    has just disappeared."
  - **Verifier's note.** "The footer already prints the filtered count against meta.total with an explicit
    '(filtered)' suffix, so the count is ambiguous rather than an outright lie — the unreachable-match half is
    the real defect. Related and verified while hunting: orders.service.ts:282-286 silently drops search
    whenever customerId is also present, which no live UI currently triggers."
  - **CLAIM — suggested fix (register).** "Send the debounced query as search to GET /orders and drop both
    the client-side filter and the !customerSearch pager guards. Note the server's search currently matches
    only customer.businessName and sits in an else-if with customerId — extend it to an OR over orderNumber
    so the placeholder's promise actually holds."
- **Repro (as stated)**: type a customer name/order number that only matches an order on page 2+ of the
  server's paginated (page-1-loaded) result → the client-side `useMemo` filter finds nothing in the loaded
  page → renders "No orders match your search" → both the per-page selector and page-nav buttons are hidden
  (`!customerSearch` guards) so there is no way to reach the actual matching page; **expected**: the search
  reaches every order in tenant history via the server.

### Code path

- `apps/web/app/(dashboard)/orders/page.tsx:340-349` — `useOrders` call, no `search` param sent:
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
- `apps/web/lib/api/orders.ts:174-186` (`useOrders` param type) — confirmed **no `search` field at all** in
  the type, even though the API DTO supports it:
  ```
  174  export function useOrders(
  175    params?: {
  176      customerId?: string;
  177      productId?: string;
  178      status?: string;
  179      urgent?: boolean;
  180      fulfillPath?: "ROUTE" | "SHIP";
  181      page?: number;
  182      limit?: number;
  183      deliveryDateFrom?: string;
  184      deliveryDateTo?: string;
  185    },
  ```
- `apps/web/app/(dashboard)/orders/page.tsx:355-382` — client-side filter+sort `useMemo` over only the
  `orders` already fetched for the current page:
  ```
  355  const filtered = React.useMemo(() => {
  356    const q = customerSearch.toLowerCase();
  357    const list = orders.filter((o) => {
  358      if (q && !o.customer?.businessName?.toLowerCase().includes(q) && !o.orderNumber?.toLowerCase().includes(q))
  359        return false;
  ...
  382  }, [orders, customerSearch, sortCol, sortDir]);
  ```
- `apps/web/app/(dashboard)/orders/page.tsx:972-1024` — pager block, `customerSearch`-gated:
  ```
  976    {customerSearch ? (
  977      filtered.length > 0 ? (
  978        <>Showing {filtered.length} of {meta.total} order{...} (filtered)</>
  979      ) : (
  985        "No orders match your search"
  ...
  999    {!customerSearch && ( ... per-page <select> ... )}
  1018   {!customerSearch && (meta.totalPages ?? 1) > 1 && ( ... prev/next buttons ... )}
  ```
  Both the per-page selector (999) and the prev/next pager (1018) are unconditionally hidden whenever
  `customerSearch` is non-empty — confirmed the record's "and then hides the pager" claim exactly.
- `apps/web/app/(dashboard)/orders/page.tsx:631-637` — the input itself: `placeholder="Search customer or
order #…"`, bound to `customerSearch`/`setCustomerSearch`.
- **Server-side support already exists but is under-reached and has its own gap**:
  - `apps/api/src/orders/dto/list-orders.dto.ts:14` — `@IsOptional() @IsString() search?: string;` — the DTO
    field the web hook never sends.
  - `apps/api/src/orders/orders.service.ts:307-333` (`findAll`), the else-if chain:
    ```
    323  if (user.role === UserRole.CUSTOMER) {
    324    ... where.customerId = customer.id;
    329  } else if (customerId) {
    330    where.customerId = customerId;
    331  } else if (search) {
    332    where.customer = { businessName: { contains: search, mode: "insensitive" } };
    333  }
    ```
    Confirms the verifier's note: `search` is silently dropped whenever `customerId` is also present
    (mutually exclusive `else if` branches), and — separately — the server's own `search` matches ONLY
    `customer.businessName`, never `orderNumber`, even though the input's placeholder promises "order #"
    matching too.

### History

```
$ git blame -L 340,349 --date=short "apps/web/app/(dashboard)/orders/page.tsx"
ae438b633 (Najath Akram 2026-03-10 340-342,349)  useOrders call — original
bb3b3446c (Najath Akram 2026-03-11 343,344)      deliveryDateFrom/To added next day
3884e1fc9 (najathakram  2026-08-19 345)          productId added (#369)
26ec71839 (najathakram  2026-08-24 346)          fulfillPath added (#435)
f4833855b (Najath Akram 2026-04-09 347,348)      page/limit added

$ git blame -L 329,333 --date=short apps/api/src/orders/orders.service.ts
ae438b633 (Najath Akram 2026-03-10 329,330,333)  customerId branch — original
41ab2803c (Najath Akram 2026-03-24 331,332)      search branch — added 2 weeks later

$ git blame -L 368,370 --date=short apps/api/src/orders/orders.service.ts
92b8ff6b1 (Najath Akram 2026-03-10 370)          orderBy: { createdAt: "desc" } — original

$ git log -3 --format='%h %ad %s' --date=short -- "apps/web/app/(dashboard)/orders/page.tsx"
f950543e 2026-08-31 fix(api): destructive-write guards, tenant scoping, and the scan/RLS guardrails (F02b) (#551)
28cb0a25 2026-08-29 fix: honor dispatch feature toggles ... (#491)
bca7e7ca 2026-08-28 fix: audit follow-up — nav skeletons, one purchasing home, charts, copy (#474)
```

`useOrders`'s param list has grown three times since 2026-03-10 to add new filters (`productId`,
`fulfillPath`, `deliveryDateFrom/To`) but `search` was never added to it, even though the server-side `search`
DTO field has existed since 2026-03-24 (`41ab2803c`) — i.e. every later filter addition to this hook copied
the existing (search-less) param list forward rather than adding the one that already existed server-side.

### Existing tests around this behavior

- No Jest/RTL test exists for `apps/web/app/(dashboard)/orders/page.tsx` (the only `.test.tsx` under
  `orders/` is `_components/CreateOrderModal.test.tsx`, an unrelated modal).
- No e2e spec navigates the orders list search box (`08-create-order-escape.spec.ts`,
  `13-boxed-order-entry.spec.ts`, `24-order-edit-pricing.spec.ts` are the other orders-adjacent e2e specs;
  none reference `customerSearch` or the "Search customer or order" placeholder).
- No API spec (`orders.service.spec.ts` — grepped for `it(...findAll|orderBy|pagination...)`) exercises
  `findAll`'s `search` parameter or the `customerId`/`search` else-if interaction.

### Production evidence (if any)

None cited.

### Open unknowns

- Whether any live UI path calls `findAll` with both `customerId` and `search` set (the verifier's note says
  "no live UI currently triggers" this today — not independently re-verified across the whole web app in this
  pass, only within `apps/web/app/(dashboard)/orders/page.tsx`).
- Whether `orderNumber` search should be a separate exact/prefix match vs. a `contains` OR alongside
  `businessName` — no product decision recorded either way in the source bug.

---

## B169 — Orders, invoices and customers paginate on a non-unique sort column with no id tiebreaker

### The bug as stated

- **Source** (`.claude/campaign/bugs/B169.md`, Rounds 4-5, adversarially verified Aug 29 2026 @ master
  `0b2c3a0a`, round4 R4-4-5), quoted verbatim:
  - **Meant to do.** "Paging through a list shows every matching row exactly once, in a stable order, however
    many rows share the same sort-key value."
  - **Actually does.** "All three findAll implementations pass a single-column orderBy to skip/take with no
    unique secondary key, so rows tied on the sort key have no guaranteed order between the page-1 and page-2
    queries."
  - **The gap.** "A row tied at a page boundary can appear on both adjacent pages or on neither, with no
    signal to the operator."
  - **Verifier's note.** "Not reproduced at runtime; filed as a proven code-level gap. The strongest
    real-world exposure is the invoices list, whose default sort is issueDate (day granularity, so many exact
    ties) and whose allowlist also exposes status and total. The orders createdAt tie case needs
    same-transaction batch creation."
  - **CLAIM — suggested fix (register).** "Append { id: 'desc' } — matching the primary direction — as the
    final orderBy element in all three findAll implementations; a one-line change per service with no API
    surface change."
- **Repro (as stated)**: two+ rows share the exact same value on the active sort column (e.g. two invoices
  both `issueDate = 2026-08-26`, straddling a page boundary at `skip`/`take`) → Postgres has no guaranteed tie
  order across the two separate `findMany` calls (page N and page N+1) → the tied rows can both appear on
  both pages, or on neither; **expected**: every row appears exactly once across all pages, in a stable order.

### Code path

All three `findAll` implementations confirmed to end their `orderBy` in a single column with no id/uuid
tiebreaker appended:

- `apps/api/src/orders/orders.service.ts:307-373` (`findAll`):
  ```
  368          skip,
  369          take: limit,
  370          orderBy: { createdAt: "desc" },
  371        }),
  372        this.prisma.forTenant().order.count({ where }),
  ```
  Single hardcoded column, no client-controlled sort at all for orders (unlike invoices/customers below).
- `apps/api/src/invoices/invoices.service.ts:2820-2846` (`findAll`) — client-controlled via an allowlist:
  ```
  2821      const validSortFields: Record<string, string> = {
  2822        date: "issueDate", issueDate: "issueDate", dueDate: "dueDate", total: "total",
  2826        amount: "total", createdAt: "createdAt", status: "status", invoiceNumber: "invoiceNumber",
  2830      };
  2831      const orderField = validSortFields[sortBy ?? ""] ?? "issueDate";
  2832      const orderDir = sortOrder === "asc" ? "asc" : "desc";
  2833      const orderBy: any = { [orderField]: orderDir };
  ...
  2836        this.prisma.forTenant().invoice.findMany({ where, include: {...}, skip, take: limit, orderBy }),
  ```
  Default sort field is `issueDate`, a date-only (day-granularity) column — matches the verifier's note that
  this is the highest-exposure of the three (many same-day ties possible). The allowlist also exposes `status`
  and `total` as sortable, both low-cardinality/tie-prone columns.
- `apps/api/src/customers/customers.service.ts:113-190` (`findAll`) — same allowlist shape:
  ```
  156      const validSortFields: Record<string, string> = {
  157        businessName: "businessName", contactName: "contactName", displayName: "displayName",
  160        customerType: "customerType", pricingTier: "pricingTier", createdAt: "createdAt", updatedAt: "updatedAt",
  164      };
  168      const orderField = query.sortBy && Object.hasOwn(validSortFields, query.sortBy)
  170          ? validSortFields[query.sortBy] : undefined;
  172      const dir = query.sortDir === "asc" ? "asc" : "desc";
  173      const orderBy: any = orderField ? { [orderField]: dir } : { createdAt: "desc" };
  ...
  187        skip, take: limit, orderBy,
  ```
- None of the three appends a second `orderBy` element (`{ id: "..." }` or similar) after the primary field —
  confirmed by reading each `findMany` call's full `orderBy` value above; each is a single-key object literal.

### History

```
$ git blame -L 368,370 --date=short apps/api/src/orders/orders.service.ts
92b8ff6b1 (Najath Akram 2026-03-10 370)  orderBy — original, unchanged

$ git blame -L 2820,2833 --date=short apps/api/src/invoices/invoices.service.ts
8fdedad77 (Najath Akram 2026-03-30 2820,2830-2833)  base allowlist shape
da5e89faa (Najath Akram 2026-04-08 2822-2829)       allowlist entries expanded (issueDate/dueDate/etc.)

$ git blame -L 168,173 --date=short apps/api/src/customers/customers.service.ts
ef21ef046 (najathakram 2026-07-17 168-173)  current allowlist/orderBy shape

$ git log -3 --format='%h %ad %s' --date=short -- apps/api/src/orders/orders.service.ts
1ebd4f54 2026-09-05 feat(api): 2b — leader-elected crons via advisory locks, per-family lock pools (#623)
d7dcf393 2026-09-05 fix(api,web,mobile): recurring invoices and standing orders (F13) (#612)
22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
```

The orders `orderBy` (single hardcoded `createdAt desc`) has been unchanged since original authoring
(2026-03-10). The invoices allowlist's base shape is from 2026-03-30 with entries added 2026-04-08; the
customers allowlist reached its current shape 2026-07-17. None of these later touches added a tiebreaker.

### Existing tests around this behavior

- No test in `orders.service.spec.ts`, `invoices.service.spec.ts`, or `customers.service.spec.ts` asserts the
  full `orderBy` array/object passed to `findMany` includes more than the single primary-sort key (grepped
  each spec file for `it(...findAll|orderBy|pagination|tiebreak|skip|take...)` — no matches in any of the
  three).
- No test constructs same-sort-key ties across a page boundary in any of the three services.

### Production evidence (if any)

None — the record explicitly states "Not reproduced at runtime; filed as a proven code-level gap."

### Open unknowns

- Real-world tie frequency on `Invoice.issueDate` in production (day-granularity column, default sort) — not
  queried in this read-only pass.
- Whether `Order.createdAt` ties are realistically reachable given the verifier's note that it "needs
  same-transaction batch creation" — i.e. whether any current order-creation path actually creates multiple
  orders with millisecond-identical (or, depending on column precision, second-identical) `createdAt` values
  in one transaction.

---

## Cross-row observations

Facts only — shared code, shared constants, shared queries between rows. No conclusions about fixes.

1. **The `limit: 999` / `MAX_LIST_LIMIT = 1000` "fetch-all" idiom (B12) is a repo-wide pattern, not unique to
   invoices.** `apps/api/src/common/pagination.ts:1-11`'s own doc comment says _"the dashboard's largest
   'fetch-all' idiom is ~999"_. Grepping `apps/web` for `limit:\s*999|limit=999` found the same
   `useX({ limit: 999 })` shape at: `apps/web/app/(dashboard)/credit-notes/page.tsx:556` (`useCreditNotes`),
   `apps/web/app/(dashboard)/vendor-bills/page.tsx:1058` and `:2326` (`useVendorBills`, two call sites), and
   `apps/web/app/(dashboard)/estimates/page.tsx:702` (`useEstimates`) — all in addition to
   `apps/web/app/(dashboard)/invoices/page.tsx:235`. None of these were audited beyond the grep in this pass;
   flagged as the same shape as B12, not confirmed to have the same symptom.

2. **The distinct `limit: 0` "fetch-all sentinel" idiom does NOT reach any of the eight endpoints in this
   batch.** Grepping the same pattern also surfaced a second, different fetch-all idiom (`{ limit: 0 }`) used
   by `useProducts` (`AssignProductsModal.tsx:30`, `ProductCreateModal.tsx:114`,
   `InlineCreateProductModal.tsx:74`, `GroupAsVariantsModal.tsx:60`, `promotions/page.tsx:171,675`,
   `inventory/page.tsx:2589,2596`, `products/[id]/page.tsx:315`, `products/page.tsx:1050`) and by product-search
   fallbacks in the buyer order-detail page (`buyer/portal/[seller]/orders/[id]/page.tsx:246,521`). `useOrders`,
   `useInvoices`, `useCustomers`, and `useInvoicePayments` (the hooks for the eight rows here) all sit behind
   DTOs with `@Min(1)` on `limit` (`list-invoices.dto.ts:35`, `list-orders.dto.ts:18`), so a `limit: 0`
   sentinel is not available to them — B12's fetch-all idiom for invoices is `limit: 999`, not `limit: 0`,
   confirming the two idioms are separate mechanisms in this codebase.

3. **No `findAll`-style list query in this batch appends an `id` (or any other unique-column) tiebreaker to
   its `orderBy`.** Confirmed directly for orders (`orders.service.ts:370`), invoices
   (`invoices.service.ts:2833`), and customers (`customers.service.ts:173`) — the three B169 sites — and also
   true of every OTHER `orderBy` read in this pass that backs a paginated list: `listAllPayments`
   (`invoices.service.ts:4272`, `{ paidAt: "desc" }` default), `getStatementForOperator`/`getMyStatement`
   (`customers.service.ts:876,890,904,273,287`, all single-column `createdAt`/`receivedAt desc`), and
   `fetchMatchableBills` (B117) which has **no** `orderBy` at all (worse than a missing tiebreaker — fully
   DB-order-arbitrary).

4. **Two independent, hand-copied invoice-number generators exist, all sharing the same pad-4/pad-5
   desc-string-sort ceiling (B100).** `InvoicesService.generateInvoiceNumber`
   (`invoices.service.ts:2722-2732`, 4 call sites: lines 444, 1171, 2650, 4187), `EstimatesService`'s inline
   copy inside `convertToInvoice` (`estimates.service.ts:245-252`, tenant-scoped via `tx`), `EstimatesService`'s
   separate `nextEstNumber` (`estimates.service.ts:15-24`, tenant-scoped via `.forTenant()`), and
   `OrdersService`'s order-number generator (`orders.service.ts:2230-2238`, pad-5) all independently
   reimplement "parse `<PREFIX>-<year-or-none>-<padded-int>`, `orderBy: { <col>: 'desc' }`,
   `parseInt(...) + 1`, `padStart(N, '0')`" rather than sharing one helper — three of the four (the two direct
   `generateInvoiceNumber` unscoped call sites plus `createPartialFromOrder`) additionally scan the bare
   (unscoped) `this.prisma` client, while the estimates/orders copies are tenant-scoped via
   `tenantTransaction`-wrapped `tx` or `.forTenant()`.

5. **An atomic, tenant-scoped counter pattern already exists in the same file as the buggy invoice-number
   generator and is not used by it.** `PaymentCounter` (`apps/api/prisma/schema/finance.prisma:349-357`,
   `id`/`next`/`tenantId`) is used via `tx.paymentCounter.upsert({ where: { id: counterKey }, update: { next:
{ increment: 1 } }, create: {...} })` at three sites in `invoices.service.ts` (lines 4447, 4743, 5042) for
   `InvoicePayment.paymentNumber` generation — an `upsert`+`increment` pattern that sidesteps both the
   cross-tenant-scan problem and the max+1-race problem that afflicts every generator in observation 4. No
   equivalent counter model exists for `Invoice`/`Estimate`/`Order` numbering.

6. **The date-filter asymmetry (B89) and the pagination-cap problems (B12, B80, B110, B117) are both
   "the same shape copied forward without revisiting the original bug."** B89's `dueDate` site
   (`invoices.service.ts:2810-2818`, added 2026-08-25 in #442) copied the already-five-months-buggy `issueDate`
   site's exact local-`setHours` pattern rather than the `setUTCHours` convention already established
   elsewhere in the same codebase (`bookkeeping.service.ts`, 17 sites) at the time of the copy. Likewise
   B117's two `fetchMatchableBills` copies were born identical in the same commit (`2499b95b6`) and have
   drifted zero lines apart since.

7. **Every list-cap/no-orderBy site touched in this batch predates the most recent ~10 days of commits and
   was not revisited by any of them.** The newest commit touching an _implicated_ line directly (as opposed to
   an unrelated nearby change in the same file) across all eight rows is B89's `dueDate` site (2026-08-25,
   #442); every other implicated line dates to March–April 2026 (original authoring) or August 20, 2026
   (`fetchMatchableBills`, #376). Files that show a 2026-09-0x commit in `git log -3` (e.g.
   `invoices.service.ts`'s `151c3f70`/`1f6483ec`/`22372911`, `customers.service.ts`'s `151c3f70`) touched
   unrelated lines in the same file, confirmed by `git blame` pinning every implicated line to its original,
   older commit.

8. **No spec file in this batch tests a cap, tiebreaker, or ordering boundary directly** — the one partial
   exception is `invoices.service.spec.ts:3211-3217` (B89), which asserts the _buggy_ local-`setHours`
   expectation rather than catching it. Every other implicated behavior (B12's `limit:999`, B80's `limit:200`
   - client find, B100's cross-tenant scan and string-sort wall, B110's `take:100/50`, B117's `take:500` +
     no orderBy, B144's missing `search` param, B169's missing tiebreaker) has zero direct unit-test coverage in
     this pass's greps. The one E2E dependency found (`apps/web/e2e/22-payment-truth.spec.ts:67-71`, B12) asserts
     the _literal_ `limit=999` request URL as a wait condition, not a correctness property — a fix that changes
     that request shape will need this test updated too.
