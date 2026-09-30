# F15 · Customer removal lifecycle — discovery

> Produced 2026-09-13 by the analysis pass (bug-registry skill, carve-out batch: plan only, no
> code written). Per-bug detail lives in `.claude/campaign/bugs/B###.md`; this file is the
> CROSS-BUG plan. Verified against master@2d35375 (this worktree's api/web trees are identical
> to master there). Fix card: `.claude/pipeline/fix-cards/F15-customer-soft-delete-lifecycle.md`.

## Verdict

**Batch coherent: YES — but two of its seven bugs are ALREADY FIXED on master and the third is
half-fixed, and the ledger does not know.** PR #693 (`692bdf8`, merged 2026-09-11, train 4 Run D,
`Bookkeeping-Follow-Up: pending`) shipped B131 and B141 in full, plus the dispatch half of B157,
with `REG-B131 T1–T19` and `REG-B141 T6–T12 / W1 / W4` specs that were CI-green at merge. No
follow-up has run `prove`, so all seven rows still read `queued` and `brief F15` still leads
with "CONTAINS CARVE-OUT BUGS".

That matters for scheduling more than for code: **B131 is the ONLY money-tagged row in F15.** The
whole batch is parked because of it. Proving B131 and B141 against #693 removes the last
money-tagged workable row, and the remaining five (B156, B157, B158, B159, B170 — none tagged
`sensitive`) become agent-safe under `classify()`. The owner's decision here is therefore mostly
bookkeeping, not a money fix authorisation.

The five open bugs are one defect class in five surfaces — `Customer.deletedAt` written by one
branch (`customers.service.ts:2044-2047`) and either not read (B157 planning reads, B158 export,
B170 mutators/list) or its identity not released (B159), plus one pagination bug that only
shares a file (B156). They collide in `customers.service.ts` `findAll` and in the web list page,
so they ship as ONE where-builder plus two follow-on PRs, not five parallel agents.

One NEW finding raised the stakes on B170: `changeStatus` (`customers.service.ts:763-770`) has
no `deletedAt` gate, and the removed customer's page still renders the status buttons. Clicking
"Active" on a removed customer writes a zombie — `deletedAt` set + `User.status ACTIVE` — hidden
from every list and refused by every #693 door, yet able to log in (`auth.service.ts:60-61`
checks `User.deletedAt` and `status` only, never `Customer.deletedAt`).

## Re-verification

| Bug  | Severity | Tier | Verdict at master@2d35375                                                                                                                                                                                                                                                                      |
| ---- | -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B131 | high     | T1   | **ALREADY FIXED** — #693: both crons filter `customer: { deletedAt: null }` (order-templates :319-342, recurring-invoices :403-426), every create door refuses (invoices :348-350, orders :1925-1953, templates :131-137, recurring :84-90), expiry sweep :102-122. `prove --pr 693`.          |
| B141 | high     | T1   | **ALREADY FIXED** — #693: guard `buyer-seller-context.guard.ts:43-71`, getSellers/invite doors `buyer.service.ts:30,81,121,189`, Google `google-oauth.service.ts:615,647`, web context. Guard-only by owner ruling (DECIDE-22, no token revocation). `prove --pr 693`.                         |
| B157 | medium   | T1   | **HALF FIXED** — dispatch: `createRun` :808-836 drops removed customers' stops (REG-B131 T15). OPEN: `findOneRoute` :192-204, `getPackingList` :628-658, `getCustomerRouteAssignments` :704-728, `addStop` :450-487, optimizer/analysis includes. Re-scoped to the planning reads + badge.     |
| B156 | medium   | T2   | **CONFIRMED** — client-side filter over one server page `customers/page.tsx:352-355`; footer :1011-1013 / pager :1033-1069 from unfiltered `meta`; no `unassigned` in `ListCustomersDto`; `useResetPageOnChange` :286-292 omits the chip.                                                      |
| B158 | medium   | T1   | **CONFIRMED + widened** — `exportCustomers` :1635-1657 seeds `{}` vs `findAll` :122-127; export ALSO lacks the `regulated` clause (:151-153); web button `mutate({})` :701 sends no filters though the hook (:632-644) and controller (:67-75) accept them.                                    |
| B159 | medium   | T1   | **CONFIRMED** — soft branch keeps `User.email/username/googleId` under `@@unique` (tenancy.prisma:279-281); probe :477-480 unfiltered; a filtered probe alone still hits the index at :499. Import side-steps via `_1` suffix (import.service.ts:405-411, :604-613) — a duplicate, not a fail. |
| B170 | medium   | T1   | **CONFIRMED + widened** — restore hook's sole caller is the Undo toast (`[id]/page.tsx:1980,1994`); no `removed`/`includeDeleted` list filter; detail page never reads `deletedAt`; NEW: `changeStatus` :763-770 unguarded → zombie (see Verdict).                                             |

