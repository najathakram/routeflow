import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// W-723 (#3638 follow-ups): the DB-lane runner's hard timeout (scripts/run-db-tests.mjs).
//   1. On a timeout it kills the WHOLE process tree. spawnSync's `timeout` kills only the direct
//      child (jest), so a CLI a spec spawned (a script under test, a prisma CLI) outlived it and
//      kept its DB connection and the heavy slot. This case only DISCRIMINATES on POSIX: on Windows
//      Node's job object already ends a killed child's own children, so it is green there either way.
//   2. A SIGHUP to the runner (a closed terminal or ssh) reaches jest's group too (POSIX only: jest
//      runs detached in its own session there, so the hangup would otherwise miss it).
//   3. A junk or too-large RF_DB_LANE_TIMEOUT_MIN is one readable line and exit 2, never a stack
//      trace and never a setTimeout overflow that fires at once.
//   (CI's 25 min RF_DB_LANE_TIMEOUT_MIN on the DB-backed specs step ships separately: a workflow edit.)

const API_DIR = path.resolve(__dirname, "../..");
const RUNNER = path.join(API_DIR, "scripts/run-db-tests.mjs");
const posixOnly = process.platform === "win32" ? it.skip : it;

/** Polls for `file` (a child writes it after it starts); never a single racy read under load. */
async function waitForFile(file: string, ms = 20_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text) return text;
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventuallyDead(pid: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

/** A child that starts a grandchild which never exits, records both pids, then hangs itself. */
function writeHangingChild(dir: string): { child: string; pidFile: string } {
  const pidFile = path.join(dir, "pids.json");
  const child = path.join(dir, "child.cjs");
  fs.writeFileSync(
    child,
    `const { spawn } = require("node:child_process");
     const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
     require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: g.pid }));
     setInterval(() => {}, 1000);`,
  );
  return { child, pidFile };
}

describe("W-723 the DB-lane hard timeout", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "w723-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a timeout kills the child's own children too (no orphaned CLI keeps the DB or the slot)", async () => {
    const { child, pidFile } = writeHangingChild(dir);
    const probe = `
      const m = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});
      const r = await m.runWithHardTimeout(process.execPath, [${JSON.stringify(child)}], { timeoutMs: 3000 });
      console.log(JSON.stringify(r));`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const { grandchild } = JSON.parse(await waitForFile(pidFile));
    const dead = await eventuallyDead(grandchild, 2_000);
    if (!dead) process.kill(grandchild, "SIGKILL"); // never leave it behind, even when red
    expect(res.stderr).toBe("");
    expect(JSON.parse(res.stdout)).toMatchObject({ timedOut: true });
    expect(dead).toBe(true);
  }, 60_000);

  posixOnly(
    "a SIGHUP to the runner (closed terminal / ssh) ends jest's whole group, not just the runner",
    async () => {
      const { child, pidFile } = writeHangingChild(dir);
      const wrapper = path.join(dir, "wrapper.mjs");
      fs.writeFileSync(
        wrapper,
        `const m = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});
         await m.runWithHardTimeout(process.execPath, [${JSON.stringify(child)}], { timeoutMs: 600000 });`,
      );
      const runner = spawn(process.execPath, [wrapper], { stdio: "ignore" });
      const pids = JSON.parse(await waitForFile(pidFile));
      runner.kill("SIGHUP");
      await new Promise((r) => runner.once("exit", r));
      const childDead = await eventuallyDead(pids.child);
      const grandchildDead = await eventuallyDead(pids.grandchild);
      for (const p of [pids.child, pids.grandchild]) if (alive(p)) process.kill(p, "SIGKILL");
      expect({ childDead, grandchildDead }).toEqual({ childDead: true, grandchildDead: true });
    },
    60_000,
  );

  it.each(["abc", "0", "-3", "1.5", "40000", "35792"])(
    "RF_DB_LANE_TIMEOUT_MIN=%s is one line on stderr and exit 2 (no stack trace, jest never starts)",
    (raw) => {
      const res = spawnSync(process.execPath, [RUNNER], {
        cwd: API_DIR,
        encoding: "utf8",
        env: { ...process.env, RF_DB_LANE_TIMEOUT_MIN: raw },
        timeout: 60_000,
      });
      expect(res.status).toBe(2);
      const lines = res.stderr.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^run-db-tests: RF_DB_LANE_TIMEOUT_MIN must be a positive whole number of minutes up to 35791/,
      );
    },
  );

  it("35791 min (the largest setTimeout can hold) is accepted", () => {
    const probe = `
      const m = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});
      console.log(JSON.stringify([m.MAX_DB_LANE_TIMEOUT_MIN, m.dbLaneTimeoutMs({ RF_DB_LANE_TIMEOUT_MIN: "35791" })]));`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    const [max, ms] = JSON.parse(res.stdout);
    expect(max).toBe(35791);
    expect(ms).toBe(35791 * 60_000);
    expect(ms).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});
