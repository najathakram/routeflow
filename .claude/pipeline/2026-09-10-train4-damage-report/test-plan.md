# Test plan: train 4 read-only damage report

> **Stage S4.** Written 2026-09-10. **Model note:** dev-pipeline puts this on Fable 5.1, which was out of usage
> credits on 2026-09-10 (HTTP 429). **Opus 5 wrote it, as the documented fallback.**
> Companion of [build-plan.md](./build-plan.md), which defines R1-R5, the section table and the JSON contract. The
> expected values below are the oracle. Test agents copy them and never compute them from the script.

## 1. Strategy for this change

- The script is new, so every test is red today by absence. Absence alone proves nothing about bite, so each DB test
  seeds **one damage row plus at least one near-miss** and asserts an EXACT count and an exact id list. A section that
  counts too broadly fails on the near-miss. A section that counts too narrowly fails on the damage row.
- Two layers:
  - **Unit (TP1).** A source-structure and CLI contract with no database: read-only guarantees and flag refusal.
  - **DB lane (TP2).** The real script against the compose Postgres, through `spawnSync`, scoped with `--tenant` to
    four throwaway `qa-damage-*` tenants.
- Titles are prefixed `TDR-T<n>`. There are no `REG-` tokens: this is a feature run, not a bug proof.

## 2. Test table

| #   | File | Title (prefix)                                  | Asserts                                                                                                                                                                                                                                                                                                                                                                                               | Red today                      |
| --- | ---- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| T1  | unit | `TDR-T1 no write-capable SQL keyword`           | no non-comment line (`codeLines()` as in report-addon-gate-blast-radius-script.spec.ts) matches `/\b(INSERT\|UPDATE\|DELETE\|TRUNCATE\|ALTER\|DROP)\b/i`                                                                                                                                                                                                                                              | `ENOENT`                       |
| T2  | unit | `TDR-T2 read-only session is the first query`   | the code contains `SET default_transaction_read_only = on`, and the index of that `.query(` call is lower than every other `.query(` occurrence                                                                                                                                                                                                                                                       | `ENOENT`                       |
| T3  | unit | `TDR-T3 no write-mode flag`                     | the source contains none of `--execute`, `--live`, `--apply`, `--fix`, `--repair`                                                                                                                                                                                                                                                                                                                     | `ENOENT`                       |
| T4  | unit | `TDR-T4 unknown flag exits 2 before connecting` | spawn `--execute` with `DATABASE_URL=postgresql://x:y@127.0.0.1:1/none`, `RAILWAY_*`/`POSTGRES_*` stripped: status 2, stderr `/Unknown flag/`. If the script connected first it would exit 1 (ECONNREFUSED)                                                                                                                                                                                           | `Expected: 2, Received: 1`     |
| T5  | unit | `TDR-T5 no connection string exits 1`           | env with `DATABASE_URL`, `RAILWAY_*` and `POSTGRES_*` removed: status 1, stderr `/No usable connection string/`                                                                                                                                                                                                                                                                                       | stderr is `Cannot find module` |
| T6  | db   | `TDR-T6 B134 buckets`                           | `candidates=1`, `candidateInvoiceIds=[I134a]`, `candidateTotal=100`, `mergedAtStopContext=1`, `noChangeRequestContext=1`. Labels `candidates:UPPER_BOUND`, the two context buckets `CONTEXT`                                                                                                                                                                                                          | `Expected: 0, Received: 1`     |
| T7  | db   | `TDR-T7 B135 late merges`                       | `lateMerges=1`, `changeRequestIds=[CR135a]`, `mutationIds=[DM135a]`, `lateNoteContext=1`. Labels `LOWER_BOUND`/`CONTEXT`                                                                                                                                                                                                                                                                              | same                           |
| T8  | db   | `TDR-T8 B214 orphaned notes`                    | `orphaned=2`, `creditNoteIds=sorted([CN_a,CN_b])`, `spendable=1`, `spendableRemaining=40`, `expired=1`, `expiredRemaining=5`. Label `orphaned:UPPER_BOUND`                                                                                                                                                                                                                                            | same                           |
| T9  | db   | `TDR-T9 B215 double folds`                      | `confirmedPairs=1`, `confirmedOrderIds=[O215a]`, `unconfirmablePairs=1`, `unconfirmableOrderIds=[O215d]`, `keyedOrders=1`. Labels `ESTIMATE`/`UPPER_BOUND`/`CONTEXT`                                                                                                                                                                                                                                  | same                           |
| T10 | db   | `TDR-T10 B216 reinstated downgrades`            | `appliedAfterReinstatement=1`, `planChangedEventIds=[E4]`, `mrrDeltaSum=-50`, `seatsFreedNear=2`, `armedAfterReinstatement=1`, `armedOrderUnknown=1`. `armedTenantOrdinals` has length 1 and matches `/^#\d+$/`. Labels `ESTIMATE`/`UPPER_BOUND`/`UPPER_BOUND`                                                                                                                                        | same                           |
| T11 | db   | `TDR-T11 B131 removed-customer generation`      | `templateOrders=1` (`templateOrderIds=[O131a]`), `recurringInvoices=1` (`[I131a]`), `recurringInvoicesEmailed=1`, `manualInvoices=1` (`[I131c]`). Labels `LOWER_BOUND`/`LOWER_BOUND`/`UPPER_BOUND`                                                                                                                                                                                                    | same                           |
| T12 | db   | `TDR-T12 B141 post-removal buyer activity`      | `customerSideEdits=1` (`[O141a]`), `unmarkedOrdersUpperBound=1` (`[O141b]`), `buyerPaymentRequests=1` (`[BPR141a]`), `buyerPaymentRequestAmount=12.5`. Labels `LOWER_BOUND`/`UPPER_BOUND`/`LOWER_BOUND`                                                                                                                                                                                               | same                           |
| T13 | db   | `TDR-T13 output carries no identifiers`         | the `--json` stdout, the human stdout+stderr and the JSONL file under `--out-dir` contain none of: `SECRET-<sfx>`, `qa-damage-<sfx>` (every tenant id and slug), any seeded email. `tenants=4`, every `byTenant[].tenant` matches `/^#\d+$/`, the JSONL has ≥ 1 line, every line parses with `class`, `bucket`, `label` and `tenant`. The human stdout contains all seven section ids and `READ-ONLY` | same                           |
| T14 | db   | `TDR-T14 run leaves the database unchanged`     | for the four tenants, per seeded table, `count(*)` and `max("updatedAt")` (`max("createdAt")` for `OrderRevision`/`BillingEvent`) are identical before `beforeAll`'s CLI runs and after them. The snapshot is taken right after seeding                                                                                                                                                               | same (status check first)      |

