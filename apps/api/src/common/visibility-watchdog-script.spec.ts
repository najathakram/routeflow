import { spawn, spawnSync } from "node:child_process";
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
// with no network access and never touches the real repo's visibility. The driver
// persists a small { visibility, editCalls } state object to FAKE_STATE_FILE across its
// own process invocations (each `gh` call is a fresh child), so it can model a flip that
// only actually lands after N failed attempts.
// VISIBILITY_WATCHDOG_LOG_FILE and VISIBILITY_WATCHDOG_MARKER_FILE point the log and the
// FAILED marker at scratch files instead of the real `local-assets/` paths, and
// VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS collapses the real 5s..120s backoff between flip
// attempts to a few milliseconds so specs don't sleep for real minutes.
//
// All four overrides are gated on JEST_WORKER_ID inside the script (the SCHEMA_DRIFT_PRISMA_CLI
// pattern). These specs run INSIDE a jest worker and spawn the script with `...process.env`, so
// the child inherits JEST_WORKER_ID and the overrides are honoured — that inheritance is what
// makes this whole suite possible, and it is asserted directly below.

const API_ROOT = path.resolve(__dirname, "../..");

/** The four test-only overrides, all gated on JEST_WORKER_ID inside the script. */
const OVERRIDE_NAMES = [
  "VISIBILITY_WATCHDOG_GH_CMD",
  "VISIBILITY_WATCHDOG_LOG_FILE",
  "VISIBILITY_WATCHDOG_MARKER_FILE",
  "VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS",
] as const;
const SCRIPT = path.resolve(__dirname, "../../../../scripts/visibility-watchdog.mjs");

let dir: string;
let fakeGh: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "visibility-watchdog-"));
  fakeGh = path.join(dir, "fake-gh.mjs");
  fs.writeFileSync(
    fakeGh,
    [
      "import fs from 'node:fs';",
      "const mode = process.env.FAKE_MODE || 'success';",
      "const stateFile = process.env.FAKE_STATE_FILE;",
      "const failAttempts = Number(process.env.FAKE_FAIL_ATTEMPTS || '0');",
      "const args = process.argv.slice(2);",
      "",
      "function readState() {",
      "  try {",
      "    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));",
      "  } catch {",
      "    return { visibility: 'PUBLIC', editCalls: 0 };",
      "  }",
      "}",
      "function writeState(state) {",
      "  fs.writeFileSync(stateFile, JSON.stringify(state));",
      "}",
      "",
      "if (args[0] === 'repo' && args[1] === 'edit') {",
      "  const state = readState();",
      "  state.editCalls += 1;",
      "  if (mode === 'edit-fail') {",
      "    writeState(state);",
      "    process.stderr.write('HTTP 403: Forbidden\\n');",
      "    process.exit(1);",
      "  }",
      "  if (mode === 'public-forever') {",
      "    // gh reports success but the visibility never actually lands PRIVATE.",
      "    writeState(state);",
      "    process.exit(0);",
      "  }",
      "  if (mode === 'retry-then-success') {",
      "    if (state.editCalls <= failAttempts) {",
      "      writeState(state);",
      "      process.stderr.write(`HTTP 500: Internal Server Error (attempt ${state.editCalls})\\n`);",
      "      process.exit(1);",
      "    }",
      "    state.visibility = 'PRIVATE';",
      "    writeState(state);",
      "    process.exit(0);",
      "  }",
      "  // 'success' (default)",
      "  state.visibility = 'PRIVATE';",
      "  writeState(state);",
      "  process.exit(0);",
      "} else if (args[0] === 'repo' && args[1] === 'view') {",
      "  const state = readState();",
      "  process.stdout.write(JSON.stringify({ visibility: state.visibility }));",
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
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 60_000 });
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
    VISIBILITY_WATCHDOG_MARKER_FILE: markerPathFor(logFile),
    VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS: "[5,5,5,5,5,5]",
    FAKE_MODE: mode,
    FAKE_STATE_FILE: logFile.replace(/\.log$/, ".state.json"),
    FAKE_FAIL_ATTEMPTS: "0",
    ...extra,
  };
}

function newLogPath(name: string): string {
  return path.join(dir, `${name}.log`);
}

function markerPathFor(logFile: string): string {
  return logFile.replace(/\.log$/, ".FAILED");
}

