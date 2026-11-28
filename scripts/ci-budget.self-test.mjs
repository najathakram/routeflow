#!/usr/bin/env node
// W-1514 self-test for scripts/ci-budget.sh, the Verify step's session-scoped budget wrapper.
//
// Why: `timeout -k 60 56m npm run verify` signals only its own process group, but turbo starts each
// task in a new process group (turbo 2.11.11 `process_group(0)`). A task that outlives turbo is out
// of `timeout`'s reach and keeps the step's stdout open, so the job runs to the cap and loses its log
// (#4556's runs 46009439210, 46082824251, 46087941710). The wrapper kills by SESSION instead, which a
// process group change does not leave.
//
// The fixtures copy turbo's shape with `set -m`: a background `sleep 300` in its own process group,
// same session, holding the inherited stdout. Each case asserts what the runner would see: the exit
// code, stdout EOF, and whether the leftover is still alive.
//
// Every red case runs here too, so the harness is proven able to see the escape:
// - M: master's literal shape, `timeout -k 1 2s bash <fixture>` (skipped where GNU `timeout` is absent).
// - P: the fix-revert probe, the same wrapper with `pkill -s <sid>` swapped for the group kill
//   `kill -- -<sid>`. It must fail W1 and W2.
//
// K: a pkill that cannot kill (a stub on PATH that exits 2) makes the wrapper exit 125, never a clean
// 124 or the command's own status; a stub that exits 1 (nothing matched) is benign. These and W6 run
// on any POSIX host.
//
// Platforms: under Windows everything prints SKIPPED and exits 0. W1-W5, P and M need procps pkill with
// -s, which the CI runner (Linux) has. macOS pkill has no -s: there the K and W6 cases run and the rest
// prints SKIPPED with the probe's exit code. CI_BUDGET_SH=<path> runs every case against another
// wrapper file.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log(
    "ci-budget self-test: SKIPPED on win32 (needs bash, perl POSIX::setsid, procps pkill -s and ps; CI runs it)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = process.env.CI_BUDGET_SH || join(HERE, "ci-budget.sh");
const dir = mkdtempSync(join(tmpdir(), "ci-budget-test-"));
const leftovers = new Set();

let passed = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

// A fixture's background `sleep` is in its own process group (set -m), in the fixture's session, and
// holds the inherited stdout. $1 is where it writes the sleep's pid.
const FIXTURES = {
  // the turbo shape: the leader waits on a group-escaped task
  escape: 'set -m\nsleep 300 &\necho $! > "$1"\nwait\n',
  // turbo dies first: the leader SIGKILLs itself and orphans the task
  orphan: 'set -m\nsleep 300 &\necho $! > "$1"\nkill -KILL $$\n',
  // a green verify that leaves a group-escaped leftover behind
  pass: 'set -m\nsleep 300 &\necho $! > "$1"\nexit 0\n',
  // a red verify, exit code 3
  exit3: "exit 3\n",
  // the leader is the long task itself, nothing escaped
  sleeper: 'echo $$ > "$1"\nexec sleep 300\n',
};
for (const [name, body] of Object.entries(FIXTURES)) writeFileSync(join(dir, `${name}.sh`), body);

// Alive means present and not a zombie (an orphan waits for init to reap it).
const alive = (pid) => {
  if (!pid) return false;
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = (r.stdout || "").trim();
  return stat !== "" && !stat.startsWith("Z");
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const readPid = (file) => {
  if (!existsSync(file)) return 0;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (pid) leftovers.add(pid);
  return pid;
};
// Wait up to `ms` for the leftover to die, so a just-signalled sleep is not read as alive.
const deadWithin = async (pid, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleepMs(100);
  }
  return !alive(pid);
};

let seq = 0;
// Runs argv with stdout and stderr piped, like a runner step. Resolves when stdout reaches EOF and the
// process has exited ('close'), or at `boundMs` with eof=false. Then it always cleans up: it kills the
// leftover sleep (our own pid, from the fixture's pid file) so the pipe can close.
function run(argv, { boundMs, fixture, onStart, env } = {}) {
  const pidFile = join(dir, `pid-${++seq}`);
  const args = fixture ? [...argv, "bash", join(dir, `${fixture}.sh`), pidFile] : argv;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"], env });
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (stderr += d));
    let exit = null;
    child.on("exit", (code, signal) => (exit = { code, signal }));
    let settled = false;
    const finish = async (eof) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const pid = readPid(pidFile);
      const leftoverDead = await deadWithin(pid, 1500);
      resolve({ eof, ms, pid, leftoverDead, exit, stderr });
    };
    child.on("close", (code, signal) => {
      exit = exit || { code, signal };
      finish(true);
    });
    const timer = setTimeout(() => finish(false), boundMs);
    if (onStart) onStart(child);
  });
}

