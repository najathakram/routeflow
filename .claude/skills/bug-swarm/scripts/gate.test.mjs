// node --test gate.test.mjs — contract tests for gate.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { scrubbedGitEnv } from "../../../../scripts/lib/check-git-hooks.mjs";
import {
  addedSince,
  CENSUS_LANES,
  CENSUS_SPECS,
  missingSpecs,
  runCensusLane,
  commandLineOf,
  holdPidFile,
  stopGate,
  beginJson,
  changedSince,
  execStep,
  finishJson,
  planGate,
  runGate,
  STEP_TIMEOUT_MS,
  DB_LANE_TIMEOUT_MS,
} from "./gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const norm = (p) => path.normalize(p);
const opts = { root: "/r", base: "abc123", exists: () => true, hasLint: () => true };
const names = (steps) => steps.map((s) => s.name);
const step = (steps, name) => steps.find((s) => s.name === name);

test("changedSince uses git merge-base origin/master HEAD, then base..HEAD (no origin/master..HEAD)", () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    return args[0] === "merge-base" ? "deadbeef\n" : "a.ts\0b/(c)/d.tsx\0";
  };
  const r = changedSince(git);
  assert.deepEqual(calls[0], ["merge-base", "origin/master", "HEAD"]);
  assert.ok(calls[1].includes("deadbeef..HEAD"));
  assert.ok(calls[1].includes("--diff-filter=d"));
  assert.deepEqual(r, { base: "deadbeef", files: ["a.ts", "b/(c)/d.tsx"] });
});

test("paths with parentheses and brackets survive as single argv elements", () => {
  const f = "apps/web/app/(dashboard)/orders/[id]/page.tsx";
  const steps = planGate({
    changedFiles: [f, "apps/mobile/app/(operator)/returns/[id].tsx"],
    ...opts,
  });
  assert.ok(step(steps, "prettier").cmd.includes(f));
  assert.equal(step(steps, "eslint:apps/web"), undefined);
  for (const s of steps)
    assert.ok(Array.isArray(s.cmd) && s.cmd.every((x) => typeof x === "string"));
});

test("prettier skips dotfiles without an extension such as .prettierignore", () => {
  const steps = planGate({
    changedFiles: [".prettierignore", "apps/web/a.ts", "Dockerfile"],
    ...opts,
  });
  const cmd = step(steps, "prettier").cmd;
  assert.ok(cmd.includes("apps/web/a.ts"));
  assert.ok(!cmd.includes(".prettierignore"));
  assert.ok(!cmd.includes("Dockerfile"));
  assert.ok(!names(planGate({ changedFiles: [".prettierignore"], ...opts })).includes("prettier"));
});

test("lint is npm run lint -w <ws> for every touched workspace with a lint script; jest paths are workspace-relative", () => {
  const steps = planGate({
    changedFiles: [
      "apps/api/src/orders/a.service.ts",
      "apps/api/src/orders/a.service.spec.ts",
      "packages/ui/x.tsx",
    ],
    ...opts,
    hasLint: (ws) => ws !== "packages/nolint",
  });
  assert.deepEqual(step(steps, "lint:apps/api").cmd, ["npm", "run", "lint", "-w", "apps/api"]);
  assert.deepEqual(step(steps, "lint:packages/ui").cmd, [
    "npm",
    "run",
    "lint",
    "-w",
    "packages/ui",
  ]);
  assert.equal(norm(step(steps, "lint:apps/api").cwd), norm("/r"));
  const none = planGate({ changedFiles: ["packages/nolint/a.ts"], ...opts, hasLint: () => false });
  assert.ok(!names(none).some((n) => n.startsWith("lint:")));
  const jest = step(steps, "jest:apps/api");
  assert.equal(norm(jest.cwd), norm("/r/apps/api"));
  assert.ok(jest.cmd.includes("--findRelatedTests"));
  assert.ok(jest.cmd.includes("src/orders/a.service.ts"));
  assert.deepEqual(step(steps, "tsc:apps/api").cmd, [
    "npm",
    "run",
    "check-types",
    "-w",
    "apps/api",
  ]);
});

