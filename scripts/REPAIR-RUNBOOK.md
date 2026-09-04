# Production Integrity Repair Runbook (2026-08 findings)

Companion to [`scripts/repair-integrity.mjs`](repair-integrity.mjs), which repairs — one row
at a time, dry-run first — the damage found by [`scripts/data-integrity-report.mjs`](data-integrity-report.mjs)
on 2026-08-28/29. All affected rows belong to **live client tenants**: fresh verified backup
first, per-row confirmation, forensic re-check after every write. The script's row registry is
a hardcoded allowlist; it cannot touch anything else.

The script was end-to-end tested on 2026-08-29 against a local DB seeded with synthetic copies
of every damaged state (same UUIDs, `qa-repair-test` tenant): every executable path ran, every
scoped forensic re-check came back clean, and the audit log captured before-state + SQL.

**Per-batch repair lanes (campaign D4, repair-as-we-go).** Each batch that fixed a
damage-writing bug ships its own scoped script beside this runbook, same safety model
(dry-run default, explicit `--execute` + backup attestation + per-row confirm, one
transaction per row with an in-transaction re-read, JSONL log to `local-assets/`):

| Script                                                             | Batch      | Repairs                                                                                                                                                                                                                                                                                                                                                                                                             | Report-only                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`repair-f03.mjs`](repair-f03.mjs)                                 | F03        | payment-status truth                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                  |
| [`repair-f17.mjs`](repair-f17.mjs)                                 | F17        | duplicate import payments                                                                                                                                                                                                                                                                                                                                                                                           | clusters > 2                                                                                                                                                                                                                                                                       |
| [`repair-f10-reopen-damage.mjs`](repair-f10-reopen-damage.mjs)     | F10 (#591) | **B55** — `Product.currentStock` inflated by pre-fix reopens, derived from the only rows that record them (`type:SALE`, `quantity>0`, `reference LIKE 'Reopen stop %'`)                                                                                                                                                                                                                                             | **B54** — invoices left PAID/PARTIAL on a reopened stop. NEVER auto-mutated: the money really was collected, so whether the order state or the invoice is wrong is a per-case owner judgment                                                                                       |
| [`repair-f11-stranded-orders.mjs`](repair-f11-stranded-orders.mjs) | F11 (#TBD) | **B129 / B211** — orders stranded on a CANCELLED run's non-COMPLETED stop or a COMPLETED run's SKIPPED stop: `routeRunId`/`routeRunStopId` never released, invisible to the dispatch sweep and the trip builder. One transaction per run, with the stop's status re-read under lock: revert `OUT_FOR_DELIVERY` → `CONFIRMED`, null both pointers, then DECLINE every PENDING `ChangeRequest` on the released orders | settlement attribution — a released order that also carries a PAID CASH/CHECK `InvoicePayment`. Still released (spec R15); printed so the owner can check that run's settlement. Sales-by-Driver also drops every released order's invoices (not itemised — see the section below) |

⚠️ **`Reopen stop %` is load-bearing.** It is simultaneously the B55 damage footprint and the
only historical trace of a pre-fix reopen (F10 added an `AuditLog` + `podHistory` trail going
forward). A new writer reusing that `reference` prefix would poison the repair query.
Reopens of stops that recorded no DELIVERED/PARTIAL mutation left no trace at all and are
recorded as unrepairable rather than guessed.

---

## 1. Command sequence (always in this order)

```bash
# 0. See the row registry and each row's options (no DB needed)
node scripts/repair-integrity.mjs --list

# 1. FRESH BACKUP — house method (proxy pg_dump dies mid-stream; use the in-container dump):
#    railway ssh --service postgres, pg_dump inside the container to /tmp, cat it out,
#    verify line-count match + the trailing "PostgreSQL database dump complete" marker.
#    Do NOT proceed on an unverified dump.

# 2. DRY RUN — prints current state → proposed state → exact SQL, writes nothing
#    (the session is forced read-only server-side):
railway run --service postgres node scripts/repair-integrity.mjs

# 3. Decide the "needs a human" rows (section 3 below), then execute ONE ROW AT A TIME:
railway run --service postgres node scripts/repair-integrity.mjs \
  --execute --i-have-a-fresh-backup --confirm <rowId> \
  [--resolution <rowId>=<option>] [--payment <paymentId>]

# 4. After each row (the script already re-runs the scoped forensic check), and once
#    at the end, re-run the full report:
railway run --service postgres node scripts/data-integrity-report.mjs --verbose
```

Safety properties you can rely on:

- Nothing is written without `--execute` **and** `--i-have-a-fresh-backup` **and** an explicit
  `--confirm <rowId>` per row. There is no fix-everything mode.
- Each repair is one transaction; the row is locked and its before-state re-read and compared
  to the dry-run snapshot inside the transaction — if anything changed in between, that row
  aborts untouched.
- Refuses to run against a DB whose `current_database()` isn't `railway` unless
  `--force-nonprod` is passed.
- Every executed repair is appended to `local-assets/repair-log-<timestamp>.jsonl`
  (ids, before-state, SQL + params, verify result). `local-assets/` is gitignored and
  machine-local — keep these files; they are the rollback source.

---

## 2. What each repair does and why

### CRITICAL

#### `overpaid-1a8fbb3d` — invoice `1a8fbb3d-2a43-4b5f-88e5-a88254a5e97a` (invoice-overpaid) — **NEEDS HUMAN**

total = 1483.50, non-VOID payments = 1912.50 → **429.00 over**. The payment-recording paths
cap at `total − othersTotal` (invoices.service.ts ~L4595), so this predates the guard or came
through a bug — either a **double-recorded payment** or a **genuine customer overpayment**.
The DB cannot tell those apart. Decision + options in section 3.

#### `paidbal-882e3615` — invoice `882e3615-e79b-43f8-aa7d-4193483ce55a` (invoice-paid-with-balance) — **NEEDS HUMAN**

status PAID but recorded payments total 834.00 of 1834.00 (**1000.00 short**). Either the PAID
flag is a lie (a status write that skipped `recomputeStatus` — B74/B84 family, possibly a
double-void that erased a payment), or a real 1000.00 payment was never recorded. The dry run
prints every payment row including VOID ones — look there for a voided ~1000 payment (B84
fingerprint) before deciding. Decision + options in section 3.

#### `deadpay-cf082424` — payment `cf082424-0a8c-47ec-8f7b-6e63e964f192` (payment-on-dead-invoice) — auto

A live 6.25 CREDIT_NOTE/ADVANCE application sits on a VOID invoice: the customer's wallet
money is stranded on a dead document (B66/B67 — the void path predating
`releaseWalletPaymentsInTx`). The repair performs **exactly the step `voidInvoice` should
have run**: delete the application row and restore the wallet —

- CREDIT_NOTE → `CreditNote.amountUsed −= 6.25`, status/appliedAt/expiry per
  `restoreCreditFromPaymentInTx` (including the owner-approved 2026-08-13 REVIVE of a
  past expiry, so the money lands somewhere spendable);
- ADVANCE → `AdvancePayment.balance += 6.25`.

Effect: the customer regains 6.25 of spendable credit. The script aborts to a human if the
invoice turns out to be WRITTEN_OFF rather than VOID (bad-debt write-offs are a business call).

#### `overbill-6edd8f20` — order item `6edd8f20-b0d1-4404-be6d-954eb7aacd14` (orderitem-overbilled) — auto

ordered = 11 but `invoicedQty` = 55 (= 5 × 11 — the increment ran five times; a retry loop
around the split-invoice bump, before the atomic-batch fix). `invoicedQty` is pure
bookkeeping ("how much of this line have invoices claimed") — customer-facing money is on the
invoices themselves. The repair recomputes it from ground truth: Σ qty of **live (non-VOID)
invoice lines** with provenance to this order line (plus the legacy productId match
`adjustInvoicedQtyForInvoice` uses), clamped to `[0, qty]` exactly like the service. Expected
end state: `invoicedQty = 11`.

Guardrails: if live invoice lines genuinely bill MORE than ordered, the script refuses (that
would be real over-billing being papered over) and escalates; likewise if the product-match is
ambiguous. Without this repair, voiding an invoice on this order later would decrement from 55
and the line would still look fully billed — permanently un-re-invoiceable.

### HIGH

#### `repair-f11-stranded-orders.mjs` — stranded orders on cancelled / completed runs (B129 / B211) — auto

Before F11 (#TBD), cancelling a run — or completing one with a SKIPPED stop — never released the
stop's undelivered orders: `Order.routeRunId`/`routeRunStopId` stayed pinned to the now-dead run,
invisible to the dispatch sweep and the trip builder (both require the pointer null), so the
order was stranded with no path back to a route. The fixed code now runs the release inline, in
the same transaction as the status write, for every run going terminal from the deploy forward.
This script finds every row that predates the deploy — `routeRunStopId IS NOT NULL`, order status
NOT IN (DELIVERED, CANCELLED), **the stop itself not COMPLETED**, and its run CANCELLED, or
COMPLETED with that stop SKIPPED — and applies the identical release retroactively, one
transaction per run. **What it changes, in this order:**

1. an `OUT_FOR_DELIVERY` order → `CONFIRMED` (its stop filter is lost the moment the pointer is
   nulled, so this has to run first);
2. `routeRunId` / `routeRunStopId` → NULL for those orders;
3. every **PENDING `ChangeRequest`** on the orders step 2 actually released → `status='DECLINED'`,
   `resolution='DECLINED'`, `resolutionReason='Run cancelled — order released to dispatch'`,
   `resolvedAt=NOW()`, `updatedAt=NOW()` (the shipped helper bumps `updatedAt` through Prisma's
   `@updatedAt`; raw SQL has to set it). Resolver identity fields stay NULL (a system decline,
   exactly as the shipped helper writes it) and no notification is sent. Without this a released
   order carries a PENDING CR that a re-dispatched driver could approve, **applying the same items
   a second time** — CRs are only created and applied while the order's run is IN_PROGRESS, so a
   released order is back in the buyer's own edit window while its CR still sits PENDING. Step 3
   is keyed by the same locked id array as step 2, so the released set and the declined set are
   provably the same rows.

Nothing outside that predicate is written. The RouteRunStop rows themselves
are untouched — they stay as history. Inside each run's transaction the run's status and every
scoped order's `(status, routeRunId, routeRunStopId)` are re-read and compared to the dry-run
snapshot; any drift aborts that run and moves on to the next one.

⚠️ **The stop's status is re-read inside the transaction too**, after the order rows are locked,
and any order whose stop has become COMPLETED since the scan is dropped from **all three** writes
and reported as `skipped (stop completed since scan): N` (printed in both modes). The scan and the
writes are two statements under READ COMMITTED; a driver's `completeStop` / `completeWithPayment`
committing in that window would otherwise let the script strip the pointers off an order that had
just been delivered and paid for at the door. The shipped fix closes the same hole by carrying
`routeRunStop: { status: { not: "COMPLETED" } }` in every statement. The re-check runs _before_ the
drift comparison on purpose: completing a stop usually moves its order's status too, and such an
order must be skipped, not treated as drift that aborts the whole run. A run whose every scoped
order is skipped this way commits nothing and is counted under `skipped`.

The dry run also prints `change requests declined: N` — a COUNT over step 3's own predicate, never
a write.

**Report-only:** a released order that also carries a PAID CASH/CHECK `InvoicePayment` (joined
through `Invoice.orderId`) is still released — the money really was collected, and leaving the
pointer pinned would just re-strand the order — but is printed under a **"settlement attribution
moved"** heading so the owner can check whether that run's settlement (if one was recorded) needs
a second look. This is the forward-fix's own intended contract (spec R15), not a bug the script
corrects, and the script never mutates money.

**Report-only:** an undelivered order still pinned to a **COMPLETED** stop of a cancelled run. The
fixed code only ever releases stops read with `status: { not: "COMPLETED" }`, so such a row is not
the damage this bug wrote — work was recorded at that door, and its cash is attributed to that run.
The script lists it under **"pinned to a COMPLETED stop — NOT repaired"** and never writes it;
freeing one is an owner decision, taken row by row.

⚠️ **Run this promptly after the F11 deploy — until it runs, those operators have no self-service
recovery.** From the deploy forward `reopenStop` refuses a SKIPPED stop on a COMPLETED run, and it
refuses pre-deploy rows too — reopening one used to be the operator's own way back to its orders.
The API tells them which case they are in, using this script's own scope filter: a stop that still
holds an order with status **not in** `DELIVERED`/`CANCELLED` (a row this script has not reached
yet) says _"still attached to it … ask an operator to run the F11 stranded-order repair"_, while
any other stop says _"released to dispatch — dispatch them on a new run"_. An operator reporting
that first message is asking for this script. The discriminator is deliberately not "does the stop
have any orders": a released stop keeps its DELIVERED and CANCELLED orders pinned (this script
skips them too), so keying on order count would send an operator here for rows the dry run reports
nothing about.

⚠️ **`--tenant` takes the slug, not the business name.** An unknown slug now exits non-zero with
`No tenant with slug "<x>"` instead of scanning nothing and reporting "nothing to repair" — but
re-check the slug against `Tenant.slug` before reading a clean dry run as a clean tenant.

**Two reports attribute through `Order.routeRunId`, and this repair moves both — retroactively.**
`getRunCashCollections` (a run's expected cash at settlement, the note above) and **Sales-by-Driver**
(`BookkeepingService.getSalesByDriver`, which credits an invoice to the driver of its order's
_current_ run and skips an order that has no run). So releasing an order drops **every** invoice on
it — payment or not, i.e. a wider set than the payment-scoped print above — out of Sales-by-Driver
until a re-dispatch re-pins it, at which point the credit lands on the driver who actually delivers.
Running this script applies that shift in one go across every historical cancelled /
completed-with-skipped run. It is intended (spec R15): the stop recorded no work, so that driver
never delivered the order. The affected invoices are **not** itemised by the script, so if
Sales-by-Driver numbers for a past period feed driver pay or commission, export them **before** the
run and re-run the report afterwards.

```bash
railway run --service postgres node scripts/repair-f11-stranded-orders.mjs [--tenant <slug>] [--verbose]
railway run --service postgres node scripts/repair-f11-stranded-orders.mjs \
  --execute --i-have-a-fresh-backup --confirm <runId>   # repeat --confirm per run, or use --confirm-all-listed
```

#### `unpaidpay-638eb534`, `unpaidpay-bc48a97b` (invoice-unpaid-with-payments) — auto

Invoices carrying real non-VOID payments (824.00 / 1371.00) whose status was never recomputed
(B74/B76). The repair is a pure mirror of `InvoicesService.recomputeStatus` over the recorded
payments — the same function every payment path calls today:

- `638eb534…` (OVERDUE, paid 824 of total) → PARTIAL (or PAID if payments cover the total —
  the script computes from live data);
- `bc48a97b…` (SENT, paid 1371) → PARTIAL/PAID accordingly; `paidAt` is set to the latest
  payment's date when landing PAID.

No money moves; the status simply stops lying. AR aging and reminder emails change accordingly.

#### `hdrmath-1a62c9d9` — invoice `1a62c9d9-0c49-42df-bfa5-a701fd13a4db` (invoice-header-math) — **NEEDS HUMAN**

stored total = 100.00, but subtotal 100.00 − discount 50.00 + tax + shipping = 50.00. Either
the total is stale (a discount edit that never re-derived the total) or the 50.00 discount is
phantom. Decision + options in section 3.

#### `linesum-ea63fb65` — invoice `ea63fb65-f883-4a02-97ce-b93316f6284f` (invoice-lines-vs-subtotal) — **NEEDS HUMAN**

header subtotal = 297.50 but Σ line subtotals = 554.50. Either a line edit never re-summed the
header (lines right, header wrong) or the line list carries duplicates (header right, lines
wrong). The dry run prints every line with id/qty/subtotal/createdAt so duplicates are easy to
spot. Decision + options in section 3.

#### `retdel-36c21079`, `retdel-aa79cb93`, `retdel-2ef317f6` (return-exceeds-delivered) — **NEEDS HUMAN**

Three order lines where returned qty > delivered qty (returns validated against ORDERED qty —
B53): returned 1/2/1 against delivered 0 (ordered 1/4/3). A return of goods never recorded as
delivered is self-contradictory — but which side is wrong depends on what physically happened.
Decision + options in section 3. (The script resolves these rows by the forensic report's
order:product id prefixes and aborts unless the prefix matches exactly one pair.)

#### `tenantdrift-23fae434` — return `23fae434-d2a6-465f-a8fd-ac0d52cffa3a` (tenant-drift-return) — auto

`Return.tenantId` is NULL/wrong while its Order has a tenant — the row is **invisible to every
`forTenant()`-scoped reader** (returns list, credit-note flows, reports). The only defensible
tenant is the parent Order's. The repair stamps the Return — and, in the same transaction, any
of its ReturnItem children whose tenantId also drifted (shown explicitly in the dry run;
fixing only the parent would just make the `tenant-drift-returnitem` check fire next run).

### Data hygiene (optional)

#### `orphantpl-15e9d9f1` — recurring template `15e9d9f1-f333-40ec-8ac2-cecd840fe668` — auto

Its Tenant row no longer exists; the cron may trip over it and nothing can legitimately own
its output. Repair: `isActive = false` (reversible). Deleting the template + items outright is
the tidier end state but destroys the last record of what that tenant billed — owner's call,
by hand, later.

#### `stalledtpl-61bc82ba` — recurring template `61bc82ba-eb23-47cd-802f-10715352fd92` — auto

Tenant is READ_ONLY and `lastRunAt == nextRunAt == 2026-05-01` — B46's dead-advance
fingerprint (the run fired but never advanced the schedule). If the tenant is ever reactivated
the cron would fire **nightly**, duplicate-invoicing the customer each midnight. Repair:
`isActive = false`. If the client returns, re-enable from the app only after setting a future
`nextRunAt`. (Alternative for "client is coming back next week": manually advance `nextRunAt`
to the next valid future occurrence instead of deactivating — do that by hand if preferred.)

---

## 3. The decisions the owner must make

| Row                   | Question                                                                                                                                                             | Executable option                                                                                                                                                                                            | Other option                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overpaid-1a8fbb3d`   | Is the 429.00 a duplicate entry or real money received? Check the drawer/bank for that day; the dry run lists every payment (amount/method/date).                    | **Duplicate:** `--resolution overpaid-1a8fbb3d=void-duplicate-payment --payment <id of the duplicate>` — voids that one payment (wallet-restoring if it is credit/advance money) and recomputes status.      | **Real overpayment:** `--resolution overpaid-1a8fbb3d=convert-excess-to-advance` — moves the 429.00 off the latest cash-type payment into a new AdvancePayment (customer wallet). Customer statement then shows a 429.00 credit — tell the client. |
| `paidbal-882e3615`    | Did the customer actually pay the missing 1000.00? Look for a VOID ~1000 payment in the dry run (B84 double-void) and check the bank.                                | **Not paid:** `--resolution paidbal-882e3615=recompute-status` — invoice returns to PARTIAL with 1000.00 due; it re-enters AR aging and dunning.                                                             | **Paid:** record the 1000.00 payment through the app UI (correct numbering/commissions/cash-basis); the forensic check then clears itself. Never fabricate the payment row via SQL.                                                                |
| `hdrmath-1a62c9d9`    | Was this sale really 50.00 (discount legit, total stale) or 100.00 (discount phantom)? Compare against the PDF actually sent / what the customer paid.               | **50.00 is right:** `--resolution hdrmath-1a62c9d9=trust-components` — total → 50.00, status recomputed (may flip PAID if payments cover it).                                                                | **100.00 is right:** fix the wrong component (likely the 50.00 discount) by hand/in the app; the script deliberately won't guess which component to change.                                                                                        |
| `linesum-ea63fb65`    | Are both lines real (customer received 554.50 of goods) or is one a duplicate append? Inspect the dry run's line list (ids, qty, createdAt) and the delivered order. | **Lines right:** `--resolution linesum-ea63fb65=resum-header` — subtotal → 554.50, total re-derived, status recomputed. ⚠️ The customer's balance due rises by ~257 — reconcile with them before dunning.    | **Header right:** delete the duplicate line(s) in the app, then run `resum-header` (no-op if the header already matches).                                                                                                                          |
| `retdel-*` (×3)       | Were the goods physically delivered? Ask the driver/client for each order.                                                                                           | **Delivered in full:** `--resolution retdel-<id>=mark-delivered-full` (deliveredQty → ordered). **Only the returned part provably reached them:** `=mark-delivered-returned-only` (deliveredQty → returned). | **Never delivered:** cancel/reject the return in the app (so restock + credit reverse through the service paths), not via this script.                                                                                                             |
| `orphantpl-15e9d9f1`  | Keep the orphan template's history or purge it?                                                                                                                      | Deactivate (the script's action — reversible).                                                                                                                                                               | Hard-delete template + items by hand once history is confirmed worthless.                                                                                                                                                                          |
| `stalledtpl-61bc82ba` | Is the READ_ONLY client expected back?                                                                                                                               | Deactivate (the script's action — safe either way).                                                                                                                                                          | If they return: set a future `nextRunAt` first, then re-enable in the app.                                                                                                                                                                         |

Open follow-ups the repairs do **not** cover:

- If `paidbal-882e3615` turns out to be a B84 double-void, the same bug may have released
  `invoicedQty` twice on its order — after deciding, re-run the full forensic report and look
  at `orderitem-invoicedqty-underrun`.
- `retdel` repairs record delivery bookkeeping only; they do not touch stock. If a return
  restocked goods that were never delivered, inventory is overstated by that qty — check the
  product's stock after deciding.

---

## 4. Rolling back

Full rollback = restore the pre-repair backup (house method, `psql` — never raw `pg` binary
restore). For single repairs, use the before-state in `local-assets/repair-log-*.jsonl`:

| Repair type                                                               | Rollback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status recompute (`unpaidpay-*`, `paidbal`, and the status leg of others) | `UPDATE "Invoice" SET status='<before.status>'::"InvoiceStatus", "paidAt"=<before paidAt or NULL> WHERE id='<id>';`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `deadpay-cf082424` (payment deleted + wallet restored)                    | Re-insert the InvoicePayment from the log's before-state, then reverse the wallet: CreditNote `amountUsed += amount` (and restore its previous status/appliedAt/expiresAt from the log) or AdvancePayment `balance -= amount`.                                                                                                                                                                                                                                                                                                                       |
| `overpaid` void-duplicate-payment                                         | `UPDATE "InvoicePayment" SET status='PAID' WHERE id='<payment>';` then re-run the status leg's rollback. If the payment was credit/advance money, also re-consume the wallet (reverse of the restore above).                                                                                                                                                                                                                                                                                                                                         |
| `overpaid` convert-excess-to-advance                                      | `DELETE FROM "AdvancePayment" WHERE id='<minted id from log>';` and restore the source payment's amount (or its PAID status if it was fully voided). **Only while the advance is unspent** — if the customer already applied it, unwind the application first (`POST /credit-notes`-style unapply does not exist for advances; void the application payment via the app).                                                                                                                                                                            |
| `overbill` / `retdel` counter resets                                      | `UPDATE "OrderItem" SET "invoicedQty"=<before>` / `SET "deliveredQty"=<before>` for the ids in the log.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Header math / line re-sum                                                 | `UPDATE "Invoice" SET total=<before>, subtotal=<before> WHERE id='<id>';` plus the status leg.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tenant stamp                                                              | `UPDATE "Return" SET "tenantId"=NULL …` / same for the logged ReturnItem ids (before-state in log).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Template deactivation                                                     | `UPDATE "RecurringInvoice" SET "isActive"=true WHERE id='<id>';` — for `61bc82ba…` **only together with** a corrected future `nextRunAt`, otherwise the nightly duplicate-fire risk returns.                                                                                                                                                                                                                                                                                                                                                         |
| F11 release (`repair-f11-stranded-orders.mjs`)                            | `UPDATE "Order" SET "routeRunId"='<before>', "routeRunStopId"='<before>', status='<before>'::"OrderStatus" WHERE id='<id>';` — per order, from that order's `before` object in `local-assets/f11-repair-<ts>.jsonl`.                                                                                                                                                                                                                                                                                                                                 |
| F11 change-request decline (same script, same log)                        | `UPDATE "ChangeRequest" SET status='PENDING', resolution=NULL, "resolutionReason"=NULL, "resolvedAt"=NULL WHERE id IN (<before.pendingChangeRequestIds>);` — the ids are the exact rows that order's decline touched (the write's own `RETURNING`), so an empty list means nothing was declined for it. Run this **with** the release rollback above: a re-pinned order whose CR stayed DECLINED is still un-approvable. `updatedAt` is deliberately NOT restored — a rollback is itself a modification, so a fresh `updatedAt` after it is correct. |

After any rollback, re-run `scripts/data-integrity-report.mjs` — the original finding should
reappear (that's the proof the rollback landed).
