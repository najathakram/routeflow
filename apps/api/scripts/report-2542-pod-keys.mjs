/**
 * READ-ONLY census for #2548 (SA-502, the follow-up to #2547 / #2542): stored proof-of-delivery
 * values that fail #2547's strict key shape.
 *
 * #2547 made `isPodStorageKey` structural: a POD storage key must be EXACTLY
 * `tenants/<own tenantId>/pod/<stopId>/<name>.<ext>`, each segment from a safe alphabet. Before it,
 * signing checked only a `tenants/<own>/pod/` prefix, and the complete-stop DTO accepted arbitrary
 * strings, so a traversal (`tenants/<own>/pod/../../<other>/…`) could have been stored. The fix
 * never signs such a value; this report tells the owner whether any row ALREADY holds one.
 *
 * WHAT IT SCANS: every RouteRunStop's `signatureUrl` and each `podPhotoUrls` entry. Only
 * storage-key CANDIDATES count: a value with a URI scheme (`data:`, `file:`, `content:`, `ph:`),
 * the legacy `native-captured` sentinel, and empty values are never signed and are skipped.
 * The stop's tenant is its own `tenantId`, or its run's for legacy rows.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-2542-pod-keys.mjs
 *   ... add --json for machine-readable output (adds stop ids), --tenant <tenantId> to scope it.
 *   node apps/api/scripts/report-2542-pod-keys.mjs --self-test   (no database)
 *
 * WHAT IT PRINTS: per tenant (anonymous labels A, B, …), the number of stops and values failing
 * the shape, split by kind:
 *   OTHER_TENANT  names another tenant's pod prefix (a cross-tenant pointer);
 *   TRAVERSAL     contains `..`, a `.` or empty segment, a backslash or percent-encoding;
 *   OTHER_SHAPE   any other schemeless value that is not a canonical own pod key;
 *   SAME_TENANT_OTHER_STOP  (#2585) a canonical OWN-tenant pod key whose stop segment names a
 *                 different stop: a relink stored before #2582's per-stop check. It passes the
 *                 shape and the tenant check, so signing still serves it for the wrong stop.
 * The stored VALUES and tenant slugs are never printed; `--json` adds the affected stop ids.
 * Live and approved-test tenants are reported separately. Any cleanup is a separate,
 * dry-run-first ticket.
 *
 * SAFETY: `default_transaction_read_only = on`, statement and lock timeouts, SELECTs only. It
 * writes nothing and never signs, reads or deletes a stored object.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const NAME = "report-2542-pod-keys";
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$/;

/** Mirrors src/routes/pod-artifacts.util.ts `isPodStorageKey` (#2547). */
export function isPodStorageKey(value, tenantId) {
  if (typeof value !== "string" || typeof tenantId !== "string") return false;
  if (!SAFE_SEGMENT.test(tenantId)) return false;
  const parts = value.split("/");
  return (
    parts.length === 5 &&
    parts[0] === "tenants" &&
    parts[1] === tenantId &&
    parts[2] === "pod" &&
    SAFE_SEGMENT.test(parts[3]) &&
    SAFE_FILE.test(parts[4])
  );
}

/** A value `podCaptureValueRefusal` would treat as a storage key (schemeless, not the sentinel). */
export function isKeyCandidate(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "" || v === "native-captured") return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(v);
}

/** Why a candidate fails the strict shape: OTHER_TENANT | TRAVERSAL | OTHER_SHAPE. */
export function classify(value, tenantId) {
  const v = value.trim();
  if (/\.\.|\\|%|\/\/|(^|\/)\.(\/|$)/.test(v)) return "TRAVERSAL";
  const m = /^tenants\/([^/]+)\/pod\//.exec(v);
  if (m && m[1] !== tenantId) return "OTHER_TENANT";
  return "OTHER_SHAPE";
}