test("packages/types or packages/pricing change adds consumer type checks and enum-parity", () => {
  for (const f of ["packages/types/api/enums.ts", "packages/pricing/src/a.ts"]) {
    const steps = planGate({ changedFiles: [f], ...opts });
    for (const ws of ["apps/api", "apps/web", "apps/mobile"]) {
      assert.deepEqual(step(steps, `tsc:${ws}`).cmd, ["npm", "run", "check-types", "-w", ws]);
    }
    const ep = step(steps, "enum-parity");
    assert.equal(norm(ep.cwd), norm("/r/apps/api"));
    assert.deepEqual(ep.cmd, ["npx", "jest", "src/common/enum-parity.spec.ts"]);
  }
  const plain = planGate({ changedFiles: ["packages/ui/a.tsx"], ...opts });
  assert.equal(step(plain, "enum-parity"), undefined);
  assert.equal(step(plain, "tsc:apps/web"), undefined);
  const dup = planGate({ changedFiles: ["packages/types/a.ts", "apps/api/b.ts"], ...opts });
  assert.equal(names(dup).filter((n) => n === "tsc:apps/api").length, 1);
});

test("steps carry timeouts: 15 min default, 30 min for db-lane", () => {
  assert.equal(STEP_TIMEOUT_MS, 15 * 60_000);
  assert.equal(DB_LANE_TIMEOUT_MS, 30 * 60_000);
  const steps = planGate({ changedFiles: ["apps/api/a.ts"], needsDb: true, ...opts });
  assert.equal(step(steps, "packages-build").timeoutMs, STEP_TIMEOUT_MS);
  assert.equal(step(steps, "db-lane").timeoutMs, DB_LANE_TIMEOUT_MS);
});

test("execStep kills a step past its timeout and reports timedOut", async () => {
  const r = await execStep({
    name: "slow",
    cwd: process.cwd(),
    cmd: [process.execPath, "-e", "setTimeout(()=>{},60000)"],
    timeoutMs: 300,
  });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.status, 0);
});

test("execStep timeout kills the whole process group and resolves without waiting for close", async () => {
  const t0 = Date.now();
  const r = await execStep({
    name: "hung",
    cwd: process.cwd(),
    cmd: ["sh", "-c", "sleep 6 & echo $!; wait"],
    timeoutMs: 1000,
  });
  const ms = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(ms < 2000, `resolved in ${ms} ms`);
  const gpid = Number(r.output.trim().split("\n")[0]);
  assert.ok(gpid > 1, `grandchild pid in output: ${r.output}`);
  await new Promise((res) => setTimeout(res, 200));
  let alive = true;
  try {
    process.kill(gpid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "grandchild sleep must be dead");
});

test("timeout on win32 uses taskkill /T /F", async () => {
  const calls = [];
  const r = await execStep(
    {
      name: "w",
      cwd: process.cwd(),
      cmd: [process.execPath, "-e", "setTimeout(()=>{},5000)"],
      timeoutMs: 200,
    },
    {
      platform: "win32",
      killTree: (pid) => calls.push(["taskkill", "/pid", String(pid), "/T", "/F"]),
    },
  );
  assert.equal(r.timedOut, true);
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill", "/pid"]);
  assert.deepEqual(calls[0].slice(3), ["/T", "/F"]);
});

test("runGate marks timedOut steps ok=false and continues", async () => {
  const exec = async (s) =>
    s.name === "a" ? { status: null, output: "", timedOut: true } : { status: 0, output: "" };
  const r = await runGate(
    [
      { name: "a", cwd: "/", cmd: ["x"] },
      { name: "b", cwd: "/", cmd: ["y"] },
    ],
    { exec },
  );
  assert.equal(r.steps[0].timedOut, true);
  assert.equal(r.steps[0].ok, false);
  assert.equal(r.steps[1].ok, true);
  assert.equal(r.ok, false);
});

test("avoid-files step fails when the merge-base diff touches an avoided file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-avoid-"));
  const sh = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env: scrubbedGitEnv() });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "1");
  sh("add", ".");
  sh("commit", "-qm", "base");
  const base = sh("rev-parse", "HEAD").stdout.trim();
  writeFileSync(path.join(dir, "b.txt"), "1");
  sh("add", ".");
  sh("commit", "-qm", "next");
  const run = (avoid) => {
    const st = step(
      planGate({ changedFiles: ["b.txt"], ...opts, base, avoid, root: dir }),
      "avoid-files",
    );
    return spawnSync(st.cmd[0], st.cmd.slice(1), {
      cwd: st.cwd,
      encoding: "utf8",
      env: scrubbedGitEnv(),
    });
  };
  assert.equal(run(["a.txt"]).status, 0);
  const bad = run(["a.txt", "b.txt"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /b\.txt/);
  assert.equal(step(planGate({ changedFiles: [], ...opts }), "avoid-files"), undefined);
});

