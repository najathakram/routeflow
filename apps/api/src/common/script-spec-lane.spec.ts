import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #2192: the spawn-heavy `*-script.spec.ts` files run in their own serial jest lane
// (jest.scripts.config.js), after the parallel unit pool, via scripts/run-unit-tests.mjs.
// This spec pins the three things that lane depends on:
//   1. every spec file runs in exactly one lane (never both, never none);
//   2. the runner keeps a caller's filters for both lanes but the worker count for the pool only;
//   3. the campaign reporter merges the serial lane into the pool's artifact only for the SAME
//      run, and otherwise marks its own artifact partial (never a falsely fresh full report).

const API_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_DIR, "../..");
const SRC_DIR = path.join(API_DIR, "src");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const baseJest = require(path.join(API_DIR, "package.json")).jest;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scriptsJest = require(path.join(API_DIR, "jest.scripts.config.js"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const repoTruthJest = require(path.join(API_DIR, "jest.repo-truth.config.js"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CampaignReporter = require(path.join(REPO_ROOT, "scripts/jest-campaign-reporter.cjs"));

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...specFiles(p));
    else if (e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

const runs = (cfg: { testRegex: string; testPathIgnorePatterns: string[] }, file: string) =>
  new RegExp(cfg.testRegex).test(file) &&
  !cfg.testPathIgnorePatterns.some((p) => new RegExp(p).test(file));

describe("#2192 script-spec lane", () => {
  const files = specFiles(SRC_DIR).filter((f) => !/\.(db|smtp)\.spec\.ts$/.test(f));
  const scriptSpecs = files.filter((f) => f.endsWith("-script.spec.ts"));

  it("the fixture set is real: there are script specs to route", () => {
    expect(scriptSpecs.length).toBeGreaterThanOrEqual(10);
  });

  it("every script spec runs in exactly one lane, never the parallel pool", () => {
    for (const f of scriptSpecs) {
      const lanes = [
        runs(baseJest, f) && "pool",
        runs(scriptsJest, f) && "scripts",
        runs(repoTruthJest, f) && "repo-truth",
      ].filter(Boolean);
      expect({ file: path.basename(f), lanes }).toEqual({
        file: path.basename(f),
        lanes: [f.endsWith("bugs-self-test-script.spec.ts") ? "repo-truth" : "scripts"],
      });
    }
  });

  it("the script lane takes nothing but script specs, one file at a time", () => {
    for (const f of files.filter((x) => !x.endsWith("-script.spec.ts"))) {
      expect({ file: path.basename(f), scripts: runs(scriptsJest, f) }).toEqual({
        file: path.basename(f),
        scripts: false,
      });
    }
    expect(scriptsJest.maxWorkers).toBe(1);
  });

  it("the runner keeps filters for both lanes and the worker count for the pool only", () => {
    const probe = `
      const m = await import(${JSON.stringify(pathToFileURL(path.join(API_DIR, "scripts/run-unit-tests.mjs")).href)});
      const cases = [
        ["--maxWorkers=4"], ["--maxWorkers", "4"], ["-w", "2"], ["-w4"], ["--runInBand"], ["-i"],
        ["--maxWorkers=4", "janitor"], ["-t", "REG-B418", "--ci"], ["--ci"],
      ];
      console.log(JSON.stringify(cases.map((c) => {
        const lane = m.scriptLaneArgs(c);
        return { lane, filtered: m.isFiltered(lane) };
      })));`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(JSON.parse(res.stdout)).toEqual([
      { lane: [], filtered: false },
      { lane: [], filtered: false },
      { lane: [], filtered: false },
      { lane: [], filtered: false },
      { lane: [], filtered: false },
      { lane: [], filtered: false },
      { lane: ["janitor"], filtered: true },
      { lane: ["-t", "REG-B418", "--ci"], filtered: true },
      { lane: ["--ci"], filtered: false },
    ]);
  });

  describe("campaign artifact merge", () => {
    let root: string;
    const prevRunId = process.env.RF_CAMPAIGN_RUN_ID;
    const suite = (name: string, status = "passed") => ({
      testFilePath: `/x/${name}.spec.ts`,
      testResults: [{ fullName: `${name} works`, title: "works", status }],
    });
    const results = (...names: string[]) => ({
      numTotalTests: names.length,
      numPassedTests: names.length,
      numFailedTests: 0,
      testResults: names.map((n) => suite(n)),
    });
    const report = (merge: boolean, res: ReturnType<typeof results>) =>
      new CampaignReporter({}, { artifact: "api", merge, root }).onRunComplete([], res);
    const artifact = () =>
      JSON.parse(fs.readFileSync(path.join(root, ".campaign/runs/api.json"), "utf8"));

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "script-lane-"));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
      if (prevRunId === undefined) delete process.env.RF_CAMPAIGN_RUN_ID;
      else process.env.RF_CAMPAIGN_RUN_ID = prevRunId;
    });

    it("the same run: the script lane's suites are appended to the pool's, counts summed", () => {
      process.env.RF_CAMPAIGN_RUN_ID = "run-1";
      report(false, results("pool-a", "pool-b"));
      report(true, results("janitor-script"));
      const a = artifact();
      expect(a.runId).toBe("run-1");
      expect(a.partial).toBe(false);
      expect(a.numTotalTests).toBe(3);
      expect(a.numPassedTests).toBe(3);
      expect(a.testResults.map((s: { name: string }) => path.basename(s.name))).toEqual([
        "pool-a.spec.ts",
        "pool-b.spec.ts",
        "janitor-script.spec.ts",
      ]);
    });

    it("a different run's artifact is never refreshed: the lane's own results, marked partial", () => {
      process.env.RF_CAMPAIGN_RUN_ID = "run-1";
      report(false, results("pool-a"));
      process.env.RF_CAMPAIGN_RUN_ID = "run-2";
      report(true, results("janitor-script"));
      const a = artifact();
      expect(a.partial).toBe(true);
      expect(a.numTotalTests).toBe(1);
      expect(a.testResults.map((s: { name: string }) => path.basename(s.name))).toEqual([
        "janitor-script.spec.ts",
      ]);
    });

    it("a standalone script lane (no run id, no artifact) is partial", () => {
      delete process.env.RF_CAMPAIGN_RUN_ID;
      report(true, results("janitor-script"));
      expect(artifact().partial).toBe(true);
    });

    it("the pool alone (no merge) still writes a full, unpartial artifact", () => {
      delete process.env.RF_CAMPAIGN_RUN_ID;
      report(false, results("pool-a"));
      const a = artifact();
      expect(a.partial).toBe(false);
      expect(a.runId).toBeUndefined();
    });
  });
});