None of the register's suggested fixes was refuted outright this time; two were narrowed. B131's
"set isActive=false + restore" was superseded by the train-4 ruling (stateless read filter,
restore-symmetric) and has shipped that way. B141's "flip CustomerLink status" was rejected by the
same ruling (restore symmetry; the guard is the choke point for all 51 seller-scoped routes).
B159's "filter the probe" half is insufficient on its own — the DB unique index throws at
`tx.user.create` — so the identity must actually be released (the verifier's note was right).

## Ordering

`B131 + B141 -> B158 + B156 + B170 -> B159 -> B157`

**Step 0 = bookkeeping, no code.** `prove B131 --pr 693` and `prove B141 --pr 693` (titles in
each record's Test plan). This is what un-parks the batch. A docs-only PR; it also settles
#693's `Bookkeeping-Follow-Up: pending` trailer for these two rows.

**PR 1 = B158 + B156 + B170 together** — the customers list / export / lifecycle surface.
B158 introduces the ONE where-builder (`buildListWhere(query)`) that `findAll` and
`exportCustomers` both call; B156 (`unassigned=1` → `routeStops: { none: { route: { kind:
"SCHEDULED" } } }`) and B170 (`removed=1` → `deletedAt: { not: null }`, default `null`) are
additions to that same function and to the same 17-line `ListCustomersDto`. Splitting them means
three agents editing one `where` and one DTO. Web: all three edit `customers/page.tsx`
(chip → server param + pager, export params, "Removed" chip + row badge + Restore); B170 also
edits `customers/[id]/page.tsx` (Removed banner, hide status/edit/Remove, Restore) and
`changeStatus`/`update` refuse a removed customer (409 "Restore the customer first").
B158 lands first WITHIN the PR because the other two extend its builder.

**PR 2 = B159** — changes what the soft delete WRITES (tombstone `username~removed~<id8>`,
`removed+<id>@placeholder.local`, `googleId = null`, `User.deletedAt`) and what restore reverses
(strip suffix, email back from `Customer.email`, 409 on a real clash, tolerate pre-fix rows). It
touches `deleteCustomer`'s soft branch and `restoreCustomer` only — disjoint from PR 1's methods
but the same file, and its restore-conflict UX ("restore with a different username") wants B170's
Restore surface to exist first. No migration.

**PR 3 = B157** — routes module only (`routes.service.ts` reads + `addStop` refusal, one named
stop-filter constant reused by `createRun`/`getPackingList`/optimizer loads, web + mobile route
stop badge). Its `getCustomerRouteAssignments` change (`customer: { deletedAt: null }`) is the
same "assigned" predicate B156 filters on, so B157's API half may fold into PR 1 if one author
takes both; the badge UI stays in PR 3.

## File conflicts — never parallelise these

| File                                                                                                                                                                                                                                                | Bugs                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `apps/api/src/customers/customers.service.ts` — `findAll` :117-202 / `exportCustomers` :1635-1709 share the new builder (B158+B156+B170); `changeStatus` :763 (B170); `deleteCustomer` soft branch :2039-2049 + `restoreCustomer` :1965-1984 (B159) | B156, B158, B159, B170 |
| `apps/api/src/customers/dto/list-customers.dto.ts` — 17 lines, both add a field                                                                                                                                                                     | B156, B170             |
| `apps/web/app/(dashboard)/customers/page.tsx` — chip/pager (:265-355, :902-920, :1006-1069), export button (:701), Removed chip + row badge                                                                                                         | B156, B158, B170       |
| `apps/web/app/(dashboard)/customers/[id]/page.tsx` — Removed banner / Restore (B170); restore-conflict prompt (B159, optional)                                                                                                                      | B159, B170             |
| `apps/api/src/routes/routes.service.ts` — `getCustomerRouteAssignments` :704-728 is B156's predicate AND B157's exclusion                                                                                                                           | B156, B157             |
| `apps/api/src/customers/customers.service.spec.ts` — every T1 token in this batch except B157's lands here                                                                                                                                          | B156, B158, B159, B170 |

Hub file: `routes.service.ts` (B157 only, plus the shared predicate above). No conflict with
another batch's non-hub file was found; `orders.service.ts` / `invoices.service.ts` are not
touched by the five open bugs.

## Shared fixes and the structural candidate

- **One where-builder** (`buildListWhere`) is the fix for B158 and the landing site for B156 and
  B170 — list/export drift becomes unwritable, not merely tested. A parity spec (`REG-B158 T1`)
  pins it.
- **One stop-filter constant** in `routes.service.ts` (`OR [{ customerId: null }, { customer:
{ deletedAt: null } }]`, already written inline in `createRun` :818) reused by
  `getPackingList` and the optimizer loads — B157.
- **Scan signature `soft-delete-omission`** (issue #502 territory): schema-derived, like
  `unscoped-tenant` (`scan-signatures.mjs:798-854`) — for every model whose block has
  `deletedAt`, flag a `findMany`/`findFirst`/`count`/`update` on a model carrying a relation to
  it whose captured `where` does not filter that relation's `deletedAt`. Four of this batch's
  seven bugs (B131, B141, B157, B170) are that one shape; the cheapest low-noise first cut is
  `@LeaderCron` methods + guards' `canActivate` + mutators on the soft-deletable model itself.
- **Scan signature `client-filter-paginated`** (B156): `useMemo(() => x.filter(` over
  `result?.data` in a file that also reads `meta.total`. Two siblings to triage if it lands:
  `vendor-bills/page.tsx:935 needsMappingOnly`, `inventory/page.tsx:2640 missingCostOnly`.
- **Restore symmetry** is the batch's design law (train-4 ruling): every new gate is a read-side
  filter on `deletedAt`, never a second flag written at delete time — the ONE exception is B159,
  which must write (the unique index leaves no read-side option) and therefore must reverse
  itself in `restoreCustomer`.

## Risks

1. **B159 changes the soft-delete write.** Rows removed before the fix carry no tombstone;
   `restoreCustomer` must strip a suffix only when present and leave a pre-fix email alone
   (`REG-B159 T4` pin). The owner's train-4 damage report reads only `deletedAt`, so it is
   unaffected. A `*.db.spec.ts` under `local:test:db` is the only test that can prove the unique
   index no longer fires — T1 mocks cannot.
2. **B170's `removed=1` reaches the export through B158's builder** — intended ("export what I
   see"), but state it in the PR so nobody "fixes" it back.
3. **B156's server predicate must equal `getCustomerRouteAssignments`'s** (RouteStop on a
   SCHEDULED route, live customer) or the "Currently in" hint and the filter will disagree on
   the same screen — one exported constant, not two literals.
4. **B170's `changeStatus` gate must not live in `findCustomerOrThrow`** — statements, documents,
   comments and history reads all go through it and must keep working for a removed customer.
5. **B157 severity**: with dispatch already fixed, the residual is planning noise; the record
   says medium is generous. Re-tier is the owner's call; the batch does not depend on it.

## Non-goals

Refresh-token revocation on removal (DECIDE-22 — BuyerRefreshToken is account-wide) · deleting
`RouteStop`/`RouteCustomer` rows on soft delete (restore symmetry) · a global Prisma soft-delete
middleware (would hide removed customers from `findOne`, restore and history) · mobile
remove/restore UI (mobile has neither today; mirror later) · `send`/`sendEmail` of an EXISTING
invoice to a removed customer (real residual door, not in any F15 title — file separately) ·
historical data repair for pre-#693 generated orders/invoices (owner's read-only damage report,
`2026-09-10-train4-damage-report`).

## Bookkeeping commands (owner / landing coordinator)

```bash
npm run bugs -- prove B131 --pr 693 --proof "REG-B131 T1: generateDailyOrders skips an active template whose customer was removed"
npm run bugs -- prove B141 --pr 693 --proof "REG-B141 T6: the seller-context guard refuses a removed customer's ACTIVE link, and names it in the log"
npm run bugs -- sync
```

Both specs live on master since #693 and were CI-green at merge; this analysis worktree carries
no `node_modules`, so they were not re-run here.
