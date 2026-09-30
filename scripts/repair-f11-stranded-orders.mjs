/**
 * repair-f11-stranded-orders.mjs — D4 repair flight for campaign batch F11
 * (bugs B129 and B211, shipped in the F11 PR).
 *
 * ⚠️ SCOPE IS DERIVED, NOT HARDCODED. Before the F11 fix, cancelling a run (or
 * completing one with a SKIPPED stop) never released the stop's undelivered
 * orders: `Order.routeRunId`/`routeRunStopId` stayed pinned to the now-dead
 * run, invisible to the dispatch sweep and the trip builder (both require the
 * pointer null) — the order was stranded with no path back to a route. F11's
 * fix runs the release inline, in the same transaction as the status write,
 * for every run going terminal from then on. This script finds every row that
 * predates the deploy and applies exactly that same release retroactively:
 *
 *     Order.routeRunStopId IS NOT NULL
 *     AND Order.status NOT IN ('DELIVERED', 'CANCELLED')
 *     AND RouteRunStop.status <> 'COMPLETED'
 *     AND ( RouteRun.status = 'CANCELLED'
 *           OR (RouteRun.status = 'COMPLETED' AND RouteRunStop.status = 'SKIPPED') )
 *
 * The `RouteRunStop.status <> 'COMPLETED'` line is what keeps this equal to the
 * forward fix: the helper is only ever handed the ids of stops read with
 * `status: { not: "COMPLETED" }` (routes.service.ts), so an order still pinned
 * to a COMPLETED stop of a cancelled run is NOT the damage this bug wrote —
 * work was recorded at that door, and releasing it would move a settlement
 * attribution the forward fix never moves. Those rows are LISTED (see
 * "pinned to a COMPLETED stop" below) and never written. The completed-run arm
 * stays SKIPPED-only per spec R13 — narrower than the helper, which is the safe
 * direction for a retroactive write.
 *
 * WHAT IS REPAIRED (B129 / B211 — stranded orders)
 *   Per affected run, in ONE transaction, the same three writes the fixed
 *   `releaseUndeliveredOrders` helper runs inline:
 *     1. OUT_FOR_DELIVERY → CONFIRMED for the run's affected orders (their
 *        stop filter is lost the moment the pointer is nulled, so this must
 *        run first);
 *     2. `routeRunId`/`routeRunStopId` → NULL for those orders (status still
 *        NOT IN (DELIVERED, CANCELLED) at write time);
 *     3. every PENDING `ChangeRequest` on the orders write 2 actually released
 *        → DECLINED, `resolution='DECLINED'`, `resolutionReason` = the helper's
 *        own RELEASED_CHANGE_REQUEST_REASON, `resolvedAt`/`updatedAt` = NOW()
 *        (the forward fix bumps `updatedAt` through Prisma's `@updatedAt`,
 *        so the raw SQL sets it explicitly). Resolver identity fields stay
 *        NULL (a system decline, exactly as the helper does it) and no
 *        notification is sent — this script has no app context.
 *        Without it a released order carries a PENDING CR that a re-dispatched
 *        driver could approve, applying the same items a SECOND time: CRs are
 *        only created and applied while the order's run is IN_PROGRESS, so a
 *        released order is back in the buyer's direct-edit window while its CR
 *        still sits PENDING. Keyed by the SAME locked id array as write 2, so
 *        the released set and the declined set are provably the same rows.
 *   The RouteRunStop rows are left exactly as they are — they are history,
 *   not the thing being repaired.
 *
 *   ⚠️ The stop-status half of the scope is RE-READ INSIDE the transaction,
 *   after the order rows are locked, and any order whose stop has become
 *   COMPLETED since the scan is dropped from ALL THREE writes (reported as
 *   `skipped (stop completed since scan)`). The scan and the writes are two
 *   statements under READ COMMITTED; a driver's completeStop /
 *   completeWithPayment committing in that window would otherwise let this
 *   script strip the pointers off an order that had just been delivered and
 *   paid for at the door. The forward fix closes the same hole by carrying
 *   `routeRunStop: { status: { not: "COMPLETED" } }` in every statement.
 *
 * WHAT IS ONLY REPORTED (settlement attribution)
 *   A released order that also carries a `PAID` `CASH`/`CHECK` InvoicePayment
 *   (joined through `Invoice.orderId`) is STILL released — the money really
 *   was collected at some point, and leaving the pointer pinned would just
 *   re-strand the order — but is printed under a "settlement attribution
 *   moved" heading so the owner can check whether that run's settlement
 *   record (if one was recorded) needs a second look. This mirrors the
 *   forward-fix's own contract (spec R15): the office-recorded payment's
 *   attribution moving off the run is intended behaviour, not a bug this
 *   script corrects. Nothing about money is ever mutated by this script.
 *
 * WHAT IS ONLY REPORTED (orders pinned to a COMPLETED stop)
 *   An undelivered order still pinned to a COMPLETED stop of a cancelled run is
 *   printed under its own heading and NEVER written: it is outside the forward
 *   fix's release scope (above), so releasing it would be this script inventing
 *   a repair the shipped code does not perform — on a stop that recorded work at
 *   the door, whose cash `getRunCashCollections` attributes to that run. Freeing
 *   such a row is an owner decision, taken row by row, not a repair flight's.
 *
 * NOT DETECTABLE, recorded as such: a pre-fix order released or re-dispatched
 * by hand (an operator manually cleared the pointer before this repair ran)
 * leaves no trace distinguishing it from a normal order and is simply absent
 * from the scope query — there is nothing left to repair for it.
 *
 * SAFETY MODEL (house pattern — mirrors scripts/repair-f10-reopen-damage.mjs)
 *   • DRY RUN BY DEFAULT: session forced `default_transaction_read_only = on`;
 *     prints every affected run, its orders, and the exact three SQL statements
 *     (with --verbose).
 *   • Writing requires ALL of:
 *       --execute                   turn writes on
 *       --i-have-a-fresh-backup     attest a fresh VERIFIED backup exists
 *       --confirm <runId>           opt in EACH run individually (repeatable)
 *                                   (or --confirm-all-listed, which still
 *                                    requires --execute and the backup
 *                                    attestation)
 *   • --tenant <slug>               narrow the scope query to one tenant. The
 *                                   slug is resolved to an id FIRST and an
 *                                   unknown one EXITS NON-ZERO — never a silent
 *                                   zero-row "nothing to repair".
 *   • One transaction PER RUN. Inside it the run row and every one of its
 *     scoped order rows are locked (SELECT … FOR UPDATE), those orders' stops
 *     are re-read and any now-COMPLETED stop's order is dropped from the
 *     write set, and the run's status plus each REMAINING order's (status,
 *     routeRunId, routeRunStopId) are compared to the dry-run snapshot; ANY
 *     drift aborts that run's transaction and moves on to the next run. The
 *     stop re-check runs BEFORE the drift comparison on purpose: a stop
 *     completed mid-flight usually moves its order's status too, and that
 *     order must be SKIPPED (as the helper skips it) rather than aborting the
 *     whole run's repair.
 *   • Every executed repair appends one JSONL line per order to
 *     local-assets/f11-repair-<ts>.jsonl:
 *       { orderId, runId, stopId, before: { status, routeRunId, routeRunStopId,
 *         pendingChangeRequestIds }, attributionMoved }
 *     — the before-state there is the rollback source (REPAIR-RUNBOOK.md §4);
 *     `pendingChangeRequestIds` are the exact rows write 3 declined for that
 *     order (from its `RETURNING`), so the decline is reversible row by row.
 *   • Refuses to run unless current_database() is 'railway' or 'routeflow' —
 *     pass --force-nonprod to run elsewhere (loud, deliberate; this is also
 *     how the builder verification runs against a local docker Postgres).
 *   • Prints ids, statuses and counts ONLY — never customer, product, or
 *     business names.
 *
 * `assertTestTenant` deliberately does NOT apply here (same as repair-f03.mjs /
 * repair-f17.mjs): this script repairs live rows by design — that is the whole
 * point of a D4 repair lane. `--tenant` narrows the scope, it does not gate it.
 *
 * Usage:
 *   railway run --service postgres node scripts/repair-f11-stranded-orders.mjs
 *   railway run --service postgres node scripts/repair-f11-stranded-orders.mjs --tenant <slug> --verbose
 *   railway run --service postgres node scripts/repair-f11-stranded-orders.mjs \
 *     --execute --i-have-a-fresh-backup --confirm <runId>
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const BACKUP_ATTESTED = argv.includes("--i-have-a-fresh-backup");
const FORCE_NONPROD = argv.includes("--force-nonprod");
const CONFIRM_ALL = argv.includes("--confirm-all-listed");
const VERBOSE = argv.includes("--verbose");

function collectFlag(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        console.error(`${name} requires an argument`);
        process.exit(2);
      }
      out.push(argv[i + 1]);
    }
  }
  return out;
}
const CONFIRMED = new Set(collectFlag("--confirm"));

const tenantIdx = argv.indexOf("--tenant");
const TENANT_SLUG = tenantIdx >= 0 ? argv[tenantIdx + 1] : null;
if (tenantIdx >= 0 && (!TENANT_SLUG || TENANT_SLUG.startsWith("--"))) {
  console.error("--tenant requires a slug argument");
  process.exit(2);
}

// ─── Connection resolution (mirrors scripts/repair-f10-reopen-damage.mjs) ────
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
      POSTGRES_PASSWORD,
    )}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

const url = resolveUrl();
if (!url) {
  console.error(
    "No usable connection string. Set DATABASE_URL, or run via:\n" +
      "  railway run --service postgres node scripts/repair-f11-stranded-orders.mjs",
  );
  process.exit(2);
}

// MUST stay byte-identical to RELEASED_CHANGE_REQUEST_REASON in
// apps/api/src/routes/routes.service.ts — the retroactive decline and the
// forward one have to be indistinguishable in the CR history (that string,
// em dash included, is what an operator greps for).
const RELEASED_CHANGE_REQUEST_REASON = "Run cancelled — order released to dispatch";

// PENDING change requests on a set of orders. Used twice with the SAME
// predicate: as a COUNT in the dry run (no write) and as the UPDATE's own
// WHERE in the live path.
const PENDING_CR_PREDICATE = `"orderId" = ANY($1::text[]) AND status = 'PENDING'`;

// ─── Scope query (derived, never hardcoded ids) — see spec R13/R15 ───────────
// This is the CANDIDATE set. The `RouteRunStop.status <> 'COMPLETED'` half of
// the scope (header) is applied in JS, not here, so the COMPLETED-stop rows can
// still be listed under their own report heading instead of vanishing silently.
const SCOPE_QUERY = `
  SELECT o.id AS order_id, o."tenantId" AS tenant_id, o.status AS order_status,
         o."routeRunId" AS route_run_id, o."routeRunStopId" AS route_run_stop_id,
         rr.id AS run_id, rr.status AS run_status, s.status AS stop_status,
         EXISTS (
           SELECT 1 FROM "InvoicePayment" ip JOIN "Invoice" i ON i.id = ip."invoiceId"
           WHERE i."orderId" = o.id AND ip.status = 'PAID' AND ip.method IN ('CASH','CHECK')
         ) AS attribution_moved
  FROM "Order" o
  JOIN "RouteRunStop" s ON s.id = o."routeRunStopId"
  JOIN "RouteRun" rr ON rr.id = s."routeRunId"
  WHERE o."routeRunStopId" IS NOT NULL
    AND o.status NOT IN ('DELIVERED','CANCELLED')
    AND (rr.status = 'CANCELLED' OR (rr.status = 'COMPLETED' AND s.status = 'SKIPPED'))
    AND ($1::text IS NULL OR o."tenantId" = $1)
  ORDER BY rr.id, o.id
`;

const client = new pg.Client({ connectionString: url });

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exitCode = 1;
}

/**
 * Current status of each of `stopIds`, as a Map. Called twice per repair: once
 * on the scan's candidate set (a second snapshot, seconds after the scope
 * query) and once inside every repair transaction with the orders locked. Both
 * stand in for the forward fix's per-statement
 * `routeRunStop: { status: { not: "COMPLETED" } }`.
 */
