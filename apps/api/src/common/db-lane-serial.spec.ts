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
