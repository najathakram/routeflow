# Cause brief — B440 / B455 / B456 — revenue accrual (bookkeeping)

> S1 evidence (Sonnet, read-only). Facts only — file:line, command output, or quoted source per
> claim. Cause is a CLAIM. No fix proposals.

## The bug as stated

- **B440** (`bookkeeping.service.ts:1093-1096 getSummary()`): "Bookkeeping getSummary.totalRevenue
  counts an invoice settled by a return credit note as full revenue (RULED: switch to accrual net
  sales)." Ruling folds in the same defect class at 4 sibling sites in this file.
- **B455** (`returns.service.ts:726-727`): "EXTERNAL_REFUND returns never reduce net sales (no
  credit note is minted for them)."
- **B456**: "Profit & Loss has no bad-debt expense line for written-off invoices."

**Suspected cause (claim, unverified)**: sites 1-2 key revenue on `paidAt` (a settlement
timestamp, not an accrual date) with no CN subtraction; sites 4-5 key on the correct `issueDate`
but never read CreditNote; B455/B456 are the upstream/downstream gaps feeding those reads —
mechanism traced in Code path below.

Repro (input → observed → expected):

1. **getSummary** `totalRevenue` (:1093-1096) — invoice issued last month, settled this month by
   a return CN → full `total` counted this month → should be $0 net-new.
2. **getProfitAndLoss** `revenue` (:985-989) — same invoice/CN → full total in the
   CN-application month; COGS windowed on SAME `paidAt` (:990-995) → both should be $0 net.
3. **getMobileDashboard** `revenue`/`netIncome` (:1223-1225) — `revenue:totalCollected` is a cash
   figure; the accrual figure `totalInvoiced` (:1214) is computed but unused (L-143, see Code
   path) — not itself wrong, just the wrong concept for the ruling's "revenue".
4. **getFinanceDashboard** `sales`/`totalSales`/`summaryTable.*.sales` — invoice $500 issued this
   month, $200 credited this month → `monthlyData[].sales`(:1313)/`getPeriodSummary().sales`
   (:1374) sum full `total`, no CN subtraction → reports $500, should be $300.
5. **getSalesByCustomer** `salesAmount` (:1498) — same fixture, same $500-vs-$300 gap.
6. **B455** — refund `method:"EXTERNAL_REFUND"` mints no CreditNote (:727) → sites 1-5 never see
   a reduction (they key off CreditNote/InvoicePayment) → invoice `total` counts as revenue
   forever despite `Return.refundAmount` saying money left.

## Code path

- **Mechanism, sites 1-2**: `returns.service.ts:701-704,738-743` (CN method) →
  `creditNotes.create()` → `applyCreditInTx()` (`credit-notes.service.ts:542`), diverging at
  `:605-608` — full settlement writes `{status:newStatus, paidAt: newStatus===PAID ? new
  Date():null}`: the CN-application instant, not `issueDate` (finance.prisma:185) — so downstream
  `paidAt`-windowed reads misattribute the period (**L-125**: `paidAt`="settled", not "earned").
- **getSummary**(:1093-1096) + **getProfitAndLoss** `revenueAgg`(:985-989, doc :966-973): both
  gate `invoice.aggregate({where:{status:PAID,paidAt:{window}},_sum:{total}})`, no CN
  subtraction; COGS shares this exact set (`fetchInvoicedSaleLines(...,{dateBasis:"paidAt",
  status:PAID})`, :990-995) — **L-119**: one shared collection today.
- **getMobileDashboard** (:1214 `totalInvoiced` accrual-correct, unused; :1223-1225
  `revenue:totalCollected` ← `invoicePayment.aggregate`:1180-1187, CONFIRMED+
  RECEIVED_METHOD_FILTER — cash figure, **L-143**).
- **getFinanceDashboard** (:1286-1294,1318,1336-1375) + **getSalesByCustomer** (:1477-1483,1498):
  both filter `status notIn[DRAFT,VOID,WRITTEN_OFF]` on `issueDate` — accrual-correct — but read
  no `creditNote`; the file's only `creditNote.findMany` calls are :2090/:2167 (unrelated methods).
- **B456**: `getProfitAndLoss` return (:1019-1028) has no bad-debt term. Sole writer of
  `WRITTEN_OFF` is `invoices.service.ts:5527-5559 writeOff()`, stamping (:5543-5549) status +
  `writtenOffAt:new Date()` in ONE write — repo grep for WRITTEN_OFF status-writes hit only this
  site + fixtures (see Open unknowns / `getBadDebtsReport`).

## History

