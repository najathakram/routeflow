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

// Forward-slash path required for NODE_OPTIONS=--require on Windows — a Git-Bash POSIX-style
// path (/c/Users/...) fails the child's preload with MODULE_NOT_FOUND.
const SLOW_BOOT_PATH = path.resolve(__dirname, "testing/slow-boot.cjs").replace(/\\/g, "/");

// Poll/cap/kill design. Spawns the child, then polls `readLog(logFile)` every `intervalMs`
// until it contains the exact " start " tag `log()` writes at
// scripts/visibility-watchdog.mjs:137-144, resolving `{ child, log }`. If `capMs` elapses
// first, rejects with a message naming the cap and the log's last 300 chars — never a fixed
// wait, so the test proves the script's own behavior rather than how fast the host booted
// Node. stdout/stderr are drained into buffers so nothing can block on a full pipe, and if the
// child exits before the start line appears (a spawn that fails fast, e.g. a bad NODE_OPTIONS
// preload or a syntax error in the script) the helper rejects immediately with the exit code
// and the captured stderr tail instead of waiting out the full cap — unless the final log read
// on exit shows the start line already landed, in which case it still resolves. The child is
// always killed in `finally` (resolve, cap-reject, and the child's "error" event all funnel
// through it), and its exit is awaited (up to 2s) before returning.
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
