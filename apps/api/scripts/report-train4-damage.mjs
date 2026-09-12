/**
 * report-train4-damage.mjs — READ-ONLY forensic report for the train-4 fixes
 * (Plane DECIDE-23): B134, B135, B214, B215, B216, B131, B141.
 *
 * The train-4 code fixes stop NEW damage from these seven bugs. This script counts how many
 * prod rows the OLD code already damaged, so the owner can decide whether any repair is needed.
 * It performs no repair and emits no repair SQL — every bucket below is labelled with how far its
 * count can be trusted (EXACT | LOWER_BOUND | UPPER_BOUND | ESTIMATE | CONTEXT), and the human
 * output states plainly what that bucket cannot decide.
 *
 *   railway run --service postgres node apps/api/scripts/report-train4-damage.mjs
 *   railway run --service postgres node apps/api/scripts/report-train4-damage.mjs --tenant <id,id>
 *   railway run --service postgres node apps/api/scripts/report-train4-damage.mjs --json
 *
 * SECTIONS
 *   B134 — invoices un-sent by a failed at-door approval (draft, order-linked, carrying the
 *          "reverted to Draft: source order edited" audit line).
 *   B135 — at-door merges committed after the stop already completed.
 *   B214 — credit notes orphaned by an invoice/order removal (invoiceId lost, still spendable).
 *   B215 — a staff merge folded twice under a replayed Idempotency-Key.
 *   B216 — a pre-lapse downgrade applied (or still armed) after a Stripe reinstatement.
 *   B131 — a removed customer's recurring crons kept generating orders/invoices.
 *   B141 — a removed customer's buyer kept access after removal.
 *
 * SAFETY MODEL (this script must never be able to modify a client database)
 *   - `default_transaction_read_only = on` is the FIRST query issued on the session, so the
 *     server itself rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query.
 *   - Every query below is a SELECT. There is no write-mode flag anywhere in this file.
 *   - No transaction is left open; the connection is closed in `finally`.
 *   - Output carries only row ids, counts, amounts, statuses, types and dates — no tenant name,
 *     slug, email, key or free text. Tenants are printed as ordinals (#1..#n), never as ids.
 *   - Findings are written to a JSONL file under gitignored `local-assets/` for the owner's review.
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECTIONS = ["B134", "B135", "B214", "B215", "B216", "B131", "B141"];

// ─── CLI contract — parsed and validated BEFORE any connection string is resolved ──────────────
const KNOWN_FLAGS = new Set(["--help", "--json", "--tenant", "--out-dir"]);
const argv = process.argv.slice(2);

let showHelp = false;
let jsonMode = false;
let tenantIds = [];
let outDirArg = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!KNOWN_FLAGS.has(arg)) {
    console.error(`Unknown flag: ${arg}`);
    process.exit(2);
  }
  if (arg === "--help") {
    showHelp = true;
  } else if (arg === "--json") {
    jsonMode = true;
  } else if (arg === "--tenant") {
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      console.error("--tenant requires a value");
      process.exit(2);
    }
    tenantIds = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (arg === "--out-dir") {
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      console.error("--out-dir requires a value");
      process.exit(2);
    }
    outDirArg = value;
  }
}

function printUsage() {
  console.error(
    [
      "Usage: report-train4-damage.mjs [--json] [--tenant id,id,...] [--out-dir dir] [--help]",
      "",
      "READ-ONLY forensic report for the train-4 fixes (B134 B135 B214 B215 B216 B131 B141).",
      "No repair is performed and no repair SQL is emitted.",
      "",
      "  --json          print one JSON document to stdout and nothing else (no JSONL file)",
      "  --tenant a,b    scope every section to this comma-separated list of tenant ids",
      "  --out-dir dir   write the human-mode JSONL findings file under this directory",
      "  --help          print this usage and exit",
    ].join("\n"),
  );
}

if (showHelp) {
  printUsage();
  process.exit(0);
}

// ─── Connection resolution — copied verbatim from prod-readonly-audit.mjs's resolveUrl() ────────
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
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

const url = resolveUrl();
if (!url) {
  console.error("No usable connection string — run via `railway run --service postgres ...`");
  process.exit(1);
}

const host = (() => {
  try {
    const u = new URL(url);
    return `${u.host}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "unparseable";
  }
})();
console.error(`report-train4-damage — ${host} — READ-ONLY session`);

const client = new pg.Client({ connectionString: url });

// ─── Small shared helpers (no `.query(` text anywhere below this line except `q`'s own) ────────
const round = (v) => Number(Number(v ?? 0).toFixed(2));
const sortIds = (ids) => [...new Set(ids)].sort();
const sortOrdinals = (ords) =>
  [...new Set(ords)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

function tenantClause(alias) {
  if (!tenantIds.length) return "";
  const col = alias ? `${alias}."tenantId"` : `"tenantId"`;
  return `AND ${col} = ANY($1::text[])`;
}
function tenantParams() {
  return tenantIds.length ? [tenantIds] : [];
}

// ─── Section fetchers. Each returns { json, labels, findings, extraTenantIds? }. `findings` are
// raw (still carry the real tenantId) — ordinals are assigned once, after every section has run,
// from the UNION of every finding's tenantId plus each section's extraTenantIds (rows that matter
// for scope — e.g. B216's armed-now rows — even when they land in no counted bucket). ────────────

async function fetchB134(q) {
  const rows = await q(
    `SELECT i.id, i."tenantId", i.status, i.total, i."createdAt", i."orderId",
            EXISTS (SELECT 1 FROM "ChangeRequest" cr WHERE cr."orderId" = i."orderId") AS "hasCr",
            EXISTS (
              SELECT 1 FROM "ChangeRequest" cr
              WHERE cr."orderId" = i."orderId" AND cr.status = 'APPROVED' AND cr.resolution = 'MERGED_AT_STOP'
            ) AS "hasMergedAtStop"
       FROM "Invoice" i
      WHERE i.status = 'DRAFT'
        AND i."orderId" IS NOT NULL
        AND i."internalNotes" LIKE '%reverted to Draft: source order edited%'
        ${tenantClause("i")}
      ORDER BY i."createdAt"`,
    tenantParams(),
  );

  const findings = [];
  const candidateIds = [];
  let candidateTotal = 0;
  let mergedAtStopCount = 0;
  let noCrCount = 0;

  for (const r of rows) {
    if (r.hasMergedAtStop) {
      mergedAtStopCount++;
      findings.push({
        tenantId: r.tenantId,
        bucket: "mergedAtStopContext",
        label: "CONTEXT",
        extra: { id: r.id, status: r.status, orderId: r.orderId, createdAt: r.createdAt },
      });
    } else if (r.hasCr) {
      candidateIds.push(r.id);
      candidateTotal = round(candidateTotal + Number(r.total));
      findings.push({
        tenantId: r.tenantId,
        bucket: "candidates",
        label: "UPPER_BOUND",
        extra: {
          id: r.id,
          status: r.status,
          total: round(r.total),
          orderId: r.orderId,
          createdAt: r.createdAt,
        },
      });
    } else {
      noCrCount++;
      findings.push({
        tenantId: r.tenantId,
        bucket: "noChangeRequestContext",
        label: "CONTEXT",
        extra: { id: r.id, status: r.status, orderId: r.orderId, createdAt: r.createdAt },
      });
    }
  }

  return {
    json: {
      candidates: candidateIds.length,
      candidateInvoiceIds: sortIds(candidateIds),
      candidateTotal: round(candidateTotal),
      mergedAtStopContext: mergedAtStopCount,
      noChangeRequestContext: noCrCount,
    },
    labels: {
      candidates: "UPPER_BOUND",
      mergedAtStopContext: "CONTEXT",
      noChangeRequestContext: "CONTEXT",
    },
    findings,
  };
}

async function fetchB135(q) {
  const lateRows = await q(
    `WITH late_merges AS (
       SELECT cr.id, cr."tenantId", cr."orderId",
              COALESCE(cr."routeRunStopId", o."routeRunStopId") AS "routeRunStopId",
              cr."resolvedAt"
         FROM "ChangeRequest" cr
         JOIN "Order" o ON o.id = cr."orderId"
         JOIN "RouteRunStop" rs ON rs.id = COALESCE(cr."routeRunStopId", o."routeRunStopId")
        WHERE cr.status = 'APPROVED' AND cr.resolution = 'MERGED_AT_STOP' AND cr.type <> 'NOTE'
          AND rs."completedAt" IS NOT NULL AND cr."resolvedAt" > rs."completedAt"
          ${tenantClause("cr")}
     )
     SELECT lm.id AS "crId", lm."tenantId", dm.id AS "mutationId"
       FROM late_merges lm
       LEFT JOIN "DeliveryMutation" dm
              ON dm."orderId" = lm."orderId"
             AND dm."routeRunStopId" = lm."routeRunStopId"
             AND dm.type IN ('ADD_ON', 'REFUSED')
             AND dm."createdAt" >= lm."resolvedAt"
             AND dm."createdAt" <= lm."resolvedAt" + interval '20 seconds'`,
    tenantParams(),
  );

  const noteRows = await q(
    `SELECT cr.id, cr."tenantId"
       FROM "ChangeRequest" cr
       JOIN "Order" o ON o.id = cr."orderId"
       JOIN "RouteRunStop" rs ON rs.id = COALESCE(cr."routeRunStopId", o."routeRunStopId")
      WHERE cr.status = 'APPROVED' AND cr.resolution = 'MERGED_AT_STOP' AND cr.type = 'NOTE'
        AND rs."completedAt" IS NOT NULL AND cr."resolvedAt" > rs."completedAt"
        ${tenantClause("cr")}`,
    tenantParams(),
  );

  const crTenantById = new Map();
  const mutationIds = new Set();
  for (const r of lateRows) {
    if (!crTenantById.has(r.crId)) crTenantById.set(r.crId, r.tenantId);
    if (r.mutationId) mutationIds.add(r.mutationId);
  }

  const findings = [];
  for (const [crId, tenantId] of crTenantById) {
    findings.push({ tenantId, bucket: "lateMerges", label: "LOWER_BOUND", extra: { id: crId } });
  }
  for (const r of noteRows) {
    findings.push({
      tenantId: r.tenantId,
      bucket: "lateNoteContext",
      label: "CONTEXT",
      extra: { id: r.id },
    });
  }

  return {
    json: {
      lateMerges: crTenantById.size,
      changeRequestIds: sortIds([...crTenantById.keys()]),
      mutationIds: sortIds([...mutationIds]),
      lateNoteContext: noteRows.length,
    },
    labels: { lateMerges: "LOWER_BOUND", lateNoteContext: "CONTEXT" },
    findings,
  };
}

async function fetchB214(q) {
  const rows = await q(
    `SELECT cn.id, cn."tenantId", cn.amount, cn."amountUsed", cn."expiresAt"
       FROM "CreditNote" cn
      WHERE cn."invoiceId" IS NULL
        AND cn.status <> 'VOID'
        AND cn.amount - cn."amountUsed" > 0.001
        ${tenantClause("cn")}
      ORDER BY cn."createdAt"`,
    tenantParams(),
  );

  const findings = [];
  const orphanedIds = [];
  let spendableCount = 0;
  let spendableRemaining = 0;
  let expiredCount = 0;
  let expiredRemaining = 0;
  const now = Date.now();

  for (const r of rows) {
    const remaining = round(Number(r.amount) - Number(r.amountUsed));
    orphanedIds.push(r.id);
    findings.push({
      tenantId: r.tenantId,
      bucket: "orphaned",
      label: "UPPER_BOUND",
      extra: { id: r.id, remaining },
    });

    const isExpired = Boolean(r.expiresAt) && new Date(r.expiresAt).getTime() < now;
    if (isExpired) {
      expiredCount++;
      expiredRemaining = round(expiredRemaining + remaining);
      findings.push({
        tenantId: r.tenantId,
        bucket: "expired",
        label: "CONTEXT",
        extra: { id: r.id, remaining },
      });
    } else {
      spendableCount++;
      spendableRemaining = round(spendableRemaining + remaining);
      findings.push({
        tenantId: r.tenantId,
        bucket: "spendable",
        label: "UPPER_BOUND",
        extra: { id: r.id, remaining },
      });
    }
  }

  return {
    json: {
      orphaned: orphanedIds.length,
      creditNoteIds: sortIds(orphanedIds),
      spendable: spendableCount,
      spendableRemaining: round(spendableRemaining),
      expired: expiredCount,
      expiredRemaining: round(expiredRemaining),
    },
    labels: {
      orphaned: "UPPER_BOUND",
      spendable: "UPPER_BOUND",
      spendableRemaining: "UPPER_BOUND",
      expired: "CONTEXT",
      expiredRemaining: "CONTEXT",
    },
    findings,
  };
}

function qtyMapOf(snapshot) {
  const map = new Map();
  const items = snapshot?.lineItems ?? [];
  for (const item of items) {
    const key = item.productId ?? `custom:${item.name}`;
    map.set(key, (map.get(key) ?? 0) + Number(item.qty ?? 0));
  }
  return map;
}
function deltaOf(curMap, baseMap) {
  const keys = new Set([...curMap.keys(), ...baseMap.keys()]);
  const out = new Map();
  for (const k of keys) {
    const d = (curMap.get(k) ?? 0) - (baseMap.get(k) ?? 0);
    if (d !== 0) out.set(k, d);
  }
  return out;
}
function allPositive(map) {
  if (map.size === 0) return false;
  for (const v of map.values()) if (v <= 0) return false;
  return true;
}
function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

async function fetchB215(q) {
  // `--tenant` is pushed INTO the CTE by the ORDER's tenant, never by the revision's own column:
  // OrderRevision.tenantId is NULLABLE (`sales.prisma`), so filtering on it would hide a
  // NULL-tenant revision from the window and make LAG pair non-adjacent revisions. Scoping by the
  // order keeps every revision of an in-scope order in the window. With no `--tenant`, the CTE
  // stays unfiltered rather than semi-joining the whole "Order" table for nothing.
  const windowScope = tenantIds.length
    ? `r."orderId" IN (SELECT o.id FROM "Order" o WHERE TRUE ${tenantClause("o")})`
    : "TRUE";
  const rows = await q(
    // The window carries ids only — never `snapshot` — so prod's whole OrderRevision table is not
    // sorted with three copies of each row's jsonb in the tuple (that risks the 45 s statement
    // timeout, and one section's timeout loses the whole report). The source/editedById/120 s
    // predicates deliberately stay OUTSIDE the CTE for the same reason the tenant scope is by
    // order: LAG must still see the immediately preceding revision whatever its source, or a
    // non-EDIT revision between two EDITs would be skipped and the pair wrongly counted.
    `WITH revs AS (
       SELECT r.id, r."orderId", r."tenantId", r."revisionNumber", r."createdAt", r."editedById",
              r.source,
              LAG(r."createdAt") OVER w AS "prevCreatedAt",
              LAG(r."editedById") OVER w AS "prevEditedById",
              LAG(r.source) OVER w AS "prevSource",
              LAG(r.id) OVER w AS "prevId",
              LAG(r.id, 2) OVER w AS "prevPrevId"
         FROM "OrderRevision" r
        WHERE ${windowScope}
        WINDOW w AS (PARTITION BY r."orderId" ORDER BY r."revisionNumber")
     )
     SELECT "orderId", "tenantId", id AS "curId", "prevId", "prevPrevId"
       FROM revs
      WHERE source = 'EDIT' AND "prevSource" = 'EDIT'
        AND "editedById" IS NOT NULL AND "editedById" = "prevEditedById"
        AND "createdAt" - "prevCreatedAt" <= interval '120 seconds'
        ${tenantClause()}`,
    tenantParams(),
  );

  // Snapshots load per candidate pair, keyed on the ids the window returned.
  if (rows.length) {
    const snapshotIds = [
      ...new Set(rows.flatMap((r) => [r.curId, r.prevId, r.prevPrevId]).filter((id) => id != null)),
    ];
    const snapshotRows = await q(
      `SELECT id, snapshot FROM "OrderRevision" WHERE id = ANY($1::text[])`,
      [snapshotIds],
    );
    const snapshotById = new Map(snapshotRows.map((s) => [s.id, s.snapshot]));
    for (const r of rows) {
      r.curSnapshot = snapshotById.get(r.curId) ?? null;
      r.prevSnapshot = snapshotById.get(r.prevId) ?? null;
      r.prevPrevSnapshot = r.prevPrevId == null ? null : (snapshotById.get(r.prevPrevId) ?? null);
    }
  }

  const findings = [];
  const confirmedIds = [];
  const unconfirmableIds = [];

  for (const r of rows) {
    const curMap = qtyMapOf(r.curSnapshot);
    const prevMap = qtyMapOf(r.prevSnapshot);
    const deltaCur = deltaOf(curMap, prevMap);

    if (r.prevPrevSnapshot != null) {
      const prevPrevMap = qtyMapOf(r.prevPrevSnapshot);
      const deltaPrev = deltaOf(prevMap, prevPrevMap);
      if (allPositive(deltaPrev) && allPositive(deltaCur) && mapsEqual(deltaPrev, deltaCur)) {
        confirmedIds.push(r.orderId);
        findings.push({
          tenantId: r.tenantId,
          bucket: "confirmedPairs",
          label: "ESTIMATE",
          extra: { orderId: r.orderId },
        });
      }
    } else if (allPositive(deltaCur)) {
      let coveredByPrev = true;
      for (const [k, v] of deltaCur) {
        if ((prevMap.get(k) ?? 0) < v) {
          coveredByPrev = false;
          break;
        }
      }
      if (coveredByPrev) {
        unconfirmableIds.push(r.orderId);
        findings.push({
          tenantId: r.tenantId,
          bucket: "unconfirmablePairs",
          label: "UPPER_BOUND",
          extra: { orderId: r.orderId },
        });
      }
    }
  }

  const keyedRows = await q(
    `SELECT count(*)::int AS n, min("createdAt") AS earliest
       FROM "Order"
      WHERE "idempotencyKey" IS NOT NULL
        ${tenantClause()}`,
    tenantParams(),
  );
  const keyedOrders = keyedRows[0]?.n ?? 0;
  const earliestKeyedOrderAt = keyedRows[0]?.earliest ?? null;

  return {
    json: {
      confirmedPairs: confirmedIds.length,
      confirmedOrderIds: sortIds(confirmedIds),
      unconfirmablePairs: unconfirmableIds.length,
      unconfirmableOrderIds: sortIds(unconfirmableIds),
      keyedOrders,
      earliestKeyedOrderAt,
    },
    labels: {
      confirmedPairs: "ESTIMATE",
      unconfirmablePairs: "UPPER_BOUND",
      keyedOrders: "CONTEXT",
      earliestKeyedOrderAt: "CONTEXT",
    },
    findings,
  };
}

async function fetchB216(q) {
  const events = await q(
    `SELECT id, "tenantId", type, payload, "amountDelta", "createdAt"
       FROM "BillingEvent"
      WHERE type IN ('plan.downgrade_scheduled', 'subscription.resumed', 'plan.changed', 'seat.freed')
        ${tenantClause()}
      ORDER BY "tenantId", "createdAt"`,
    tenantParams(),
  );

  const byTenantEvents = new Map();
  for (const e of events) {
    if (!byTenantEvents.has(e.tenantId)) byTenantEvents.set(e.tenantId, []);
    byTenantEvents.get(e.tenantId).push(e);
  }

  const findings = [];
  const planChangedIds = [];
  let mrrDeltaSum = 0;
  let seatsFreedNear = 0;

  for (const [tenantId, evs] of byTenantEvents) {
    const scheduled = evs.filter((e) => e.type === "plan.downgrade_scheduled");
    const resumedStripe = evs.filter(
      (e) => e.type === "subscription.resumed" && e.payload?.source === "stripe",
    );
    const seatFreed = evs.filter((e) => e.type === "seat.freed");
    const applied = evs.filter(
      (e) =>
        e.type === "plan.changed" && e.payload?.scheduled === true && e.payload?.applied === true,
    );

    for (const ev of applied) {
      const t = new Date(ev.createdAt).getTime();
      const priorScheduled = scheduled
        .filter((se) => new Date(se.createdAt).getTime() < t)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const s = priorScheduled[0];
      if (!s) continue;
      const sTime = new Date(s.createdAt).getTime();
      const resumedBetween = resumedStripe.some((re) => {
        const rt = new Date(re.createdAt).getTime();
        return rt > sTime && rt < t;
      });
      if (!resumedBetween) continue;

      planChangedIds.push(ev.id);
      mrrDeltaSum = round(mrrDeltaSum + Number(ev.amountDelta ?? 0));
      const near = seatFreed
        .filter((se) => {
          const st = new Date(se.createdAt).getTime();
          return st >= t - 60_000 && st <= t;
        })
        .reduce((sum, se) => sum + Number(se.payload?.quantity ?? 0), 0);
      seatsFreedNear += near;
      findings.push({
        tenantId,
        bucket: "appliedAfterReinstatement",
        label: "ESTIMATE",
        extra: { id: ev.id, amountDelta: round(ev.amountDelta ?? 0) },
      });
    }
  }

  const armedRows = await q(
    `SELECT s."tenantId", s."downgradeEffectiveAt"
       FROM "TenantSubscription" s
       JOIN "Tenant" t ON t.id = s."tenantId"
      WHERE s."downgradeToPlanKey" IS NOT NULL
        AND t.status = 'ACTIVE'
        AND t."deletedAt" IS NULL
        ${tenantClause("s")}`,
    tenantParams(),
  );

  const armedAfterTenantIds = [];
  const armedUnknownIds = [];
  const armedEffectiveDates = [];
  const extraTenantIds = [];

  for (const row of armedRows) {
    extraTenantIds.push(row.tenantId);
    const evs = byTenantEvents.get(row.tenantId) ?? [];
    const scheduled = evs.filter((e) => e.type === "plan.downgrade_scheduled");
    const resumedStripe = evs.filter(
      (e) => e.type === "subscription.resumed" && e.payload?.source === "stripe",
    );
    const latestScheduled = scheduled.length
      ? Math.max(...scheduled.map((e) => new Date(e.createdAt).getTime()))
      : null;
    const latestResumed = resumedStripe.length
      ? Math.max(...resumedStripe.map((e) => new Date(e.createdAt).getTime()))
      : null;

    if (latestResumed != null && latestScheduled != null && latestResumed > latestScheduled) {
      armedAfterTenantIds.push(row.tenantId);
      armedEffectiveDates.push(row.downgradeEffectiveAt);
      findings.push({
        tenantId: row.tenantId,
        bucket: "armedAfterReinstatement",
        label: "UPPER_BOUND",
        extra: { downgradeEffectiveAt: row.downgradeEffectiveAt },
      });
    } else if (latestResumed != null && latestScheduled == null) {
      armedUnknownIds.push(row.tenantId);
      findings.push({
        tenantId: row.tenantId,
        bucket: "armedOrderUnknown",
        label: "UPPER_BOUND",
        extra: {},
      });
    }
  }

  return {
    json: {
      appliedAfterReinstatement: planChangedIds.length,
      planChangedEventIds: sortIds(planChangedIds),
      mrrDeltaSum: round(mrrDeltaSum),
      seatsFreedNear,
      armedAfterReinstatement: armedAfterTenantIds.length,
      armedTenantOrdinals: [],
      armedEffectiveDates: armedEffectiveDates
        .filter(Boolean)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime()),
      armedOrderUnknown: armedUnknownIds.length,
    },
    labels: {
      appliedAfterReinstatement: "ESTIMATE",
      armedAfterReinstatement: "UPPER_BOUND",
      armedOrderUnknown: "UPPER_BOUND",
    },
    findings,
    extraTenantIds,
    armedAfterTenantIds,
  };
}

async function fetchB131(q) {
  const templateOrders = await q(
    `SELECT o.id, o."tenantId", o.status, o.total, o."createdAt"
       FROM "Order" o
       JOIN "Customer" c ON c.id = o."customerId"
      WHERE c."deletedAt" IS NOT NULL
        AND o."createdAt" > c."deletedAt"
        AND o."templateId" IS NOT NULL
        ${tenantClause("o")}
      ORDER BY o."createdAt"`,
    tenantParams(),
  );

  const recurringInvoices = await q(
    `SELECT i.id, i."tenantId", i.status, i.total, i."createdAt", (i."sentAt" IS NOT NULL) AS emailed
       FROM "Invoice" i
       JOIN "Customer" c ON c.id = i."customerId"
      WHERE c."deletedAt" IS NOT NULL
        AND i."createdAt" > c."deletedAt"
        AND i."recurringInvoiceId" IS NOT NULL
        ${tenantClause("i")}
      ORDER BY i."createdAt"`,
    tenantParams(),
  );

  const manualInvoices = await q(
    `SELECT i.id, i."tenantId", i.status, i.total, i."createdAt"
       FROM "Invoice" i
       JOIN "Customer" c ON c.id = i."customerId"
      WHERE c."deletedAt" IS NOT NULL
        AND i."createdAt" > c."deletedAt"
        AND i."recurringInvoiceId" IS NULL
        AND i."orderId" IS NULL
        ${tenantClause("i")}
      ORDER BY i."createdAt"`,
    tenantParams(),
  );

  const findings = [];
  for (const r of templateOrders) {
    findings.push({
      tenantId: r.tenantId,
      bucket: "templateOrders",
      label: "LOWER_BOUND",
      extra: { id: r.id, status: r.status, total: round(r.total), createdAt: r.createdAt },
    });
  }
  let emailedCount = 0;
  for (const r of recurringInvoices) {
    if (r.emailed) emailedCount++;
    findings.push({
      tenantId: r.tenantId,
      bucket: "recurringInvoices",
      label: "LOWER_BOUND",
      extra: {
        id: r.id,
        status: r.status,
        total: round(r.total),
        createdAt: r.createdAt,
        emailed: Boolean(r.emailed),
      },
    });
  }
  for (const r of manualInvoices) {
    findings.push({
      tenantId: r.tenantId,
      bucket: "manualInvoices",
      label: "UPPER_BOUND",
      extra: { id: r.id, status: r.status, total: round(r.total), createdAt: r.createdAt },
    });
  }

  return {
    json: {
      templateOrders: templateOrders.length,
      templateOrderIds: sortIds(templateOrders.map((r) => r.id)),
      recurringInvoices: recurringInvoices.length,
      recurringInvoiceIds: sortIds(recurringInvoices.map((r) => r.id)),
      recurringInvoicesEmailed: emailedCount,
      manualInvoices: manualInvoices.length,
      manualInvoiceIds: sortIds(manualInvoices.map((r) => r.id)),
    },
    labels: {
      templateOrders: "LOWER_BOUND",
      recurringInvoices: "LOWER_BOUND",
      recurringInvoicesEmailed: "LOWER_BOUND",
      manualInvoices: "UPPER_BOUND",
    },
    findings,
  };
}

async function fetchB141(q) {
  const scopeCte = `WITH scope AS (
       SELECT c.id AS "customerId", c."userId", c."deletedAt", c."tenantId"
         FROM "Customer" c
        WHERE c."deletedAt" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "CustomerLink" l WHERE l."customerId" = c.id AND l.status = 'ACTIVE')
     )`;

  const editedRows = await q(
    `${scopeCte}
     SELECT DISTINCT o.id, o."tenantId"
       FROM "Order" o
       JOIN scope s ON s."customerId" = o."customerId"
       JOIN "OrderRevision" r ON r."orderId" = o.id
      WHERE r."editedById" = s."userId" AND r."createdAt" > s."deletedAt"
        ${tenantClause("o")}`,
    tenantParams(),
  );

  const unmarkedRows = await q(
    `${scopeCte}
     SELECT o.id, o."tenantId"
       FROM "Order" o
       JOIN scope s ON s."customerId" = o."customerId"
      WHERE o."templateId" IS NULL
        AND o."createdAt" > s."deletedAt"
        AND NOT EXISTS (
          SELECT 1 FROM "OrderRevision" r
           WHERE r."orderId" = o.id AND r."editedById" = s."userId" AND r."createdAt" > s."deletedAt"
        )
        ${tenantClause("o")}`,
    tenantParams(),
  );

  const paymentRows = await q(
    `${scopeCte}
     SELECT p.id, p."tenantId", p.status, p.kind, p.amount, p."createdAt"
       FROM "BuyerPaymentRequest" p
       JOIN scope s ON s."customerId" = p."customerId"
      WHERE p."createdAt" > s."deletedAt"
        ${tenantClause("p")}`,
    tenantParams(),
  );

  const findings = [];
  for (const r of editedRows) {
    findings.push({
      tenantId: r.tenantId,
      bucket: "customerSideEdits",
      label: "LOWER_BOUND",
      extra: { id: r.id },
    });
  }
  for (const r of unmarkedRows) {
    findings.push({
      tenantId: r.tenantId,
      bucket: "unmarkedOrdersUpperBound",
      label: "UPPER_BOUND",
      extra: { id: r.id },
    });
  }
  let paymentAmount = 0;
  for (const r of paymentRows) {
    paymentAmount = round(paymentAmount + Number(r.amount));
    findings.push({
      tenantId: r.tenantId,
      bucket: "buyerPaymentRequests",
      label: "LOWER_BOUND",
      extra: {
        id: r.id,
        status: r.status,
        kind: r.kind,
        amount: round(r.amount),
        createdAt: r.createdAt,
      },
    });
  }

  return {
    json: {
      customerSideEdits: editedRows.length,
      customerSideEditOrderIds: sortIds(editedRows.map((r) => r.id)),
      unmarkedOrdersUpperBound: unmarkedRows.length,
      unmarkedOrderIds: sortIds(unmarkedRows.map((r) => r.id)),
      buyerPaymentRequests: paymentRows.length,
      buyerPaymentRequestIds: sortIds(paymentRows.map((r) => r.id)),
      buyerPaymentRequestAmount: round(paymentAmount),
    },
    labels: {
      customerSideEdits: "LOWER_BOUND",
      unmarkedOrdersUpperBound: "UPPER_BOUND",
      buyerPaymentRequests: "LOWER_BOUND",
    },
    findings,
  };
}

// ─── Human-mode presentation ─────────────────────────────────────────────────────────────────────
const SECTION_TITLES = {
  B134: "B134 invoices un-sent by a failed at-door approval",
  B135: "B135 at-door merges committed after the stop completed",
  B214: "B214 credit notes orphaned by invoice/order removal",
  B215: "B215 staff merge folded twice under a replayed Idempotency-Key",
  B216: "B216 pre-lapse downgrade applied after a Stripe reinstatement",
  B131: "B131 removed customer's crons kept generating",
  B141: "B141 removed customer's buyer kept access",
};

const CANNOT_DECIDE = {
  B134:
    "A staff order edit writes the same audit line, so a CR-bearing order may have been " +
    "reverted by an edit rather than a failed door approval. The stamp is a locale date with no " +
    "time, so it cannot be tied to a specific change request. A re-sent invoice is correctly " +
    "invisible here.",
  B135:
    "A claim stamped just before the stop's completion but committed after is missed. The " +
    "stale-line variant leaves no persisted marker, and completedAt is overwritten on a " +
    "re-completed stop.",
  B214:
    "A note issued standalone, never tied to an invoice, looks identical to an orphaned one. " +
    "The schema keeps no record of a former invoiceId, so the owner reads the ids in-app.",
  B215:
    "Two identical manual edits by one person inside the window look like a double fold when " +
    "they were not. A double fold split across editors, or spread past the window, is missed. " +
    "Order creation writes no revision, so a first-edit double fold has no baseline.",
  B216:
    "Whether the tenant still wanted the downgrade after reinstating is not decidable here. A " +
    "schedule written with no matching event is invisible to the applied bucket. The near-seat " +
    "count is a time-window association, not proof.",
  B131:
    "A customer removed and later restored reads as live now, so its window is invisible " +
    "(undercount). A manual invoice may be a deliberate final bill to a removed customer.",
  B141:
    "A customer-side edit cannot be told apart from the customer's own login. Order creation " +
    "carries no creator column, so a buyer-created order cannot be told apart from a staff-created " +
    "one. A disconnected link, or a restored customer, is excluded (undercount).",
};

// Monetary totals per section. They are not count buckets, so they carry no bound label; without
// them the human summary would print no money figure at all.
const MONEY_FIELDS = {
  B134: ["candidateTotal"],
  B216: ["mrrDeltaSum"],
  B141: ["buyerPaymentRequestAmount"],
};

/** A bucket value as the human report prints it: dates as ISO, a missing value as "(none)". */
function formatBucketValue(value) {
  if (value == null) return "(none)";
  if (value instanceof Date || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value))) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return String(value);
}

