import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * C-1b (SA-1123): the null-tenant split SQL builders behind the read-only prod audit are pure, so their
 * self-test (no DB) runs on every verify. Spawned with no database URL in the environment: the self-test
 * must never need one.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/lib/null-tenant-split.self-test.mjs");

describe("null-tenant-split self-test", () => {
  it("passes its pure-function checks without a database", () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/DATABASE_URL|PG[A-Z]*$/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });
});