test("beginJson deletes a stale file and writes a running marker; finishJson writes head and base", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "gate-json-")), "g.json");
  writeFileSync(f, JSON.stringify({ ok: true, steps: [] }));
  beginJson(f, "h1");
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { ok: false, running: true, head: "h1" });
  finishJson(f, { ok: true, steps: [] }, { head: "h1", base: "b1" });
  const done = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(done.ok, true);
  assert.equal(done.running, undefined);
  assert.equal(done.head, "h1");
  assert.equal(done.base, "b1");
  assert.equal(existsSync(f), true);
});

test("web and package workspaces use tsc --noEmit in their own directory", () => {
  const steps = planGate({
    changedFiles: ["apps/web/a.tsx", "packages/pricing/src/x.ts"],
    ...opts,
  });
  assert.deepEqual(step(steps, "tsc:apps/web").cmd, ["npx", "tsc", "--noEmit"]);
  assert.equal(norm(step(steps, "tsc:apps/web").cwd), norm("/r/apps/web"));
  assert.equal(norm(step(steps, "tsc:packages/pricing").cwd), norm("/r/packages/pricing"));
});

test("fixed steps: packages-build, signature-scan, commitlint on the merge-base, size-ratchet", () => {
  const steps = planGate({ changedFiles: ["apps/web/a.ts"], ...opts });
  assert.deepEqual(step(steps, "packages-build").cmd, [
    "npx",
    "turbo",
    "run",
    "build",
    "--filter=./packages/*",
  ]);
  assert.deepEqual(step(steps, "signature-scan").cmd, [
    "node",
    ".claude/skills/bug-hunt/scripts/scan-signatures.mjs",
  ]);
  assert.deepEqual(step(steps, "commitlint").cmd.slice(-4), ["--from", "abc123", "--to", "HEAD"]);
  const sr = step(steps, "size-ratchet");
  assert.equal(norm(sr.cwd), norm("/r/apps/api"));
  assert.deepEqual(sr.cmd, ["npx", "jest", "-c", "jest.repo-truth.config.js", "size-ratchet"]);
});

test("db-lane only when needsDb", () => {
  assert.ok(!names(planGate({ changedFiles: ["apps/api/a.ts"], ...opts })).includes("db-lane"));
  const steps = planGate({ changedFiles: ["apps/api/a.ts"], needsDb: true, ...opts });
  assert.deepEqual(step(steps, "db-lane").cmd, ["npm", "run", "local:test:db"]);
});

test("tools/ops-monitor change adds its run-all; scripts/<x>.mjs adds its self-test when present", () => {
  const steps = planGate({
    changedFiles: ["tools/ops-monitor/lib/a.mjs", "scripts/janitor.mjs"],
    ...opts,
  });
  assert.deepEqual(step(steps, "self-test:ops-monitor").cmd, [
    "node",
    "tools/ops-monitor/test/run-all.mjs",
  ]);
  assert.deepEqual(step(steps, "self-test:scripts/janitor").cmd, [
    "node",
    "scripts/janitor.self-test.mjs",
  ]);
  const none = planGate({ changedFiles: ["scripts/janitor.mjs"], ...opts, exists: () => false });
  assert.ok(!names(none).some((n) => n.startsWith("self-test:")));
});

