/**
 * SA-842 §5 (B209 / #1402): the pure part of report-orphaned-delivery-evidence.mjs — the SQL, the
 * per-tenant count builders, the object-storage aggregation and the argument / live-target checks.
 * Kept in CommonJS so the jest spec requires it directly with a mocked client (no database).
 *
 * Everything here READS. The SQL is SELECT / SHOW only, the storage side is ListObjectsV2 only, and the
 * output is tenant ids and counts: no slug, business name, email, key, customer or order data.
 */

/** Session settings, first thing on the connection (the server then refuses any write). */
const READ_ONLY_SESSION = [
  "SET default_transaction_read_only = on",
  "SET statement_timeout = '120s'",
  "SET lock_timeout = '5s'",
  // a slow storage listing must never hold the READ ONLY snapshot open indefinitely
  "SET idle_in_transaction_session_timeout = '300s'",
];
const BEGIN_READ_ONLY = "BEGIN TRANSACTION READ ONLY";
const SHOW_READ_ONLY = "SHOW transaction_read_only";
const END_TX = "ROLLBACK";

const BAND_DAYS = 30;

/** Printed (header + output) when R2 is unset: prod may store POD files on the API volume (UPLOAD_DIR). */
const STORAGE_NOT_LISTED =
  "R2 not configured: POD files are on the API volume and are NOT listed by this report";

/**
 * One entry per count in SA-842 §5. Each query returns rows of
 * `{ tenantId, total, recent, older }` (recent/older banded only where §5 asks for it).
 */
const COUNT_QUERIES = [
  {
    key: "returnStopMissing",
    label: "1 definitive: Return.routeRunStopId set, no RouteRunStop row",
    sql: `
      SELECT r."tenantId" AS "tenantId", count(*)::int AS total
        FROM "Return" r
       WHERE r."routeRunStopId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "RouteRunStop" s WHERE s.id = r."routeRunStopId")
       GROUP BY r."tenantId"`,
  },
  {
    key: "advanceRunMissing",
    label: "2 definitive: AdvancePayment.reference RUN:{runId}:..., no RouteRun row",
    sql: `
      SELECT a."tenantId" AS "tenantId", count(*)::int AS total
        FROM "AdvancePayment" a
       WHERE a.reference LIKE 'RUN:%'
         AND NOT EXISTS (
           SELECT 1 FROM "RouteRun" rr WHERE rr.id = split_part(a.reference, ':', 2)
         )
       GROUP BY a."tenantId"`,
  },
  {
    key: "mutationUnlinked",
    label: "3 strong: DeliveryMutation unlinked after creation (driver row)",
    banded: true,
    sql: `
      SELECT m."tenantId" AS "tenantId", count(*)::int AS total,
             (count(*) FILTER (WHERE m."updatedAt" >= now() - interval '${BAND_DAYS} days'))::int AS recent,
             (count(*) FILTER (WHERE m."updatedAt" <  now() - interval '${BAND_DAYS} days'))::int AS older
        FROM "DeliveryMutation" m
       WHERE m."routeRunStopId" IS NULL
         AND m."driverId" IS NOT NULL
         AND m."updatedAt" > m."createdAt"
       GROUP BY m."tenantId"`,
  },
  {
    key: "batchUnlinked",
    label: "4 strong: DeliveryBatch with no stop and a driver",
    sql: `
      SELECT b."tenantId" AS "tenantId", count(*)::int AS total
        FROM "DeliveryBatch" b
       WHERE b."routeRunStopId" IS NULL
         AND b."driverId" IS NOT NULL
       GROUP BY b."tenantId"`,
  },
  {
    key: "deliveredOrderUnpinned",
    label: "5 delivered orders with no run/stop pin that own a count-3 mutation",
    sql: `
      SELECT o."tenantId" AS "tenantId", count(*)::int AS total
        FROM "Order" o
       WHERE o.status IN ('DELIVERED', 'PARTIALLY_DELIVERED')
         AND o."routeRunId" IS NULL
         AND o."routeRunStopId" IS NULL
         AND EXISTS (
           SELECT 1 FROM "DeliveryMutation" m
            WHERE m."orderId" = o.id
              AND m."routeRunStopId" IS NULL
              AND m."driverId" IS NOT NULL
              AND m."updatedAt" > m."createdAt"
         )
       GROUP BY o."tenantId"`,
  },
];

