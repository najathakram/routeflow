import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #2183 / B592: the DB lane (jest.db.config.js) is serial, and a worker-count override can't make
// it parallel. A CLI `--maxWorkers` beats a config value, so this pins both enforcement points:
//   1. the runner `npm run test:db` uses (scripts/run-db-tests.mjs) drops `--maxWorkers`, `-w`,
//      `--runInBand` and `-i` (jest refuses those beside the `--maxWorkers=1` it injects), warns,
//      and passes everything else through;
//   2. the lane's globalSetup (test/db-lane-serial.cjs) refuses any run that still resolved to
//      more than one worker, so a direct `jest -c jest.db.config.js --maxWorkers=4` never starts.

const API_DIR = path.resolve(__dirname, "../..");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbConfig = require(path.join(API_DIR, "jest.db.config.js"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require(path.join(API_DIR, "package.json"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const guard = require(path.join(API_DIR, "test/db-lane-serial.cjs"));

describe("#2183 DB lane is serial whatever the caller asks for", () => {
  it("the config is serial and wires the guard; test:db goes through the runner", () => {
    expect(dbConfig.maxWorkers).toBe(1);
    expect(path.resolve(API_DIR, "src", dbConfig.globalSetup.replace("<rootDir>/", ""))).toBe(
      path.join(API_DIR, "test/db-lane-serial.cjs"),
    );
    expect(pkg.scripts["test:db"]).toBe("node scripts/run-db-tests.mjs");
  });

  it("the guard refuses a parallel run and allows a serial one", async () => {
    expect(() => guard.assertSerialDbLane({ maxWorkers: 4 })).toThrow(/must run serially/);
    expect(() => guard.assertSerialDbLane({ maxWorkers: 2 })).toThrow(/maxWorkers=2/);
    expect(() => guard.assertSerialDbLane({ maxWorkers: 1 })).not.toThrow();
    await expect(guard({ maxWorkers: 4 })).rejects.toThrow(/must run serially/);
    await expect(guard({ maxWorkers: 1 })).resolves.toBeUndefined();
  });

  it("the runner drops every worker override form and keeps the rest", () => {
    const probe = `
      const m = await import(${JSON.stringify(pathToFileURL(path.join(API_DIR, "scripts/run-db-tests.mjs")).href)});
      const cases = [
        ["--maxWorkers=4"], ["--maxWorkers", "4"], ["-w", "2"], ["-w4"], ["-w=3"],
        ["--runInBand"], ["-i"], ["--runInBand", "--maxWorkers=2", "-t", "x"],
        ["--maxWorkers=4", "src/orders/order-number.db.spec.ts"], ["-t", "B562", "--ci"],
      ];
      console.log(JSON.stringify(cases.map((c) => m.serialDbArgs(c))));`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(JSON.parse(res.stdout)).toEqual([
      { kept: [], dropped: ["--maxWorkers=4"] },
      { kept: [], dropped: ["--maxWorkers 4"] },
      { kept: [], dropped: ["-w 2"] },
      { kept: [], dropped: ["-w4"] },
      { kept: [], dropped: ["-w=3"] },
      { kept: [], dropped: ["--runInBand"] },
      { kept: [], dropped: ["-i"] },
      { kept: ["-t", "x"], dropped: ["--runInBand", "--maxWorkers=2"] },
      { kept: ["src/orders/order-number.db.spec.ts"], dropped: ["--maxWorkers=4"] },
      { kept: ["-t", "B562", "--ci"], dropped: [] },
    ]);
  });
});

// W-699: a DB-lane run that never exits (an open handle after "Tests:") would hold the machine's
// heavy slot for every other lane, so the runner kills jest after a hard timeout and exits 124.
describe("W-699 the DB lane runner has a hard timeout", () => {
  it("the runner has a hard timeout: 60 min by default, RF_DB_LANE_TIMEOUT_MIN overrides, junk refused", () => {
    const probe = `
      const m = await import(${JSON.stringify(pathToFileURL(path.join(API_DIR, "scripts/run-db-tests.mjs")).href)});
      const out = [{}, { RF_DB_LANE_TIMEOUT_MIN: "5" }, { RF_DB_LANE_TIMEOUT_MIN: "0" },
        { RF_DB_LANE_TIMEOUT_MIN: "-3" }, { RF_DB_LANE_TIMEOUT_MIN: "abc" }].map((env) => {
        try { return m.dbLaneTimeoutMs(env); } catch (e) { return "throws"; }
      });
      console.log(JSON.stringify(out));`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(JSON.parse(res.stdout)).toEqual([3_600_000, 300_000, "throws", "throws", "throws"]);
  });
});

// W-720: every DB spec ends the advisory-lock pools (and PrismaService ends its own pool on
// $disconnect), so jest exits right after "Tests:" instead of ~10 s later.
describe("W-720 the DB lane closes the advisory-lock pools after every spec", () => {
  const CLOSE = path.join(API_DIR, "test/db-lane-close-pools.cjs");

  it("jest itself resolves the hook into the lane's setup (a misspelt key would only warn)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jestBin = require.resolve("jest/bin/jest", { paths: [API_DIR] });
    const res = spawnSync(process.execPath, [jestBin, "-c", "jest.db.config.js", "--showConfig"], {
      cwd: API_DIR,
      encoding: "utf8",
    });
    expect(res.stderr).not.toMatch(/Unknown option/);
    const resolved: string[] = JSON.parse(res.stdout).configs[0].setupFilesAfterEnv;
    expect(resolved.map((f) => path.resolve(f))).toContain(CLOSE);
  });

  it("the hook ends the db-locks pools in an afterAll", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const text: string = require("node:fs").readFileSync(CLOSE, "utf8");
    expect(text).toMatch(/require\("\.\.\/src\/common\/db-locks"\)/);
    expect(text).toMatch(/afterAll\(\s*(async\s*)?\(\)\s*=>[\s\S]*_resetLockPoolForTests\(\)/);
  });
});
