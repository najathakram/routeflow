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
// VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS collapses the real 5s..240s backoff between flip
// attempts to a few milliseconds so specs don't sleep for real minutes.

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

  it("retries a failed flip: edit fails twice then succeeds — exit 0, verified on attempt 3, no error logged", () => {
    const logFile = newLogPath("retry-then-success");
    const res = run(
      ["--minutes", "0.01", "--repo", "acme/test"],
      fakeEnv("retry-then-success", logFile, { FAKE_FAIL_ATTEMPTS: "2" }),
    );

    expect(res.status).toBe(0);
    const log = readLog(logFile);
    expect(log).toContain(" start ");
    expect(log).toContain("n=1/6");
    expect(log).toContain("n=2/6");
    expect(log).toContain("n=3/6");
    expect(log).not.toContain("n=4/6");
    expect(log).toContain(" verified ");
    expect(log).toContain("attempt=3/6");
    expect(log).not.toContain(" error ");
    // the two failed attempts carry the stub's stderr first line
    expect(log).toMatch(/HTTP 500: Internal Server Error \(attempt 1\)/);
    expect(log).toMatch(/HTTP 500: Internal Server Error \(attempt 2\)/);
  });

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

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(capturedChild).toBeDefined();
    expect(capturedChild!.exitCode).not.toBeNull();
  }, 35_000);
});
