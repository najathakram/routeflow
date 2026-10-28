#!/usr/bin/env node
// Coverage for Gate 4 (register report) and the clone-mode half of Gate 5 in
// `.claude/hooks/stop.mjs` (B1-b3, SPEC v3.2 lines 277-280 and the red row at 215).
//
// Tracked mode (today) must behave exactly as before: Gate 4 spawns `bugs.mjs sync`. Clone mode is
// reached through the registry-root test hook (RF_REGISTRY_MODE_TEST=clone + RF_REGISTRY_DIR +
// BUGS_SELF_TEST=1): Gate 4 becomes a read-only lag report (never a writer, bounded at 5 s) and
// Gate 5 reads the dirty check and the usage guard from the clone. Every case runs the REAL
// stop.mjs against a throwaway main checkout on master, plus a throwaway clone.
//
// Plain node script, like stop.gate5.spec.mjs: `node .claude/hooks/stop.gate4.spec.mjs`.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scrubbedGitEnv } from "../../scripts/lib/check-git-hooks.mjs";

const STOP_HOOK = fileURLToPath(new URL("./stop.mjs", import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "stop-gate4-spec-")));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const env = (extra = {}) => {
  const e = scrubbedGitEnv();
  delete e.PLANE_API_KEY;
  return { ...e, ...extra };
};
const git = (cwd, args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    env: env(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
};

// Stand-ins for the two child scripts. bugs.mjs records that it ran; plane-sync echoes its argv.
const SYNC_FIXTURE = `
import { writeFileSync } from "node:fs";
writeFileSync("sync-ran", "1");
process.stdout.write("recorded 2 new event(s)\\n");
`;
const PLANE_FIXTURE = `
process.stdout.write("Plane mirror: argv " + JSON.stringify(process.argv.slice(2)) + "\\n");
`;

let n = 0;
const fresh = (label) => join(TMP, `${label}-${n++}`);

// The main checkout, on master: two commits, origin/master at the tip.
function makeMain({ tracked = false } = {}) {
  const dir = fresh("main");
  mkdirSync(join(dir, "scripts", "campaign"), { recursive: true });
  git(dir, ["init", "-q", "-b", "master", dir]);
  writeFileSync(join(dir, "scripts", "campaign", "bugs.mjs"), SYNC_FIXTURE);
  writeFileSync(join(dir, "scripts", "campaign", "plane-sync.mjs"), PLANE_FIXTURE);
  if (tracked) {
    mkdirSync(join(dir, ".claude", "campaign", "bugs"), { recursive: true });
    writeFileSync(join(dir, ".claude", "campaign", "bugs", "B1.md"), "# B1\n");
    writeFileSync(join(dir, ".claude", "campaign", "bugs.jsonl"), '{"id":"B1"}\n');
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: one"]);
  const first = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "chore: two"]);
  git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  return { dir, first, tip: git(dir, ["rev-parse", "HEAD"]) };
}

// The register clone: origin/main at the tip, HEAD `behind` commits back.
function makeClone({ behind = 0 } = {}) {
  const dir = fresh("clone");
  const reg = join(dir, "registry", "campaign");
  mkdirSync(join(reg, "status"), { recursive: true });
  git(dir, ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(reg, "bugs.jsonl"), '{"id":"B1"}\n');
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: seed"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(reg, "status", "B1.json"), "{}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: status"]);
  const tip = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", tip]);
  if (behind) git(dir, ["reset", "-q", "--hard", base]);
  return { dir, reg, tip, base };
}

function runHook(cwd, extra = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [STOP_HOOK], {
    cwd,
    encoding: "utf8",
    env: env(extra),
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", ms: Date.now() - t0 };
}

const cloneEnv = (clone, anchor, extra = {}) => ({
  RF_REGISTRY_MODE_TEST: "clone",
  RF_REGISTRY_DIR: clone,
  BUGS_SELF_TEST: "1",
  BUGS_SYNC_STATE: anchor,
  PLANE_SYNC_SELF_TEST: "1",
  PLANE_RUNS_PATH: join(TMP, "runs.jsonl"),
  ...extra,
});
const anchorFile = (sha) => {
  const p = fresh("anchor") + ".json";
  if (sha) writeFileSync(p, JSON.stringify({ lastSha: sha }));
  return p;
};

let failed = 0;
const check = (name, ok, res) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failed++;
    if (res) console.log(`      exit=${res.status}\n      stderr:\n${res.stderr}`);
  }
};
const bugLines = (r) => r.stderr.split(/\r?\n/).filter((l) => l.startsWith("Bug registry:"));

// 1. Tracked mode: Gate 4 still runs sync, with the same message.
{
  const m = makeMain({ tracked: true });
  const r = runHook(m.dir);
  check(
    "tracked: sync runs, output unchanged",
    r.status === 0 &&
      existsSync(join(m.dir, "sync-ran")) &&
      r.stderr.includes(
        "Bug registry: recorded 2 new event(s) into .claude/campaign/bugs/ — commit them alongside your change.",
      ) &&
      !r.stderr.includes("registry:clone"),
    r,
  );
}

