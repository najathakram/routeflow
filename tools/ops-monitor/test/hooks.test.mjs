import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const POST = join(REPO, ".claude", "hooks", "ops-post-push.mjs");
const STOP = join(REPO, ".claude", "hooks", "ops-stop.mjs");
const RF = join(REPO, "tools", "ops-monitor", "bin", "rf.mjs");

const { detectOpsActions, branchFromRefspec, splitCommand, tokenize } = await import(
  pathToUrl(POST)
);
const { evaluateGate, nextBlockState, missingHash } = await import(pathToUrl(STOP));
const { actionsFile, appendAction, readActions, archiveActions, sanitizeSessionId } = await import(
  pathToUrl(join(REPO, "tools", "ops-monitor", "lib", "turn-actions.mjs"))
);

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}
const detect = (cmd, res = {}) => detectOpsActions(cmd, res);
const MERGED_3515 = { stderr: "✓ Squashed and merged pull request #3515 (feat: x)\n" };

// ── detectOpsActions ────────────────────────────────────────────────────────
test("detect: git push -u origin feat/x", () => {
  assert.deepEqual(detect("git push -u origin feat/x"), [
    { kind: "push", remote: "origin", refspec: "feat/x" },
  ]);
});

test("detect: git -C dir push with HEAD:refs/heads refspec", () => {
  const [a] = detect("git -C ../a push origin HEAD:refs/heads/fix/b12");
  assert.equal(a.kind, "push");
  assert.equal(a.remote, "origin");
  assert.equal(a.refspec, "HEAD:refs/heads/fix/b12");
  assert.equal(a.dir, "../a");
  assert.equal(branchFromRefspec(a.refspec), "fix/b12");
});

test("detect: refspec destination forms", () => {
  assert.equal(branchFromRefspec("x:y"), "y");
  assert.equal(branchFromRefspec("x"), "x");
  assert.equal(branchFromRefspec("+x:refs/heads/z"), "z");
  assert.equal(branchFromRefspec("HEAD"), null);
  assert.equal(branchFromRefspec(null), null);
});

test("detect: echo git push is not an action", () => {
  assert.deepEqual(detect("echo git push origin x"), []);
});

test("detect: chained git add . && git push", () => {
  const out = detect("git add . && git push origin feat/y");
  assert.equal(out.length, 1);
  assert.equal(out[0].refspec, "feat/y");
});

test("detect: interrupted, delete, dry-run and tag pushes are not actions", () => {
  assert.deepEqual(detect("git push origin x", { interrupted: true }), []);
  assert.deepEqual(detect("git push origin --delete x"), []);
  assert.deepEqual(detect("git push --dry-run origin x"), []);
  assert.deepEqual(detect("git push origin :x"), []);
  assert.deepEqual(detect("git push origin refs/tags/v1"), []);
});

test("detect: gh pr merge 3515 --merge needs the success line", () => {
  assert.deepEqual(detect("gh pr merge 3515 --merge", MERGED_3515), [
    { kind: "pr", action: "merge", number: 3515 },
  ]);
  assert.deepEqual(detect("gh pr merge 3515 --merge"), []);
  assert.deepEqual(
    detect("gh pr merge 3515 --merge", { stderr: "X Pull request is not mergeable" }),
    [],
  );
  assert.deepEqual(
    detect("gh pr merge 3515 --auto", {
      stderr: "✓ Pull request #3515 will be automatically merged",
    }),
    [],
  );
});

test("detect: merge number comes from the success line first", () => {
  assert.deepEqual(detect("gh pr merge --squash", MERGED_3515), [
    { kind: "pr", action: "merge", number: 3515 },
  ]);
  assert.deepEqual(detect("gh pr merge 99", { stdout: "Merged pull request #3516" }), [
    { kind: "pr", action: "merge", number: 3516 },
  ]);
});

test("detect: gh pr create takes the number from the URL in stdout", () => {
  const out = detect('gh pr create --title "feat: x" --body "y"', {
    stdout: "https://github.com/najathakram/routeflow/pull/4001\n",
  });
  assert.deepEqual(out, [{ kind: "pr", action: "create", number: 4001 }]);
});

