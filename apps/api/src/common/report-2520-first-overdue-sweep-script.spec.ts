import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { overdueCutoff } from "./calendar-date";

/**
 * #2556: the owner-run, READ-ONLY count of what the first overdue sweep would flip
 * (apps/api/scripts/report-2520-first-overdue-sweep.mjs). Its cutoff and summary are checked by
 * its own `--self-test` (no database); the argument gates refuse before any connection; and its
 * hand-written mirror of `overdueCutoff` is pinned to the real helper here (#2567), so the two
 * cannot drift.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-2520-first-overdue-sweep.mjs");

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

describe("report-2520-first-overdue-sweep.mjs (#2556)", () => {
  it("its cutoffFor mirror agrees with common/calendar-date overdueCutoff (#2567)", () => {
    // DST eves/days on both hemispheres, a half-hour DST zone, both date-line extremes, and the
    // null / empty / invalid-zone fallbacks, each at instants either side of the local midnight.
    const days = [
      "2026-03-07",
      "2026-03-08",
      "2026-03-28",
      "2026-03-29",
      "2026-04-05",
      "2026-10-04",
      "2026-10-25",
      "2026-10-31",
      "2026-11-01",
      "2026-12-31",
    ];
    const times = [
      "00:00:00.000",
      "00:30:00.000",
      "05:59:59.999",
      "06:00:00.000",
      "11:59:59.999",
      "12:00:00.000",
      "14:00:00.000",
      "23:59:59.999",
    ];
    const zones: Array<string | null> = [
      "UTC",
      "America/Chicago",
      "America/New_York",
      "Europe/London",
      "Australia/Sydney",
      "Australia/Lord_Howe",
      "Asia/Tokyo",
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
      null,
      "",
      "Mars/Olympus_Mons",
    ];
    const cases = days.flatMap((d) =>
      times.flatMap((t) => zones.map((z) => ({ at: `${d}T${t}Z`, z }))),
    );
    // #2665: this used to pass the whole check script (with the 960-case array embedded) as a
    // `-e` argument. That serializes to ~51 KB, which blows past Windows' CreateProcess command-
    // line limit (ENAMETOOLONG) — spawnSync then never launches the child at all, so `child.stdout`/
    // `child.stderr` come back `undefined` instead of a real (possibly non-empty) stderr. Writing
    // the same script to a temp file and spawning `node <file>` sidesteps the argv-length limit
    // entirely (only the short file path is on the command line) and behaves identically on every
    // platform. The temp dir is scoped to just this test and always cleaned up.
    const dir = mkdtempSync(path.join(os.tmpdir(), "rf-2520-"));
    const scriptFile = path.join(dir, "check.mjs");
    try {
      writeFileSync(
        scriptFile,
        `import { cutoffFor } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
         const cases = ${JSON.stringify(cases)};
         console.log(JSON.stringify(cases.map((c) => cutoffFor(new Date(c.at), c.z).toISOString())));`,
        "utf8",
      );
      const child = spawnSync(process.execPath, [scriptFile], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toEqual(
        cases.map((c) => overdueCutoff(new Date(c.at), c.z).toISOString()),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it.each([
    [["--apply"], /unexpected argument --apply/],
    [["--tenant"], /--tenant needs a tenant id/],
    [["stray"], /unexpected argument stray/],
  ])("%j is refused (exit 2) before any connection", (args, message) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(message);
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/);
  });

  it("issues SELECTs only, inside a read-only session", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("SET default_transaction_read_only = on");
    expect(src).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\s+("|[A-Z])/);
  });
});
