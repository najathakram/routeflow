#!/usr/bin/env node
/**
 * Self-test for `sync` on origin/master (B1-b2a, SPEC v3.2 "Sync"): clone mode scans routeflow's
 * origin/master after a fetch that never prompts; tracked mode still scans HEAD.
 *
 * A planted routeflow repo (BUGS_SYNC_REPO, honoured only under BUGS_SELF_TEST=1) stands in for the
 * real one; the register is the shared bare-repo fixture. Everything runs the real bugs.mjs in clone
 * mode. Run: `node scripts/registry-land.self-test.mjs`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, git } from "./lib/registry-fixture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUGS = join(ROOT, "scripts", "campaign", "bugs.mjs");
const fx = fixture("rf-regland-");
const { tmp, check, section, env } = fx;
const fwd = (p) => p.replaceAll("\\", "/");

fx.world();
const A = fx.clone("a");
const commit = (dir, msg) => {
  appendFileSync(join(dir, "f.txt"), `${msg}\n`);
  git(dir, "add", "f.txt");
  git(dir, "commit", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
};

const an = (n) => join(tmp, `anchor-${n}.json`);
const regEnv = (dir, anchor, extra = {}) =>
  env({
    RF_REGISTRY_DIR: dir,
    RF_REGISTRY_MODE_TEST: "clone",
    BUGS_SELF_TEST: "1",
    BUGS_SYNC_STATE: anchor,
    ...extra,
  });
const run = (script, args, e, cwd = tmp) =>
  spawnSync("node", [script, ...args], { encoding: "utf8", env: e, cwd });
const anchorSha = (n) => JSON.parse(readFileSync(an(n), "utf8")).lastSha;

async function main() {
  await section("sync on origin/master; tracked mode unchanged", async () => {
    const sy = join(tmp, "sy");
    git(tmp, "init", "--bare", "--initial-branch=master", join(tmp, "sy.git"));
    git(tmp, "clone", join(tmp, "sy.git"), "sy");
    commit(sy, "feat: pushed");
    git(sy, "push", "origin", "HEAD:master");
    commit(sy, "feat: local only");
    const elsewhere = join(tmp, "elsewhere-repo");
    git(tmp, "init", "--initial-branch=master", elsewhere);
    commit(elsewhere, "feat: elsewhere");
    const reg = join(tmp, "fixture-reg");
    mkdirSync(join(reg, "status"), { recursive: true });
    writeFileSync(join(reg, "bugs.jsonl"), "");
    const probe = join(tmp, "probe.mjs");
    const seenEnv = join(tmp, "seen-env.json");
    writeFileSync(
      probe,
      `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const { GIT_TERMINAL_PROMPT: p, GCM_INTERACTIVE: g } = process.env;
writeFileSync(${JSON.stringify(seenEnv)}, JSON.stringify([p, g]));
process.exit(spawnSync("git", ["upload-pack", ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);
`,
    );
    const sync = (extra, cwd) => {
      rmSync(an("s"), { force: true });
      const e = { ...regEnv(A, an("s"), { BUGS_SYNC_REPO: sy, BUGS_ROOT: reg }), ...extra };
      for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
      run(BUGS, ["sync", "--quiet"], e, cwd);
      return anchorSha("s");
    };
    const mark = { RF_REGISTRY_MODE_TEST: undefined };
    check(
      "clone mode anchors on origin/master",
      sync({}),
      git(sy, "rev-parse", "refs/remotes/origin/master"),
    );
    git(tmp, "clone", join(tmp, "sy.git"), "sy2");
    commit(join(tmp, "sy2"), "feat: landed elsewhere");
    git(join(tmp, "sy2"), "push", "origin", "HEAD:master");
    git(sy, "config", "remote.origin.uploadpack", `node ${fwd(probe)}`);
    check(
      "clone mode fetches first: a stale local origin/master is refreshed",
      sync({}),
      git(join(tmp, "sy2"), "rev-parse", "HEAD"),
    );
    check(
      "the fetch never prompts: GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never",
      JSON.parse(readFileSync(seenEnv, "utf8")),
      ["0", "never"],
    );
    git(sy, "config", "--unset", "remote.origin.uploadpack");
    check("tracked mode still anchors on HEAD", sync(mark), git(sy, "rev-parse", "HEAD"));
    check(
      "BUGS_SYNC_REPO is ignored without BUGS_SELF_TEST: git runs in the cwd",
      sync({ ...mark, BUGS_SELF_TEST: undefined }, elsewhere),
      git(elsewhere, "rev-parse", "HEAD"),
    );
    const src = readFileSync(BUGS, "utf8");
    check(
      "the sync git calls carry REGISTRY_GIT_TIMEOUT_MS in clone mode only",
      src.includes('registryMode() === "clone" ? { timeout: REGISTRY_GIT_TIMEOUT_MS }'),
      true,
    );
  });
}

await main();
fx.finish("registry-land");
