/**
 * #2206 end to end: every script that calls `productionGuard` must judge the URL it will ACTUALLY
 * dial and refuse a local-looking bypass before any database work. Runs in the serial script lane
 * (jest.scripts.config.js).
 *
 * Safety by construction, so a regression can never wipe anything:
 *   - the bypass URL's real target is `host.invalid` (RFC 6761), never a real Railway host;
 *   - the destructive confirmation flag is NEVER passed, so even a guard that wrongly lets the URL
 *     through stops at "CONFIRMATION REQUIRED" and exits before its first query. That is also what
 *     makes these cases red on the old substring guard: it printed the confirmation box, not the
 *     "not provably local" refusal asserted here.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const api = resolve(__dirname, "../..");
const BYPASS = "postgresql://u:p@localhost:5432/x?host=host.invalid";
const REFUSED = /not provably local/;
// apps/api/.env WINS over DATABASE_URL in the two scripts that read it, so those cases point
// ROUTEFLOW_API_DOTENV at a fixture .env holding the bypass: the assertion no longer depends on
// whether this machine has a real apps/api/.env (#2419 review nit).
const dotenvDir = mkdtempSync(join(tmpdir(), "prod-guard-dotenv-"));
const BYPASS_DOTENV = join(dotenvDir, ".env");
writeFileSync(BYPASS_DOTENV, `DATABASE_URL="${BYPASS}"\n`);

function run(cmd: string[], env: Record<string, string>) {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: api,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...env,
    },
  });
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const node = (file: string, ...args: string[]) => ["node", `scripts/${file}`, ...args];

describe("#2206 guarded scripts refuse a ?host= bypass before dialling", () => {
  it.each([
    ["nuke-tenant-data.js", node("nuke-tenant-data.js")],
    ["nuke-db.js", node("nuke-db.js")],
  ])("%s (DATABASE_URL)", (_name, cmd) => {
    const { code, out } = run(cmd, { DATABASE_URL: BYPASS });
    expect(code).toBe(1);
    expect(out).toMatch(REFUSED);
  });

  it("nuke-db.js judges DATABASE_PUBLIC_URL, the URL it prefers, not only DATABASE_URL", () => {
    const { code, out } = run(node("nuke-db.js"), {
      DATABASE_PUBLIC_URL: BYPASS,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/routeflow_dev",
    });
    expect(code).toBe(1);
    expect(out).toMatch(REFUSED);
  });

  it("reset-and-seed.ts judges DATABASE_URL (the URL PrismaClient reads)", () => {
    const { code, out } = run(
      [process.execPath, "-r", "ts-node/register/transpile-only", "scripts/reset-and-seed.ts"],
      { DATABASE_URL: BYPASS },
    );
    expect(code).toBe(1);
    expect(out).toMatch(REFUSED);
  });

  it("reset-and-seed.ts refuses an unset DATABASE_URL (fail closed)", () => {
    const { code, out } = run(
      [process.execPath, "-r", "ts-node/register/transpile-only", "scripts/reset-and-seed.ts"],
      {},
    );
    expect(code).toBe(1);
    expect(out).toMatch(REFUSED);
  });

  it.each([
    ["DANGER-fresh-data-WIPES-ALL-DATA.js", node("DANGER-fresh-data-WIPES-ALL-DATA.js")],
    ["cleanup-qa-data.js --all", node("cleanup-qa-data.js", "--all")],
    ["cleanup-qa-data.js (targeted mode, no --all)", node("cleanup-qa-data.js")],
  ])("%s judges the apps/api/.env URL it reads first", (_name, cmd) => {
    const { code, out } = run(cmd, {
      ROUTEFLOW_API_DOTENV: BYPASS_DOTENV,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/routeflow_dev",
    });
    expect(code).toBe(1);
    expect(out).toMatch(REFUSED);
  });

  it.each([
    ["merge-duplicate-products.js (dry run)", node("merge-duplicate-products.js")],
    ["merge-pending-orders.js (dry run)", node("merge-pending-orders.js")],
    ["seed-marketing-screenshot-products.js", node("seed-marketing-screenshot-products.js")],
  ])("%s refuses a non-local DATABASE_URL before dialling (#2421)", (_name, cmd) => {
    const { code, out } = run(cmd, { DATABASE_URL: BYPASS });
    expect(code).toBe(1);
    expect(out).toMatch(REFUSED);
  });

  it("clear-financial-data.js refuses a non-local API host before any request (#2421)", () => {
    const { code, out } = run(node("clear-financial-data.js"), {
      ROUTEFLOW_URL: "https://routeflowapi-production.up.railway.app/api/v1",
    });
    expect(code).toBe(1);
    expect(out).toMatch(/API host .* is not provably local/);
    expect(out).not.toMatch(/Logging in/);
  });

  it("clear-financial-data.js (HTTP API, no database) still refuses inside Railway", () => {
    const { code, out } = run(node("clear-financial-data.js"), {
      RAILWAY_ENVIRONMENT: "production",
    });
    expect(code).toBe(1);
    expect(out).toMatch(/inside Railway/);
  });
});
