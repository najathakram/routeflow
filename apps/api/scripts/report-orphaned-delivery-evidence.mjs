/**
 * READ-ONLY report (SA-842 §5, B209 / #1402): delivery evidence left behind by route and run deletes
 * that removed RouteRunStop / RouteRun rows. Per tenant id, COUNTS only:
 *   1 Return.routeRunStopId with no RouteRunStop row            (definitive)
 *   2 AdvancePayment.reference RUN:{runId}:... with no RouteRun  (definitive)
 *   3 driver DeliveryMutation unlinked after creation, banded <=30d / >30d by updatedAt (strong)
 *   4 DeliveryBatch with no stop and a driver                    (strong)
 *   5 DELIVERED / PARTIALLY_DELIVERED orders with no run/stop pin that own a count-3 row
 *   6 object storage: tenants/{tenantId}/pod/{stopId}/ dirs whose stopId has no RouteRunStop row
 *     (stop dirs, objects, bytes, oldest/newest, banded the same way). ListObjectsV2 only.
 *     When the R2 variables are unset, storage may be in local-disk mode (files on the API service's volume
 *     at UPLOAD_DIR): the report then says "R2 not configured: POD files are on the API volume and are NOT listed by this report",
 *     so a missing count 6 is never read as zero. --skip-r2 skips it on purpose.
 *
 * Owner-run against production (warn-then-approve per call):
 *   railway run --service postgres node apps/api/scripts/report-orphaned-delivery-evidence.mjs \
 *     --read-only --target-host=<the host it prints>
 *
 * SAFETY
 *   - `--read-only` is the only mode; the script refuses without it.
 *   - Live-target guard: it prints the DB host and database name and refuses unless --target-host matches.
 *   - Session `default_transaction_read_only = on` + timeouts, then BEGIN TRANSACTION READ ONLY, and it aborts
 *     unless SHOW transaction_read_only is `on`. SELECT / SHOW only; the transaction ends with ROLLBACK.
 *   - Output: tenant ids and counts only (no slug, name, email, key, customer or order data), to stdout and
 *     local-assets/reports/ (git-ignored).
 * Pure logic + SQL: ./lib/orphaned-delivery-evidence.cjs (unit-tested with a mocked client).
 */