const BUDGET = "2s";
const GRACE = "1";
// budget + grace + 2s of slack: what "the step ends at its budget" means here
const BOUND_MS = 5000;
const wrapped = (wrapper, budget = BUDGET) => ["bash", wrapper, budget, GRACE];

async function wCases(wrapper) {
  const out = {};
  out.w1 = await run(wrapped(wrapper), { boundMs: BOUND_MS, fixture: "escape" });
  out.w2 = await run(wrapped(wrapper, "10s"), { boundMs: 3000, fixture: "orphan" });
  return out;
}

async function main() {
  check("W0 the wrapper exists", existsSync(WRAPPER), `missing: ${WRAPPER}`);
  if (!existsSync(WRAPPER)) return;

  // W6: a budget it cannot read is a usage error, not a run with no budget.
  for (const bad of ["5x", "", "m", "-1s"]) {
    const r = spawnSync("bash", [WRAPPER, bad, GRACE, "true"], { encoding: "utf8" });
    check(`W6 budget "${bad}" is refused with exit 2`, r.status === 2, `status ${r.status}`);
  }
  const g = spawnSync("bash", [WRAPPER, "2s", "x", "true"], { encoding: "utf8" });
  check('W6 grace "x" is refused with exit 2', g.status === 2, `status ${g.status}`);
  const n = spawnSync("bash", [WRAPPER, "2s", "1"], { encoding: "utf8" });
  check("W6 no command is refused with exit 2", n.status === 2, `status ${n.status}`);

  // K: a pkill that cannot kill fails the run loudly (exit 125). The stub dir goes first on PATH.
  const stub = (code) => {
    const d = mkdtempSync(join(dir, `pkill-${code}-`));
    writeFileSync(join(d, "pkill"), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    return { ...process.env, PATH: `${d}:${process.env.PATH}` };
  };
  const k1 = await run(wrapped(WRAPPER, "10s"), { boundMs: 3000, fixture: "exit3", env: stub(2) });
  check(
    "K1 pkill exits 2 on the after-exit sweep: exit 125, not the command's 3",
    k1.exit && k1.exit.code === 125,
    `exit ${JSON.stringify(k1.exit)}`,
  );
  check(
    "K1 the failure is printed",
    /pkill -s failed \(exit 2\)/.test(k1.stderr),
    `stderr ${k1.stderr.trim()}`,
  );
  const k2 = await run(wrapped(WRAPPER), { boundMs: BOUND_MS, fixture: "sleeper", env: stub(2) });
  check(
    "K2 pkill exits 2 at the budget: exit 125, not 124",
    k2.exit && k2.exit.code === 125,
    `exit ${JSON.stringify(k2.exit)}`,
  );
  check(
    "K2 the leader is still signalled, so the run ends within budget + grace + 2s",
    k2.eof && k2.leftoverDead,
    `eof ${k2.eof} dead ${k2.leftoverDead}`,
  );
  const k3 = await run(wrapped(WRAPPER, "10s"), { boundMs: 3000, fixture: "exit3", env: stub(1) });
  check(
    "K3 pkill exits 1 (nothing matched) is benign: the command's 3 passes through",
    k3.exit && k3.exit.code === 3,
    `exit ${JSON.stringify(k3.exit)}`,
  );

  // The session cases need procps pkill with -s. The probe signals processes named exactly a name no
  // process has, in this test's own session (-s 0): 0 or 1 means -s works; anything else means it does not.
  const probe0 = spawnSync("pkill", ["-s", "0", "-x", "ci-budget-probe-no-such-process"], {
    encoding: "utf8",
  });
  if (probe0.status !== 0 && probe0.status !== 1) {
    const why = `probe exit ${probe0.status}${probe0.error ? `, ${probe0.error.code}` : ""}`;
    console.log(
      `  SKIPPED W1-W5, P and M on ${process.platform}: pkill has no -s here (${why}). CI (Linux, procps) runs them.`,
    );
    return;
  }

  // W1: at the budget the whole session dies, the group-escaped task included, and stdout closes.
  const { w1, w2 } = await wCases(WRAPPER);
  check(
    "W1 budget reached: exit 124",
    w1.exit && w1.exit.code === 124,
    `exit ${JSON.stringify(w1.exit)} stderr ${w1.stderr.trim()}`,
  );
  check(
    "W1 budget reached: stdout EOF within budget + grace + 2s",
    w1.eof,
    `no EOF in ${BOUND_MS} ms`,
  );
  check(
    "W1 budget reached: the group-escaped task is dead",
    w1.leftoverDead,
    `pid ${w1.pid} alive`,
  );

  // W2: the leader dies first (turbo killed); the wrapper's after-exit sweep reaps the orphan.
  check("W2 leader killed: stdout EOF well before the budget", w2.eof, "no EOF in 3000 ms");
  check("W2 leader killed: the orphan is dead", w2.leftoverDead, `pid ${w2.pid} alive`);
  check(
    "W2 leader killed: its 137 passes through",
    w2.exit && w2.exit.code === 137,
    `exit ${JSON.stringify(w2.exit)}`,
  );

  // W3: a green verify stays green, and its leftover cannot hold the step open until the budget.
  const w3 = await run(wrapped(WRAPPER, "10s"), { boundMs: 3000, fixture: "pass" });
  check("W3 pass: exit 0", w3.exit && w3.exit.code === 0, `exit ${JSON.stringify(w3.exit)}`);
  check(
    "W3 pass: stdout EOF right after exit (the sweep, not the budget)",
    w3.eof,
    "no EOF in 3000 ms",
  );
  check("W3 pass: the leftover is dead", w3.leftoverDead, `pid ${w3.pid} alive`);

  // W4: verify's own exit code passes through.
  const w4 = await run(wrapped(WRAPPER, "10s"), { boundMs: 3000, fixture: "exit3" });
  check(
    "W4 exit code passes through: 3",
    w4.exit && w4.exit.code === 3,
    `exit ${JSON.stringify(w4.exit)}`,
  );

  // W5: a cancel (SIGTERM to the wrapper, as GitHub sends) also kills the session.
  const w5 = await run(wrapped(WRAPPER, "30s"), {
    boundMs: BOUND_MS,
    fixture: "escape",
    onStart: (child) => setTimeout(() => child.kill("SIGTERM"), 1000),
  });
  check("W5 cancel: exit 143", w5.exit && w5.exit.code === 143, `exit ${JSON.stringify(w5.exit)}`);
  check("W5 cancel: stdout EOF", w5.eof, `no EOF in ${BOUND_MS} ms`);
  check("W5 cancel: the group-escaped task is dead", w5.leftoverDead, `pid ${w5.pid} alive`);

  // P: the fix-revert probe. The same wrapper with every session kill swapped for a group kill must
  // fail W1 and W2, or these cases cannot tell the fix from master's shape.
  const src = readFileSync(WRAPPER, "utf8");
  let swaps = 0;
  const groupKill = src.replace(/pkill (-\S+) -s "\$sid"/g, (_, sig) => {
    swaps++;
    return `kill ${sig} -- -"$sid"`;
  });
  // A pkill COMMAND left over, not the word inside a quoted message (the 125 error names pkill).
  const pkillLeft = groupKill
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && /\bpkill\b/.test(l.replace(/"[^"]*"|'[^']*'/g, "")));
  check(
    "P0 the probe swapped every session kill for a group kill",
    swaps >= 1 && pkillLeft.length === 0,
    `swapped ${swaps}, pkill left: ${pkillLeft.join(" | ")}`,
  );
  const probe = join(dir, "ci-budget.group-kill.sh");
  writeFileSync(probe, groupKill);

  const hasTimeout = spawnSync("timeout", ["--version"], { encoding: "utf8" }).status === 0;
  const [p, m1, m2] = await Promise.all([
    wCases(probe),
    hasTimeout
      ? run(["timeout", "-k", GRACE, BUDGET], { boundMs: BOUND_MS, fixture: "escape" })
      : null,
    hasTimeout ? run(["timeout", "-k", GRACE, "10s"], { boundMs: 3000, fixture: "orphan" }) : null,
  ]);
  check(
    "P1 group-kill probe, escape: the task survives (red, as on master)",
    !p.w1.leftoverDead && !p.w1.eof,
    `eof ${p.w1.eof} dead ${p.w1.leftoverDead}`,
  );
  check(
    "P2 group-kill probe, orphan: the orphan survives (red, as on master)",
    !p.w2.leftoverDead && !p.w2.eof,
    `eof ${p.w2.eof} dead ${p.w2.leftoverDead}`,
  );
  if (hasTimeout) {
    check(
      "M1 master shape `timeout -k 1 2s`, escape: the task survives and stdout stays open",
      !m1.leftoverDead && !m1.eof,
      `eof ${m1.eof} dead ${m1.leftoverDead}`,
    );
    check(
      "M2 master shape `timeout -k 1 10s`, orphan: the orphan survives",
      !m2.leftoverDead && !m2.eof,
      `eof ${m2.eof} dead ${m2.leftoverDead}`,
    );
  } else {
    console.log(
      "  skip M1/M2: no GNU `timeout` on this host (the P probe covers the group-kill shape)",
    );
  }
}

try {
  await main();
} finally {
  for (const pid of leftovers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
}
console.log(`ci-budget self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
