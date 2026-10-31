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

  it("rejects an idle window that is not a positive number", async () => {
    await expect(runWithIdleTimeout(node, ["-e", "0"], { idleMs: 0 })).rejects.toThrow(/idleMs/);
  });
});
