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

  it("the source has no INSERT / UPDATE / DELETE statement and always ends the transaction read-only", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
    );
    expect(src).toContain("withReadOnlyTx");
    expect(src).toContain("guardTarget");
  });
});