function readLog(logFile: string): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
}

// Forward-slash path required for NODE_OPTIONS=--require on Windows — a Git-Bash POSIX-style
// path (/c/Users/...) fails the child's preload with MODULE_NOT_FOUND.
const SLOW_BOOT_PATH = path.resolve(__dirname, "testing/slow-boot.cjs").replace(/\\/g, "/");

// Poll/cap/kill design. Spawns the child, then polls `readLog(logFile)` every `intervalMs`
// until it contains the exact " start " tag `log()` writes, resolving `{ child, log }`. If
// `capMs` elapses first, rejects with a message naming the cap and the log's last 300 chars —
// never a fixed wait, so the test proves the script's own behavior rather than how fast the
// host booted Node. stdout/stderr are drained into buffers so nothing can block on a full
// pipe, and if the child exits before the start line appears (a spawn that fails fast, e.g. a
// bad NODE_OPTIONS preload or a syntax error in the script) the helper rejects immediately with
// the exit code and the captured stderr tail instead of waiting out the full cap — unless the
// final log read on exit shows the start line already landed, in which case it still resolves.
// The child is always killed in `finally` (resolve, cap-reject, and the child's "error" event
// all funnel through it), and its exit is awaited (up to 2s) before returning.
async function awaitStartLine({
  argv = [SCRIPT],
  env,
  logFile,
  capMs = 30_000,
  intervalMs = 50,
  onSpawn,
}: {
  argv?: string[];
  env: NodeJS.ProcessEnv;
  logFile: string;
  capMs?: number;
  intervalMs?: number;
  // Test-only hook so a caller can capture the child handle even on the reject path (the
  // resolve-only `{ child, log }` return value is unreachable there) — used by the T3
  // cap-rejection pin to confirm the child is dead afterward.
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
}): Promise<{ child: ReturnType<typeof spawn>; log: string }> {
  const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  onSpawn?.(child);
  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });
  const start = Date.now();
  let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      const poll = () => {
        if (settled) return;
        const log = readLog(logFile);
        if (log.includes(" start ")) {
          settled = true;
          resolve({ child, log });
          return;
        }
        if (Date.now() - start >= capMs) {
          settled = true;
          reject(
            new Error(
              `start line not seen within ${capMs}ms; stderr=${stderrBuf.slice(-300)}; log=${readLog(logFile).slice(-300)}`,
            ),
          );
          return;
        }
        setTimeout(poll, intervalMs);
      };
      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        const log = readLog(logFile);
        if (log.includes(" start ")) {
          settled = true;
          resolve({ child, log });
          return;
        }
        settled = true;
        reject(
          new Error(
            `child exited before start line (code=${code} signal=${signal}); stderr=${stderrBuf.slice(-300)}; log=${log.slice(-300)}`,
          ),
        );
      });
      poll();
    });
  } finally {
    child.kill();
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
        return;
      }
      const timer = setTimeout(resolveExit, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}