test("runGate runs every step after a failure and reports ok=false with a 20-line tail", async () => {
  const steps = [
    { name: "a", cwd: path.join("/r"), cmd: ["x"] },
    { name: "b", cwd: path.join("/r"), cmd: ["y"] },
    { name: "c", cwd: path.join("/r"), cmd: ["z"] },
  ];
  const seen = [];
  const exec = async (s) => {
    seen.push(s.name);
    if (s.name === "b")
      return { status: 1, output: Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") };
    return { status: 0, output: "fine" };
  };
  const r = await runGate(steps, { exec });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.steps.map((s) => [s.name, s.ok, s.exit]),
    [
      ["a", true, 0],
      ["b", false, 1],
      ["c", true, 0],
    ],
  );
  assert.equal(r.steps[1].tail.split("\n").length, 20);
  assert.ok(r.steps[1].tail.endsWith("l29"));
  assert.equal(typeof r.steps[0].ms, "number");
  assert.equal((await runGate(steps.slice(0, 1), { exec })).ok, true);
});

test("CLI --dry-run prints the plan and runs nothing", () => {
  const r = spawnSync(process.execPath, [path.join(here, "gate.mjs"), "--dry-run", "--needs-db"], {
    encoding: "utf8",
    cwd: here,
    env: scrubbedGitEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /packages-build/);
  assert.match(r.stdout, /size-ratchet/);
  assert.match(r.stdout, /db-lane/);
});

// --wait polls in Node because agent harnesses block a foreground `sleep`.
const runWait = (file, extra = []) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(here, "gate.mjs"), "--wait", file, ...extra]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });

test("--wait returns exit 0 with the json once running flips to false", async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "gw-")), "g.json");
  writeFileSync(f, JSON.stringify({ ok: false, running: true, head: "h" }));
  setTimeout(() => writeFileSync(f, JSON.stringify({ ok: true, head: "h", steps: [] })), 1000);
  const r = await runWait(f);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).ok, true);
  assert.ok(r.ms >= 900 && r.ms < 8000, `took ${r.ms} ms`);
});

test("--wait exits 3 and prints the json when the gate never finishes within --max-ms", async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "gw-")), "g.json");
  writeFileSync(f, JSON.stringify({ ok: false, running: true, head: "h" }));
  const r = await runWait(f, ["--max-ms", "1500"]);
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.out).running, true);
});

test("clean-tree is the first step and fails on a dirty tracked file, passes when clean", () => {
  const steps = planGate({ changedFiles: ["a.ts"], ...opts });
  assert.equal(steps[0].name, "clean-tree");
  const dir = mkdtempSync(path.join(tmpdir(), "gate-clean-"));
  const sh = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env: scrubbedGitEnv() });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "1");
  sh("add", ".");
  sh("commit", "-qm", "base");
  const run = (ignore = []) => {
    const st = planGate({ changedFiles: [], ...opts, root: dir, ignore })[0];
    return spawnSync(st.cmd[0], st.cmd.slice(1), {
      cwd: st.cwd,
      encoding: "utf8",
      env: scrubbedGitEnv(),
    });
  };
  assert.equal(run().status, 0);
  writeFileSync(path.join(dir, "a.txt"), "2");
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /a\.txt/);
  sh("checkout", "a.txt");
  writeFileSync(path.join(dir, "gate.json"), "{}");
  assert.equal(run().status, 1);
  assert.equal(run(["gate.json"]).status, 0);
});

test("clean-tree fails on a new untracked file inside a new directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-untracked-"));
  const sh = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env: scrubbedGitEnv() });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "1");
  sh("add", ".");
  sh("commit", "-qm", "base");
  const st = planGate({ changedFiles: [], ...opts, root: dir })[0];
  const run = () =>
    spawnSync(st.cmd[0], st.cmd.slice(1), { cwd: st.cwd, encoding: "utf8", env: scrubbedGitEnv() });
  assert.equal(run().status, 0);
  mkdirSync(path.join(dir, "newdir", "deep"), { recursive: true });
  writeFileSync(path.join(dir, "newdir", "deep", "b.ts"), "x");
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /b\.ts/);
});

