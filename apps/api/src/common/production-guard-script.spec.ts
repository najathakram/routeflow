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
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const api = resolve(__dirname, "../..");
const BYPASS = "postgresql://u:p@localhost:5432/x?host=host.invalid";
const REFUSED = /not provably local/;
// apps/api/.env WINS over DATABASE_URL in the two scripts that read it; with one present the
// injected bypass is not what they dial, so there the case can only require a safe exit.
const DOTENV_PRESENT = existsSync(resolve(api, ".env"));

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
  ])("%s (apps/api/.env, else DATABASE_URL)", (_name, cmd) => {
    const { code, out } = run(cmd, { DATABASE_URL: BYPASS });
    expect(code).toBe(1);
    if (!DOTENV_PRESENT) expect(out).toMatch(REFUSED);
  });

  it("clear-financial-data.js (HTTP API, no database) still refuses inside Railway", () => {
    const { code, out } = run(node("clear-financial-data.js"), {
      RAILWAY_ENVIRONMENT: "production",
    });
    expect(code).toBe(1);
    expect(out).toMatch(/inside Railway/);
  });
});