const TENANT_IDS = `SELECT t.id AS "tenantId" FROM "Tenant" t ORDER BY t.id`;
const EXISTING_STOPS = `SELECT s.id FROM "RouteRunStop" s WHERE s.id = ANY($1::text[])`;
const STOP_CHUNK = 1000;

/** `--read-only` is the only mode; `--target-host=<host>` must equal the host the URL resolves to. */
function checkArgs(argv) {
  const has = (f) => argv.includes(f);
  const value = (name) => {
    const hit = argv.find((a) => a.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : null;
  };
  if (!has("--read-only")) {
    return {
      ok: false,
      code: 64,
      message: "refusing: --read-only is required (it is the only mode)",
    };
  }
  const targetHost = value("--target-host");
  if (!targetHost) {
    return {
      ok: false,
      code: 64,
      message: "refusing: --target-host=<host> is required (run once without it to see the host)",
    };
  }
  return { ok: true, targetHost, json: has("--json"), skipStorage: has("--skip-r2") };
}

/** Host and database name of a postgres URL, for the type-back guard. Never the credentials. */
function targetOf(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default)",
  };
}

/**
 * Run the session settings, open a READ ONLY transaction, prove it is read-only, then run every count.
 * Returns `{ tenants: Map<tenantId, {...counts}>, tenantIds: string[] }`. `inTx(result)` (optional) runs
 * inside the same READ ONLY transaction (the storage stop-id lookups). The transaction always ends with
 * ROLLBACK (nothing to keep).
 */
async function buildCounts(client, { inTx } = {}) {
  for (const sql of READ_ONLY_SESSION) await client.query(sql);
  await client.query(BEGIN_READ_ONLY);
  try {
    const ro = await client.query(SHOW_READ_ONLY);
    const flag = ro.rows?.[0]?.transaction_read_only;
    if (flag !== "on")
      throw new Error(`aborting: transaction_read_only is "${flag}", expected "on"`);
    const tenantIds = (await client.query(TENANT_IDS)).rows.map((r) => r.tenantId);
    const tenants = new Map();
    const bucket = (id) => {
      const k = id ?? "(no tenant)";
      if (!tenants.has(k)) tenants.set(k, emptyCounts());
      return tenants.get(k);
    };
    for (const q of COUNT_QUERIES) {
      for (const row of (await client.query(q.sql)).rows) {
        const b = bucket(row.tenantId);
        b[q.key] = Number(row.total) || 0;
        if (q.banded) {
          b[`${q.key}Recent`] = Number(row.recent) || 0;
          b[`${q.key}Older`] = Number(row.older) || 0;
        }
      }
    }
    const result = { tenants, tenantIds, bucket };
    if (inTx) await inTx(result);
    return result;
  } finally {
    await client.query(END_TX);
  }
}

function emptyCounts() {
  return {
    returnStopMissing: 0,
    advanceRunMissing: 0,
    mutationUnlinked: 0,
    mutationUnlinkedRecent: 0,
    mutationUnlinkedOlder: 0,
    batchUnlinked: 0,
    deliveredOrderUnpinned: 0,
    podStopDirs: 0,
    podObjects: 0,
    podBytes: 0,
    podRecent: 0,
    podOlder: 0,
    podOldest: null,
    podNewest: null,
  };
}

const POD_KEY = /^tenants\/([^/]+)\/pod\/([^/]+)\//;

/** Group listed objects by stop id: `Map<stopId, {objects, bytes, oldest, newest}>` for one tenant. */
function groupPodObjects(objects) {
  const byStop = new Map();
  for (const o of objects) {
    const m = POD_KEY.exec(o.Key ?? "");
    if (!m) continue;
    const at = o.LastModified ? new Date(o.LastModified) : null;
    const g = byStop.get(m[2]) ?? { objects: 0, bytes: 0, oldest: null, newest: null };
    g.objects += 1;
    g.bytes += Number(o.Size) || 0;
    if (at && (!g.oldest || at < g.oldest)) g.oldest = at;
    if (at && (!g.newest || at > g.newest)) g.newest = at;
    byStop.set(m[2], g);
  }
  return byStop;
}

