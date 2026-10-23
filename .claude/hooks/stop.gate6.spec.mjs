#!/usr/bin/env node
// Coverage for Gate 6 of `.claude/hooks/stop.mjs`: the Design Gate reference check (owner ruling R19,
// 2026-10-08; see `.claude/skills/future-proof/`).
//
// Gate 6 is WARN-ONLY (dark), so every case below must exit 0. The warning appears only when a feat/* or
// fix/* branch that touches code has neither of these:
//   - a matched spec with a `## Design Gate` block;
//   - a HEAD commit body that mentions one.
//
// This follows the convention of stop.gates.spec.mjs and stop.gate5.spec.mjs: a plain node script, run
// as `node .claude/hooks/stop.gate6.spec.mjs`. Each case builds a disposable git repo and spawns the
// REAL stop.mjs against it.
//
// The scaffold keeps Gates 1 to 5 out of the way:
//   - it never creates .claude/code-map/_meta.json or .claude/lessons/LESSONS.md;
//   - its code file is a .prisma file, which Gate 1's prettier check skips;
//   - Gates 4 and 5 need files the scaffold never has.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const STOP_HOOK = fileURLToPath(new URL("./stop.mjs", import.meta.url));
const WARN = "Design Gate (R19, dark — warn only)";
const GATE =
  "# SA-747\n\n## Design Gate (Lite) — SA-747 · 2026-10-08 · base 1bf58be42\n- G1 Fit: x\n";