/** Failing values for one stop row: [{ field, kind }] (values themselves never leave). */
export function failingValues(stop) {
  const out = [];
  const check = (field, value) => {
    if (!isKeyCandidate(value)) return;
    const v = value.trim();
    if (!isPodStorageKey(v, stop.tenantId))
      out.push({ field, kind: classify(value, stop.tenantId) });
    // #2585: a well-formed own key for ANOTHER stop (segment 3 is the stop id).
    else if (v.split("/")[3] !== stop.stopId) out.push({ field, kind: "SAME_TENANT_OTHER_STOP" });
  };
  check("signatureUrl", stop.signatureUrl);
  for (const p of stop.podPhotoUrls ?? []) check("podPhotoUrls", p);
  return out;
}

/** Anonymous per-tenant summary; ids and slugs never leave this function (stop ids only on request). */
export function summarize(rows, { withStopIds = false } = {}) {
  const label = new Map();
  const byTenant = new Map();
  for (const r of rows) {
    if (!label.has(r.tenantId))
      label.set(
        r.tenantId,
        `tenant ${String.fromCharCode(65 + (label.size % 26))}${label.size >= 26 ? Math.floor(label.size / 26) : ""}`,
      );
    const t = byTenant.get(r.tenantId) ?? {
      tenant: label.get(r.tenantId),
      stops: new Set(),
      values: 0,
      OTHER_TENANT: 0,
      TRAVERSAL: 0,
      OTHER_SHAPE: 0,
      SAME_TENANT_OTHER_STOP: 0,
    };
    t.stops.add(r.stopId);
    t.values++;
    t[r.kind]++;
    byTenant.set(r.tenantId, t);
  }
  const detail = [...byTenant.values()].map((t) => ({
    tenant: t.tenant,
    stops: t.stops.size,
    values: t.values,
    OTHER_TENANT: t.OTHER_TENANT,
    TRAVERSAL: t.TRAVERSAL,
    OTHER_SHAPE: t.OTHER_SHAPE,
    SAME_TENANT_OTHER_STOP: t.SAME_TENANT_OTHER_STOP,
    ...(withStopIds ? { stopIds: [...t.stops] } : {}),
  }));
  return {
    tenants: detail.length,
    stops: detail.reduce((n, d) => n + d.stops, 0),
    values: detail.reduce((n, d) => n + d.values, 0),
    crossTenant: detail.reduce((n, d) => n + d.OTHER_TENANT, 0),
    otherStop: detail.reduce((n, d) => n + d.SAME_TENANT_OTHER_STOP, 0),
    detail,
  };
}