/** Fold the stop dirs whose id has no RouteRunStop row into a tenant's counts (banded by newest object). */
function foldOrphanStops(counts, byStop, existingStopIds, now = new Date()) {
  const cutoff = new Date(now.getTime() - BAND_DAYS * 86400000);
  for (const [stopId, g] of byStop) {
    if (existingStopIds.has(stopId)) continue;
    counts.podStopDirs += 1;
    counts.podObjects += g.objects;
    counts.podBytes += g.bytes;
    if (g.newest && g.newest >= cutoff) counts.podRecent += 1;
    else counts.podOlder += 1;
    if (g.oldest && (!counts.podOldest || g.oldest < counts.podOldest)) counts.podOldest = g.oldest;
    if (g.newest && (!counts.podNewest || g.newest > counts.podNewest)) counts.podNewest = g.newest;
  }
  return counts;
}

/** Which of `stopIds` still have a RouteRunStop row, chunked. Read inside the caller's READ ONLY tx. */
async function existingStops(client, stopIds) {
  const found = new Set();
  for (let i = 0; i < stopIds.length; i += STOP_CHUNK) {
    const chunk = stopIds.slice(i, i + STOP_CHUNK);
    for (const r of (await client.query(EXISTING_STOPS, [chunk])).rows) found.add(r.id);
  }
  return found;
}

const COLUMNS = [
  ["returnStopMissing", "1.returns"],
  ["advanceRunMissing", "2.advances"],
  ["mutationUnlinked", "3.mutations"],
  ["mutationUnlinkedRecent", "3.<=30d"],
  ["mutationUnlinkedOlder", "3.>30d"],
  ["batchUnlinked", "4.batches"],
  ["deliveredOrderUnpinned", "5.orders"],
  ["podStopDirs", "6.podStops"],
  ["podObjects", "6.objects"],
  ["podBytes", "6.bytes"],
  ["podRecent", "6.<=30d"],
  ["podOlder", "6.>30d"],
];

/** Plain-text report: one line per tenant id that has any non-zero count, then totals. */
function formatReport({ tenants, target, storageNote, generatedAt }) {
  const lines = [
    "=== ORPHANED DELIVERY EVIDENCE (SA-842 §5) — read-only, tenant ids + counts only ===",
    `generated ${generatedAt} · target host ${target.host} · database ${target.database}`,
    `storage: ${storageNote}`,
    "",
    ["tenantId", ...COLUMNS.map((c) => c[1]), "6.oldest", "6.newest"].join("\t"),
  ];
  const totals = emptyCounts();
  let shown = 0;
  for (const [id, c] of [...tenants.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!COLUMNS.some(([k]) => c[k] > 0)) continue;
    shown += 1;
    for (const [k] of COLUMNS) totals[k] += c[k];
    lines.push([id, ...COLUMNS.map(([k]) => c[k]), iso(c.podOldest), iso(c.podNewest)].join("\t"));
  }
  if (shown === 0) lines.push("(no tenant has any orphaned evidence)");
  lines.push("", ["TOTAL", ...COLUMNS.map(([k]) => totals[k])].join("\t"));
  lines.push(
    "",
    "1-2 definitive · 3-4 strong · 5 orders owning a count-3 row · 6 storage stop dirs with no RouteRunStop row.",
    `Bands: <=${BAND_DAYS}d is still inside the backup window; >${BAND_DAYS}d is beyond DB recovery.`,
  );
  return lines.join("\n");
}
const iso = (d) => (d ? d.toISOString().slice(0, 10) : "-");

module.exports = {
  READ_ONLY_SESSION,
  BEGIN_READ_ONLY,
  SHOW_READ_ONLY,
  COUNT_QUERIES,
  TENANT_IDS,
  EXISTING_STOPS,
  BAND_DAYS,
  STORAGE_NOT_LISTED,
  checkArgs,
  targetOf,
  buildCounts,
  emptyCounts,
  groupPodObjects,
  foldOrphanStops,
  existingStops,
  formatReport,
};
