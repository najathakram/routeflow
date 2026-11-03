import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-1091 piece 1 owner-run census (apps/api/scripts/report-sa1091-order-bound-census.mjs): READ ONLY, behind the two-step
 * live-target guard, and the read-only session is proved before any read. Run under jest.scripts.config.js; none of these
 * cases opens a database connection (every refusal happens before one).
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-sa1091-order-bound-census.mjs");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = strip(fs.readFileSync(SCRIPT, "utf8"));
const body = strip(
  fs.readFileSync(path.resolve(API_DIR, "src/returns/order-bound-census.ts"), "utf8"),
);
const FAKE_URL = "postgresql://u:secret@db.example.test:5432/railway";

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.DATABASE_URL;
  delete e.CENSUS_DATABASE_URL;
  for (const k of Object.keys(e)) if (k.startsWith("RAILWAY_")) delete e[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...e, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

describe("report-sa1091-order-bound-census (SA-1091 piece 1)", () => {
  it("--self-test passes without a database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("self-test ok");
  });

  it("a non-loopback target is refused (exit 64) before connecting when --target-host is missing", () => {
    const r = run([], { CENSUS_DATABASE_URL: FAKE_URL });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("db.example.test");
    expect(r.stderr).not.toContain("secret");
  });

  it("a --target-host that is not the resolved host is refused (exit 65)", () => {
    const r = run(["--target-host=other.test"], { CENSUS_DATABASE_URL: FAKE_URL });
    expect(r.status).toBe(65);
  });

  it("a write-looking flag is refused (the report has no write mode)", () => {
    const r = run(["--apply"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no write mode");
  });

  it("proves the session read-only, then every read transaction read-only, and rolls each one back", () => {
    expect(code).toContain("default_transaction_read_only=on");
    expect(code).toContain("SHOW transaction_read_only");
    expect(code).toContain("await proveSession(pool)");
    expect(code).toContain("throw ROLLBACK");
    // the census is handed the per-read wrapper, never a client or one long transaction of its own
    expect(code).toContain("censusOrderBound(makeReader(db)");
    expect(code).not.toContain("censusOrderBound(tx");
    expect(code).not.toContain("censusOrderBound(db");
  });

  it("bounds the production connection: short statements, a short transaction backstop, a time budget, few workers", () => {
    expect(code).toContain("statement_timeout=${STATEMENT_TIMEOUT_MS}");
    expect(code).toMatch(/STATEMENT_TIMEOUT_MS = 30_000/);
    const backstop = Number(
      new RegExp("TX_BACKSTOP_MS = ([0-9_]+)").exec(code)?.[1]?.replace(/_/g, ""),
    );
    expect(backstop).toBeGreaterThan(0);
    expect(backstop).toBeLessThanOrEqual(90_000); // the failed run held one transaction for 120 s
    expect(code).toContain("timeout: TX_BACKSTOP_MS");
    expect(code).toContain("deadline: started + args.maxMinutes * 60_000");
    expect(code).toContain("max: args.workers + 1");
  });

  it("sends nothing from a connect handler: a query fired there overlaps the first one Prisma sends", () => {
    // the first production run warned "client.query() called while the client is already executing a query"
    expect(code).not.toContain('.on("connect"');
    expect(code).not.toContain(".on('connect'");
  });

  it("refuses a worker count or a budget out of range (exit 2) before connecting", () => {
    for (const bad of [
      "--workers=9",
      "--workers=0",
      "--max-minutes=0",
      "--max-minutes=999",
      "--max-minutes=ten",
    ]) {
      const r = run([bad], { CENSUS_DATABASE_URL: FAKE_URL });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("must be a whole number");
    }
  });

  it("holds no write: no INSERT/UPDATE/DELETE/DDL, no $executeRaw, no create/update/delete call", () => {
    for (const text of [code, body]) {
      expect(text).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
      );
      expect(text).not.toMatch(/\$executeRaw/);
      expect(text).not.toMatch(
        /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
      );
    }
  });

  it("the only raw statement is the read-only proof; the census module issues none", () => {
    const raws = [...code.matchAll(/\$queryRawUnsafe\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(raws.length).toBeGreaterThan(0);
    for (const arg of raws) expect(arg).toBe("SHOW_READ_ONLY");
    expect(body).not.toMatch(/\$queryRaw/);
  });

  it("reads the order-wide bound through the headroom module's batch read, never a copy of its sum", () => {
    expect(body).toContain("loadOrderRefundRooms(tx, batch)");
    expect(body).not.toContain("loadOrderRefundRoom(");
    expect(body).toContain("refundableLineShare(");
    // counts and buckets only: nothing the census returns is an id, a name or an amount
    expect(body).not.toMatch(/sample|ids\b.*:\s*string\[\]/);
  });
});