async function readStopStatuses(stopIds) {
  const ids = [...new Set(stopIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT id, status FROM "RouteRunStop" WHERE id = ANY($1::text[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.status]));
}

/** Groups the flat scope rows into one entry per run, each carrying its orders. */
function groupByRun(rows) {
  const runs = new Map();
  for (const r of rows) {
    if (!runs.has(r.run_id)) {
      runs.set(r.run_id, {
        runId: r.run_id,
        runStatus: r.run_status,
        tenantId: r.tenant_id,
        orders: [],
      });
    }
    runs.get(r.run_id).orders.push({
      orderId: r.order_id,
      orderStatus: r.order_status,
      routeRunId: r.route_run_id,
      routeRunStopId: r.route_run_stop_id,
      stopStatus: r.stop_status,
      attributionMoved: r.attribution_moved,
    });
  }
  return runs;
}

async function main() {
  await client.connect();

  const { rows: dbRows } = await client.query("SELECT current_database() AS db");
  const db = dbRows[0].db;
  if (!["railway", "routeflow"].includes(db) && !FORCE_NONPROD) {
    fail(
      `Refusing to run against database "${db}" — expected 'railway' or 'routeflow'. ` +
        `Pass --force-nonprod to override deliberately.`,
    );
    await client.end();
    return;
  }

  if (!EXECUTE) {
    await client.query("SET default_transaction_read_only = on");
  } else if (!BACKUP_ATTESTED) {
    fail("--execute requires --i-have-a-fresh-backup (attest a fresh VERIFIED backup exists).");
    await client.end();
    return;
  }

  console.log(
    `\nF11 repair flight — database "${db}" — ${EXECUTE ? "EXECUTE" : "DRY RUN"}` +
      `${TENANT_SLUG ? ` — tenant "${TENANT_SLUG}"` : ""}`,
  );
  console.log("=".repeat(78));

  // Resolve --tenant to an id FIRST. Inlining the lookup in the scope query
  // would turn an unknown slug into `o."tenantId" = NULL` — zero rows, exit 0,
  // and a typo reads as "this tenant is clean".
  let tenantId = null;
  if (TENANT_SLUG) {
    const { rows: tenantRows } = await client.query(`SELECT id FROM "Tenant" WHERE slug = $1`, [
      TENANT_SLUG,
    ]);
    if (tenantRows.length === 0) {
      fail(
        `No tenant with slug "${TENANT_SLUG}" — nothing was scanned. ` +
          `--tenant takes the SLUG, not the business name; drop the flag to scan every tenant.`,
      );
      await client.end();
      return;
    }
    tenantId = tenantRows[0].id;
    console.log(`\ntenant "${TENANT_SLUG}" → ${tenantId}`);
  }

  const { rows: scopeRows } = await client.query(SCOPE_QUERY, [tenantId]);
  // Parity with releaseUndeliveredOrders (see the header): only stops that
  // recorded no work are releasable. Rows on a COMPLETED stop are reported and
  // never written.
  const releasableAtScan = scopeRows.filter((r) => r.stop_status !== "COMPLETED");
  const onCompletedStops = scopeRows.filter((r) => r.stop_status === "COMPLETED");

  // First of the two stop re-checks. The scope query's `stop_status` is a
  // snapshot; a driver completing that stop afterwards must drop the order from
  // the plan, not just from the writes, so the printed listing is what an
  // --execute would actually attempt. (The authoritative re-check is the second
  // one, taken under lock inside each repair transaction.)
  const completedSinceScan = [];
  const releasable = [];
  const stopStatusNow = await readStopStatuses(releasableAtScan.map((r) => r.route_run_stop_id));
  for (const r of releasableAtScan) {
    if (stopStatusNow.get(r.route_run_stop_id) === "COMPLETED") {
      completedSinceScan.push({
        runId: r.run_id,
        orderId: r.order_id,
        stopId: r.route_run_stop_id,
      });
    } else {
      releasable.push(r);
    }
  }
  const runs = groupByRun(releasable);

  console.log(
    `\nStranded orders on cancelled / completed-with-skipped runs (B129 / B211): ` +
      `${runs.size} run(s), ${releasable.length} order(s) total\n`,
  );
  if (runs.size === 0) {
    console.log("  (nothing to repair)");
  }

  const attributionMoved = [];
  for (const run of runs.values()) {
    console.log(`  run ${run.runId}  [${run.runStatus}]  tenant ${run.tenantId ?? "(none)"}`);
    for (const o of run.orders) {
      const marker = o.attributionMoved ? "  ⚠ attribution moved" : "";
      console.log(
        `    order ${o.orderId} [${o.orderStatus}]  stop ${o.routeRunStopId} [${o.stopStatus}]${marker}`,
      );
      if (o.attributionMoved) {
        attributionMoved.push({ runId: run.runId, orderId: o.orderId, orderStatus: o.orderStatus });
      }
    }
    if (VERBOSE) {
      const idList = run.orders.map((o) => `'${o.orderId}'`).join(",");
      console.log(
        `    SQL: UPDATE "Order" SET status='CONFIRMED' WHERE id = ANY(ARRAY[${idList}]) ` +
          `AND status='OUT_FOR_DELIVERY';\n` +
          `         UPDATE "Order" SET "routeRunId"=NULL, "routeRunStopId"=NULL ` +
          `WHERE id = ANY(ARRAY[${idList}]) AND status NOT IN ('DELIVERED','CANCELLED');\n` +
          `         UPDATE "ChangeRequest" SET status='DECLINED', resolution='DECLINED', ` +
          `"resolutionReason"='${RELEASED_CHANGE_REQUEST_REASON}', "resolvedAt"=NOW(), "updatedAt"=NOW() ` +
          `WHERE "orderId" = ANY(ARRAY[${idList}]) AND status='PENDING';`,
      );
    }
  }

  console.log(
    `\nSettlement attribution moved — check this run's settlement if one was recorded: ` +
      `${attributionMoved.length} order(s) (still released; the office-recorded payment's ` +
      `attribution moving off the run is intended per spec R15, not a bug this script fixes)\n`,
  );
  if (attributionMoved.length === 0) {
    console.log("  (none found)");
  } else {
    for (const f of attributionMoved) {
      console.log(`  run ${f.runId}  order ${f.orderId} [${f.orderStatus}]`);
    }
  }

  console.log(
    `\nPinned to a COMPLETED stop — NOT repaired (outside the forward fix's release scope: ` +
      `work was recorded at that door, so releasing would move settlement attribution the shipped ` +
      `code never moves — free these row by row if the owner decides to): ` +
      `${onCompletedStops.length} order(s)\n`,
  );
  if (onCompletedStops.length === 0) {
    console.log("  (none found)");
  } else {
    for (const r of onCompletedStops) {
      console.log(
        `  run ${r.run_id} [${r.run_status}]  order ${r.order_id} [${r.order_status}]  ` +
          `stop ${r.route_run_stop_id} [${r.stop_status}]`,
      );
    }
  }

  // ── Release side-effects (both modes) ────────────────────────────────────
  // In a DRY RUN both numbers are projections over the scan's order set: the
  // skip count from the pre-apply stop re-read above, the change-request count
  // from a COUNT with write 3's own predicate (no write). In an EXECUTE they
  // are the totals actually applied, so they are printed after the apply loop.
  const releasableIds = [...runs.values()].flatMap((r) => r.orders.map((o) => o.orderId));
  let declinedChangeRequests = 0;
  if (!EXECUTE) {
    const { rows: crRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM "ChangeRequest" WHERE ${PENDING_CR_PREDICATE}`,
      [releasableIds],
    );
    declinedChangeRequests = crRows[0].n;
  }

  const printReleaseSideEffects = () => {
    console.log(
      `\nskipped (stop completed since scan): ${completedSinceScan.length} order(s) — dropped ` +
        `from ALL THREE writes because the stop recorded work between the scan and the write ` +
        `(the forward fix excludes exactly these rows, per statement)\n`,
    );
    if (completedSinceScan.length === 0) {
      console.log("  (none)");
    } else {
      for (const s of completedSinceScan) {
        console.log(`  run ${s.runId}  order ${s.orderId}  stop ${s.stopId}`);
      }
    }
    console.log(
      `\nchange requests declined: ${declinedChangeRequests} — every PENDING ChangeRequest on a ` +
        `released order, resolved as DECLINED / "${RELEASED_CHANGE_REQUEST_REASON}" so a ` +
        `re-dispatched driver cannot approve it and apply the same items twice` +
        `${EXECUTE ? "" : " (projected; the dry run counts, it never writes)"}`,
    );
  };

  // ── Apply ────────────────────────────────────────────────────────────────
  if (!EXECUTE) {
    printReleaseSideEffects();
    console.log(
      `\nDry run complete. To repair: --execute --i-have-a-fresh-backup --confirm <runId> ` +
        `[--confirm <runId> ...]  (or --confirm-all-listed)`,
    );
    await client.end();
    return;
  }

  const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "local-assets");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `f11-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  const append = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");

  let repairedRuns = 0;
  let repairedOrders = 0;
  let skipped = 0;
  for (const run of runs.values()) {
    if (!CONFIRM_ALL && !CONFIRMED.has(run.runId)) {
      skipped++;
      continue;
    }
    const scanned = run.orders;

    try {
      await client.query("BEGIN");

      const { rows: lockedRun } = await client.query(
        `SELECT status FROM "RouteRun" WHERE id = $1 FOR UPDATE`,
        [run.runId],
      );
      if (lockedRun.length === 0) throw new Error("run row vanished");
      if (lockedRun[0].status !== run.runStatus) {
        throw new Error(
          `run status drifted since the dry run (${run.runStatus} → ${lockedRun[0].status})`,
        );
      }

      const { rows: recheck } = await client.query(
        // FOR UPDATE: these are the rows this tx is about to write, so they stay
        // locked for the whole compare-then-write window. Without it a
        // concurrent dashboard edit can land between the drift check and the
        // UPDATEs, and the JSONL `before` state (the runbook §4 rollback
        // source) would record a status the order no longer had.
        `SELECT id, status, "routeRunId", "routeRunStopId" FROM "Order" WHERE id = ANY($1::text[]) FOR UPDATE`,
        [scanned.map((o) => o.orderId)],
      );
      const recheckById = new Map(recheck.map((r) => [r.id, r]));

      // Authoritative stop re-check: the orders are locked, so a stop that
      // completes from here on cannot also move one of these order rows. Runs
      // BEFORE the drift comparison deliberately — completing a stop usually
      // moves its order's status too, and such an order must be SKIPPED (the
      // forward fix skips it per statement) rather than aborting the whole run.
      const stopNowLocked = await readStopStatuses(scanned.map((o) => o.routeRunStopId));
      const orders = [];
      for (const o of scanned) {
        if (stopNowLocked.get(o.routeRunStopId) === "COMPLETED") {
          completedSinceScan.push({
            runId: run.runId,
            orderId: o.orderId,
            stopId: o.routeRunStopId,
          });
        } else {
          orders.push(o);
        }
      }

      for (const o of orders) {
        const now = recheckById.get(o.orderId);
        if (!now) throw new Error(`order ${o.orderId} vanished`);
        if (
          now.status !== o.orderStatus ||
          now.routeRunId !== o.routeRunId ||
          now.routeRunStopId !== o.routeRunStopId
        ) {
          throw new Error(`order ${o.orderId} drifted since the dry run`);
        }
      }

      const ids = orders.map((o) => o.orderId);
      if (ids.length === 0) {
        await client.query("COMMIT");
        console.log(
          `\n  – run ${run.runId}: nothing left to release — every scoped stop completed since ` +
            `the scan (${scanned.length} order(s) skipped)`,
        );
        skipped++;
        continue;
      }

      // Same three writes, same order, over the same stop set (non-COMPLETED
      // stops only) as releaseUndeliveredOrders (routes.service.ts).
      await client.query(
        `UPDATE "Order" SET status = 'CONFIRMED' WHERE id = ANY($1::text[]) AND status = 'OUT_FOR_DELIVERY'`,
        [ids],
      );
      await client.query(
        `UPDATE "Order" SET "routeRunId" = NULL, "routeRunStopId" = NULL ` +
          `WHERE id = ANY($1::text[]) AND status NOT IN ('DELIVERED','CANCELLED')`,
        [ids],
      );
      // Write 3, keyed by the SAME id array as write 2, which the drift check
      // above proves is exactly the released set (every one of those orders was
      // re-read with the scan's status, and the scan excluded DELIVERED /
      // CANCELLED). `RETURNING` is what makes the JSONL's
      // `pendingChangeRequestIds` provably the rows this statement declined —
      // the runbook §4 rollback names them one by one.
      const { rows: declinedCrs } = await client.query(
        `UPDATE "ChangeRequest" SET status = 'DECLINED', resolution = 'DECLINED', ` +
          `"resolutionReason" = $2, "resolvedAt" = NOW(), "updatedAt" = NOW() ` +
          `WHERE ${PENDING_CR_PREDICATE} RETURNING id, "orderId"`,
        [ids, RELEASED_CHANGE_REQUEST_REASON],
      );

      await client.query("COMMIT");

      const crIdsByOrder = new Map();
      for (const cr of declinedCrs) {
        if (!crIdsByOrder.has(cr.orderId)) crIdsByOrder.set(cr.orderId, []);
        crIdsByOrder.get(cr.orderId).push(cr.id);
      }
      declinedChangeRequests += declinedCrs.length;

      for (const o of orders) {
        append({
          orderId: o.orderId,
          runId: run.runId,
          stopId: o.routeRunStopId,
          before: {
            status: o.orderStatus,
            routeRunId: o.routeRunId,
            routeRunStopId: o.routeRunStopId,
            pendingChangeRequestIds: crIdsByOrder.get(o.orderId) ?? [],
          },
          attributionMoved: o.attributionMoved,
        });
      }

      console.log(
        `\n  ✓ run ${run.runId}: released ${ids.length} order(s) — ${ids.join(", ")}` +
          `; declined ${declinedCrs.length} pending change request(s)` +
          `${scanned.length > ids.length ? `; skipped ${scanned.length - ids.length} (stop completed since scan)` : ""}`,
      );
      repairedRuns++;
      repairedOrders += ids.length;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(`run ${run.runId}: aborted — ${e.message}`);
      append({
        kind: "f11-repair-aborted",
        at: new Date().toISOString(),
        runId: run.runId,
        error: e.message,
      });
      skipped++;
    }
  }

  printReleaseSideEffects();

  console.log(
    `\nRepaired ${repairedRuns} run(s) / ${repairedOrders} order(s), skipped ${skipped} run(s). ` +
      `Log: ${logPath}`,
  );
  await client.end();
}

main().catch(async (e) => {
  console.error(e);
  await client.end().catch(() => {});
  process.exit(1);
});