describe("visibility-watchdog.mjs contract", () => {
  it("success: edit succeeds, view confirms PRIVATE on the first attempt — exit 0 with start/attempt/verified logged, stale marker cleared", () => {
    const logFile = newLogPath("success");
    const markerFile = markerPathFor(logFile);
    // A stale marker from a previous failed run must not survive a clean success.
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ time: "stale", repo: "acme/test" }));

    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));

    expect(res.status).toBe(0);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    expect(log).toContain(" attempt ");
    expect(log).toContain("n=1/6");
    expect(log).toContain(" verified ");
    expect(log).not.toContain(" error ");
    // one line per event, well-formed ISO timestamps leading each line
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (start|attempt|verified) /,
      );
    }
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it("retries a failed flip: edit fails twice then succeeds — exit 0, verified on attempt 3 after two real sleeps", () => {
    const logFile = newLogPath("retry-then-success");
    // Five delays for six attempts (the script's real shape since the dead 240s entry was
    // dropped), each 40ms: a 3-attempt success must therefore burn TWO of them. 80ms is the
    // floor the sleeps alone impose — asserting it proves the backoff is actually awaited
    // rather than skipped, without making the test hostage to how fast the host boots Node.
    const startedAt = Date.now();
    const res = run(
      ["--minutes", "0.01", "--repo", "acme/test"],
      fakeEnv("retry-then-success", logFile, {
        FAKE_FAIL_ATTEMPTS: "2",
        VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS: "[40,40,40,40,40]",
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(80);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    expect(log).toContain("n=1/6");
    expect(log).toContain("n=2/6");
    expect(log).toContain("n=3/6");
    expect(log).not.toContain("n=4/6");
    expect(log).toContain(" verified ");
    expect(log).toContain("attempt=3/6");
    expect(log).not.toContain(" error ");
    // the delays actually in force are reported on the start line
    expect(log).toContain("delays=[40,40,40,40,40]");
    // the two failed attempts carry the stub's stderr first line
    expect(log).toMatch(/HTTP 500: Internal Server Error \(attempt 1\)/);
    expect(log).toMatch(/HTTP 500: Internal Server Error \(attempt 2\)/);
  });

  it("an invalid VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS falls back to the five default delays", () => {
    const logFile = newLogPath("bad-delays");
    // `success` verifies on attempt 1, so the default 5s..120s list is reported but never slept.
    const res = run(
      ["--minutes", "0.01", "--repo", "acme/test"],
      fakeEnv("success", logFile, { VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS: "not json at all" }),
    );

    expect(res.status).toBe(0);
    const log = readLog(logFile);
    // Five entries for six attempts — the sixth attempt is never followed by a sleep, so a
    // sixth delay would be unreachable (and would overstate the documented budget).
    expect(log).toContain("delays=[5000,15000,30000,60000,120000]");
  });

  it("the four test-only overrides are gated on JEST_WORKER_ID and announced on stderr", () => {
    const logFile = newLogPath("override-warnings");
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));

    expect(res.status).toBe(0);
    for (const name of OVERRIDE_NAMES) {
      expect(res.stderr).toContain(`WARNING: test override ${name} active`);
      // exactly one line per variable, however many times the getter is called
      expect(res.stderr.split(`WARNING: test override ${name} active`)).toHaveLength(2);
    }
  });

  it("outside a jest worker every override is ignored LOUDLY — gated in code, not in a comment", () => {
    // Deliberately NOT executed with JEST_WORKER_ID unset: without the overrides the script
    // would call the real `gh` over the network and append to the real operational log under
    // `local-assets/`. The guard is pinned at the source level instead — the same technique
    // backfill-legacy-tenant-ids-script.spec.ts uses for its read-only pins.
    const code = fs.readFileSync(SCRIPT, "utf8");

    // one gate, derived from process.env.JEST_WORKER_ID, and every override read through it
    expect(code).toContain("const UNDER_TEST = Boolean(process.env.JEST_WORKER_ID)");
    expect(code).toContain("WARNING: test override ${name} active");
    expect(code).toContain("is ignored outside test (JEST_WORKER_ID unset)");
    for (const name of OVERRIDE_NAMES) {
      expect(code).toContain(`testOverride("${name}")`);
      // never read straight off process.env, which would bypass the gate
      expect(code).not.toContain(`process.env.${name}`);
    }
  });

  it("this suite really does run inside a jest worker, and the child inherits it", () => {
    // The premise every other case rests on: the overrides above are only honoured because
    // JEST_WORKER_ID is set here and `fakeEnv` spreads `process.env` into the child.
    expect(process.env.JEST_WORKER_ID).toBeTruthy();
    expect(fakeEnv("success", newLogPath("inherit")).JEST_WORKER_ID).toBe(
      process.env.JEST_WORKER_ID,
    );
  });

  it("the start line names the main-checkout root the marker and log are written under", async () => {
    const logFile = newLogPath("root-line");
    const { log } = await awaitStartLine({
      env: fakeEnv("success", logFile),
      logFile,
    });
    const gitCommonDir = spawnSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: API_ROOT, encoding: "utf8" },
    );
    expect(log).toMatch(/ root=\S/);
    if (gitCommonDir.status === 0) {
      // The MAIN checkout, even when this spec runs from a linked worktree: the parent of the
      // common git dir, never the worktree's own root.
      const expected = path.dirname(path.resolve(gitCommonDir.stdout.trim()));
      expect(log).toContain(`root=${expected}`);
    }
  }, 35_000);

  it("never verifies: gh edit reports success but visibility stays PUBLIC — exit 1, all 6 attempts logged, FAILED marker written", () => {
    const logFile = newLogPath("public-forever");
    const markerFile = markerPathFor(logFile);
    const res = run(
      ["--minutes", "0.01", "--repo", "acme/test"],
      fakeEnv("public-forever", logFile),
    );

    expect(res.status).toBe(1);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    for (let n = 1; n <= 6; n++) {
      expect(log).toContain(`n=${n}/6`);
    }
    expect(log).toContain(" error ");
    expect(log).not.toContain(" verified ");

    expect(fs.existsSync(markerFile)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    expect(marker.repo).toBe("acme/test");
    expect(typeof marker.time).toBe("string");
    expect(marker.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(typeof marker.error).toBe("string");
    expect(marker.error.length).toBeGreaterThan(0);
  });

  it("edit itself fails every attempt: exit 1, no verified, FAILED marker written with the edit's stderr", () => {
    const logFile = newLogPath("edit-fail");
    const markerFile = markerPathFor(logFile);
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("edit-fail", logFile));

    expect(res.status).toBe(1);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    expect(log).toContain(" error ");
    expect(log).not.toContain(" verified ");
    for (let n = 1; n <= 6; n++) {
      expect(log).toContain(`n=${n}/6`);
    }
    expect(log).toMatch(/HTTP 403: Forbidden/);

    expect(fs.existsSync(markerFile)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    expect(marker.repo).toBe("acme/test");
    expect(marker.error).toMatch(/HTTP 403: Forbidden/);
  });

  it("prints the same lines to stdout that it appends to the log", () => {
    const logFile = newLogPath("stdout-mirror");
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));

    // T4 (pin): guard against a vacuous pass on an empty log — the loop below asserts nothing
    // at all if `log.trim()` is "", so an empty log must fail here first, not silently succeed.
    const log = readLog(logFile);
    expect(log.trim().length).toBeGreaterThan(0);
    for (const line of log.trim().split("\n")) {
      expect(res.stdout).toContain(line);
    }
  });

  // T2 (pin, converted): same defaults assertion as before, now driven through the seam-extracted
  // awaitStartLine helper instead of an inline fixed-delay Promise. Explicit 35_000ms timeout —
  // above both the helper's internal wait and Jest's undeclared 5000ms default for this lane —
  // so the helper's own behavior decides pass/fail, never Jest's timer.
  it("defaults --minutes to 45 and --repo to najathakram/routeflow when omitted", async () => {
    const logFile = newLogPath("defaults");
    // Real sleep isn't exercised here (45 real minutes) — the child is killed by
    // awaitStartLine once the "start" line proves the defaults were applied.
    const { log } = await awaitStartLine({
      env: fakeEnv("success", logFile),
      logFile,
    });
    expect(log).toContain("minutes=45 repo=najathakram/routeflow");
  }, 35_000);

  // T1 — REG-WATCHDOG-SLOWBOOT — applies the defaults even when the child boots slowly
  // (NODE_OPTIONS preload sleeps 1.5s). Deterministic repro for the host-speed race:
  // awaitStartLine's capped poll on the " start " log line still sees the defaults line
  // regardless of how slowly the host boots Node; a fixed-delay read would observe an empty
  // log here.
  it("REG-WATCHDOG-SLOWBOOT applies the defaults even when the child boots slowly (NODE_OPTIONS preload sleeps 1.5s)", async () => {
    const logFile = newLogPath("slow-boot");
    const { log } = await awaitStartLine({
      env: fakeEnv("success", logFile, { NODE_OPTIONS: `--require ${SLOW_BOOT_PATH}` }),
      logFile,
    });
    expect(log).toContain("minutes=45 repo=najathakram/routeflow");
  }, 35_000);

  // T3 (pin): awaitStartLine rejects once capMs elapses with no " start " line and leaves no
  // orphaned child (kills it and awaits exit). The child here never writes the log, so the cap
  // is the only exit path.
  it("awaitStartLine rejects once its cap elapses with no start line, and kills the child", async () => {
    const logFile = newLogPath("never-starts");
    let capturedChild: ReturnType<typeof spawn> | undefined;
    await expect(
      awaitStartLine({
        argv: ["-e", "setInterval(() => {}, 1000)"],
        env: fakeEnv("success", logFile),
        logFile,
        capMs: 300,
        onSpawn: (child) => {
          capturedChild = child;
        },
      }),
    ).rejects.toThrow(/start line not seen within 300 ?ms/);

    // The rejection path must still leave the child dead — poll briefly since kill() is
    // asynchronous (SIGTERM delivery isn't instantaneous).
    const deadline = Date.now() + 2_000;
    while (
      capturedChild &&
      capturedChild.exitCode === null &&
      capturedChild.signalCode === null &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedChild).toBeDefined();
    expect(capturedChild!.exitCode !== null || capturedChild!.signalCode !== null).toBe(true);
  }, 35_000);

  // T5 (pin): awaitStartLine rejects promptly — well before the cap — with the exit code and
  // captured stderr when the child dies before ever writing the start line, instead of burning
  // the full cap on a silent, diagnosis-free empty log.
  it("awaitStartLine rejects promptly with the exit code and stderr when the child dies before the start line", async () => {
    const logFile = newLogPath("dies-before-start");
    let capturedChild: ReturnType<typeof spawn> | undefined;
    const startedAt = Date.now();
    await expect(
      awaitStartLine({
        argv: ["-e", "process.stderr.write('boom-diag'); process.exit(3)"],
        env: fakeEnv("success", logFile),
        logFile,
        capMs: 10_000,
        onSpawn: (child) => {
          capturedChild = child;
        },
      }),
    ).rejects.toThrow(/code=3.*boom-diag/s);

    // 15 s: host-load flakes on 2026-09-05/06 refused two pushes; the property under test is
    // "rejects rather than hangs", not the exact latency.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(capturedChild).toBeDefined();
    expect(capturedChild!.exitCode).not.toBeNull();
  }, 35_000);
});