test("holdPidFile writes the pid and removes the file on exit and on signals", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "gate-pid-")), "g.pid");
  const handlers = {};
  const exits = [];
  const proc = { pid: 4242, on: (e, fn) => (handlers[e] = fn), exit: (c) => exits.push(c) };
  holdPidFile(f, proc);
  assert.equal(readFileSync(f, "utf8").trim(), "4242");
  handlers.exit();
  assert.equal(existsSync(f), false);
  writeFileSync(f, "4242");
  handlers.SIGTERM();
  assert.equal(existsSync(f), false);
  assert.deepEqual(exits, [143]);
});

test("holdPidFile cleanup keeps the file when a newer gate overwrote it with its own pid", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "gate-pid-")), "g.pid");
  const handlers = {};
  holdPidFile(f, { pid: 4242, on: (e, fn) => (handlers[e] = fn), exit: () => {} });
  writeFileSync(f, "9999\n");
  handlers.exit();
  assert.equal(readFileSync(f, "utf8").trim(), "9999");
});

test("commandLineOf: ps on posix, PowerShell CIM on win32", () => {
  const seen = [];
  const exec = (cmd, args) => (seen.push([cmd, args]), "node /x/gate.mjs --json a");
  assert.equal(commandLineOf(7, { platform: "linux", exec }), "node /x/gate.mjs --json a");
  assert.deepEqual(seen[0], ["ps", ["-p", "7", "-o", "command="]]);
  commandLineOf(7, { platform: "win32", exec });
  assert.equal(seen[1][0], "powershell");
  assert.match(seen[1][1].join(" "), /Win32_Process.*ProcessId=7.*CommandLine/);
  assert.equal(
    commandLineOf(7, {
      exec: () => {
        throw new Error("gone");
      },
    }),
    "",
  );
});

test("stopGate kills only a gate.mjs pid, per platform, and removes the file", () => {
  const mk = (pid) => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), "gate-stop-")), "g.pid");
    writeFileSync(f, `${pid}\n`);
    return f;
  };
  for (const platform of ["linux", "win32"]) {
    const f = mk(321);
    const kills = [];
    const r = stopGate(f, {
      platform,
      exec: () => "node C:\\x\\gate.mjs --json a",
      killTree: (pid, p) => kills.push([pid, p]),
    });
    assert.equal(r.stopped, true);
    assert.deepEqual(kills, [[321, platform]]);
    assert.equal(existsSync(f), false);
  }
  const f2 = mk(654);
  const kills2 = [];
  const r2 = stopGate(f2, {
    exec: () => "/usr/bin/vim notes.txt",
    killTree: (p) => kills2.push(p),
  });
  assert.equal(r2.stopped, false);
  assert.deepEqual(kills2, []);
  assert.equal(existsSync(f2), false);
  assert.equal(stopGate("/no/such/file.pid").stopped, false);
  const f3 = mk("abc");
  assert.equal(stopGate(f3, { exec: () => "gate.mjs" }).stopped, false);
});

test("census steps: an ADDED file under apps/api/prisma, apps/api/scripts or scripts runs both lanes", () => {
  for (const f of [
    "apps/api/scripts/new.mjs",
    "apps/api/prisma/seed-x.ts",
    "scripts/lib/new.mjs",
  ]) {
    const steps = planGate({ changedFiles: [f], addedFiles: [f], ...opts });
    for (const lane of ["unit", "repo-truth"]) {
      const s = step(steps, `census:${lane}`);
      assert.ok(s, `${f} ${lane}`);
      assert.equal(norm(s.cwd), norm("/r/apps/api"));
      assert.deepEqual(s.cmd.slice(2), ["--run-census", lane]);
    }
  }
  const edited = planGate({ changedFiles: ["scripts/x.mjs"], addedFiles: [], ...opts });
  assert.equal(step(edited, "census:unit"), undefined);
  const other = planGate({
    changedFiles: ["apps/api/src/a.ts"],
    addedFiles: ["apps/api/src/a.ts"],
    ...opts,
  });
  assert.equal(step(other, "census:repo-truth"), undefined);
  assert.equal(CENSUS_SPECS.length, 10);
  const rt = CENSUS_LANES.find((l) => l.name === "repo-truth");
  assert.equal(rt.config, "jest.repo-truth.config.js");
  assert.ok(rt.specs.some((s) => s.includes("no-single-schema-path")));
});

