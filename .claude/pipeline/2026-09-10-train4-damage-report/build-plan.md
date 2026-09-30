# Build plan: train 4 read-only damage report (B134 B135 B214 B215 B216 B131 B141)

> **Stage S5, "how".** Written 2026-09-10. Status: `APPROVED` (owner ruling Plane DECIDE-23).
> **Model note:** dev-pipeline puts planning on Fable 5.1. Fable was out of usage credits on 2026-09-10
> (HTTP 429), so **Opus 5 wrote this, as the documented fallback.**
> Mode `feature`, scale `small`. The Preamble below replaces discovery.md and spec.md. The test plan is
> [test-plan.md](./test-plan.md) (T1-T14). Grounded at master `edd379bf`. Every line number was re-read at that sha;
> anchor on the quoted code, not the number (±5).
> This file is the ONLY context the implementation and review agents receive.

---

## Preamble (small scale)

- **Problem:** the train-4 fixes stop NEW damage for seven bugs. Nobody knows how many prod rows the old code already
  damaged, so the owner cannot decide whether any repair is needed.
- **Who hits it:** the owner, who decides repairs. The damage itself sits in live tenants' invoices, credit notes,
  orders and billing ledger.
- **Workaround today:** hand-written ad-hoc SQL against prod. That is error-prone, not reviewed, and risks printing
  client identifiers.
- **Success signal:** one command, `railway run --service postgres node apps/api/scripts/report-train4-damage.mjs`,
  prints a count per damage class and a label saying whether each count is exact or a bound. It writes a
  row-id JSONL to gitignored `local-assets/`. The DB-lane spec proves that every section counts its seeded damage row
  and skips its near-miss.
- **Requirements:**
  - `R1`: seven sections, each counting exactly the damage class defined in "WP1 section table" below. Every seeded
    near-miss is excluded (T6-T12).
  - `R2`: the script is physically read-only. `SET default_transaction_read_only = on` is its first query, its source
    carries no write keyword, and it has no write-mode flag (T1-T3, T14).
  - `R3`: the output (stdout and JSONL) carries only row ids, counts, amounts, statuses, types and dates. Tenants
    appear only as ordinals (`#1..#n`). There are no names, slugs, emails, tenant UUIDs, keys or free text (T13).
  - `R4`: every bucket carries one label from `EXACT | LOWER_BOUND | UPPER_BOUND | ESTIMATE | CONTEXT`, in both human
    and JSON output, and the human output states what the bucket cannot distinguish (T6-T12).
  - `R5`: the CLI accepts `--json`, `--tenant <id,id>`, `--out-dir <dir>` and `--help` only. Any other flag exits 2
    before a connection string is even resolved. No connection string means exit 1 (T4, T5).
- **Non-goals (scope fence):** no repair, no backfill, no `--execute`/`--live`/`--apply`, and no repair SQL printed.
  No change to any `src/` production file, no migration, and no new npm script. No per-bug scripts: the four
  `report-b###-*.mjs` names proposed in the run build plans are superseded by this one file.
