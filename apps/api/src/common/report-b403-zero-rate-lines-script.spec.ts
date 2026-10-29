import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** B403 census: no database. The report is READ ONLY: it refuses every write flag, names its target before it connects, and its source has no write verb. */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-b403-zero-rate-lines.mjs");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });

describe("report-b403-zero-rate-lines (read-only)", () => {
  it("its --self-test passes", () => {
    const res = run("--self-test");
    expect(res.stderr).toBe("");
    expect(res.stdout).toMatch(/self-test ok/);
  });

  it.each(["--apply", "--fix", "--repair"])("refuses %s with exit 2", (flag) => {
    const res = run(flag);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/read-only/);
  });

  it("the source has no INSERT / UPDATE / DELETE statement", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
    );
  });

  it("main() itself runs the report inside the read-only wrapper and the target guard (not just selfTest)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const main = src.slice(src.indexOf("async function main()"));
    expect(main).toMatch(/const guard = g\.guardTarget\(/);
    expect(main).toMatch(
      /const report = await g\.withReadOnlyTx\(client, async \(\) => \{[\s\S]*buildReport\(/,
    );
  });

  it("without --target-host it exits 64 BEFORE connecting (a dead local URL is never dialled), and 65 on a mismatch", () => {
    const env = { ...process.env, DATABASE_URL: "postgresql://u:p@127.0.0.1:1/db" };
    for (const k of Object.keys(env))
      if (k.startsWith("RAILWAY_")) delete (env as Record<string, unknown>)[k];
    const no = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 60_000, env });
    expect(no.status).toBe(64);
    expect(no.stderr).toMatch(/--target-host/);
    const bad = spawnSync(process.execPath, [SCRIPT, "--target-host=elsewhere"], {
      encoding: "utf8",
      timeout: 60_000,
      env,
    });
    expect(bad.status).toBe(65);
  });
});