import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const lib = require("./lib/orphaned-delivery-evidence.cjs");
const SCRIPT = "report-orphaned-delivery-evidence";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** No-DB checks of the pure part (`--self-test`). Throws on the first failure. */
async function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-test: ${msg}`);
  };
  assert(!lib.checkArgs([]).ok && lib.checkArgs([]).code === 64, "refuses without --read-only");
  assert(!lib.checkArgs(["--read-only"]).ok, "refuses without --target-host");
  const okArgs = lib.checkArgs(["--read-only", "--target-host=db.example.test"]);
  assert(okArgs.ok && okArgs.targetHost === "db.example.test", "accepts both flags");
  const t = lib.targetOf("postgresql://u:p%40ss@db.example.test:5432/railway");
  assert(t.host === "db.example.test" && t.database === "railway", "targetOf host/db");
  assert(
    !JSON.stringify(t).includes("p%40ss") && !JSON.stringify(t).includes("p@ss"),
    "no password",
  );

  const seen = [];
  const client = {
    query: async (sql) => {
      seen.push(sql);
      if (sql === lib.SHOW_READ_ONLY) return { rows: [{ transaction_read_only: "on" }] };
      if (sql === lib.TENANT_IDS) return { rows: [{ tenantId: "t1" }] };
      if (sql === lib.COUNT_QUERIES[0].sql) return { rows: [{ tenantId: "t1", total: 2 }] };
      return { rows: [] };
    },
  };
  const res = await lib.buildCounts(client);
  assert(seen[0] === lib.READ_ONLY_SESSION[0], "read-only SET is the first statement");
  assert(
    seen.includes(lib.BEGIN_READ_ONLY) && seen.at(-1) === "ROLLBACK",
    "READ ONLY tx, ends ROLLBACK",
  );
  assert(res.tenants.get("t1").returnStopMissing === 2, "count 1 lands on its tenant");

  const off = {
    query: async (sql) =>
      sql === lib.SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "off" }] } : { rows: [] },
  };
  let aborted = false;
  await lib.buildCounts(off).catch(() => (aborted = true));
  assert(aborted, "aborts when transaction_read_only is not on");

  const now = new Date("2026-10-22T00:00:00Z");
  const by = lib.groupPodObjects([
    { Key: "tenants/t1/pod/s-gone/sig-1.png", Size: 10, LastModified: "2026-10-20T00:00:00Z" },
    { Key: "tenants/t1/pod/s-gone/photo-2.jpg", Size: 5, LastModified: "2026-10-01T00:00:00Z" },
    { Key: "tenants/t1/pod/s-live/sig-3.png", Size: 7, LastModified: "2026-08-01T00:00:00Z" },
    { Key: "tenants/t1/logo.png", Size: 99 },
  ]);
  const c = lib.foldOrphanStops(lib.emptyCounts(), by, new Set(["s-live"]), now);
  assert(c.podStopDirs === 1 && c.podObjects === 2 && c.podBytes === 15, "orphan stop dir totals");
  assert(c.podRecent === 1 && c.podOlder === 0, "banded by the newest object");
  return "self-test ok";
}

/** ListObjectsV2 under each tenant's pod prefix, then fold the stop dirs with no RouteRunStop row. */
async function storagePass(client, result) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return `${lib.STORAGE_NOT_LISTED} (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set); count 6 not run`;
  }
  const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  const Bucket = process.env.R2_BUCKET_NAME || "routeflow-assets";
  let listed = 0;
  for (const tenantId of result.tenantIds) {
    const objects = [];
    let token;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket,
          Prefix: `tenants/${tenantId}/pod/`,
          ContinuationToken: token,
        }),
      );
      objects.push(...(page.Contents ?? []));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    listed += objects.length;
    if (objects.length === 0) continue;
    const byStop = lib.groupPodObjects(objects);
    const live = await lib.existingStops(client, [...byStop.keys()]);
    lib.foldOrphanStops(result.bucket(tenantId), byStop, live);
  }
  return `ListObjectsV2 over ${result.tenantIds.length} tenant pod prefixes (${listed} objects listed)`;
}

async function main(argv) {
  if (argv.includes("--self-test")) {
    console.log(await selfTest());
    return 0;
  }
  const databaseUrl = resolveReportDbUrl(SCRIPT);
  if (!databaseUrl) return 2;
  const args = lib.checkArgs(argv);
  const target = lib.targetOf(databaseUrl);
  console.error(`${SCRIPT}: DB host ${target.host} · database ${target.database}`);
  if (!args.ok) {
    console.error(`${SCRIPT}: ${args.message}`);
    return args.code;
  }
  if (args.targetHost !== target.host) {
    console.error(
      `${SCRIPT}: refusing: --target-host=${args.targetHost} does not match the resolved host ${target.host}`,
    );
    return 65;
  }

  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let storageNote = "skipped (--skip-r2)";
    const result = await lib.buildCounts(client, {
      inTx: async (r) => {
        if (!args.skipStorage) storageNote = await storagePass(client, r);
      },
    });
    const generatedAt = new Date().toISOString();
    const text = lib.formatReport({ tenants: result.tenants, target, storageNote, generatedAt });
    const json = JSON.stringify(
      { generatedAt, target, storageNote, tenants: Object.fromEntries(result.tenants) },
      null,
      2,
    );
    console.log(args.json ? json : text);
    const dir = join(REPO_ROOT, "local-assets", "reports");
    mkdirSync(dir, { recursive: true });
    const stamp = generatedAt.replace(/[:.]/g, "-");
    writeFileSync(join(dir, `${SCRIPT}-${stamp}.txt`), text + "\n");
    writeFileSync(join(dir, `${SCRIPT}-${stamp}.json`), json + "\n");
    console.error(`${SCRIPT}: written to local-assets/reports/${SCRIPT}-${stamp}.{txt,json}`);
    return 0;
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`${SCRIPT}: ${e.message}`);
    process.exitCode = 1;
  });