test("detect: failed gh call and other repos are not actions", () => {
  assert.deepEqual(detect("gh pr create", { stderr: "GraphQL: Resource not accessible" }), []);
  assert.deepEqual(detect("gh pr create --title x"), []);
  assert.deepEqual(detect("gh pr merge 5 --repo acme/other", MERGED_3515), []);
  assert.deepEqual(detect("gh pr view 5"), []);
});

test("detect: ready / close need a PR reference and no error line", () => {
  assert.deepEqual(
    detect("gh pr ready 12", { stderr: '✓ Pull request #12 is marked as "ready for review"' }),
    [{ kind: "pr", action: "ready", number: 12 }],
  );
  assert.deepEqual(detect("gh pr close 12", { stderr: "✓ Closed pull request #12 (x)" }), [
    { kind: "pr", action: "close", number: 12 },
  ]);
  assert.deepEqual(
    detect("gh pr close 12", { stderr: "GraphQL: Could not resolve to a PullRequest #12" }),
    [],
  );
  assert.deepEqual(detect("gh pr close 12", { stderr: "no pull requests found for branch x" }), []);
  assert.deepEqual(detect("gh pr ready 12"), []);
});

test("detect: a heredoc body never counts as a command", () => {
  const cmd = "cat <<'EOF'\ngh pr merge 3513\ngit push origin feat/x\nEOF\ngit status";
  assert.deepEqual(detect(cmd, { stderr: "✓ Squashed and merged pull request #3513 (x)" }), []);
  assert.deepEqual(
    splitCommand(cmd).map((x) => x.trim()),
    ["cat <<'EOF'", "git status"],
  );
  const dash = "cat <<-EOF\n\tgit push origin x\n\tEOF\ngit push origin y";
  assert.deepEqual(detect(dash), [{ kind: "push", remote: "origin", refspec: "y" }]);
});

test("detect: separators inside quotes and substitutions do not split or run", () => {
  assert.deepEqual(detect('echo "git push"'), []);
  assert.deepEqual(detect('echo "ok; git push origin x" > log'), []);
  assert.deepEqual(detect("echo 'a && git push origin x'"), []);
  assert.deepEqual(detect("echo $(git push origin x)"), []);
  assert.deepEqual(detect("echo `git push origin x`"), []);
  assert.deepEqual(splitCommand('a "b | c" && d || e; f | g\nh'), [
    'a "b | c" ',
    " d ",
    " e",
    " f ",
    " g",
    "h",
  ]);
});

test("detect: env assignments with quoted values and redirections are dropped", () => {
  assert.deepEqual(
    detect('SKIP_VERIFY=1 SKIP_VERIFY_REASON="docs only" git push origin feat/x 2>&1 | tail -5'),
    [{ kind: "push", remote: "origin", refspec: "feat/x" }],
  );
  assert.deepEqual(detect("A='x y' git push origin feat/x > out.txt"), [
    { kind: "push", remote: "origin", refspec: "feat/x" },
  ]);
  assert.deepEqual(tokenize('git push origin x 2>&1 &>log < in "a>b"'), [
    "git",
    "push",
    "origin",
    "x",
    "a>b",
  ]);
});

// ── evaluateGate ────────────────────────────────────────────────────────────
const T0 = Date.parse("2026-10-19T10:00:00Z");
function stateWith({ items = [], pushes = [], prEvents = [] } = {}) {
  const map = new Map();
  for (const i of items) {
    map.set(i.id, {
      links: { prs: [], branches: [], urls: [] },
      history: [],
      ...i,
    });
  }
  return { items: map, pushes, prEvents };
}
const SHA = "a".repeat(40);
const pushAct = { ts: T0, kind: "push", branch: "feat/x", sha: SHA };

test("gate: recorded and linked push is ok", () => {
  const state = stateWith({
    items: [{ id: "525" }],
    pushes: [{ ts: T0 + 1000, branch: "feat/x", sha: SHA, item: "525" }],
  });
  assert.deepEqual(evaluateGate({ actions: [pushAct], state, now: T0 }), { ok: true });
});

