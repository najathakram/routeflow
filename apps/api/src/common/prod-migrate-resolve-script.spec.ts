import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// W-1275 / SA-1194 K2 — apps/api/scripts/prod-migrate-resolve.mjs contract.
//
// The script marks exactly ONE failed migration as rolled back and does nothing else. These cases
// drive the real script via spawnSync with a stub `npx` on PATH: no database is touched and no real
// prisma runs. The stub logs its argv and prints Prisma's own `migrate status` wording for a failed
// migration (observed in node_modules/prisma/build/cli.js: "Following migration have failed:" /
// "Following migrations have failed:", printed with console.error, exit 1).

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/prod-migrate-resolve.mjs");

const FAILED = "20261010090000_billing_dunning_coupon";
const OTHER = "20261010090100_return_refund_tender";

const PROXY_ENV = {
  POSTGRES_USER: "u",
  POSTGRES_PASSWORD: "p w",
  POSTGRES_DB: "d",
  RAILWAY_TCP_PROXY_DOMAIN: "127.0.0.1",
  RAILWAY_TCP_PROXY_PORT: "1",
};

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_") || key.startsWith("FAKE_")) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function prependToPath(env: NodeJS.ProcessEnv, dir: string): void {
  const key = Object.keys(env).find((k) => /^path$/i.test(k)) ?? "PATH";
  env[key] = `${dir}${path.delimiter}${env[key] ?? ""}`;
}

