import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * #3726 (SA-939): the read-only netting census restates both nettings in plain JS, so its `--self-test` (no DB)
 * runs on every verify. Spawned with no database URL in the environment: the self-test must never need one.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-b297-netting-census.mjs");

describe("report-b297-netting-census --self-test", () => {
  it("passes its pure-function checks without a database", () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/DATABASE_URL|PG[A-Z]*$/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, [SCRIPT, "--self-test"], { env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });
});