// 2. Clone mode, clone missing: both gates name the clone and the fix; sync never runs.
{
  const m = makeMain();
  const missing = fresh("nowhere");
  const r = runHook(m.dir, cloneEnv(missing, anchorFile(m.tip)));
  const fixes = r.stderr.split("npm run registry:clone").length - 1;
  check(
    "clone missing: both gates print the fix line",
    r.status === 0 &&
      fixes >= 2 &&
      r.stderr.includes(missing) &&
      !existsSync(join(m.dir, "sync-ran")),
    r,
  );
}

// 3. Clone behind origin/main.
{
  const m = makeMain();
  const c = makeClone({ behind: 1 });
  const r = runHook(m.dir, cloneEnv(c.dir, anchorFile(m.tip)));
  check(
    "clone behind origin/main: prints the lag and the land command",
    r.status === 0 &&
      /clone is 1 commit\(s\) behind origin\/main/.test(r.stderr) &&
      r.stderr.includes("npm run registry:land"),
    r,
  );
}

// 4. Anchor behind origin/master.
{
  const m = makeMain();
  const c = makeClone();
  const r = runHook(m.dir, cloneEnv(c.dir, anchorFile(m.first)));
  check(
    "anchor behind origin/master: prints the lag",
    r.status === 0 && /anchor is 1 commit\(s\) behind origin\/master/.test(r.stderr),
    r,
  );
}

// 5. Anchor missing.
{
  const m = makeMain();
  const c = makeClone();
  const r = runHook(m.dir, cloneEnv(c.dir, anchorFile(null)));
  check(
    "anchor missing: names --rescan",
    r.status === 0 && /anchor/.test(bugLines(r).join("\n")) && r.stderr.includes("--rescan"),
    r,
  );
}

// 6. Up to date: Gate 4 says nothing.
{
  const m = makeMain();
  const c = makeClone();
  const r = runHook(m.dir, cloneEnv(c.dir, anchorFile(m.tip)));
  check(
    "up to date: no Bug registry line, no sync",
    r.status === 0 && bugLines(r).length === 0 && !existsSync(join(m.dir, "sync-ran")),
    r,
  );
}

// 7. Gate 4 is never a writer.
{
  const m = makeMain();
  const c = makeClone({ behind: 1 });
  const before = [
    git(c.dir, ["rev-parse", "HEAD"]),
    readFileSync(join(c.reg, "bugs.jsonl"), "utf8"),
  ];
  const r = runHook(m.dir, cloneEnv(c.dir, anchorFile(m.first)));
  const after = [
    git(c.dir, ["rev-parse", "HEAD"]),
    readFileSync(join(c.reg, "bugs.jsonl"), "utf8"),
  ];
  check(
    "never writes: no sync spawned, clone HEAD and files unchanged, clone clean",
    r.status === 0 &&
      !existsSync(join(m.dir, "sync-ran")) &&
      JSON.stringify(before) === JSON.stringify(after) &&
      git(c.dir, ["status", "--porcelain"]) === "",
    r,
  );
}

// 8. A slow git is cut at 5 s. Windows' spawnSync does not resolve a .cmd shim from PATH, so the
// shim cannot be planted there: the case is skipped on win32 (said loudly, not hidden).
if (process.platform === "win32") {
  console.log(
    "SKIP  slow git is cut at 5 s (a PATH git shim is not honoured by spawnSync on win32)",
  );
} else {
  const m = makeMain();
  const c = makeClone({ behind: 1 });
  const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const shimDir = fresh("shim");
  mkdirSync(shimDir);
  writeFileSync(
    join(shimDir, "git"),
    `#!/bin/sh\ncase " $* " in *" rev-list "*) sleep 30;; esac\nexec "${real}" "$@"\n`,
  );
  chmodSync(join(shimDir, "git"), 0o755);
  const r = runHook(
    m.dir,
    cloneEnv(c.dir, anchorFile(m.tip), { PATH: `${shimDir}:${process.env.PATH}` }),
  );
  check(
    "slow git: cut at 5 s with one skipped (timeout) line",
    r.status === 0 && r.ms < 20_000 && r.stderr.includes("skipped (timeout)"),
    r,
  );
}

// 9. Gate 5's dirty check reads the clone.
{
  const m = makeMain();
  const c = makeClone();
  const clean = runHook(m.dir, cloneEnv(c.dir, anchorFile(m.tip)));
  writeFileSync(join(c.reg, "bugs.jsonl"), '{"id":"B1","edited":true}\n');
  const dirty = runHook(m.dir, cloneEnv(c.dir, anchorFile(m.tip)));
  check(
    "gate 5 dirty check: clean clone digest-gated, dirty clone not",
    clean.stderr.includes("--if-digest-changed") && !dirty.stderr.includes("--if-digest-changed"),
    dirty,
  );
}

// 10. Gate 5's usage guard reads the clone's status history.
{
  const m = makeMain();
  const c = makeClone();
  const sha = git(c.dir, [
    "log",
    "-1",
    "--format=%H",
    "origin/main",
    "--",
    "registry/campaign/status",
  ]);
  const r = runHook(m.dir, cloneEnv(c.dir, anchorFile(m.tip)));
  check(
    "gate 5 usage guard: landing sha comes from the clone",
    r.status === 0 && r.stderr.includes(`Plane: WARN landing without sync (${sha})`),
    r,
  );
}

console.log(failed ? `\nstop.gate4.spec FAILED — ${failed} case(s).` : "\nstop.gate4.spec PASS");
process.exit(failed ? 1 : 0);