## 3. Coverage matrix

| Requirement             | Tests                          |
| ----------------------- | ------------------------------ |
| R1 seven exact sections | T6-T12                         |
| R2 physically read-only | T1, T2, T3, T14                |
| R3 no identifiers       | T13                            |
| R4 labelled bounds      | label assertions inside T6-T12 |
| R5 CLI contract         | T4, T5                         |

## 4. Negative tests: what must NOT happen

These are the near-misses in §7, one or more per section: a re-sent invoice, a merge before completion, a
completeStop `DELIVERED` mutation, a VOID/linked/fully-used note, a >120 s gap, a different editor, an
inconsistent first pair, a re-scheduled downgrade, a non-sweep `plan.changed`, pre-removal rows, a DISCONNECTED
link. On top of those: T4 (no write flag is accepted), T13 (no identifier printed), T14 (no row changes).

## 5. Property-based invariants

None beyond the exact seeds. T9's five orders pin the delta arithmetic.

## 6. Red gate

```
cd apps/api && npx jest src/common/train4-damage-report-script --reporters=default
node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- train4-damage-report"
```

Expected: both fail. The first fails with `ENOENT` and exit-code/stderr mismatches, the second with
`Expected: 0, Received: 1` on T6-T14. Treat `ECONNREFUSED` or `DB-backed specs need DATABASE_URL` as an environment
failure: start the compose Postgres (`npm run db:up`, migrations applied) and re-run.

## 7. Test data and fixtures

The fixture is built through Prisma (`PrismaClient` + `PrismaPg`, the `db-lane.db.spec.ts` pattern), from one
`NOW = new Date()` taken at spec start. The spec never forges a time close to `NOW` (L-090). Other constants:

- `sfx = randomUUID().slice(0,8)`
- `DEL = NOW − 20 d` (the removal stamp)
- `DONE = NOW − 15 d` (stop completion)
- `B0 = NOW − 50 d` (billing chain)
- `R0 = NOW − 12 d` (revisions)

Every `String[]` column is seeded as `[]`. Every free-text column carries a `SECRET-<sfx>` marker, for T13.

**Tenants.** All four are `status: ACTIVE`, with `name: "ACME SECRET-<sfx>"`, slug from
`assertTestTenant("qa-damage-<sfx>-<x>")`, and id `qa-damage-<sfx>-tenant-<x>`.

- **A** hosts B134, B135, B214, B215, B131, B141 and B216's applied chain.
- **B** is armed-after-reinstatement.
- **C** is a near-miss (re-scheduled after the resume).
- **D** is armed with an unknown order.

**Users and customers (tenant A).** Each customer has its own `User` (role CUSTOMER, email
`<uuid>@example.invalid`), and `businessName`/`contactName` carry `SECRET-<sfx>`:

