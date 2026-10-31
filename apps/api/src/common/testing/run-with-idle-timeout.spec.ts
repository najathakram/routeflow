import { readFileSync } from "node:fs";
import { runWithIdleTimeout } from "./run-with-idle-timeout";

// A wrapper spec that drives a self-test as a child process used to give the child a fixed wall-clock budget. Under
// load (a full verify holding the machine) the child was merely slow, not stuck, and the wrapper killed it at its
// budget: "a test of the slot must not fail because the slot is in use". The budget is now IDLE time: the child is
// ended only when it stops producing output. These rows pin that on tiny `node` children.

const node = process.execPath;
// A child that prints a line every `everyMs` for `count` lines, then exits with `code`.
const ticker = (everyMs: number, count: number, code = 0) => [
  "-e",
  `let n=0;const t=setInterval(()=>{console.log("line "+(++n));if(n>=${count}){clearInterval(t);process.exit(${code});}},${everyMs});`,
];

// A process is gone when it no longer exists or is only a zombie (an orphan reparented to a PID 1 that does not reap,
// as in a container, stays listed as "Z" until then).
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true; // no /proc (Windows): kill(pid, 0) succeeded
  }
}
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const stop = Date.now() + ms; Date.now() < stop;) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}
function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

describe("runWithIdleTimeout", () => {
  it("lets a child run far longer than the idle window as long as it keeps printing", async () => {
    const res = await runWithIdleTimeout(node, ticker(60, 12), { idleMs: 400 });
    expect(res.timedOut).toBeNull();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("line 12");
    expect(res.elapsedMs).toBeGreaterThan(400); // ran past the idle window: total time is not the limit
  });

  it("ends a child that stops producing output, and says it was the idle window", async () => {
    const res = await runWithIdleTimeout(
      node,
      ["-e", 'console.log("started");setTimeout(()=>{},60000);'],
      { idleMs: 300 },
    );
    expect(res.timedOut).toBe("idle");
    expect(res.stdout).toContain("started");
    expect(res.status).not.toBe(0);
  });

  it("counts stderr as output", async () => {
    const res = await runWithIdleTimeout(
      node,
      [
        "-e",
        'let n=0;const t=setInterval(()=>{console.error("e"+(++n));if(n>=8)process.exit(0)},80);',
      ],
      { idleMs: 400 },
    );
    expect(res.timedOut).toBeNull();
    expect(res.status).toBe(0);
  });

  it("passes the child's exit status and both streams through", async () => {
    const res = await runWithIdleTimeout(
      node,
      ["-e", 'console.log("out");console.error("err");process.exit(3)'],
      { idleMs: 2000 },
    );
    expect(res.timedOut).toBeNull();
    expect(res.status).toBe(3);
    expect(res.stdout).toContain("out");
    expect(res.stderr).toContain("err");
  });

  it("has a hard ceiling so a child that prints forever cannot hang the suite", async () => {
    const res = await runWithIdleTimeout(node, ticker(30, 100000), { idleMs: 400, maxMs: 500 });
    expect(res.timedOut).toBe("max");
  });

  // Linux: SIGTERM reaches the direct child only, and 'close' waits for EVERY holder of its pipes. A grandchild
  // that inherited stdio kept them open, so a silent child was never reported at the idle limit (or the ceiling).
  // The helper must END the wait itself (SIGKILL after a grace, destroy the pipes, resolve) AND leave nothing running:
  // both signals go to the child's process group, so the grandchild goes too (POSIX; Windows signals the child only).
  // The windows are 2 s: 300 ms closed before a starved child had started, so a healthy helper read red.
  it("resolves at the idle limit even when a grandchild holds the child's pipes open, and leaves none running", async () => {
    const res = await runWithIdleTimeout(
      node,
      [
        "-e",
        'const gc=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},15000)"],{stdio:"inherit"});' +
          'console.log("gc "+gc.pid);setInterval(()=>{},1000);',
      ],
      { idleMs: 2_000, graceMs: 300 },
    );
    const pid = Number(/gc (\d+)/.exec(res.stdout)?.[1]);
    try {
      expect(pid).toBeGreaterThan(0);
      expect(res.timedOut).toBe("idle");
      expect(res.elapsedMs).toBeLessThan(10_000);
      if (process.platform !== "win32") expect(await goneWithin(pid, 5_000)).toBe(true);
    } finally {
      if (pid) killQuietly(pid);
    }
  }, 30_000);

  it("resolves when the child ignores SIGTERM: SIGKILL follows the grace, and the child is gone", async () => {
    const res = await runWithIdleTimeout(
      node,
      [
        "-e",
        'process.on("SIGTERM",()=>{});console.log("deaf "+process.pid);setInterval(()=>{},1000);',
      ],
      { idleMs: 2_000, graceMs: 300 },
    );
    const pid = Number(/deaf (\d+)/.exec(res.stdout)?.[1]);
    try {
      expect(pid).toBeGreaterThan(0);
      expect(res.timedOut).toBe("idle");
      expect(res.elapsedMs).toBeLessThan(10_000);
      // `res.signal` cannot prove the SIGKILL (the helper fills it in): the deaf child must actually be gone.
      expect(await goneWithin(pid, 5_000)).toBe(true);
    } finally {
      if (pid) killQuietly(pid);
    }
  }, 30_000);

  it("rejects an idle window that is not a positive number", async () => {
    await expect(runWithIdleTimeout(node, ["-e", "0"], { idleMs: 0 })).rejects.toThrow(/idleMs/);
  });
});
