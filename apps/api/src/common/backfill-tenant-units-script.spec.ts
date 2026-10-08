import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Units U-6: the pre-connection gates of apps/api/scripts/backfill-tenant-units.mjs. Spawns the real
 * script with NO database variables at all; each case must be refused as an argument decision.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/backfill-tenant-units.mjs");

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "DATABASE_URL" || k.startsWith("RAILWAY_") || k.startsWith("POSTGRES_"))
      delete env[k];
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...env, ...extra },
    encoding: "utf8",
  });
}

describe("backfill-tenant-units.mjs gates (U-6)", () => {
  it("requires --tenant", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--tenant");
  });

  it("refuses --apply on a non-test slug before touching any database", () => {
    const r = run(["--tenant", "acme-wholesale", "--apply"], {
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Test-tenant policy violation");
  });

  it("refuses a missing DATABASE_URL", () => {
    const r = run(["--tenant", "qa-x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not provably local");
  });

  it("refuses a non-local DATABASE_URL, even for a test slug and a ?host= redirect", () => {
    for (const url of [
      "postgresql://u:p@db.example.com:5432/db",
      "postgresql://u:p@localhost:5432/db?host=db.example.com",
      "postgresql://u:p@x.railway.internal:5432/db",
    ]) {
      const r = run(["--tenant", "qa-x", "--apply"], { DATABASE_URL: url });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not provably local");
    }
  });
});
