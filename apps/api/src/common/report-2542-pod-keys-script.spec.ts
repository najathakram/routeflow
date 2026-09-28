import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPodStorageKey } from "../routes/pod-artifacts.util";

/**
 * #2548 (SA-502): the owner-run, READ-ONLY census of stored POD values failing #2547's strict key
 * shape (apps/api/scripts/report-2542-pod-keys.mjs). Its classifier and summary are checked by its
 * own `--self-test`; the argument gates refuse before any connection; its hand-written mirror of
 * `isPodStorageKey` is pinned to the real one here, so the two cannot drift.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-2542-pod-keys.mjs");

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env))
    if (
      k === "DATABASE_URL" ||
      k.startsWith("RAILWAY_") ||
      k.startsWith("POSTGRES_") ||
      k.startsWith("PG")
    )
      delete env[k];
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const T = "t1";
const CASES = [
  `tenants/${T}/pod/stop-1/photo-abcd1234.jpg`,
  `tenants/${T}/pod/stop-1/signature-sig00001.jpg`,
  `tenants/${T}/pod/../../t2/pod/stop-9/photo-abcd1234.jpg`,
  `tenants/${T}/pod/stop-1/../../../t2/logo.png`,
  `tenants/${T}/pod/./stop-1/photo-abcd1234.jpg`,
  `tenants/${T}/pod//stop-1/photo-abcd1234.jpg`,
  `tenants/${T}/pod/stop-1/..%2F..%2Fx.png`,
  `tenants\\${T}\\pod\\stop-1\\photo.jpg`,
  `tenants/${T}/pod/stop-1/photo.jpg/extra`,
  `tenants/${T}/pod/stop-1/.hidden`,
  `tenants/t2/pod/stop-9/photo-abcd1234.jpg`,
  "products/p1/x.jpg",
  "",
];

describe("report-2542-pod-keys.mjs (#2548, SA-502)", () => {
  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it("its isPodStorageKey mirror agrees with the real one on every case", () => {
    const href = pathToFileURL(SCRIPT).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { isPodStorageKey } from ${JSON.stringify(href)};
         console.log(JSON.stringify(${JSON.stringify(CASES)}.map((v) => isPodStorageKey(v, ${JSON.stringify(T)}))));`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual(CASES.map((v) => isPodStorageKey(v, T)));
  });

  // #2585 (b): a pre-#2582 relink is a canonical OWN-tenant key naming another stop. It passes the
  // shape and tenant checks (so it still signs), and the census now counts it separately.
  it("counts an own-tenant key for another stop as SAME_TENANT_OTHER_STOP (#2585)", () => {
    const href = pathToFileURL(SCRIPT).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { failingValues, summarize } from ${JSON.stringify(href)};
         const own = { stopId: "stop-1", tenantId: "t1",
           signatureUrl: "tenants/t1/pod/stop-1/signature-sig00001.jpg",
           podPhotoUrls: ["tenants/t1/pod/stop-2/photo-abcd1234.jpg"] };
         const f = failingValues(own);
         const s = summarize(f.map((x) => ({ tenantId: "t1", stopId: own.stopId, kind: x.kind })));
         console.log(JSON.stringify({ f, otherStop: s.otherStop, row: s.detail[0] }));`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(child.stderr).toBe("");
    const out = JSON.parse(child.stdout);
    expect(out.f).toEqual([{ field: "podPhotoUrls", kind: "SAME_TENANT_OTHER_STOP" }]);
    expect(out.otherStop).toBe(1);
    expect(out.row.SAME_TENANT_OTHER_STOP).toBe(1);
    expect(JSON.stringify(out.row)).not.toMatch(/tenants\/|"t1"|stop-1/);
  });

  it.each([
    [["--apply"], /unexpected argument --apply/],
    [["--tenant"], /--tenant needs a tenant id/],
    [["stray"], /unexpected argument stray/],
  ])("%j is refused (exit 2) before any connection", (args, message) => {
    const r = run(args as string[]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(message as RegExp);
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/);
  });

  it("issues SELECTs only, in a read-only session, and prints the redacted target", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("SET default_transaction_read_only = on");
    expect(src).toContain("resolveReportDbUrl(NAME)");
    expect(src).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\s+("|[A-Z])/);
  });
});