- `C_live` is live.
- `C131` has `deletedAt=DEL` and no link.
- `C141` has `deletedAt=DEL` and a `CustomerLink` with status ACTIVE and `buyerAccountId: null`. Its user is `U141`.
- `C141x` has `deletedAt=DEL` and a DISCONNECTED link. Its user is `U141x`.

There are also staff users `U_staff` and `U_staff2` (OPERATOR).

| Section | Damage row(s) → counted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Near-miss(es) → NOT counted                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B134    | `O134a` + `I134a` (C_live, DRAFT, total 100, `internalNotes = "NOTE SECRET-<sfx>\n[9/1/2026 — reverted to Draft: source order edited]"`, with the em dash as the code writes it). CR on O134a: `ADD_ITEM`, PENDING → **candidate**                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `I134b` DRAFT + audit line, its order has a CR APPROVED `MERGED_AT_STOP` → mergedAtStopContext. `I134c` DRAFT + audit line, order has no CR → noChangeRequestContext. `I134d` **SENT** + audit line, its order has a PENDING CR → nowhere. `I134e` DRAFT, no audit line, its order has a PENDING CR → nowhere                                                                                            |
| B135    | Route / RouteStop / RouteRun / `RS1` (`status COMPLETED`, `completedAt=DONE`). `O135` (C_live, `routeRunStopId=RS1`). `CR135a` APPROVED `MERGED_AT_STOP` `ADD_ITEM`, `routeRunStopId=RS1`, `resolvedAt=DONE+10 min`. `DM135a` `ADD_ON` on O135/RS1 at `DONE+10 min+2 s`                                                                                                                                                                                                                                                                                                                                                                                                                                         | `CR135b` same but `CHANGE_QTY`, `resolvedAt=DONE−10 min`. `CR135c` `NOTE` at `DONE+5 min` → lateNoteContext only. `DM135b` `DELIVERED` on O135/RS1 at `DONE+1 s`                                                                                                                                                                                                                                         |
| B214    | `CN_a` invoiceId null, ISSUED, amount 50, used 10, no expiry → spendable 40. `CN_b` invoiceId null, ISSUED, 5/0, `expiresAt=NOW−1 d` → expired 5. Every note has `reason: "REASON SECRET-<sfx>"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `CN_c` invoiceId null, VOID, 30/0. `CN_d` `invoiceId=I134c`, ISSUED, 25/0. `CN_e` invoiceId null, APPLIED, 20/20                                                                                                                                                                                                                                                                                         |
| B215    | `O215a` (`idempotencyKey: "KEY-SECRET-<sfx>"`). Revisions, all `EDIT` by U_staff: r1 at `R0` `{P1:2}` · r2 at `R0+10 min` `{P1:4,P2:3}` · r3 at `R0+10 min+60 s` `{P1:6,P2:6}` → confirmed. `O215d`: r1 at `R0` `{P1:3}` · r2 at `R0+20 s` `{P1:6}`, both by U_staff → unconfirmable                                                                                                                                                                                                                                                                                                                                                                                                                            | `O215b`: `{P1:2}` → `+10 min` `{P1:4}` → `+300 s` `{P1:6}` (gap too long). `O215c`: same quantities as O215a with r3 at a 30 s gap, but r3 by U_staff2 (editor differs). `O215e`: r1 `{P1:3}` → `+20 s` `{P1:3,P2:1}` (P2 absent in r1, so not consistent). Snapshot lines are `{productId:"P1", name:"PRODUCT SECRET-<sfx>", qty, unitPrice:1, subtotal:qty, status:"PENDING"}` in `snapshot.lineItems` |
| B216    | **Tenant A events:** E1 `plan.downgrade_scheduled` at `B0` · E2 `subscription.suspended` at `B0+1 d` · E3 `subscription.resumed` `{source:"stripe",reason:"payment_succeeded"}` at `B0+2 d` · E5 `seat.freed` `{quantity:2}` at `B0+3 d−1 s` · E4 `plan.changed` `{fromPlan:"GROWTH",toPlan:"STARTER",scheduled:true,applied:true}` amountDelta −50 at `B0+3 d` → applied. Tenant A subscription: `downgradeToPlanKey: null`. **Tenant B:** subscription `downgradeToPlanKey:"STARTER"`, `downgradeEffectiveAt: NOW+5 d`. Events: scheduled at `B0`, stripe resumed at `B0+1 d` → armedAfterReinstatement. **Tenant D:** armed subscription, one stripe resumed at `B0`, no scheduled event → armedOrderUnknown | **Tenant A:** E6 scheduled at `B0+4 d` · E7 stripe resumed at `B0+5 d` · E8 scheduled at `B0+6 d` · E9 `plan.changed` `{scheduled:true,applied:true}` −20 at `B0+7 d` (latest schedule falls after the resume) · E10 `plan.changed` `{fromPlan,toPlan}` without flags at `B0+8 d`. **Tenant C:** armed subscription, stripe resumed at `B0`, then scheduled at `B0+1 d`                                  |
| B131    | `TPL131` (C131). `O131a` `templateId=TPL131`, `createdAt=DEL+1 d`. `RI131` (C131, MONTHLY, `nextRunAt=NOW+10 d`). `I131a` `recurringInvoiceId=RI131`, SENT, `sentAt` and `createdAt` at `DEL+1 d`. `I131c` C131, no order, no recurring, DRAFT, `createdAt=DEL+2 d`                                                                                                                                                                                                                                                                                                                                                                                                                                             | `O131b` template order at `createdAt=DEL−1 d`. `I131b` recurring at `createdAt=DEL−1 d`. `I131d` manual invoice on C_live at `DEL+2 d`                                                                                                                                                                                                                                                                   |
| B141    | `O141a` (C141, `createdAt=DEL−5 d`) with a revision `EDIT`, `editedById=U141`, `editedByRole:"CUSTOMER"`, `createdAt=DEL+1 h` → customerSideEdit. `O141b` (C141, `templateId` null, `createdAt=DEL+2 h`, no revision) → unmarked. `BPR141a` (C141, CASH, 12.50, created at `DEL+3 h`)                                                                                                                                                                                                                                                                                                                                                                                                                           | `O141c` (C141, created at `DEL−3 d`, revision by U141 at `DEL−2 d`). `O141d` (C141x, created at `DEL+2 h`, revision by U141x at `DEL+3 h`; link DISCONNECTED). `BPR141b` (C141, created at `DEL−1 d`)                                                                                                                                                                                                    |

**Cross-section isolation, by construction:**

- B134, B214 and B215 rows sit on C_live, which is not removed, so B131 and B141 never see them.
- B131 rows sit on a customer with no link, so B141 ignores them.
- Every B141 order has at most one revision, so none can form a B215 pair.
- B135's orders carry no audit-lined invoice, so B134 ignores them.

**Required columns.** The builder takes them from the model blocks in `apps/api/prisma/schema/*.prisma`; TypeScript
flags any omission. Among them: `Invoice.invoiceNumber/subtotal/total`, `CreditNote.creditNoteNumber`,
`ChangeRequest.payload`, `Route.name`, `RouteRun.scheduledDate`, `RouteRunStop.stopNumber`, `BillingEvent.payload`,
`RecurringInvoice.frequency/nextRunAt`, `BuyerPaymentRequest.kind/amount`. Invoice and credit-note numbers carry
`sfx` so they stay unique per tenant.

**Cleanup.** In `afterAll`, delete in FK order, filtered by `tenantId IN [A,B,C,D]` (or through the tenant's customers
for any row type with a nullable tenantId). Then delete the users and the tenants (the cascades take `BillingEvent` and
`TenantSubscription`), and remove the temp out-dir. Cleanup tolerates missing rows, so a half-seeded run still
cleans up.

## 8. UI flows to drive

None: there is no UI surface.

## 9. Mutation probe targets

Small scale runs no probe; the near-miss design substitutes for it. If the launcher runs at `major`, each target is
in `apps/api/scripts/report-train4-damage.mjs`:

| #   | Behavior to protect                                                        | Test that MUST go red |
| --- | -------------------------------------------------------------------------- | --------------------- |
| 1   | only merges resolved AFTER the stop's completion count (B135)              | T7                    |
| 2   | a Stripe resume counts only when it falls after the latest schedule (B216) | T10                   |
| 3   | VOID and fully-used notes are excluded (B214)                              | T8                    |
| 4   | the read-only SET precedes every query                                     | T2                    |

## 10. Flake risks

| Risk                                | Where                   | How it is removed                                                                               |
| ----------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| Other rows in the shared compose DB | T6-T13                  | `--tenant` scoping plus UUID row ids; the exact counts cover the four tenants only              |
| Clock boundaries                    | B214 expiry, B216 armed | Every stamp sits days away from `NOW`. SQL `now()` and JS `NOW` differ by seconds at most       |
| Slow CLI runs                       | T6-T14                  | Both CLI runs live in `beforeAll(fn, 180_000)` and are cached. The `spawnSync` timeout is 120 s |
| Teardown after a failed seed        | afterAll                | Delete by tenant filter, tolerant of missing rows                                               |

## 11. Regression watch

- **On every push:** T1-T5, in the apps/api unit suite (no DB, under 5 s).
- **In the DB lane** (CI `db-migrations` job / `npm run local:test:db`): T6-T14.
- **How this regresses unnoticed:** someone adds a repair mode "for convenience". T1, T3 and T4 catch it by name. A
  schema rename (for example `resolution` or `internalNotes`) turns T6/T7 red instead of letting the script silently
  report zero.
