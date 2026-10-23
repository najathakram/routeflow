import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// W-723 (#3638 follow-ups): the DB-lane runner's hard timeout (scripts/run-db-tests.mjs).
//   1. On a timeout it kills the WHOLE process tree. spawnSync's `timeout` kills only the direct
//      child (jest), so a CLI a spec spawned (a script under test, a prisma CLI) outlived it and
//      kept its DB connection and the heavy slot.
//   2. A junk RF_DB_LANE_TIMEOUT_MIN is one readable line and exit 2, never a stack trace.
//   (CI's 25 min RF_DB_LANE_TIMEOUT_MIN on the DB-backed specs step ships separately: a workflow edit.)

const API_DIR = path.resolve(__dirname, "../..");
const RUNNER = path.join(API_DIR, "scripts/run-db-tests.mjs");

describe("W-723 the DB-lane hard timeout", () => {
  it("a timeout kills the child's own children too (no orphaned CLI keeps the DB or the slot)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w723-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const child = path.join(dir, "child.cjs");
    // The child starts a grandchild that never exits, records its pid, then hangs itself.
    fs.writeFileSync(
      child,
      `const { spawn } = require("node:child_process");
       const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
       setInterval(() => {}, 1000);`,
    );
    const probe = `
      const m = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});
      const r = await m.runWithHardTimeout(process.execPath, [${JSON.stringify(child)}], { timeoutMs: 3000 });
      console.log(JSON.stringify(r));`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 60_000,
    });
    try {
      expect(res.stderr).toBe("");
      expect(JSON.parse(res.stdout)).toMatchObject({ timedOut: true });
      const gpid = Number(fs.readFileSync(pidFile, "utf8"));
      let alive = true;
      try {
        process.kill(gpid, 0);
      } catch {
        alive = false;
      }
      if (alive) process.kill(gpid, "SIGKILL"); // never leave it behind, even when red
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["abc", "0", "-3", "1.5"])(
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
        /^run-db-tests: RF_DB_LANE_TIMEOUT_MIN must be a positive whole number/,
      );
    },
  );
});