test("missingSpecs flags an expected spec that jest did not list", () => {
  const exp = ["src/common/a.spec.ts", "src/common/b.spec.ts"];
  assert.deepEqual(
    missingSpecs("/x/apps/api/src/common/a.spec.ts\n/x/apps/api/src/common/b.spec.ts\n", exp),
    [],
  );
  assert.deepEqual(missingSpecs("C:\\x\\apps\\api\\src\\common\\a.spec.ts\n", exp), [
    "src/common/b.spec.ts",
  ]);
  assert.deepEqual(missingSpecs("", exp), exp);
});

test("runCensusLane fails closed naming the missing spec, and runs jest only when all are listed", () => {
  const lane = CENSUS_LANES.find((l) => l.name === "repo-truth");
  const calls = [];
  const partial = (cmd, args) => (
    calls.push(args),
    { status: 0, stdout: `/x/apps/api/${lane.specs[0]}\n` }
  );
  assert.equal(runCensusLane("repo-truth", { exec: partial }), 1);
  assert.equal(calls.length, 1, "no jest run after a short listing");
  assert.ok(calls[0].includes("--listTests") && calls[0].includes("-c"));
  const calls2 = [];
  const full = (cmd, args) => (
    calls2.push(args),
    { status: 0, stdout: lane.specs.map((s) => `/x/apps/api/${s}`).join("\n") }
  );
  assert.equal(runCensusLane("repo-truth", { exec: full }), 0);
  assert.equal(calls2.length, 2);
  assert.ok(!calls2[1].includes("--listTests") && calls2[1].includes("jest.repo-truth.config.js"));
  assert.equal(runCensusLane("nope"), 2);
});

test("addedSince lists only added files of the merge-base range", () => {
  const calls = [];
  const git = (a) => (calls.push(a), "a.ts\0b.ts\0");
  assert.deepEqual(addedSince(git, "abc"), ["a.ts", "b.ts"]);
  assert.deepEqual(calls[0].slice(0, 3), ["diff", "--name-only", "-z"]);
  assert.ok(calls[0].includes("--diff-filter=A") && calls[0].includes("abc..HEAD"));
});

test("id-labels step: a (B###) commit label outside the given ids fails; row labels pass", () => {
  const steps = planGate({ changedFiles: [], ...opts, ids: ["599", "W-679"], idSpace: "row" });
  const s = step(steps, "id-labels");
  assert.ok(s);
  assert.equal(names(steps).indexOf("id-labels") > names(steps).indexOf("commitlint"), true);
  assert.equal(step(planGate({ changedFiles: [], ...opts }), "id-labels"), undefined);
  const dir = mkdtempSync(path.join(tmpdir(), "gate-idl-"));
  const sh = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env: scrubbedGitEnv() });
  sh("init", "-q");
  sh("config", "user.email", "t@t");
  sh("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "1");
  sh("add", ".");
  sh("commit", "-qm", "base");
  const base = sh("rev-parse", "HEAD").stdout.trim();
  const plan = planGate({
    changedFiles: [],
    ...opts,
    base,
    root: dir,
    ids: ["599", "W-679"],
    idSpace: "row",
  });
  const st = step(plan, "id-labels");
  const run = () =>
    spawnSync(st.cmd[0], st.cmd.slice(1), { cwd: dir, encoding: "utf8", env: scrubbedGitEnv() });
  writeFileSync(path.join(dir, "a.txt"), "2");
  sh("commit", "-qam", "fix(x): thing (row 599)");
  writeFileSync(path.join(dir, "a.txt"), "3");
  sh("commit", "-qam", "fix(x): other (W-679)");
  assert.equal(run().status, 0);
  writeFileSync(path.join(dir, "a.txt"), "4");
  sh("commit", "-qam", "fix(x): translated (B668)");
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /B668/);
});