`git log --oneline -8 -- apps/api/src/bookkeeping/bookkeeping.service.ts`:
```
d83819cd fix: CN never counted as payment (B421)
2e5602ae fix: F39 wallet+payment guards
22372911 refactor: pricing pkg + hardening
f1599490 fix: confirmed-payment truth (F03)
5cb71545 feat: AI usage metering
ea8a7479 fix: tenant-scope findUnique sweep
e460b3f8 feat: commission ledger
661191a5 feat: payment allocation
```
`git blame` of diverging lines:
- getSummary :1093-1096 — `c620aae0c`/`ae438b633`/`da5e89faa` (2026-03-10–04-08); untouched since.
- getProfitAndLoss :985-989 — same origin commits as getSummary; doc :966-973 is newer
  (`bbcb58eaa`, 08-12, docs-only).
- getMobileDashboard :1214-1230 — one commit `643bbfca6` (2026-04-28): both fields introduced
  together, split accrual/cash from day one.
- getFinanceDashboard :1280-1318 — `d689ab610`/`dfdb4419d`/`98e5b846a` (03-30); its
  RECEIVED_METHOD_FILTER lines are TODAY's (`d83819cd5`, B421) but touch only `receipts`, not
  `sales`.
- getSalesByCustomer :1468-1504 — `d689ab610`/`dfdb4419d`/`735362c4d`/`4878d0491` (03-30–04-14);
  WRITTEN_OFF exclusion (`4878d0491`) newest — no CN-netting added.
- returns.service.ts :726-727 — `355757aae` (07-30) introduced EXTERNAL_REFUND; untouched since.
- `common/invoiced-sales.ts` — 2 commits (`22372911` refactor, `bbcb58ea` AVCO intro); header
  states "returns / credit notes are not netted out of units or COGS" (:28-30).

No commit touches >1 site — getSummary/getProfitAndLoss share an origin pair; rest drifted
independently.

## Existing tests around this behavior

- `bookkeeping.service.spec.ts:259-295 describe("getSummary")` — 2 tests mock
  `prisma.invoice.aggregate` to `{_sum:{total:5000}}`/`{total:null}`, assert only the passthrough
  sum, never the `where` shape — pin today's VALUE, not the gate; need new CN-settled fixtures.
- `:862-958 describe("getProfitAndLoss")` — 3 tests; `:896-904` **pins today's basis**:
  `cogsFetch.where.status).toBe("PAID")`, `.paidAt.toEqual({gte,lte})`,
  `.issueDate.toBeUndefined()` — must change, not gain a case. No fixture uses WRITTEN_OFF, so no
  test guards a B456 bad-debt line either.
- `:656-838 describe('REG-B11...')` — exercises the 3 dashboards together; `:720-725,748-750`
  assert `dashboard.revenue === dashboard.totalCollected` (cash, L-143) — changing `revenue`'s
  meaning breaks these. No test asserts `totalSales`/`salesAmount` net-of-CN either way.
- **getFinanceDashboard/getSalesByCustomer**: no dedicated tests; the former appears only via
  REG-B11 (`:755-788`, `receipts`/`arAging`/`due`, never `sales`); the latter has zero references
  anywhere — `sales`/`salesAmount` untested in both.
- **returns EXTERNAL_REFUND**: `returns-refund.spec.ts:368-406,408-433,802-839` cover
  mint-nothing/atomic-claim/VOID-order-resolves — none touch net-sales; untested territory.

## Production evidence

None sought — a code-logic defect provable from source, not a data-corruption question.

## Open unknowns

- "CN date" unstated: `CreditNote` (finance.prisma:470-503) has no issue-date — only `createdAt`
  (mint) and `appliedAt` (:619, first-application only). B455 is clearer: `Return`
  (sales.prisma:996-998) has only `refundedAt`, matching the ruling.
- `invoiced-sales.ts` exports `REAL_INVOICE_STATUSES` (same notIn set wanted for
  `REVENUE_INVOICE_STATUSES`) + `fetchInvoicedSaleLines`, but no `{gross,creditNotes,
  externalRefunds,net}` shape exists yet (grep: 0 hits repo-wide).
- `getBadDebtsReport()` (bookkeeping.service.ts:1665-1694) already totals written-off invoices by
  `writtenOffAt` but isn't read by `getProfitAndLoss`, and is itself untested — reuse-or-duplicate
  for B456 not asked here.
- Noticed, not requested: `getCashFlow`(:1038-1083) and the AR/ledger reports also read
  PAID/paidAt, but are cash/balance figures, not revenue.
- Whether `applyCreditInTx`'s `paidAt:new Date()` stamp (:608) is itself in scope, or only its
  readers, is unspecified.
