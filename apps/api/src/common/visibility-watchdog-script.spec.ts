import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// scripts/visibility-watchdog.mjs contract — the safety net for the killed-session
// incident of 2026-09-04, where a public repo window outlived the session that opened
// it by ~6.5 hours because the private flip lived only in that session's own control
// flow. This script must flip the repo private on a fixed deadline REGARDLESS of what
// happens to whatever session launched it.
//
// A fake `gh` driver (mode selected by FAKE_MODE) stands in for the real `gh repo edit`
// / `gh repo view` invocations via VISIBILITY_WATCHDOG_GH_CMD, so every case here runs
// with no network access and never touches the real repo's visibility.
// VISIBILITY_WATCHDOG_LOG_FILE points the log at a scratch file instead of the real
// `local-assets/visibility-watchdog.log`, and VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS
// collapses the real 10s read-back poll to near-zero so the never-verifies case runs in
// well under a second instead of ~40s.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/visibility-watchdog.mjs");

let dir: string;
let fakeGh: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "visibility-watchdog-"));
  fakeGh = path.join(dir, "fake-gh.mjs");
  fs.writeFileSync(
    fakeGh,
    [
      "const mode = process.env.FAKE_MODE || 'success';",
      "const args = process.argv.slice(2);",
      "",
      "if (args[0] === 'repo' && args[1] === 'edit') {",
      "  if (mode === 'edit-fail') {",
      "    process.stderr.write('HTTP 403: Forbidden\\n');",
      "    process.exit(1);",
      "  }",
      "  process.exit(0);",
      "} else if (args[0] === 'repo' && args[1] === 'view') {",
      "  const visibility = mode === 'public-forever' ? 'PUBLIC' : 'PRIVATE';",
      "  process.stdout.write(JSON.stringify({ visibility }));",
      "  process.exit(0);",
      "} else {",
      "  process.stderr.write(`fake-gh: unrecognized args ${args.join(' ')}\\n`);",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

function fakeEnv(
  mode: string,
  logFile: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VISIBILITY_WATCHDOG_GH_CMD: JSON.stringify([process.execPath, fakeGh]),
    VISIBILITY_WATCHDOG_LOG_FILE: logFile,
    VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS: "5",
    FAKE_MODE: mode,
    ...extra,
  };
}

function newLogPath(name: string): string {
  return path.join(dir, `${name}.log`);
}

function readLog(logFile: string): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
}

describe("visibility-watchdog.mjs contract", () => {
  it("success: edit succeeds, view confirms PRIVATE — exit 0 with start/flip/verified logged", () => {
    const logFile = newLogPath("success");
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));

    expect(res.status).toBe(0);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    expect(log).toContain(" flip ");
    expect(log).toContain(" verified ");
    expect(log).not.toContain(" error ");
    // one line per event, well-formed ISO timestamps leading each line
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (start|flip|verified) /);
    }
  });

  it("never verifies: view keeps reporting PUBLIC — exit 1 with error logged", () => {
    const logFile = newLogPath("public-forever");
    const res = run(
      ["--minutes", "0.01", "--repo", "acme/test"],
      fakeEnv("public-forever", logFile),
    );

    expect(res.status).toBe(1);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    expect(log).toContain(" flip ");
    expect(log).toContain(" error ");
    expect(log).not.toContain(" verified ");
  });

  it("edit itself fails: exit 1 with error logged, no flip/verified", () => {
    const logFile = newLogPath("edit-fail");
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("edit-fail", logFile));

    expect(res.status).toBe(1);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    expect(log).toContain(" error ");
    expect(log).not.toContain(" flip ");
    expect(log).not.toContain(" verified ");
  });

  it("prints the same lines to stdout that it appends to the log", () => {
    const logFile = newLogPath("stdout-mirror");
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));

    const log = readLog(logFile);
    for (const line of log.trim().split("\n")) {
      expect(res.stdout).toContain(line);
    }
  });

  it("defaults --minutes to 45 and --repo to najathakram/routeflow when omitted", () => {
    const logFile = newLogPath("defaults");
    // Real sleep isn't exercised here (45 real minutes) — the process is left running
    // briefly, then killed once the "start" line proves the defaults were applied.
    const child = require("node:child_process").spawn(process.execPath, [SCRIPT], {
      env: fakeEnv("success", logFile),
    });
    return new Promise<void>((resolve, reject) => {
      // Poll for the start line rather than assuming a fixed boot time: a loaded machine
      // needs well over half a second to spawn node and flush the first log write, and a
      // fixed sleep made this the only flaky suite in the api gate.
      const deadline = Date.now() + 10_000;
      const poll = setInterval(() => {
        const log = readLog(logFile);
        const done = log.includes("minutes=45 repo=najathakram/routeflow");
        if (!done && Date.now() < deadline) return;
        clearInterval(poll);
        child.kill();
        try {
          expect(log).toContain("minutes=45 repo=najathakram/routeflow");
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 50);
      child.on("error", (err: Error) => {
        clearInterval(poll);
        reject(err);
      });
    });
  }, 20_000);
});