function emitHuman(report, findings) {
  console.log("READ-ONLY session. No repair SQL is emitted.\n");

  const b216 = report.sections.B216;
  if (b216.armedTenantOrdinals.length) {
    // Already chronologically sorted in fetchB216 - never re-sort here: Array#sort's default
    // comparator stringifies each Date and would order them by weekday name.
    const earliest = formatBucketValue(b216.armedEffectiveDates[0]);
    console.log(`ACT BEFORE ${earliest} — armed tenants: ${b216.armedTenantOrdinals.join(", ")}\n`);
  }

  for (const sec of SECTIONS) {
    console.log(`── ${SECTION_TITLES[sec]} ──`);
    const json = report.sections[sec];
    const labels = report.labels[sec];
    for (const [bucket, label] of Object.entries(labels)) {
      console.log(`  ${bucket}: ${formatBucketValue(json[bucket])}  [${label}]`);
    }

    const amounts = (MONEY_FIELDS[sec] ?? [])
      .filter((field) => json[field] !== undefined)
      .map((field) => `${field}=${json[field]}`);
    if (amounts.length) console.log(`  amounts: ${amounts.join(", ")}`);

    console.log(`  CANNOT DECIDE: ${CANNOT_DECIDE[sec]}`);

    const byTenantForSection = report.byTenant
      .filter((row) => typeof row[sec] === "number")
      .map((row) => `${row.tenant}=${row[sec]}`);
    if (byTenantForSection.length) console.log(`  by tenant: ${byTenantForSection.join(", ")}`);

    for (const bucket of Object.keys(labels)) {
      const ids = findings
        .filter((f) => f.class === sec && f.bucket === bucket)
        .map((f) => f.id ?? f.orderId)
        .filter(Boolean);
      if (!ids.length) continue;
      const shown = ids.slice(0, 40);
      console.log(`  ${bucket} ids: ${shown.join(", ")}`);
      if (ids.length > 40) console.log(`  … ${ids.length - 40} more in the JSONL`);
    }
    console.log("");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
  await client.connect();

  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");

  const q = async (sql, params) => (await client.query(sql, params)).rows;

  const results = {
    B134: await fetchB134(q),
    B135: await fetchB135(q),
    B214: await fetchB214(q),
    B215: await fetchB215(q),
    B216: await fetchB216(q),
    B131: await fetchB131(q),
    B141: await fetchB141(q),
  };

  // ── Ordinal assignment: every tenantId in any finding, or in a section's extraTenantIds ─────
  const allTenantIds = new Set();
  for (const sec of SECTIONS) {
    for (const f of results[sec].findings) if (f.tenantId) allTenantIds.add(f.tenantId);
    for (const t of results[sec].extraTenantIds ?? []) if (t) allTenantIds.add(t);
  }
  const sortedTenantIds = [...allTenantIds].sort();
  const ordinalMap = new Map(sortedTenantIds.map((id, i) => [id, `#${i + 1}`]));
  const ordinal = (id) => (id ? (ordinalMap.get(id) ?? "unscoped") : "unscoped");

  results.B216.json.armedTenantOrdinals = sortOrdinals(
    (results.B216.armedAfterTenantIds ?? []).map(ordinal),
  );

  // ── byTenant + JSONL findings, generic over every section ────────────────────────────────────
  const byTenant = new Map();
  const jsonlFindings = [];
  for (const sec of SECTIONS) {
    for (const f of results[sec].findings) {
      const ord = ordinal(f.tenantId);
      if (!byTenant.has(ord)) byTenant.set(ord, { tenant: ord });
      if (f.label !== "CONTEXT") {
        byTenant.get(ord)[sec] = (byTenant.get(ord)[sec] ?? 0) + 1;
      }
      jsonlFindings.push({
        class: sec,
        bucket: f.bucket,
        label: f.label,
        tenant: ord,
        verdict: "owner-decision-required",
        ...f.extra,
      });
    }
    for (const id of results[sec].extraTenantIds ?? []) {
      const ord = ordinal(id);
      if (!byTenant.has(ord)) byTenant.set(ord, { tenant: ord });
    }
  }

  const report = {
    reportVersion: 1,
    tenants: sortedTenantIds.length,
    sections: Object.fromEntries(SECTIONS.map((s) => [s, results[s].json])),
    labels: Object.fromEntries(SECTIONS.map((s) => [s, results[s].labels])),
    byTenant: [...byTenant.values()],
  };

  if (jsonMode) {
    console.log(JSON.stringify(report));
    return;
  }

  emitHuman(report, jsonlFindings);

  const outDir =
    outDirArg ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "local-assets");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `train4-damage-report-${stamp}.jsonl`);
  fs.writeFileSync(outFile, jsonlFindings.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
  console.log(`Wrote ${jsonlFindings.length} findings to ${outFile}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
