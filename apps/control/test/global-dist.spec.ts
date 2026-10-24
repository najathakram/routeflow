/**
 * Jest's globalSetup compiles the server ONCE per run (test/global-setup.ts) and every worker
 * inherits `CONTROL_TEST_DIST`. This spec proves the hand-off in whichever mode it runs (default
 * workers, --runInBand, or this one file alone): the env is set, the build is real, and the helpers
 * the heavy specs use return it instead of compiling their own.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GLOBAL_DIST_PREFIX, buildPrivateDist, sharedDist } from "./helpers/build-dist";
import { distCtl } from "./helpers/spawn-cli";

const CONTROL = path.join(__dirname, "..");
const SAVED = process.env.CONTROL_TEST_DIST;
afterEach(() => {
  if (SAVED === undefined) delete process.env.CONTROL_TEST_DIST;
  else process.env.CONTROL_TEST_DIST = SAVED;
});

describe("the once-per-run build from globalSetup", () => {
  it("is published to every worker as CONTROL_TEST_DIST, inside apps/control", () => {
    const dir = process.env.CONTROL_TEST_DIST;
    expect(dir).toBeDefined();
    expect(path.dirname(dir as string)).toBe(CONTROL);
    expect(path.basename(dir as string)).toMatch(new RegExp(`^${GLOBAL_DIST_PREFIX}\\d+$`));
  });

  it("holds a real build: the server entry, the CLI, and the page assets", () => {
    const dir = process.env.CONTROL_TEST_DIST as string;
    expect(fs.existsSync(path.join(dir, "main.js"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "cli", "ctl.js"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "render", "assets"))).toBe(true);
    // it runs: the CLI prints usage without touching any state
    const r = spawnSync(process.execPath, ["-e", "require(process.env.D).main(['--help'])"], {
      env: { PATH: process.env.PATH ?? "", D: path.join(dir, "cli", "ctl.js") },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBeLessThanOrEqual(2);
    expect(r.stdout + r.stderr).toMatch(/ctl/i);
  });

  it("buildPrivateDist returns that build, compiles nothing, and its cleanup() leaves it", () => {
    const dir = process.env.CONTROL_TEST_DIST as string;
    const d = buildPrivateDist("x");
    expect(d.dir).toBe(dir);
    expect(d.main).toBe(path.join(dir, "main.js"));
    d.cleanup();
    expect(fs.existsSync(d.main)).toBe(true);
    expect(fs.readdirSync(CONTROL).filter((n) => n === `.dist-x-${process.pid}`)).toEqual([]);
  });

  it("only a dir that holds a main.js counts as shared (a stale env value is ignored)", () => {
    process.env.CONTROL_TEST_DIST = path.join(os.tmpdir(), "no-such-control-dist");
    expect(sharedDist()).toBeNull();
    delete process.env.CONTROL_TEST_DIST;
    expect(sharedDist()).toBeNull();
  });

  it("a stub shared dir is returned as given (no compile)", () => {
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "stub-dist-"));
    try {
      fs.writeFileSync(path.join(stub, "main.js"), "");
      process.env.CONTROL_TEST_DIST = stub;
      const d = buildPrivateDist("y");
      expect(d.dir).toBe(stub);
      d.cleanup();
      expect(fs.existsSync(path.join(stub, "main.js"))).toBe(true);
    } finally {
      fs.rmSync(stub, { recursive: true, force: true });
    }
  });

  it("spawn-cli runs the same build (the CLI spec helper never compiles dist/)", () => {
    const dir = process.env.CONTROL_TEST_DIST as string;
    expect(distCtl()).toBe(path.join(dir, "cli", "ctl.js"));
    delete process.env.CONTROL_TEST_DIST;
    expect(distCtl()).toBe(path.join(CONTROL, "dist", "cli", "ctl.js")); // outside the setup
  });
});