describe("prod-migrate-resolve.mjs contract (W-1275)", () => {
  let dir: string;
  let log: string;
  let state: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-migrate-resolve-"));
    const fake = path.join(dir, "fake-npx.mjs");
    fs.writeFileSync(
      fake,
      String.raw`import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + "\n");
const cmd = argv.join(" ");
const mode = process.env.FAKE_STATUS || "clean";
const resolved = fs.existsSync(process.env.FAKE_STATE);
const names = mode.includes(":") ? mode.split(":")[1].split(",") : [];
if (cmd.includes("resolve")) {
  if (process.env.FAKE_RESOLVE_FAIL) {
    console.error("Error: P1001 resolve failed");
    process.exit(1);
  }
  if (!process.env.FAKE_RESOLVE_NOOP) fs.writeFileSync(process.env.FAKE_STATE, "resolved");
  console.log("Migration marked as rolled back.");
  process.exit(0);
}
if (cmd.includes("db execute")) {
  fs.writeFileSync(process.env.FAKE_LOG + ".sql", fs.readFileSync(0, "utf8"));
  if (mode === "qerror") {
    console.error("Error: P1001: Can not reach database server");
    process.exit(1);
  }
  if (resolved || names.length === 0) {
    console.log("Script executed successfully.");
    process.exit(0);
  }
  // Real prisma 7.10.1 db execute output on a throwaway Postgres.
  console.error("Loaded Prisma config from prisma.config.ts.\n\nError: ERROR: rf-failed-migrations:" + names.join(","));
  process.exit(1);
}
console.log("url: " + process.env.DATABASE_URL);
if (resolved || mode === "clean" || mode === "qerror") {
  console.log("Database schema is up to date!");
  process.exit(0);
}
if (mode.startsWith("behind:")) {
  // Real prisma 7.10.1 output captured on a throwaway Postgres with a failed migration AND a later pending
  // one: the failed block is NOT printed, only the pending list (stdout, exit 1).
  console.log("118 migrations found in prisma/migrations\nFollowing migration have not yet been applied:\n29990101000100_p84_later\n\nTo apply migrations in development run prisma migrate dev.\nTo apply migrations in production run prisma migrate deploy.");
  process.exit(1);
}
console.error("Following migration" + (names.length > 1 ? "s" : "") + " have failed:\n" + names.join("\n") + "\n\nDuring development if the failed migration(s) have not been deployed to a production database you can then fix the migration(s) and run npx prisma migrate dev.\n");
console.error("The failed migration(s) can be marked as rolled back or applied:\n\n- If you rolled back the migration(s) manually:\nnpx prisma migrate resolve --rolled-back \"" + names[0] + "\"");
process.exit(1);
`,
    );
    // POSIX `npx` and Windows `npx.cmd`; both hand argv to the same node stub.
    fs.writeFileSync(path.join(dir, "npx"), `#!/bin/sh\nexec node "${fake}" "$@"\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(dir, "npx.cmd"), `@node "${fake}" %*\r\n`);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    log = path.join(dir, `calls-${Math.random().toString(36).slice(2)}.log`);
    state = path.join(dir, `state-${Math.random().toString(36).slice(2)}`);
  });

  function run(args: string[], extra: Record<string, string> = {}, withProxy = true) {
    const env = scrubbedEnv({
      ...(withProxy ? PROXY_ENV : {}),
      FAKE_LOG: log,
      FAKE_STATE: state,
      ...extra,
    });
    prependToPath(env, dir);
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: API_DIR,
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
  }

  function calls(): string[][] {
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  }

  const resolveCalls = () => calls().filter((c) => c.includes("resolve"));

  it("refuses when a Railway proxy var is missing, even with DATABASE_URL set", () => {
    const { POSTGRES_DB: _omit, ...partial } = PROXY_ENV;
    const res = run(
      [FAILED],
      {
        ...partial,
        DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nope",
        FAKE_STATUS: `failed:${FAILED}`,
      },
      false,
    );

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain("POSTGRES_DB");
    expect(calls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it("refuses a folder that does not exist under prisma/migrations", () => {
    const res = run(["20990101000000_nope"], { FAKE_STATUS: `failed:${FAILED}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain("not under prisma/migrations");
    expect(resolveCalls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it.each(["../x", "20261010090000_a;rm", "20261010090000_BILLING", "billing"])(
    "refuses the malformed folder %s before any prisma call",
    (folder) => {
      const res = run([folder], { FAKE_STATUS: `failed:${FAILED}` });

      expect(res.stderr).not.toContain("Cannot find module");
      expect(res.stderr).toContain("folder");
      expect(calls()).toHaveLength(0);
      expect(res.status).toBe(1);
    },
  );

  it("refuses an existing folder that is not the failed one, naming the failed one", () => {
    const res = run([OTHER], { FAKE_STATUS: `failed:${FAILED}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain(FAILED);
    expect(resolveCalls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it("refuses when status reports no failed migration", () => {
    const res = run([FAILED], { FAKE_STATUS: "clean" });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain("no failed migration");
    expect(resolveCalls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it("refuses when more than one migration has failed", () => {
    const res = run([FAILED], { FAKE_STATUS: `failed:${FAILED},${OTHER}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain(OTHER);
    expect(resolveCalls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it("refuses --applied before any prisma call", () => {
    const res = run([FAILED, "--applied"], { FAKE_STATUS: `failed:${FAILED}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain("--applied");
    expect(calls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it("refuses two folder arguments", () => {
    const res = run([FAILED, OTHER], { FAKE_STATUS: `failed:${FAILED}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(calls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it("marks the one failed folder rolled back: status, resolve --rolled-back, status, check", () => {
    const res = run([FAILED], { FAKE_STATUS: `failed:${FAILED}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(calls()).toEqual([
      ["prisma", "migrate", "status"],
      ["prisma", "migrate", "resolve", "--rolled-back", FAILED],
      ["prisma", "migrate", "status"],
      ["prisma", "db", "execute", "--stdin"],
    ]);
    expect(res.status).toBe(0);
  });

  // N1 (R-63): real prisma, when the DB has a failed migration AND later pending ones, prints only the
  // pending list and never the failed block. The script falls back to a read-only _prisma_migrations read.
  it("finds the failed folder when status prints only the pending list (failed + behind)", () => {
    const res = run([FAILED], { FAKE_STATUS: `behind:${FAILED}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).not.toContain("no failed migration");
    expect(calls()).toEqual([
      ["prisma", "migrate", "status"],
      ["prisma", "db", "execute", "--stdin"],
      ["prisma", "migrate", "resolve", "--rolled-back", FAILED],
      ["prisma", "migrate", "status"],
      ["prisma", "db", "execute", "--stdin"],
    ]);
    const sql = fs.readFileSync(log + ".sql", "utf8");
    expect(sql).toContain("_prisma_migrations");
    expect(sql).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
    expect(res.status).toBe(0);
  });

  it("refuses a folder that is not the failed one when status is failed + behind", () => {
    const res = run([OTHER], { FAKE_STATUS: `behind:${FAILED}` });

    expect(res.stderr).toContain(FAILED);
    expect(resolveCalls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  it("refuses when the failed list cannot be read at all", () => {
    const res = run([FAILED], { FAKE_STATUS: "qerror" });

    expect(res.stderr).toContain("could not read");
    expect(resolveCalls()).toHaveLength(0);
    expect(res.status).toBe(1);
  });

  // N2 (R-63)
  it("prints the after status and exits non-zero when resolve itself fails", () => {
    const res = run([FAILED], { FAKE_STATUS: `failed:${FAILED}`, FAKE_RESOLVE_FAIL: "1" });

    expect(res.stdout).toContain("(after)");
    expect(calls().filter((c) => c.includes("status"))).toHaveLength(2);
    expect(res.stderr).toContain("resolve failed");
    expect(res.status).toBe(1);
  });

  // N3 (R-63)
  it("exits non-zero when the folder is still reported failed after resolve", () => {
    const res = run([FAILED], { FAKE_STATUS: `failed:${FAILED}`, FAKE_RESOLVE_NOOP: "1" });

    expect(res.stderr).toContain("still reported as failed");
    expect(res.stdout).not.toContain("marked rolled back");
    expect(res.status).toBe(1);
  });

  it("accepts the explicit --rolled-back flag as the same operation", () => {
    const res = run(["--rolled-back", FAILED], { FAKE_STATUS: `failed:${FAILED}` });

    expect(res.stderr).not.toContain("Cannot find module");
    expect(resolveCalls()).toEqual([["prisma", "migrate", "resolve", "--rolled-back", FAILED]]);
    expect(res.status).toBe(0);
  });

  it("never prints the raw URL, even when the stubbed status echoes DATABASE_URL", () => {
    const res = run([FAILED], { FAKE_STATUS: `failed:${FAILED}` });
    const combined = res.stdout + res.stderr;

    expect(res.stderr).not.toContain("Cannot find module");
    expect(combined).toContain("Target host:");
    expect(combined).toContain("***");
    expect(combined).toContain("127.0.0.1:1");
    expect(combined).not.toContain("p w");
    expect(combined).not.toContain("p%20w");
    expect(res.status).toBe(0);
  });
});