- **Deploy-day answer:** nothing deploys. The script sits in `apps/api/scripts/` (inside Railway's `watchPatterns`,
  so a merge triggers an API image rebuild, but `CMD` never runs it). The owner runs it by hand after the train-4
  fixes land, reads it, and decides repairs separately (fresh backup, dry-run-first script, never on a live tenant
  without the client's request).

**Scale check.** One production file. No UI, no schema, no write path. It reads money and tenancy tables, but only
through a session the server forces read-only. See Risks for how Baseline may classify it.

---

## Objective

Ship `apps/api/scripts/report-train4-damage.mjs`: a SELECT-only forensic report in the tone of
`scripts/f07-conservation-report.mjs`. It states plainly what it cannot decide. Seven sections, one per train-4 bug,
each labelled with how far its count can be trusted.

**In scope:** the script plus two specs (structural/CLI unit spec, DB-lane seeded spec).
**Out of scope:** everything in the Preamble's non-goals. No per-row repair verdicts beyond
`owner-decision-required`.

---

## Constraints & conventions

- **Runtime:** Node ESM `.mjs`, `import pg from "pg"`, `pg.Client`. No Prisma client, no TypeScript, no new
  dependency.
- **Copy EXACTLY from `apps/api/scripts/prod-readonly-audit.mjs`:**
  - `resolveUrl()` (lines ~23-40), verbatim: `DATABASE_URL` unless it contains `.railway.internal`, else built from
    `POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB/RAILWAY_TCP_PROXY_DOMAIN/RAILWAY_TCP_PROXY_PORT`.
  - The `No usable connection string — run via ...` message and `process.exit(1)`.
  - The host/db-only print, which never prints credentials (L-078).
  - `await client.query("SET default_transaction_read_only = on")`, then `SET statement_timeout = '45s'`, as the
    FIRST two queries after `connect()`, and `client.end()` in `finally`.
- **Tone to copy:** `scripts/f07-conservation-report.mjs`. The header comment names each class, what it cannot
  decide, and the SAFETY MODEL. Findings go to a JSONL file in `local-assets/`, which is gitignored (`.gitignore:109`).
- **Test runner and layout:** apps/api has no jest.config file. Its Jest config is `package.json#jest` (`rootDir: src`,
  `.spec.ts`, ignores `.db.spec.ts`). The DB lane is `apps/api/jest.db.config.js` (`.db.spec.ts$`, default
  reporter only). Unit spec: `cd apps/api && npx jest <path> --reporters=default`. DB spec:
  `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- <pattern>"`.
- **Existing patterns to copy rather than invent:**
  - `apps/api/src/common/report-addon-gate-blast-radius-script.spec.ts`: `codeLines()` (comments stripped),
    `spawnSync(process.execPath, [SCRIPT])`, scrubbed env.
  - `apps/api/src/common/backfill-legacy-tenant-ids.db.spec.ts`: `describeDb` + `requireLocalDatabaseUrl` from
    `./testing/db-spec`, `assertTestTenant` via `require("../../../../scripts/lib/test-tenants.cjs")`, and `runCli()`,
    which strips every `RAILWAY_*`/`POSTGRES_*` key and sets `DATABASE_URL`. Nothing env-dependent runs at
    collection time.
  - `apps/api/src/common/testing/db-lane.db.spec.ts`: `PrismaClient({ adapter: new PrismaPg(pool) })` for seeding.
- **House rule L-062:** every spec lives inside `apps/api/src`, and the script inside `apps/api/scripts`. Both are
  hashed by apps/api's own `test` task (`$TURBO_DEFAULT$`). Nothing reads outside the workspace except
  `scripts/lib/test-tenants.cjs`, which the backfill spec already requires the same way.
- **Must NOT change:** any file under `apps/api/src/` other than the two new specs, `package.json` scripts,
  `turbo.json`, or the schema.
- **Do-not-introduce:** Vitest, a root test runner, snapshot tests, Prisma in the script, a second HTTP client.
- **Landmines:**
  1. **B134's audit line uses an EM DASH:** `invoices.service.ts:4337` writes
     `[${new Date().toLocaleDateString()} — reverted to Draft: source order edited]`. Match on the dash-free fragment
     `reverted to Draft: source order edited`. The date is server-locale and date-only, so it can never be tied to a
     specific change request.
  2. **T1 is case-insensitive** (`/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i` over non-comment lines). So the
     script must not use the JS `delete` operator, `Map#delete`, a `.update(` call, or the words update or delete in a
     printed string. `deletedAt`/`updatedAt` are safe because no word boundary follows the keyword. Write "removed"
     rather than "deleted" in messages.
  3. **`--json` mode:** stdout is ONE JSON document and nothing else. The host line and all prose go to stderr.
     `--json` writes no JSONL file, so spec runs leave nothing behind.
  4. **Scalar-list columns** (`TenantSubscription.retainedUserIds`, `RouteRunStop.podPhotoUrls`, and any other
     `String[]`): the DB spec seeds them explicitly as `[]`. The backfill spec's raw insert of `'{}'::text[]` shows
     that there is no DB default.
  5. **B141's editor marker (verified, corrects the brief):**
     - `makePseudoUser(ctx)` sets `sub: ctx.userId` (`buyer.controller.ts:77-91`), and the guard sets
       `userId: link.customer.userId` (`apps/api/src/buyer/guards/buyer-seller-context.guard.ts:57`).
     - The buyer WRITE paths call `makePseudoUser(ctx)` with NO role: the merge-into-active call at
       `buyer.controller.ts:617` and the PATCH at `:747`. So the role defaults to `CUSTOMER`.
     - The `UserRole.OPERATOR` pseudo-users at `:186`/`:217` are on the list READS (`getOrders`/`getInvoices`), which
       write no revision.
     - A buyer edit is therefore recorded as `editedById = Customer.userId`, `editedByRole = "CUSTOMER"`.
     - Use `editedById = c."userId"` as the marker, not the role. The same id also covers the customer's own login,
       which is equally customer-side.
     - Buyer order CREATION (`:712`, `ordersService.create`) leaves no creator column on `Order`. Hence the
       UPPER_BOUND bucket.

---

## Test packages

### TP1: structural + CLI-contract unit spec

- **writes:** `apps/api/src/common/train4-damage-report-script.spec.ts` (new)
- **tests:** T1-T5 (exact assertions in test-plan.md §2).
- **must fail with:** `ENOENT` reading `apps/api/scripts/report-train4-damage.mjs` (T1-T3). For T4/T5 it is
  `Expected: 2, Received: 1` or a stderr mismatch (`Cannot find module`).

### TP2: DB-lane seeded-damage spec

- **writes:** `apps/api/src/common/train4-damage-report.db.spec.ts` (new)
- **tests:** T6-T14. The seed table, the expected counts and the ids are in test-plan.md §7. Restate them verbatim;
  never derive an expected value from the script.
- **harness:**
  - `beforeAll(fn, 180_000)` seeds four throwaway tenants through Prisma. Each has slug
    `assertTestTenant("qa-damage-<sfx>-a")` (…`-b`, `-c`, `-d`) and id `qa-damage-<sfx>-tenant-a` etc. Every other
    row id is `randomUUID()`.
  - It then runs the CLI once with `--json --tenant <A,B,C,D>` and stores `{status, stdout, stderr}`. It never throws
    on a failed run.
  - It runs human mode once with `--tenant <A,B,C,D> --out-dir <fs.mkdtempSync(os.tmpdir())>`, for T13.
  - `afterAll` removes the four tenants' rows in FK order and the temp dir.
  - Every test starts with `expect(run.status).toBe(0)`.
- **must fail with:** `Expected: 0, Received: 1` (the script file does not exist).

**Red gate** (`expect: "fail"`): both commands in the Pipeline args. The DB command needs the compose Postgres up
(`npm run db:up` + migrations). A red from `ECONNREFUSED`, or from `DB-backed specs need DATABASE_URL`, is an
environment failure, not the red the gate means.

---

## Work packages

### WP1: `apps/api/scripts/report-train4-damage.mjs` (new file)

- **satisfies:** R1-R5 · **provenBy:** T1-T14 · **effort:** high
- **Order of operations:**
  1. Parse flags. On an unknown flag, exit 2 with `Unknown flag: <f>` on stderr.
  2. `--help`: print usage and exit 0.
  3. `resolveUrl()`. With no URL, exit 1.
  4. Print the host to stderr.
  5. `connect()`, then the two `SET`s.
  6. Run the sections.
  7. Assign ordinals.
  8. Emit the output.
  9. `end()` in `finally`. Any query error prints `err.message` and exits 1.
- **`--tenant a,b`:** adds `AND <alias>."tenantId" = ANY($1::text[])` to every section's primary table. It filters
  only and never looks up a slug.
- **Ordinals:** collect every tenantId that appears in any finding or in the armed-downgrade rows, sort ascending, and
  map to `#1..#n`. A NULL tenantId maps to `unscoped`. The id→ordinal map is never printed and never written.
- **Output file (human mode):** `path.resolve(<scriptDir>, "../../..", "local-assets")` (the repo root's
  local-assets), or `--out-dir`. The name is `train4-damage-report-<ISO ts with [:.] replaced by ->.jsonl`, with one
  line per finding: `{class, bucket, label, tenant, verdict: "owner-decision-required", ...ids/amounts/statuses/dates}`.
  Print `Wrote N findings to <path>`.
- **JSON document (`--json`):**
  `{ reportVersion: 1, tenants: <n>, sections: { B134: {...}, B135, B214, B215, B216, B131, B141 }, labels: { <section>: { <bucket>: <label> } }, byTenant: [{ tenant: "#1", <section>: <sum of that section's non-CONTEXT buckets> }] }`.
  Field names are exactly as in the section table. Money is `Number(x.toFixed(2))`. Id arrays are sorted ascending.
  `B216.armedTenantOrdinals` holds ordinals, never ids.
- **Human output:** a header saying `READ-ONLY session. No repair SQL is emitted.`. The B216 armed tenants are
  printed first, under `ACT BEFORE <earliest downgradeEffectiveAt>`. Then, per section: the title, one line per
  bucket (`<bucket>: <count>  [<LABEL>]`), a `CANNOT DECIDE:` paragraph (the table's last column), per-tenant counts
  by ordinal, and the first 40 ids per bucket followed by `… N more in the JSONL`.

#### WP1 section table (the contract T6-T12 test)

| §                                                                  | Buckets (JSON field → label)                                                                                                                                                                                                     | Exact selection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Cannot decide / cannot see                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B134** invoices un-sent by a failed at-door approval             | `candidates` (+`candidateInvoiceIds`, `candidateTotal`) → UPPER_BOUND · `mergedAtStopContext` → CONTEXT · `noChangeRequestContext` → CONTEXT                                                                                     | `"Invoice" i` with `i.status='DRAFT' AND i."orderId" IS NOT NULL AND i."internalNotes" LIKE '%reverted to Draft: source order edited%'`. Bucket by EXISTS on `"ChangeRequest" cr WHERE cr."orderId"=i."orderId"`: some CR and none with `status='APPROVED' AND resolution='MERGED_AT_STOP'` → candidates. Any such APPROVED merge → mergedAtStopContext. No CR at all → noChangeRequestContext. Select id, tenantId, status, total, createdAt, orderId only; `internalNotes` is used in WHERE, never selected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | A staff order edit also writes this audit line (by design), so a CR-bearing order may have been reverted by an edit rather than a failed door approval. The stamp is a locale date without time, so it cannot be matched to a CR. An invoice re-sent since is not DRAFT and is invisible (correct: no longer damaged)                                                         |
| **B135** at-door merges committed after the stop completed         | `lateMerges` (+`changeRequestIds`, `mutationIds`) → LOWER_BOUND · `lateNoteContext` → CONTEXT                                                                                                                                    | `"ChangeRequest" cr JOIN "Order" o ON o.id=cr."orderId" JOIN "RouteRunStop" rs ON rs.id=COALESCE(cr."routeRunStopId", o."routeRunStopId")` where `cr.status='APPROVED' AND cr.resolution='MERGED_AT_STOP' AND rs."completedAt" IS NOT NULL AND cr."resolvedAt" > rs."completedAt"`. `type='NOTE'` → lateNoteContext (no money), else lateMerges. `mutationIds`: `"DeliveryMutation" dm` with `dm.type IN ('ADD_ON','REFUSED')`, same `orderId` and `routeRunStopId` as a lateMerges CR, and `dm."createdAt"` in `[cr."resolvedAt", cr."resolvedAt" + interval '20 seconds']` (the merge tx claims first, writes the mutation after, under a 15 s timeout, `orders.service.ts:4951-5290`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A claim stamped just before the stop's completion but committed after is missed. The stale delivered-line variant (edit merged onto a line already delivered) leaves no persisted marker. `completedAt` is overwritten if a stop is re-completed                                                                                                                              |
| **B214** credit notes orphaned by invoice/order removal            | `orphaned` (+`creditNoteIds`) → UPPER_BOUND · `spendable`, `spendableRemaining` → UPPER_BOUND · `expired`, `expiredRemaining` → CONTEXT                                                                                          | `"CreditNote" cn` with `cn."invoiceId" IS NULL AND cn.status <> 'VOID' AND cn.amount - cn."amountUsed" > 0.001`. expired = `cn."expiresAt" IS NOT NULL AND cn."expiresAt" < now()`, else spendable. Remaining = `amount - amountUsed`, rounded to cents. Never select `reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A note issued standalone, never tied to an invoice, looks identical. The schema keeps no record of a former `invoiceId`. `reason` is free text and must not be printed, so the owner reads the ids in-app                                                                                                                                                                     |
| **B215** staff merge folded twice under a replayed Idempotency-Key | `confirmedPairs` (+`confirmedOrderIds`) → ESTIMATE · `unconfirmablePairs` (+`unconfirmableOrderIds`) → UPPER_BOUND · `keyedOrders`, `earliestKeyedOrderAt` → CONTEXT                                                             | `"OrderRevision"` with `LAG(...) OVER (PARTITION BY "orderId" ORDER BY "revisionNumber")`. Candidate pair (prev, cur): both `source='EDIT'`, the same non-null `editedById`, and `cur."createdAt" - prev."createdAt" <= interval '120 seconds'`. Snapshots for the pair and for prev's predecessor are loaded in JS. **delta(k)** = per-key sum of `snapshot.lineItems[].qty` in k minus in k-1. The key is `productId`; a null productId keys `"custom:"+name`, used only in memory and never output. Only non-zero entries count. **confirmed:** prev has a predecessor, delta(prev) and delta(cur) are both non-empty, all entries are > 0, and they are equal as maps. **unconfirmable:** prev is the order's first revision (no baseline), delta(cur) is non-empty, all entries are > 0, and for every key prev's qty ≥ delta(cur)[key]. keyedOrders = `count(*)` and `min("createdAt")` of `"Order"` with `"idempotencyKey" IS NOT NULL` (the earliest key approximates the F30/R8 ship date, so no date is hard-coded)                                                                                                                                                     | Two identical manual edits by one person within 2 min look like a double fold (over). A double fold more than 120 s apart, or split across editors, is missed (under). Order creation writes no revision (only `updateOrderItems` "EDIT" `:4361` and at-door "CHANGE_REQUEST" `:5297` do), so a first-edit double fold has no baseline. Hence the separate UPPER_BOUND bucket |
| **B216** pre-lapse downgrade applied after a Stripe reinstatement  | `appliedAfterReinstatement` (+`planChangedEventIds`, `mrrDeltaSum`, `seatsFreedNear`) → ESTIMATE · `armedAfterReinstatement` (+`armedTenantOrdinals`, `armedEffectiveDates`) → UPPER_BOUND · `armedOrderUnknown` → UPPER_BOUND   | `"BillingEvent"` rows of type `plan.downgrade_scheduled`, `subscription.resumed`, `plan.changed`, `seat.freed`, ordered by tenantId and createdAt, then evaluated in JS per tenant. **Applied:** a `plan.changed` with `payload.scheduled === true && payload.applied === true` (emitted ONLY by the 02:00 sweep, `billing-cron.service.ts:208-212`). Let S be the latest `plan.downgrade_scheduled` strictly before it. Count it iff S exists and some `subscription.resumed` with `payload.source === "stripe"` falls strictly between S and it (`billing.service.ts:547/597` write `{source:"stripe", reason}`). `mrrDeltaSum` = sum of those events' `amountDelta`. `seatsFreedNear` = sum of `payload.quantity` over `seat.freed` events of that tenant in `[applied - 60 s, applied]`. **Armed now:** `"TenantSubscription" s JOIN "Tenant" t` with `s."downgradeToPlanKey" IS NOT NULL AND t.status='ACTIVE' AND t."deletedAt" IS NULL`. If the latest stripe resumed is after the latest downgrade_scheduled → armedAfterReinstatement. If there is a stripe resumed but no downgrade_scheduled event at all → armedOrderUnknown. Never print `downgradeToPlanKey` values | Whether the tenant still wanted the downgrade after reinstating. A schedule written without a `plan.downgrade_scheduled` event is invisible to the applied bucket. `seatsFreedNear` is a time-window association, not a proof                                                                                                                                                 |
| **B131** removed customer's crons kept generating                  | `templateOrders` (+`templateOrderIds`) → LOWER_BOUND · `recurringInvoices` (+`recurringInvoiceIds`), `recurringInvoicesEmailed` → LOWER_BOUND · `manualInvoices` (+`manualInvoiceIds`) → UPPER_BOUND                             | `JOIN "Customer" c ON c.id=<x>."customerId" WHERE c."deletedAt" IS NOT NULL AND <x>."createdAt" > c."deletedAt"`, plus: (a) `"Order" o` with `o."templateId" IS NOT NULL`; (b) `"Invoice" i` with `i."recurringInvoiceId" IS NOT NULL`, emailed = `i."sentAt" IS NOT NULL`; (c) `"Invoice" i` with `i."recurringInvoiceId" IS NULL AND i."orderId" IS NULL`. Select id, tenantId, status, total, createdAt (+ sentAt IS NOT NULL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A customer removed and later restored has `deletedAt = NULL` now, so its window is invisible (undercount). A manual invoice may be a deliberate final bill to a removed customer                                                                                                                                                                                              |
| **B141** removed customer's buyer kept access                      | `customerSideEdits` (+`customerSideEditOrderIds`) → LOWER_BOUND · `unmarkedOrdersUpperBound` (+`unmarkedOrderIds`) → UPPER_BOUND · `buyerPaymentRequests` (+`buyerPaymentRequestIds`, `buyerPaymentRequestAmount`) → LOWER_BOUND | Scope: `c."deletedAt" IS NOT NULL AND EXISTS (SELECT 1 FROM "CustomerLink" l WHERE l."customerId"=c.id AND l.status='ACTIVE')`. (a) DISTINCT `"Order" o` joined to `"OrderRevision" r ON r."orderId"=o.id` with `r."editedById" = c."userId" AND r."createdAt" > c."deletedAt"`, whatever the order's createdAt. (b) `"Order" o` with `o."templateId" IS NULL AND o."createdAt" > c."deletedAt"` and `o.id` not in (a). (c) `"BuyerPaymentRequest" p` (`finance.prisma:1040`; confirm its timestamp column name there) created after `c."deletedAt"`: id, status, kind, amount, created date                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | (a) cannot tell the buyer portal from the customer's own login: both are customer-side. (b) cannot tell a buyer-created order from a staff-created one (`Order` has no creator column, `source` is APP/PHONE/ROUTE only). Links disconnected later, and restored customers, are excluded (undercount)                                                                         |

---

## Package map

| Package | Files                                                           | satisfies  | provenBy |
| ------- | --------------------------------------------------------------- | ---------- | -------- |
| TP1     | `apps/api/src/common/train4-damage-report-script.spec.ts` (new) | R2, R5     | n/a      |
| TP2     | `apps/api/src/common/train4-damage-report.db.spec.ts` (new)     | R1, R3, R4 | n/a      |
| WP1     | `apps/api/scripts/report-train4-damage.mjs` (new)               | R1-R5      | T1-T14   |

---

## Acceptance criteria

1. T1-T14 are green. The red gate was red for the reason stated above, not an environment error.
2. `node --check apps/api/scripts/report-train4-damage.mjs` exits 0.
3. The human run against the compose DB prints all seven section titles and every bucket label, and writes a JSONL
   file that contains no tenant UUID or name.
4. The diff touches exactly the three new files.

## Verification commands

- Per round: `node --check apps/api/scripts/report-train4-damage.mjs`, `npm run check-types -w apps/api`,
  `npm run lint -w apps/api`.
- Final: the TP1 unit command and the TP2 DB-lane command (see Pipeline args). Never run a repo-wide suite.

---

## Risks & rollback

| Risk                                                                                                           | Likelihood        | Blast radius                                              | Mitigation / watch                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Baseline classes the script HIGH (it reads money/tenancy tables; "prod-capable script") though it cannot write | med               | review depth only                                         | Accept the deeper review, or note the forced read-only session. Do not split the file to dodge the classifier    |
| The builder "improves" scope with a `--fix`/repair mode or repair SQL                                          | low               | owner ruling breach (DECIDE-23)                           | T3 + T4 fail on any such flag. The reviewer treats any write-shaped code as a blocker                            |
| Red gate goes red from the environment (compose DB down) rather than the missing script                        | med               | a false-meaning red                                       | The launcher checks the failure text: `Expected: 0, Received: 1` / `ENOENT`, never `ECONNREFUSED`                |
| B215 LAG + JSON snapshot load is slow on prod                                                                  | low               | the report times out (`statement_timeout` 45 s) → exit 1  | The window query returns candidate pairs only. Snapshots load per candidate. The owner can scope with `--tenant` |
| B216 armed-now rows keep firing after Run C deploys (the fix disarms only NEW reinstatements)                  | high if any exist | money: one more plan flip + MRR delta per tenant at 02:00 | Human output prints armed tenants FIRST, with effective dates, under `ACT BEFORE <date>`. The owner decides      |
| A section leaks free text through `SELECT *`                                                                   | low               | privacy (repo goes public for CI; output is local)        | T13 seeds secret markers in every free-text column and asserts none appears                                      |
| Compose DB shared with Runs A-D                                                                                | low               | T6-T14 exact counts                                       | `--tenant` scoping on four throwaway tenants; ids are UUIDs; teardown by tenant                                  |

- **Rollback:** revert the squash commit. The change is three new files and writes no data.
- **Feature flag / entitlement / migration:** none.
- **Close-out:** use a `feat/` or `chore/` branch (not `fix/`, so Gate 3 does not demand a lesson). The code PR's HEAD
  commit carries `Bookkeeping-Follow-Up: pending`. The follow-up adds the `api.md` code-map entry for the script. No
  lesson is required unless the run hits a surprising failure.

---

## Pipeline args

Launcher: copy this file, `test-plan.md` and `pipeline-args.json` into
`.claude/pipeline/2026-09-1X-train4-damage-report/` on the run branch, fix the date in both paths, and add `startedAt`

- `workdir`. Pass the args as a real OBJECT, never a JSON string. The object below is identical to
  `pipeline-args.json` (under 4 KB minified).

```json
{
  "mode": "feature",
  "scale": "small",
  "planPath": ".claude/pipeline/2026-09-1X-train4-damage-report/build-plan.md",
  "testPlanPath": ".claude/pipeline/2026-09-1X-train4-damage-report/test-plan.md",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "context": "Train 4 read-only damage report (Plane DECIDE-23): ONE SELECT-only script apps/api/scripts/report-train4-damage.mjs counting B134 B135 B214 B215 B216 B131 B141 damage with labelled bounds; forced read-only session, no write flag, tenants as ordinals, JSONL to gitignored local-assets. No repair. Plan by Opus 5 (Fable 5.1 429).",
  "testPackages": [
    {
      "id": "TP1",
      "title": "Structural + CLI-contract unit spec",
      "files": ["apps/api/src/common/train4-damage-report-script.spec.ts"],
      "brief": "build-plan.md TP1; test-plan.md T1-T5 exact assertions",
      "satisfies": ["R2", "R5"]
    },
    {
      "id": "TP2",
      "title": "DB-lane seeded-damage spec",
      "files": ["apps/api/src/common/train4-damage-report.db.spec.ts"],
      "brief": "build-plan.md TP2 harness; test-plan.md T6-T14 + section 7 seed table (copy expected values verbatim)",
      "satisfies": ["R1", "R3", "R4"],
      "effort": "high"
    }
  ],
  "redGate": {
    "commands": [
      "cd apps/api && npx jest src/common/train4-damage-report-script --reporters=default",
      "node scripts/local-env.mjs --db --db-specs -- \"npm run test:db -w apps/api -- train4-damage-report\""
    ],
    "expect": "fail"
  },
  "packages": [
    {
      "id": "WP1",
      "title": "Read-only damage report script",
      "files": ["apps/api/scripts/report-train4-damage.mjs"],
      "brief": "build-plan.md WP1: copy prod-readonly-audit.mjs connection+SET pattern exactly; implement the section table verbatim; JSON contract and labels as specified; landmines 1-5",
      "satisfies": ["R1", "R2", "R3", "R4", "R5"],
      "provenBy": [
        "T1",
        "T2",
        "T3",
        "T4",
        "T5",
        "T6",
        "T7",
        "T8",
        "T9",
        "T10",
        "T11",
        "T12",
        "T13",
        "T14"
      ],
      "effort": "high"
    }
  ],
  "verifyCommands": {
    "perRound": [
      "node --check apps/api/scripts/report-train4-damage.mjs",
      "npm run check-types -w apps/api",
      "npm run lint -w apps/api"
    ],
    "final": [
      "cd apps/api && npx jest src/common/train4-damage-report-script --reporters=default",
      "node scripts/local-env.mjs --db --db-specs -- \"npm run test:db -w apps/api -- train4-damage-report\""
    ]
  }
}
```

> Amended 2026-09-10 (lead): --reporters=default moved LAST — Jest reads positionals after it as reporter modules (proven in wf_363f0377-624 Baseline).