// Git exports repo-scoped variables into every hook it runs. Scrub them, so that a throwaway repo is never
// silently re-pointed at the real one (the same hazard stop.gate5.spec.mjs handles).
const GIT_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];
function cleanEnv() {
  const env = { ...process.env };
  for (const k of GIT_KEYS) delete env[k];
  return env;
}
function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  if (res.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  return res;
}
function write(dir, rel, text) {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

// Options:
//   skill:  whether the future-proof skill exists in the repo.
//   branch: checked out after the master seed commit.
//   spec:   { name, text }, written to local-assets/specs/.
//   code:   "uncommitted", "committed" or "none".
//   body:   the message of the HEAD commit on the branch.
function makeRepo({ skill = true, branch = null, spec = null, code = "uncommitted", body = null }) {
  const dir = mkdtempSync(join(tmpdir(), "stop-gate6-spec-"));
  git(dir, ["init", "-q"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  git(dir, ["config", "user.email", "stop-gate6-spec@example.com"]);
  git(dir, ["config", "user.name", "stop-gate6-spec"]);
  write(dir, "README.md", "seed\n");
  if (skill) write(dir, ".claude/skills/future-proof/SKILL.md", "---\nname: future-proof\n---\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: seed"]);
  if (branch) git(dir, ["checkout", "-q", "-b", branch]);
  if (spec) write(dir, `local-assets/specs/${spec.name}`, spec.text);
  if (code === "committed") {
    write(dir, "apps/api/schema.prisma", "// committed change\n");
    git(dir, ["add", "apps"]);
    git(dir, ["commit", "-q", "-m", body || "feat: change"]);
  } else {
    if (body) git(dir, ["commit", "-q", "--allow-empty", "-m", body]);
    if (code === "uncommitted") write(dir, "apps/api/schema.prisma", "// scenario change\n");
  }
  return dir;
}

function runStopHook(cwd) {
  return spawnSync(process.execPath, [STOP_HOOK], { cwd, encoding: "utf8", env: cleanEnv() });
}

const cases = [
  {
    name: "feat branch with uncommitted code, no spec, plain commit: warns, exit 0",
    repo: { branch: "feat/no-gate" },
    warn: true,
  },
  {
    name: "code committed since master and no gate anywhere: warns (merge-base path)",
    repo: { branch: "feat/committed", code: "committed" },
    warn: true,
  },
  {
    name: "spec matched by an SA id and carrying a Design Gate block: silent",
    repo: {
      branch: "feat/sa-747-quick-keys",
      spec: { name: "sa-747-pos-quick-keys.md", text: GATE },
    },
    warn: false,
  },
  {
    name: "spec matched by a bug id and carrying a Design Gate block: silent",
    repo: {
      branch: "fix/b1036-driver-price",
      spec: { name: "sa-753-b1036-driver-tier-price.md", text: GATE },
    },
    warn: false,
  },
  {
    name: "spec matched by the branch slug and carrying a Design Gate block: silent",
    repo: { branch: "feat/pos-quick-keys", spec: { name: "sa-747-pos-quick-keys.md", text: GATE } },
    warn: false,
  },
  {
    name: "a matched spec with no gate: warns, and counts the spec",
    repo: {
      branch: "feat/sa-747-quick-keys",
      spec: { name: "sa-747-pos-quick-keys.md", text: "# SA-747\n\nNo gate.\n" },
    },
    warn: true,
    extra: (r) => r.stderr.includes("1 matched spec(s)"),
  },
  {
    name: "an unrelated spec with a gate does not satisfy the branch: warns",
    repo: { branch: "feat/sa-748-park", spec: { name: "sa-747-pos-quick-keys.md", text: GATE } },
    warn: true,
    extra: (r) => r.stderr.includes("0 matched spec(s)"),
  },
  {
    name: "a Design-Gate trailer in the HEAD commit body: silent",
    repo: {
      branch: "feat/trailer",
      code: "committed",
      body: "feat: x\n\nDesign-Gate: local-assets/specs/sa-999-x.md",
    },
    warn: false,
  },
  {
    name: "a Lite gate quoted in the HEAD commit body: silent",
    repo: {
      branch: "fix/lite-in-body",
      body: "fix: y\n\nDesign Gate (Lite) — B9999 · 2026-10-08 · base 1bf58be42",
    },
    warn: false,
  },
  {
    name: "a branch that touches no code: silent",
    repo: { branch: "feat/docs-only", code: "none" },
    warn: false,
  },
  {
    name: "master with code changes: silent (only feat/* and fix/* are checked)",
    repo: { branch: null },
    warn: false,
  },
  {
    name: "a checkout without the future-proof skill: silent (the gate is inactive)",
    repo: { skill: false, branch: "feat/no-skill" },
    warn: false,
  },
];

let failed = 0;
const report = (name, ok, res) => {
  if (ok) {
    console.log(`PASS  ${name}`);
    return;
  }
  failed++;
  console.log(
    `FAIL  ${name}\n      exit ${res.status}\n      stdout:\n${res.stdout}\n      stderr:\n${res.stderr}`,
  );
};

for (const c of cases) {
  const dir = makeRepo(c.repo);
  try {
    const res = runStopHook(dir);
    const warned = res.stderr.includes(WARN);
    report(c.name, res.status === 0 && warned === c.warn && (!c.extra || c.extra(res)), res);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A lane worktree has no local-assets/ of its own. Gate 6 must find the spec in the MAIN checkout's
// local-assets/specs, which it reaches through `git rev-parse --git-common-dir`.
{
  const main = makeRepo({
    branch: null,
    code: "none",
    spec: { name: "sa-747-pos-quick-keys.md", text: GATE },
  });
  const lane = mkdtempSync(join(tmpdir(), "stop-gate6-spec-lane-"));
  try {
    rmSync(lane, { recursive: true, force: true }); // git worktree add wants a missing or empty path
    git(main, ["worktree", "add", "-q", "-b", "feat/sa-747-lane", lane]);
    write(lane, "apps/api/schema.prisma", "// lane change\n");
    const res = runStopHook(lane);
    report(
      "a lane worktree finds the gate in the main checkout's local-assets/specs: silent",
      res.status === 0 && !res.stderr.includes(WARN),
      res,
    );
  } finally {
    rmSync(lane, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  }
}

const total = cases.length + 1;
if (failed > 0) {
  console.log(`\nstop.gate6.spec FAILED: ${failed}/${total} case(s).`);
  process.exit(1);
}
console.log(`\nstop.gate6.spec PASS (${total}/${total} cases)`);
process.exit(0);