test("gate: unrecorded push is missing with the record fix", () => {
  const r = evaluateGate({ actions: [pushAct], state: stateWith(), now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.missing[0].why, "push not recorded");
  assert.match(
    r.missing[0].fix,
    /event push --branch feat\/x --sha a{40} --repo najathakram\/routeflow/,
  );
});

test("gate: same branch within 5 minutes counts as recorded; older does not", () => {
  const ok = stateWith({
    items: [{ id: "525" }],
    pushes: [{ ts: T0 - 4 * 60000, branch: "feat/x", sha: "b".repeat(40), item: "525" }],
  });
  assert.equal(evaluateGate({ actions: [pushAct], state: ok, now: T0 }).ok, true);
  const old = stateWith({
    pushes: [{ ts: T0 - 6 * 60000, branch: "feat/x", sha: "b".repeat(40), item: "525" }],
  });
  assert.equal(evaluateGate({ actions: [pushAct], state: old, now: T0 }).ok, false);
});

test("gate: recorded push without an item is missing with the link fix", () => {
  const state = stateWith({ pushes: [{ ts: T0, branch: "feat/x", sha: SHA, item: null }] });
  const r = evaluateGate({ actions: [pushAct], state, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.missing[0].why, "branch feat/x is not linked to an item");
  assert.match(r.missing[0].fix, /event link <id> --branch feat\/x/);
});

test("gate: a later branch link satisfies the push", () => {
  const state = stateWith({
    items: [{ id: "7", links: { prs: [], branches: ["feat/x"], urls: [] } }],
    pushes: [{ ts: T0, branch: "feat/x", sha: SHA, item: null }],
  });
  assert.equal(evaluateGate({ actions: [pushAct], state, now: T0 }).ok, true);
});

test("gate: push to master needs no item link", () => {
  const state = stateWith({ pushes: [{ ts: T0, branch: "master", sha: SHA, item: null }] });
  const a = { ts: T0, kind: "push", branch: "master", sha: SHA };
  assert.equal(evaluateGate({ actions: [a], state, now: T0 }).ok, true);
});

test("gate: PR create needs a linked item", () => {
  const act = { ts: T0, kind: "pr", action: "create", number: 3600, branch: "feat/x" };
  const bad = evaluateGate({ actions: [act], state: stateWith(), now: T0 });
  assert.equal(bad.ok, false);
  assert.match(bad.missing[0].fix, /event link <id> --pr 3600/);
  const good = stateWith({
    items: [{ id: "9", links: { prs: [3600], branches: [], urls: [] } }],
  });
  assert.equal(evaluateGate({ actions: [act], state: good, now: T0 }).ok, true);
});

test("gate: PR merge without a status event is missing; with one is ok", () => {
  const act = { ts: T0, kind: "pr", action: "merge", number: 3515, branch: null };
  const linked = {
    id: "525",
    links: { prs: [3515], branches: [], urls: [] },
  };
  const bad = evaluateGate({
    actions: [act],
    state: stateWith({ items: [{ ...linked }] }),
    now: T0,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.missing[0].why, "PR #3515 merged but item 525 has no status event");
  assert.match(bad.missing[0].fix, /status 525 shipping/);
  const stale = { ...linked, history: [{ ts: T0 - 6 * 60000, kind: "status", status: "live" }] };
  assert.equal(
    evaluateGate({ actions: [act], state: stateWith({ items: [stale] }), now: T0 }).ok,
    false,
  );
  const good = { ...linked, history: [{ ts: T0 + 1000, kind: "status", status: "shipping" }] };
  assert.equal(
    evaluateGate({ actions: [act], state: stateWith({ items: [good] }), now: T0 }).ok,
    true,
  );
});

test("gate: close/edit carry no obligation; unidentifiable PR fails open", () => {
  const acts = [
    { ts: T0, kind: "pr", action: "close", number: 1, branch: null },
    { ts: T0, kind: "pr", action: "edit", number: 2, branch: null },
    { ts: T0, kind: "pr", action: "merge", number: null, branch: null },
  ];
  assert.equal(evaluateGate({ actions: acts, state: stateWith(), now: T0 }).ok, true);
});

test("loop guard: third identical block is allowed", () => {
  const h = missingHash([{ action: { kind: "push", branch: "b" }, why: "w" }]);
  const a = nextBlockState(null, h);
  const b = nextBlockState(a.record, h);
  const c = nextBlockState(b.record, h);
  assert.deepEqual([a.block, b.block, c.block], [true, true, false]);
  assert.equal(nextBlockState(b.record, "other").block, true);
});

// ── turn-actions ────────────────────────────────────────────────────────────
test("turn-actions: sanitize, append, read, archive keeps 5", () => {
  const home = mkdtempSync(join(tmpdir(), "rf-ta-"));
  assert.equal(sanitizeSessionId("../../x y"), "_x_y");
  assert.equal(sanitizeSessionId(""), "unknown");
  const file = actionsFile(home, "s/1");
  assert.equal(file, join(home, "turn-actions", "s_1.jsonl"));
  assert.deepEqual(readActions(file), []);
  appendAction(file, { ts: 1, kind: "push" });
  writeFileSync(file, `${readFileSync(file, "utf8")}{torn\n`);
  appendAction(file, { ts: 2, kind: "pr" });
  assert.deepEqual(
    readActions(file).map((a) => a.ts),
    [1, 2],
  );
  for (let i = 1; i <= 7; i++) {
    appendAction(file, { ts: i });
    archiveActions(file, 1000 + i);
  }
  assert.equal(existsSync(file), false);
  const done = readdirSync(dirname(file)).filter((n) => n.includes(".done-"));
  assert.equal(done.length, 5);
  assert.ok(done.includes("s_1.jsonl.done-1007"));
});

// ── child processes ─────────────────────────────────────────────────────────
function mkEnv() {
  const root = mkdtempSync(join(tmpdir(), "rf-hooks-"));
  const home = join(root, "ops");
  const specs = join(root, "specs");
  mkdirSync(join(specs, "events", "testbox"), { recursive: true });
  return { root, home, specs };
}
let seq = 0;
function ev(kind, item, data, ts, lane = null) {
  seq++;
  return {
    v: 1,
    id: `testbox-${String(Date.parse(ts)).padStart(13, "0")}-${String(seq)
      .padStart(4, "0")
      .replace(/\d/g, (d) => "abcdefghij"[d])}`,
    ts,
    machine: "testbox",
    actor: "tester",
    lane,
    kind,
    item,
    data,
  };
}
function writeEvents(env, events) {
  writeFileSync(
    join(env.specs, "events", "testbox", "2026-10-19.jsonl"),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}
function run(script, env, stdin, extra = {}) {
  return spawnSync(process.execPath, [script], {
    input: stdin,
    encoding: "utf8",
    cwd: REPO,
    timeout: 60000,
    env: {
      ...process.env,
      RF_OPS_HOME: env.home,
      RF_SPECS_DIR: env.specs,
      RF_OPS_RETRY_MS: "10",
      CI: "",
      RF_SPECS_REMOTE: join(tmpdir(), "rf-no-such-remote.git"),
      RF_SPECS_REMOTE: join(tmpdir(), "rf-no-such-remote.git"),
      RF_OPS_GATE: "",
      ...extra,
    },
  });
}
const stopIn = (sid) => JSON.stringify({ session_id: sid, cwd: REPO, stop_hook_active: false });

test("stop hook: garbage stdin exits 0", () => {
  const env = mkEnv();
  assert.equal(run(STOP, env, "not json {{").status, 0);
  assert.equal(run(STOP, env, "").status, 0);
  assert.equal(run(STOP, env, "[]").status, 0);
});

test("stop hook: no actions file exits 0", () => {
  const env = mkEnv();
  const r = run(STOP, env, stopIn("sess-none"));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("stop hook: RF_OPS_GATE=off exits 0 even with an unmet action", () => {
  const env = mkEnv();
  writeEvents(env, [
    ev("item.new", "525", { title: "Acme thing", type: "feature" }, "2026-01-01T09:00:00Z"),
  ]);
  appendAction(actionsFile(env.home, "sess-off"), {
    ts: Date.now(),
    kind: "pr",
    action: "merge",
    number: 3515,
    branch: null,
  });
  const r = run(STOP, env, stopIn("sess-off"), { RF_OPS_GATE: "off" });
  assert.equal(r.status, 0);
});

test("stop hook: missing ops clone fails open", () => {
  const env = mkEnv();
  appendAction(actionsFile(env.home, "sess-noclone"), {
    ts: Date.now(),
    kind: "push",
    branch: "feat/x",
    sha: SHA,
  });
  const r = run(STOP, { ...env, specs: join(env.root, "nowhere") }, stopIn("sess-noclone"));
  assert.equal(r.status, 0);
});

test("stop hook: unmet action exits 2 with the fix text; third identical block allows", () => {
  const env = mkEnv();
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  writeEvents(env, [
    ev("item.new", "525", { title: "Acme thing", type: "feature" }, "2026-01-01T09:00:00Z"),
    ev("link", "525", { prs: [3515] }, "2026-01-01T09:01:00Z"),
  ]);
  const sid = "sess-block";
  const file = actionsFile(env.home, sid);
  appendAction(file, { ts: Date.now(), kind: "pr", action: "merge", number: 3515, branch: null });
  void nowIso;
  const r1 = run(STOP, env, stopIn(sid));
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /Ops gate: 1 action\(s\) this turn have no matching event:/);
  assert.match(
    r1.stderr,
    /PR #3515 merged but item 525 has no status event → .*status 525 shipping/,
  );
  assert.match(r1.stderr, /RF_OPS_GATE=off disables this gate/);
  assert.equal(run(STOP, env, stopIn(sid)).status, 2);
  const r3 = run(STOP, env, stopIn(sid));
  assert.equal(r3.status, 0);
  assert.match(r3.stderr, /allowing the turn to close/);
  assert.equal(existsSync(file), false);
});

test("stop hook: met action archives the actions file and exits 0", () => {
  const env = mkEnv();
  const t = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  writeEvents(env, [
    ev("item.new", "525", { title: "Acme thing", type: "feature" }, "2026-01-01T09:00:00Z"),
    ev("push", "525", { branch: "feat/x", sha: SHA, repo: "najathakram/routeflow" }, iso(t)),
  ]);
  const file = actionsFile(env.home, "sess-ok");
  appendAction(file, { ts: t, kind: "push", branch: "feat/x", sha: SHA });
  const r = run(STOP, env, stopIn("sess-ok"));
  assert.equal(r.status, 0);
  assert.equal(existsSync(file), false);
});

test("post-push hook: garbage stdin and gate off exit 0 silently", () => {
  const env = mkEnv();
  for (const [input, extra] of [
    ["garbage {", {}],
    ["", {}],
    [
      JSON.stringify({
        session_id: "s",
        cwd: REPO,
        tool_input: { command: "git push origin x" },
        tool_response: {},
      }),
      { RF_OPS_GATE: "off" },
    ],
  ]) {
    const r = run(POST, env, input, extra);
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
  }
  assert.equal(existsSync(join(env.home, "turn-actions")), false);
});

function tempRepo(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "rf-repo-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "feat/hook-test");
  g("remote", "add", "origin", remoteUrl);
  g(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  return dir;
}
const postIn = (sid, cwd, command, response = {}) =>
  JSON.stringify({ session_id: sid, cwd, tool_input: { command }, tool_response: response });

test("post-push hook: a non-routeflow remote writes no actions file", () => {
  const env = mkEnv();
  const repo = tempRepo("https://github.com/acme/other.git");
  const r = run(POST, env, postIn("sess-other", repo, "git push -u origin feat/hook-test"));
  assert.equal(r.status, 0);
  assert.equal(existsSync(actionsFile(env.home, "sess-other")), false);
  const specsRepo = tempRepo("https://github.com/najathakram/routeflow-specs.git");
  run(POST, env, postIn("sess-specs", specsRepo, "git push origin feat/hook-test"));
  assert.equal(existsSync(actionsFile(env.home, "sess-specs")), false);
});

const gitIn = (dir, ...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
/** Points the tracking ref at HEAD, as a successful push would. */
const trackHead = (dir, branch = "feat/hook-test") =>
  gitIn(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
const RF_URL = "git@github.com:najathakram/routeflow.git";
const rfOnly = { skip: !existsSync(RF) };

test("post-push hook: a routeflow push is recorded when the tracking ref matches", rfOnly, () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  trackHead(repo);
  const r = run(POST, env, postIn("sess-rf", repo, "git push -u origin feat/hook-test"), {
    RF_ACTOR: "",
  });
  assert.equal(r.status, 0);
  const acts = readActions(actionsFile(env.home, "sess-rf"));
  assert.equal(acts.length, 1);
  assert.equal(acts[0].kind, "push");
  assert.equal(acts[0].branch, "feat/hook-test");
  assert.equal(acts[0].sha, gitIn(repo, "rev-parse", "HEAD"));
});

test("post-push hook: a push whose sha is not on the tracking ref records nothing", rfOnly, () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  trackHead(repo); // tracking ref stays at the first commit
  gitIn(repo, "commit", "-q", "--allow-empty", "-m", "second"); // HEAD moved on: push was rejected
  const r = run(POST, env, postIn("sess-mismatch", repo, "git push origin feat/hook-test"), {
    RF_ACTOR: "",
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(actionsFile(env.home, "sess-mismatch")), false);
  const noRef = tempRepo(RF_URL); // no tracking ref at all: the push never happened
  run(POST, env, postIn("sess-noref", noRef, "git push origin feat/hook-test"));
  assert.equal(existsSync(actionsFile(env.home, "sess-noref")), false);
});

test("post-push hook: refspec source and a HEAD push resolve the pushed sha", rfOnly, () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  const first = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "update-ref", "refs/remotes/origin/other", first);
  gitIn(repo, "commit", "-q", "--allow-empty", "-m", "second");
  run(POST, env, postIn("sess-src", repo, "git push origin feat/hook-test~1:other"));
  const acts = readActions(actionsFile(env.home, "sess-src"));
  assert.equal(acts.length, 1);
  assert.equal(acts[0].branch, "other");
  assert.equal(acts[0].sha, first);
  trackHead(repo);
  run(POST, env, postIn("sess-bare", repo, "git push origin HEAD"));
  assert.equal(readActions(actionsFile(env.home, "sess-bare"))[0].branch, "feat/hook-test");
});

test("post-push hook: quoted env assignment and pipe parse as a push", rfOnly, () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  trackHead(repo);
  const cmd =
    'SKIP_VERIFY=1 SKIP_VERIFY_REASON="docs only" git push origin feat/hook-test 2>&1 | tail -5';
  run(POST, env, postIn("sess-env", repo, cmd));
  assert.equal(readActions(actionsFile(env.home, "sess-env")).length, 1);
});

test("post-push hook: background calls record nothing", rfOnly, () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  trackHead(repo);
  const input = JSON.stringify({
    session_id: "sess-bg",
    cwd: repo,
    tool_input: { command: "git push origin feat/hook-test", run_in_background: true },
    tool_response: {},
  });
  assert.equal(run(POST, env, input).status, 0);
  assert.equal(existsSync(actionsFile(env.home, "sess-bg")), false);
  run(POST, env, postIn("sess-fg", repo, "git push origin feat/hook-test"));
  assert.equal(existsSync(actionsFile(env.home, "sess-fg")), true);
});

test("post-push hook: gh merge/create are recorded only with success output", rfOnly, () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  run(POST, env, postIn("sess-m0", repo, "gh pr merge 3515 --squash"));
  assert.equal(existsSync(actionsFile(env.home, "sess-m0")), false);
  run(POST, env, postIn("sess-m1", repo, "gh pr merge 3515 --squash", MERGED_3515));
  const [a] = readActions(actionsFile(env.home, "sess-m1"));
  assert.equal(a.kind, "pr");
  assert.equal(a.action, "merge");
  assert.equal(a.number, 3515);
  const url = { stdout: "https://github.com/najathakram/routeflow/pull/4001\n" };
  run(POST, env, postIn("sess-c1", repo, 'gh pr create --title "x"', url));
  assert.equal(readActions(actionsFile(env.home, "sess-c1"))[0].number, 4001);
});
