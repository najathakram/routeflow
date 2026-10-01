import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #2187 / SA-387 — apps/api/scripts/report-b2187-subscription-period-census.mjs contract.
// Read-only, counts only: fails closed without a DB url, carries no write SQL, buckets period
// lengths exactly as specified, and never lets a tenant id or slug reach its output.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b2187-subscription-period-census.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");

function codeLines(): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    );
}

function node(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

/** Runs `expr` against the script's exports and returns its JSON-parsed result. */
function evalExports(expr: string) {
  const r = node(
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; console.log(JSON.stringify(${expr}));`,
    ],
    process.env,
  );
  expect(r.status).toBe(0);
  return { stdout: r.stdout, value: JSON.parse(r.stdout) };
}

describe("report-b2187-subscription-period-census.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    expect(node([SCRIPT], env).status).toBe(2);
  });

  it("sets the session read-only, caps statements and locks, and carries no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    expect(source).toContain("SET statement_timeout");
    expect(source).toContain("SET lock_timeout");
    const sql = codeLines().join("\n");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/);
  });

  // A dead entry check exits 0 with no output, which reads as "nothing found". Spawn the REAL
  // file — and the same file through a symlink in a directory whose name has a space — and
  // require the self-test's own output, so that can never pass silently again.
  it("--self-test runs when spawned by its real path", () => {
    const direct = node([SCRIPT, "--self-test"], process.env);
    expect(direct.status).toBe(0);
    expect(direct.stdout.trim()).toBe("self-test ok");
  });

  // Windows without symlink rights throws EPERM (the #2221 trap) — skip there, loudly, rather
  // than turn every PC pre-push red; the real-path case above still runs everywhere.
  it("--self-test runs through a symlink in a directory whose name has a space", () => {
    if (process.platform === "win32") {
      console.warn("skipped: symlink entry case needs symlink rights; not asserted on win32");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census entry "));
    const link = path.join(dir, "report-b2187-subscription-period-census.mjs");
    try {
      try {
        fs.symlinkSync(SCRIPT, link);
      } catch (e: any) {
        if (e?.code === "EPERM" || e?.code === "EACCES") {
          console.warn(`skipped: cannot create a symlink here (${e.code})`);
          return;
        }
        throw e;
      }
      const viaLink = node([link, "--self-test"], process.env);
      expect(viaLink.status).toBe(0);
      expect(viaLink.stdout.trim()).toBe("self-test ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buckets period lengths at the specified inclusive edges; a negative period is invalid", () => {
    const days = [1, 35, 35.5, 45, 46, 75, 76, 135, 136, 225, 226, 400, -0.5];
    const { value } = evalExports(`${JSON.stringify(days)}.map(m.bucketOf)`);
    expect(value).toEqual([
      "<=35",
      "<=35",
      "36-45",
      "36-45",
      "46-75",
      "46-75",
      "76-135",
      "76-135",
      "136-225",
      "136-225",
      ">225",
      ">225",
      "invalid",
    ]);
  });

  it("summarize: status × bucket × cycle, cancelAtPeriodEnd apart, anonymous labels only", () => {
    const rows = [
      {
        tenantId: "33333333-cccc",
        slug: "initech",
        status: "ACTIVE",
        cycle: "MONTHLY",
        days: 30,
        cancelAtPeriodEnd: false,
      },
      {
        tenantId: "11111111-aaaa",
        slug: "acme",
        status: "TRIAL",
        cycle: "MONTHLY",
        days: 90,
        cancelAtPeriodEnd: true,
      },
      {
        tenantId: "22222222-bbbb",
        slug: "globex",
        status: "READ_ONLY",
        cycle: "MONTHLY",
        days: 180,
        cancelAtPeriodEnd: false,
      },
      {
        tenantId: "44444444-dddd",
        slug: "umbrella",
        status: "ACTIVE",
        cycle: "ANNUAL",
        days: -2,
        cancelAtPeriodEnd: false,
      },
    ];
    const { stdout, value } = evalExports(`m.summarize(${JSON.stringify(rows)})`);
    expect(stdout).not.toMatch(/1111|2222|3333|4444|acme|globex|initech|umbrella/);
    expect(value.rows).toBe(4);
    expect(value.counts.ACTIVE["<=35"]).toEqual({ MONTHLY: 1 });
    expect(value.counts.ACTIVE.invalid).toEqual({ ANNUAL: 1 });
    expect(value.counts.TRIAL["76-135"]).toEqual({ MONTHLY: 1 });
    expect(value.counts["READ_ONLY"]["136-225"]).toEqual({ MONTHLY: 1 });
    expect(value.cancelAtPeriodEnd.TRIAL["76-135"]).toEqual({ MONTHLY: 1 });
    expect(value.cancelAtPeriodEnd.ACTIVE["<=35"]).toEqual({});
    expect(value.outside).toEqual([
      { tenant: "tenant A", status: "TRIAL", bucket: "76-135", cycle: "MONTHLY" },
      { tenant: "tenant B", status: "READ_ONLY", bucket: "136-225", cycle: "MONTHLY" },
      { tenant: "tenant C", status: "ACTIVE", bucket: "invalid", cycle: "ANNUAL" },
    ]);
  });
});