export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const T = "t1";
  eq(isPodStorageKey(`tenants/${T}/pod/stop-1/photo-abcd1234.jpg`, T), true, "own key");
  eq(isKeyCandidate("data:image/png;base64,AA"), false, "data url");
  eq(isKeyCandidate("file:///x.jpg"), false, "file uri");
  eq(isKeyCandidate("native-captured"), false, "sentinel");
  eq(isKeyCandidate(""), false, "empty");
  eq(classify(`tenants/${T}/pod/../../t2/pod/s/x.jpg`, T), "TRAVERSAL", "dotdot");
  eq(classify(`tenants/${T}/pod/s/..%2Fx.png`, T), "TRAVERSAL", "encoded");
  eq(classify(`tenants\\${T}\\pod\\s\\x.jpg`, T), "TRAVERSAL", "backslash");
  eq(classify(`tenants/${T}/pod//s/x.jpg`, T), "TRAVERSAL", "empty segment");
  eq(classify(`tenants/${T}/pod/./s/x.jpg`, T), "TRAVERSAL", "dot segment");
  eq(classify("tenants/t2/pod/s/x.jpg", T), "OTHER_TENANT", "other tenant");
  eq(classify("products/p1/x.jpg", T), "OTHER_SHAPE", "other shape");
  const relinked = {
    stopId: "stop-1",
    tenantId: T,
    signatureUrl: `tenants/${T}/pod/stop-1/signature-sig00001.jpg`,
    podPhotoUrls: [`tenants/${T}/pod/stop-2/photo-abcd1234.jpg`],
  };
  eq(
    failingValues(relinked),
    [{ field: "podPhotoUrls", kind: "SAME_TENANT_OTHER_STOP" }],
    "own key for another stop",
  );
  eq(
    summarize([{ tenantId: T, stopId: "stop-1", kind: "SAME_TENANT_OTHER_STOP" }]).otherStop,
    1,
    "other-stop total",
  );
  const stop = {
    stopId: "s1",
    tenantId: T,
    signatureUrl: `tenants/${T}/pod/../../t2/pod/s/sig.jpg`,
    podPhotoUrls: [
      `tenants/${T}/pod/s1/photo-abcd1234.jpg`, // its own stop: passes
      "data:image/jpeg;base64,/9j",
      "tenants/t2/pod/s/p.jpg",
    ],
  };
  eq(
    failingValues(stop).map((f) => f.kind),
    ["TRAVERSAL", "OTHER_TENANT"],
    "failing values",
  );
  const s = summarize(
    failingValues(stop).map((f) => ({ tenantId: T, stopId: "s1", kind: f.kind })),
  );
  eq([s.tenants, s.stops, s.values, s.crossTenant], [1, 1, 2, 1], "summary");
  if (
    JSON.stringify(s).includes("tenants/") ||
    JSON.stringify(s).includes('"t1"') ||
    JSON.stringify(s).includes('"s1"')
  )
    throw new Error("summary leaked a value, tenant id or stop id");
  eq(
    summarize([{ tenantId: T, stopId: "s1", kind: "TRAVERSAL" }], { withStopIds: true }).detail[0]
      .stopIds,
    ["s1"],
    "stop ids on request",
  );
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const known = new Set(["--json", "--tenant"]);
  const tenantArg = argv.indexOf("--tenant");
  const onlyTenant = tenantArg >= 0 ? argv[tenantArg + 1] : null;
  for (const [i, a] of argv.entries())
    if (
      (a.startsWith("--") && !known.has(a)) ||
      (!a.startsWith("--") && argv[i - 1] !== "--tenant")
    ) {
      console.error(`${NAME}: unexpected argument ${a}`);
      process.exit(2);
    }
  if (tenantArg >= 0 && !onlyTenant) {
    console.error(`${NAME}: --tenant needs a tenant id`);
    process.exit(2);
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME); // prints the redacted target (B768)
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");

    const { rows: stops } = await client.query(
      `SELECT s.id AS "stopId", COALESCE(s."tenantId", r."tenantId") AS "tenantId", t.slug,
              s."signatureUrl", s."podPhotoUrls"
         FROM "RouteRunStop" s
         JOIN "RouteRun" r ON r.id = s."routeRunId"
         LEFT JOIN "Tenant" t ON t.id = COALESCE(s."tenantId", r."tenantId")
        WHERE (s."signatureUrl" IS NOT NULL OR cardinality(s."podPhotoUrls") > 0)
          AND ($1::text IS NULL OR COALESCE(s."tenantId", r."tenantId") = $1::text)`,
      [onlyTenant],
    );
    const failing = [];
    for (const s of stops)
      for (const f of failingValues(s))
        failing.push({
          tenantId: s.tenantId ?? "(none)",
          slug: s.slug,
          stopId: s.stopId,
          kind: f.kind,
        });

    const report = {
      scanned: { stops: stops.length },
      live: summarize(
        failing.filter((r) => !isTestTenant(r.slug ?? "")),
        { withStopIds: json },
      ),
      test: summarize(
        failing.filter((r) => isTestTenant(r.slug ?? "")),
        { withStopIds: json },
      ),
    };
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`${NAME}: scanned ${report.scanned.stops} stop(s) with POD values`);
    for (const block of ["live", "test"]) {
      const s = report[block];
      console.log(
        `${block}: ${s.values} POD value(s) failing the strict key shape or naming another stop, on ${s.stops} stop(s) across ${s.tenants} tenant(s); ${s.crossTenant} point at ANOTHER tenant, ${s.otherStop} at another stop of the same tenant`,
      );
      for (const d of s.detail)
        console.log(
          `  ${d.tenant}  ${d.stops} stop(s), ${d.values} value(s): other-tenant ${d.OTHER_TENANT}, traversal ${d.TRAVERSAL}, other shape ${d.OTHER_SHAPE}, same-tenant other stop ${d.SAME_TENANT_OTHER_STOP}`,
        );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(self) || basename(entry) === basename(self);
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