// #2076 — argument validation and the single-instance lock. A stray `--help` probe once started a
// REAL 45-minute watchdog (the old parser ignored flags it did not know) that flipped the repo
// private mid-window. Every case here uses a fake `gh` and scratch log/lock paths; the "no side
// effect" cases use a recording `gh` so a call is provable, not assumed.
describe("visibility-watchdog.mjs: argument validation and single instance (#2076)", () => {
  const lockPathFor = (logFile: string) => logFile.replace(/\.log$/, ".lock");
  let recordingGh: string;
  let callsFile: string;

  beforeAll(() => {
    callsFile = path.join(dir, "gh-calls.txt");
    recordingGh = path.join(dir, "recording-gh.mjs");
    fs.writeFileSync(
      recordingGh,
      [
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(callsFile)}, process.argv.slice(2).join(' ') + '\\n');`,
        "process.stdout.write(JSON.stringify({ visibility: 'PRIVATE' }));",
      ].join("\n"),
    );
  });
  beforeEach(() => fs.rmSync(callsFile, { force: true }));

  const recordingEnv = (logFile: string): NodeJS.ProcessEnv => ({
    ...fakeEnv("success", logFile),
    VISIBILITY_WATCHDOG_GH_CMD: JSON.stringify([process.execPath, recordingGh]),
  });

  const expectNoSideEffect = (logFile: string) => {
    expect(fs.existsSync(logFile)).toBe(false); // no log line
    expect(fs.existsSync(lockPathFor(logFile))).toBe(false); // no lock
    expect(fs.existsSync(callsFile)).toBe(false); // no gh call at all
  };

  it.each([["--bogus"], ["stray-positional"], ["--minutes", "abc"], ["--minutes"], ["--repo"]])(
    "rejects %j with a usage message and exit 2, before any side effect",
    (...args) => {
      const logFile = newLogPath(`bad-args-${args.join("_").replace(/\W/g, "")}`);
      const res = run(args, recordingEnv(logFile));
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("usage: node scripts/visibility-watchdog.mjs");
      expectNoSideEffect(logFile);
    },
  );

  it("names the offending flag", () => {
    const res = run(["--bogus"], recordingEnv(newLogPath("names-flag")));
    expect(res.stderr).toContain("unknown argument: --bogus");
  });

  it.each([["--help"], ["-h"]])("%s prints usage and exits 0 with no side effect", (flag) => {
    const logFile = newLogPath(`help-${flag.replace(/\W/g, "")}`);
    const res = run([flag], recordingEnv(logFile));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("usage: node scripts/visibility-watchdog.mjs");
    expect(res.stdout).toContain("--replace");
    expectNoSideEffect(logFile);
  });

  it("--help wins even next to a real --minutes (a probe never arms a watchdog)", () => {
    const logFile = newLogPath("help-with-minutes");
    const res = run(["--minutes", "45", "--help"], recordingEnv(logFile));
    expect(res.status).toBe(0);
    expectNoSideEffect(logFile);
  });

  it("a normal run takes the lock and removes it on exit", () => {
    const logFile = newLogPath("lock-released");
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));
    expect(res.status).toBe(0);
    expect(fs.existsSync(lockPathFor(logFile))).toBe(false);
  });

  /** Start a long-lived watchdog and wait until it holds the lock. */
  async function startHolder(logFile: string) {
    const child = spawn(process.execPath, [SCRIPT, "--minutes", "5", "--repo", "acme/test"], {
      env: fakeEnv("success", logFile),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const lock = lockPathFor(logFile);
    for (
      let i = 0;
      i < 300 && !(fs.existsSync(lock) && readLog(logFile).includes(" start "));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!fs.existsSync(lock)) {
      child.kill("SIGKILL");
      throw new Error("holder never took the lock");
    }
    return child;
  }
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });

  it("a second start reports the running pid and deadline, refuses with exit 3, and does nothing", async () => {
    const logFile = newLogPath("second-start");
    const holder = await startHolder(logFile);
    try {
      const startLines = readLog(logFile)
        .split("\n")
        .filter((l) => l.includes(" start ")).length;
      const held = JSON.parse(fs.readFileSync(lockPathFor(logFile), "utf8"));
      const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));
      expect(res.status).toBe(3);
      expect(res.stderr).toContain(`already running: pid ${holder.pid}`);
      expect(res.stderr).toContain(`deadline ${held.deadline}`);
      expect(res.stderr).toContain("--replace");
      // The runbook launches discard stderr: the refusal must ALSO be in the log, naming the pid.
      expect(readLog(logFile)).toMatch(new RegExp(` refused .*already running: pid ${holder.pid}`));
      // The refused start wrote no log line and left the holder's lock alone.
      expect(
        readLog(logFile)
          .split("\n")
          .filter((l) => l.includes(" start ")).length,
      ).toBe(startLines);
      expect(JSON.parse(fs.readFileSync(lockPathFor(logFile), "utf8")).pid).toBe(holder.pid);
      expect(holder.exitCode).toBeNull();
    } finally {
      holder.kill("SIGKILL");
      await exited(holder);
    }
  }, 30_000);

  it("--replace stops the running watchdog and takes over the lock", async () => {
    const logFile = newLogPath("replace");
    const holder = await startHolder(logFile);
    try {
      // Async on purpose: the holder is OUR child, and a blocked parent (spawnSync) can never reap
      // it, so the replacer would see a zombie as "still alive". Production holders are never the
      // replacer's child.
      const replacer = spawn(
        process.execPath,
        [SCRIPT, "--replace", "--minutes", "0.01", "--repo", "acme/test"],
        { env: fakeEnv("success", logFile), stdio: "ignore" },
      );
      const code = await new Promise<number | null>((resolve) => replacer.once("exit", resolve));
      expect(code).toBe(0);
      await exited(holder);
      expect(holder.signalCode ?? holder.exitCode).toBeTruthy(); // the old one was stopped
      expect(readLog(logFile)).toContain("verified");
      expect(fs.existsSync(lockPathFor(logFile))).toBe(false); // the new one released it on exit
    } finally {
      holder.kill("SIGKILL");
    }
    // Load flake (row 272): passes alone, took 111 s on a saturated shared host (the replacer's
    // PowerShell process-identity check is slow under load). Timeout only; assertions unchanged.
  }, 240_000);

  it("a lock left by a dead pid is stale: the new start just takes it", async () => {
    const logFile = newLogPath("stale-lock");
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await exited(dead);
    fs.writeFileSync(
      lockPathFor(logFile),
      JSON.stringify({ pid: dead.pid, repo: "acme/test", deadline: "2020-01-01T00:00:00Z" }),
    );
    const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));
    expect(res.status).toBe(0);
    expect(fs.existsSync(lockPathFor(logFile))).toBe(false);
  });

  (process.platform === "win32" ? it.skip : it)(
    "a lock whose pid now belongs to ANOTHER live process is stale: taken over, nothing killed, with or without --replace",
    async () => {
      for (const flags of [[], ["--replace"]]) {
        const logFile = newLogPath(`reused-pid-${flags.length}`);
        const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        try {
          fs.writeFileSync(
            lockPathFor(logFile),
            JSON.stringify({
              pid: other.pid,
              repo: "acme/test",
              deadline: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          );
          const res = run(
            [...flags, "--minutes", "0.01", "--repo", "acme/test"],
            fakeEnv("success", logFile),
          );
          expect(res.status).toBe(0); // it armed: the window is never left with no watchdog
          expect(other.exitCode).toBeNull();
          expect(other.signalCode).toBeNull();
        } finally {
          other.kill("SIGKILL");
          await exited(other);
        }
      }
    },
    30_000,
  );

  (process.platform === "win32" ? it.skip : it)(
    "a lock past its deadline plus the retry budget is stale even if a watchdog-looking process holds the pid; nothing is killed",
    async () => {
      const logFile = newLogPath("overdue");
      // A live process whose command line names the script, so identity alone would say "watchdog".
      const lookalike = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", "visibility-watchdog"],
        { stdio: "ignore" },
      );
      try {
        fs.writeFileSync(
          lockPathFor(logFile),
          JSON.stringify({
            pid: lookalike.pid,
            repo: "acme/test",
            deadline: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          }),
        );
        const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));
        expect(res.status).toBe(0);
        expect(lookalike.exitCode).toBeNull();
      } finally {
        lookalike.kill("SIGKILL");
        await exited(lookalike);
      }
    },
    30_000,
  );

  (process.platform === "win32" ? it.skip : it)(
    "a live watchdog-looking pid still inside its deadline is NOT stale: refused",
    async () => {
      const logFile = newLogPath("live-lookalike");
      const lookalike = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", "visibility-watchdog"],
        { stdio: "ignore" },
      );
      try {
        fs.writeFileSync(
          lockPathFor(logFile),
          JSON.stringify({
            pid: lookalike.pid,
            repo: "acme/test",
            deadline: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        const res = run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile));
        expect(res.status).toBe(3);
        expect(readLog(logFile)).toContain(" refused ");
        expect(lookalike.exitCode).toBeNull();
      } finally {
        lookalike.kill("SIGKILL");
        await exited(lookalike);
      }
    },
    30_000,
  );

  it("--replace on a lock whose pid is already gone is not an error (ESRCH means already stopped)", async () => {
    const logFile = newLogPath("replace-gone");
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await exited(dead);
    fs.writeFileSync(
      lockPathFor(logFile),
      JSON.stringify({ pid: dead.pid, repo: "acme/test", deadline: "2099-01-01T00:00:00Z" }),
    );
    const res = run(
      ["--replace", "--minutes", "0.01", "--repo", "acme/test"],
      fakeEnv("success", logFile),
    );
    expect(res.status).toBe(0);
  });

  it("FOUR parallel starts on one lock: exactly one arms, the rest are refused (no create-then-write race)", async () => {
    // The holder must outlive a refused starter's identity check. On win32 that check is a cold
    // PowerShell `Get-CimInstance Win32_Process` (seconds under load): with a 3 s holder the three
    // starters saw it already gone and correctly took over a free lock. 15 s on win32; 3 s elsewhere.
    const HOLDER_MINUTES = process.platform === "win32" ? "0.25" : "0.05";
    const logFile = newLogPath("parallel");
    const start = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          process.execPath,
          [SCRIPT, "--minutes", HOLDER_MINUTES, "--repo", "acme/test"],
          { env: fakeEnv("success", logFile), stdio: "ignore" },
        );
        child.once("exit", resolve);
      });
    const codes = await Promise.all([start(), start(), start(), start()]);
    expect([...codes].sort()).toEqual([0, 3, 3, 3]);
  }, 60_000);

  it("Windows identity is checked from the command line (Win32_Process), never trusted by pid alone", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain("Get-CimInstance Win32_Process");
    expect(src).not.toMatch(/process\.platform === "win32"\)\s*return true/);
  });
});
