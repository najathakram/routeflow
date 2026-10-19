import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
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
// RF_HOOKS_DIR lets a reviewer point the pure-function tests at another copy of the hooks.
const HOOKS = process.env.RF_HOOKS_DIR || join(REPO, ".claude", "hooks");
const POST = join(HOOKS, "ops-post-push.mjs");
const STOP = join(HOOKS, "ops-stop.mjs");
const RF = join(REPO, "tools", "ops-monitor", "bin", "rf.mjs");

const postMod = await import(pathToUrl(POST));
const {
  detectOpsActions,
  branchFromRefspec,
  splitCommand,
  tokenize,
  mergedFromView,
  confirmMerge,
} = postMod;
const { evaluateGate, nextBlockState, missingHash, pendingMergeOpen } = await import(
  pathToUrl(STOP)
);
const { actionsFile, appendAction, readActions, archiveActions, sanitizeSessionId } = await import(
  pathToUrl(join(REPO, "tools", "ops-monitor", "lib", "turn-actions.mjs"))
);

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}
const detect = (cmd, res = {}) => detectOpsActions(cmd, res);
// Real gh shapes: on a TTY "✓ Squashed and merged pull request owner/repo#N (title)"; WITHOUT a
// TTY (every Claude Bash call) gh prints nothing at all on success.
const MERGED_3515 = {
  stderr: "✓ Squashed and merged pull request najathakram/routeflow#3515 (feat: x)\n",
};
const SILENT = { stdout: "", stderr: "" };

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

test("detect: a TTY success line is the fast path (owner/repo#N)", () => {
  // the success line proves the merge, but the PR's head branch still comes from gh pr view
  assert.deepEqual(detect("gh pr merge 3515 --merge", MERGED_3515), [
    { kind: "pr", action: "merge", number: 3515, named: true, verify: true, trusted: true },
  ]);
  assert.deepEqual(detect("gh pr merge --squash", MERGED_3515), [
    { kind: "pr", action: "merge", number: 3515, verify: true, trusted: true },
  ]);
  assert.deepEqual(detect("gh pr merge 99", { stdout: "Merged pull request #3516" }), [
    { kind: "pr", action: "merge", number: 3516, named: true, verify: true, trusted: true },
  ]);
});

test("detect: no-TTY gh merge (empty output) is a candidate to verify", () => {
  const cand = { kind: "pr", action: "merge", number: 3515, verify: true, named: true };
  assert.deepEqual(detect("gh pr merge 3515 --squash", SILENT), [cand]);
  assert.deepEqual(detect("gh pr merge 3515 --squash"), [cand]);
  assert.deepEqual(
    detect("gh pr merge https://github.com/najathakram/routeflow/pull/77 --merge", SILENT),
    [{ kind: "pr", action: "merge", number: 77, verify: true, named: true }],
  );
  // no number or URL argument: the current branch's PR, number unknown until verified
  assert.deepEqual(detect("gh pr merge --squash --delete-branch", SILENT), [
    { kind: "pr", action: "merge", number: null, verify: true },
  ]);
  // a flag value is never a PR number
  assert.equal(detect('gh pr merge --subject 5 --body "x" 3515', SILENT)[0].number, 3515);
});

test("detect: only auto and interrupted merges are not candidates; gh pr view is the authority", () => {
  for (const stderr of [
    "X Pull request #3515 is not mergeable: the merge commit cannot be cleanly created",
    "GraphQL: Pull request is not mergeable",
    "HTTP 405: Merge conflict",
    "error: no such flag",
    "failed to merge",
  ])
    assert.deepEqual(
      detect("gh pr merge 3515 --merge", { stderr }),
      [{ kind: "pr", action: "merge", number: 3515, verify: true, named: true }],
      stderr,
    );
  assert.deepEqual(
    detect("gh pr merge 3515 --merge", {
      stderr:
        "✓ Pull request najathakram/routeflow#3515 will be automatically merged when all requirements are met",
    }),
    [],
  );
  assert.deepEqual(detect("gh pr merge 3515 --auto --squash", SILENT), []);
  assert.deepEqual(detect("gh pr merge 3515", { interrupted: true }), []);
});

test("detect: a branch name is the PR selector for merge and ready", () => {
  assert.deepEqual(detect("gh pr merge feat/x --squash --delete-branch", SILENT), [
    { kind: "pr", action: "merge", number: null, verify: true, named: true, selector: "feat/x" },
  ]);
  assert.deepEqual(detect('gh pr merge -t "a b" --squash train/r27-1', SILENT), [
    {
      kind: "pr",
      action: "merge",
      number: null,
      verify: true,
      named: true,
      selector: "train/r27-1",
    },
  ]);
  const ready = { stderr: '✓ Pull request #12 is marked as "ready for review"' };
  assert.deepEqual(detect("gh pr ready feat/x", ready), [
    { kind: "pr", action: "ready", number: 12, named: true, verify: true, selector: "feat/x" },
  ]);
  // no positional at all: still the unnamed (current branch) form
  assert.equal(detect("gh pr merge --squash", SILENT)[0].named, undefined);
});

test("mergedFromView: only a MERGED pr view counts", () => {
  const v = (o) =>
    JSON.stringify({
      number: 5,
      state: "MERGED",
      mergedAt: "2026-10-19T10:00:00Z",
      headRefName: "feat/x",
      ...o,
    });
  assert.deepEqual(mergedFromView(v({})), {
    number: 5,
    branch: "feat/x",
    mergedAt: Date.parse("2026-10-19T10:00:00Z"),
  });
  assert.equal(mergedFromView(v({ state: "OPEN" })), null);
  assert.equal(mergedFromView(v({ state: "CLOSED" })), null);
  assert.equal(mergedFromView("not json"), null);
  assert.equal(mergedFromView(""), null);
  assert.equal(mergedFromView(v({ number: "5" })), null);
});

test("confirmMerge: records the pr event and action only for a fresh MERGED view", () => {
  const T = Date.parse("2026-10-19T10:01:00Z");
  const go = (view, job = {}) => {
    const got = { appended: [], recorded: [] };
    const r = confirmMerge(
      { ts: T, number: 5, named: true, cwd: "x", file: "f", ...job },
      {
        view: () => view,
        append: (f, e) => got.appended.push([f, e]),
        record: (a) => got.recorded.push(a),
      },
    );
    return { r, ...got };
  };
  const merged = (o = {}) =>
    JSON.stringify({
      number: 5,
      state: "MERGED",
      mergedAt: "2026-10-19T10:00:30Z",
      headRefName: "feat/x",
      ...o,
    });
  const ok = go(merged());
  // the action carries the merge time (not "now"); the pending marker keeps the job's own ts
  assert.deepEqual(ok.appended, [
    [
      "f",
      {
        ts: Date.parse("2026-10-19T10:00:30Z"),
        kind: "pr",
        action: "merge",
        number: 5,
        branch: "feat/x",
      },
    ],
    ["f", { ts: T, kind: "pr-pending-done", number: 5 }],
  ]);
  assert.deepEqual(ok.recorded, [
    ["event", "pr", "--number", "5", "--action", "merge", "--branch", "feat/x", "--quiet"],
  ]);
  // trunk head names no PR branch
  const trunk = go(merged({ headRefName: "master" }));
  assert.equal(trunk.appended[0][1].branch, null);
  assert.deepEqual(trunk.recorded, [
    ["event", "pr", "--number", "5", "--action", "merge", "--quiet"],
  ]);
  // unnamed merge: the branch captured before gh switched is the selector
  let asked;
  confirmMerge(
    { ts: T, number: null, branch: "feat/work", named: false, cwd: "x", file: "f" },
    { view: (c, sel) => ((asked = sel), merged()), append() {}, record() {} },
  );
  assert.equal(asked, "feat/work");
  // no PR named: the branch is the viewed PR's head, and the number is the confirmed one
  const cur = go(merged({ number: 9 }), { number: null, named: false });
  assert.deepEqual(cur.recorded, [
    ["event", "pr", "--number", "9", "--action", "merge", "--branch", "feat/x", "--quiet"],
  ]);
  assert.equal(cur.appended[0][1].number, 9);
  for (const view of [merged({ state: "OPEN", mergedAt: null }), "", "{"]) {
    const none = go(view);
    assert.equal(none.r, null);
    // nothing recorded, but the pending marker is released so the Stop gate stops waiting
    assert.deepEqual(none.appended, [["f", { ts: T, kind: "pr-pending-done", number: 5 }]]);
    assert.deepEqual(none.recorded, []);
  }
  // already merged long ago: a mistaken re-merge records nothing
  assert.equal(go(merged({ mergedAt: "2026-10-18T10:00:00Z" })).r, null);
  // 6 minutes after the real merge (past the gate's 5 minute window): nothing, gate released
  const late = go(merged({ mergedAt: new Date(T - 6 * 60_000).toISOString() }));
  assert.equal(late.r, null);
  assert.deepEqual(late.appended, [["f", { ts: T, kind: "pr-pending-done", number: 5 }]]);
  assert.deepEqual(late.recorded, []);
  // 4 minutes after: still the fresh merge
  assert.notEqual(go(merged({ mergedAt: new Date(T - 4 * 60_000).toISOString() })).r, null);
});

test("confirmMerge: a merge the clone already holds records nothing and releases the gate", () => {
  const T = Date.parse("2026-10-19T10:01:00Z");
  const view = JSON.stringify({
    number: 5,
    state: "MERGED",
    mergedAt: "2026-10-19T10:00:30Z",
    headRefName: "feat/x",
  });
  const got = { appended: [], recorded: [] };
  const seen = [];
  const r = confirmMerge(
    { ts: T, number: 5, named: true, cwd: "x", file: "f" },
    {
      view: () => view,
      seen: (n) => (seen.push(n), true),
      append: (f, e) => got.appended.push(e),
      record: (a) => got.recorded.push(a),
    },
  );
  assert.equal(r, null);
  assert.deepEqual(seen, [5]);
  assert.deepEqual(got.appended, [{ ts: T, kind: "pr-pending-done", number: 5 }]);
  assert.deepEqual(got.recorded, []);
  // a throwing lookup fails open: the merge is recorded
  const ok = confirmMerge(
    { ts: T, number: 5, named: true, cwd: "x", file: "f" },
    {
      view: () => view,
      seen: () => {
        throw new Error("no clone");
      },
      append() {},
      record: (a) => got.recorded.push(a),
    },
  );
  assert.equal(ok.number, 5);
  assert.equal(got.recorded.length, 1);
});

test("confirmMerge: never writes into a later turn once its pending line is gone", () => {
  const T = Date.parse("2026-10-19T10:01:00Z");
  const view = JSON.stringify({
    number: 5,
    state: "MERGED",
    mergedAt: "2026-10-19T10:00:30Z",
    headRefName: "feat/x",
  });
  const got = { appended: [], recorded: [] };
  confirmMerge(
    { ts: T, number: 5, named: true, cwd: "x", file: "f" },
    {
      view: () => view,
      owns: () => false,
      append: (f, e) => got.appended.push(e),
      record: (a) => got.recorded.push(a),
    },
  );
  assert.deepEqual(got.appended, [], "the archived turn's file is left alone");
  assert.equal(got.recorded.length, 1, "the rf event is still recorded");
});

test("confirmMerge: named ready records the PR's head branch for OPEN or MERGED", () => {
  const T = Date.parse("2026-10-19T10:01:00Z");
  const go = (view, job = {}) => {
    const got = { appended: [], recorded: [] };
    const r = confirmMerge(
      { ts: T, action: "ready", number: 12, named: true, cwd: "x", file: "f", ...job },
      {
        view: () => view,
        append: (f, e) => got.appended.push(e),
        record: (a) => got.recorded.push(a),
      },
    );
    return { r, ...got };
  };
  const v = (o) =>
    JSON.stringify({
      number: 12,
      state: "OPEN",
      mergedAt: null,
      headRefName: "train/r27-1",
      ...o,
    });
  const open = go(v({}));
  assert.deepEqual(open.appended, [
    { ts: T, kind: "pr", action: "ready", number: 12, branch: "train/r27-1" },
    { ts: T, kind: "pr-pending-done", number: 12 },
  ]);
  assert.deepEqual(open.recorded, [
    ["event", "pr", "--number", "12", "--action", "ready", "--branch", "train/r27-1", "--quiet"],
  ]);
  assert.notEqual(go(v({ state: "MERGED", mergedAt: "2026-10-18T10:00:00Z" })).r, null);
  const closed = go(v({ state: "CLOSED" }));
  assert.equal(closed.r, null);
  assert.deepEqual(closed.appended, [{ ts: T, kind: "pr-pending-done", number: 12 }]);
});

test("confirmMerge: a trusted TTY merge falls back to a branchless record when gh view fails", () => {
  const T = Date.parse("2026-10-19T10:01:00Z");
  const got = { appended: [], recorded: [] };
  const r = confirmMerge(
    { ts: T, number: 8, trusted: true, cwd: "x", file: "f" },
    { view: () => "", append: (f, e) => got.appended.push(e), record: (a) => got.recorded.push(a) },
  );
  assert.equal(r.number, 8);
  assert.deepEqual(got.appended[0], {
    ts: T,
    kind: "pr",
    action: "merge",
    number: 8,
    branch: null,
  });
  // an OPEN view overrides trust: it is not merged
  const open = confirmMerge(
    { ts: T, number: 8, trusted: true, cwd: "x", file: "f" },
    {
      view: () => JSON.stringify({ number: 8, state: "OPEN", headRefName: "x" }),
      append() {},
      record() {},
    },
  );
  assert.equal(open, null);
});

test("detect: a named PR is flagged so the hook never adds the current branch", () => {
  const ready = { stderr: '✓ Pull request #12 is marked as "ready for review"' };
  assert.equal(detect("gh pr ready 12", ready)[0].named, true);
  const [noArg] = detect("gh pr ready", ready);
  assert.equal(noArg.number, 12);
  assert.equal(noArg.named, undefined);
  const [create] = detect('gh pr create --title "x"', {
    stdout: "https://github.com/najathakram/routeflow/pull/4001\n",
  });
  assert.equal(create.named, undefined);
});

test("detect: pure tag / all / mirror pushes record nothing; --follow-tags is a normal push", () => {
  for (const c of [
    "git push --tags",
    "git push origin --tags",
    "git push --all origin",
    "git push --mirror origin",
    "git push --prune origin 'refs/heads/*:refs/heads/*'",
    "git push origin tag v1.2",
    "git push origin refs/tags/v1.2",
  ])
    assert.deepEqual(detect(c), [], c);
  assert.deepEqual(detect("git push --follow-tags origin feat/x"), [
    { kind: "push", remote: "origin", refspec: "feat/x" },
  ]);
  assert.deepEqual(detect("git push --follow-tags"), [
    { kind: "push", remote: null, refspec: null },
  ]);
  assert.deepEqual(detect("git push origin feat/x --tags"), [
    { kind: "push", remote: "origin", refspec: "feat/x" },
  ]);
});

test("detect: gh pr create carries --head / -H so the gate knows the branch", () => {
  const url = { stdout: "https://github.com/najathakram/routeflow/pull/4001\n" };
  assert.deepEqual(detect("gh pr create --head docs/bookkeeping-1 --title x", url), [
    { kind: "pr", action: "create", number: 4001, head: "docs/bookkeeping-1" },
  ]);
  assert.equal(detect("gh pr create -H someone:train/x", url)[0].head, "train/x");
  assert.equal(detect("gh pr create --head=feat/y", url)[0].head, "feat/y");
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
  assert.deepEqual(detect("gh pr merge 5 --repo acme/other", SILENT), []);
  assert.deepEqual(detect("gh pr view 5"), []);
});

test("detect: ready / close need a PR reference and no error line", () => {
  assert.deepEqual(
    detect("gh pr ready 12", { stderr: '✓ Pull request #12 is marked as "ready for review"' }),
    [{ kind: "pr", action: "ready", number: 12, named: true, verify: true }],
  );
  assert.deepEqual(detect("gh pr close 12", { stderr: "✓ Closed pull request #12 (x)" }), [
    { kind: "pr", action: "close", number: 12, named: true },
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
  assert.deepEqual(
    detect(cmd, { stderr: "✓ Squashed and merged pull request acme/x#3513 (x)" }),
    [],
  );
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

test("gate: merge-train and bookkeeping branches need no item link; others still do", () => {
  const rec = (branch) =>
    evaluateGate({
      actions: [{ ts: T0, kind: "push", branch, sha: SHA }],
      state: stateWith({ pushes: [{ ts: T0, branch, sha: SHA, item: null }] }),
      now: T0,
    }).ok;
  for (const b of ["train/product-k11", "train-r3", "docs/bookkeeping-3513", "chore/bookkeeping/x"])
    assert.equal(rec(b), true, b);
  for (const b of ["feat/x", "trains/x", "docs/guide", "training/x"])
    assert.equal(rec(b), false, b);
  // an unrecorded push on a train branch is still missing
  const miss = evaluateGate({
    actions: [{ ts: T0, kind: "push", branch: "train/x", sha: SHA }],
    state: stateWith(),
    now: T0,
  });
  assert.equal(miss.ok, false);
  assert.equal(miss.missing[0].why, "push not recorded");
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

test("gate: PRs on landing branches need no item link and no status event", () => {
  const pr = (action, branch, number = 3700) => ({ ts: T0, kind: "pr", action, number, branch });
  for (const a of [
    pr("create", "docs/bookkeeping-1"),
    pr("ready", "train/x"),
    pr("merge", "train/x"),
    pr("merge", "chore/bookkeeping-3513"),
  ])
    assert.equal(evaluateGate({ actions: [a], state: stateWith(), now: T0 }).ok, true, a.branch);
  // a feature branch is still held to the rule
  assert.equal(
    evaluateGate({ actions: [pr("merge", "feat/x")], state: stateWith(), now: T0 }).ok,
    false,
  );
});

test("gate: pendingMergeOpen waits only for a fresh, unmatched pending merge", () => {
  const now = 1_000_000;
  const p = (o = {}) => ({ kind: "pr-pending", ts: now - 5000, number: 7, ...o });
  const done = (o = {}) => ({ kind: "pr-pending-done", ts: now - 1000, number: 7, ...o });
  assert.equal(pendingMergeOpen([p()], now), true);
  assert.equal(pendingMergeOpen([p(), done()], now), false);
  assert.equal(pendingMergeOpen([p({ number: null }), done({ number: 9 })], now), false);
  assert.equal(pendingMergeOpen([p(), done({ number: 8 })], now), true);
  assert.equal(pendingMergeOpen([p({ ts: now - 31_000 })], now), false, "stale pending ignored");
  assert.equal(pendingMergeOpen([done()], now), false);
  assert.equal(pendingMergeOpen([], now), false);
  // a pending line alone never makes the gate block
  assert.equal(evaluateGate({ actions: [p()], state: stateWith(), now }).ok, true);
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

test("stop hook: a pending merge is waited for, then judged on the confirmed action", async () => {
  const env = mkEnv();
  writeEvents(env, [
    ev("item.new", "525", { title: "Acme thing", type: "feature" }, "2026-01-01T09:00:00Z"),
  ]);
  const file = actionsFile(env.home, "sess-pending");
  const t = Date.now();
  appendAction(file, { kind: "pr-pending", ts: t, number: 3515 });
  // the confirmer lands its pr action (an unlinked feature PR) a moment after Stop starts
  setTimeout(() => {
    appendAction(file, { ts: t, kind: "pr", action: "merge", number: 3515, branch: "feat/x" });
    appendAction(file, { ts: t, kind: "pr-pending-done", number: 3515 });
  }, 400);
  const r = await new Promise((res) => {
    const c = spawn(process.execPath, [STOP], {
      cwd: REPO,
      env: {
        ...process.env,
        RF_OPS_HOME: env.home,
        RF_SPECS_DIR: env.specs,
        RF_OPS_RETRY_MS: "300",
        CI: "",
        RF_OPS_GATE: "",
      },
    });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => res({ status, stderr }));
    c.stdin.end(stopIn("sess-pending"));
  });
  assert.equal(r.status, 2, "the confirmed, unlinked merge is judged instead of slipping away");
  assert.match(r.stderr, /PR #3515 merged but is not linked to an item/);
});

test("stop hook: a pending line alone never blocks (stale or unmatched)", () => {
  const env = mkEnv();
  writeEvents(env, [
    ev("item.new", "525", { title: "Acme thing", type: "feature" }, "2026-01-01T09:00:00Z"),
  ]);
  const file = actionsFile(env.home, "sess-pend-alone");
  appendAction(file, { kind: "pr-pending", ts: Date.now(), number: 3515 }); // fresh, never resolved
  const r = run(STOP, env, stopIn("sess-pend-alone"));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.equal(existsSync(file), false);
  const old = actionsFile(env.home, "sess-pend-old");
  appendAction(old, { kind: "pr-pending", ts: Date.now() - 60_000, number: 1 });
  assert.equal(run(STOP, env, stopIn("sess-pend-old")).status, 0);
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

test("post-push hook: gh merge/create are recorded only with success output", rfOnly, async () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  const failed = { stderr: "X Pull request #3515 is not mergeable" };
  run(POST, env, postIn("sess-m0", repo, "gh pr merge 3515 --squash", failed));
  // a failed merge is only a candidate: gh pr view decides, so no pr action is ever recorded
  assert.equal(
    readActions(actionsFile(env.home, "sess-m0")).some((x) => x.kind === "pr"),
    false,
  );
  const gh = fakeGh(env.root, {
    number: 3515,
    state: "MERGED",
    mergedAt: new Date().toISOString(),
    headRefName: "train/r27-1",
  });
  run(POST, env, postIn("sess-m1", repo, "gh pr merge 3515 --squash", MERGED_3515), {
    RF_OPS_GH: gh,
  });
  const file1 = actionsFile(env.home, "sess-m1");
  assert.ok(await waitFor(() => readActions(file1).some((x) => x.kind === "pr")));
  const a = readActions(file1).find((x) => x.kind === "pr");
  assert.equal(a.action, "merge");
  assert.equal(a.number, 3515);
  assert.equal(a.branch, "train/r27-1", "the TTY fast path gets the PR's head via the confirmer");
  const url = { stdout: "https://github.com/najathakram/routeflow/pull/4001\n" };
  run(POST, env, postIn("sess-c1", repo, 'gh pr create --title "x"', url));
  assert.equal(readActions(actionsFile(env.home, "sess-c1"))[0].number, 4001);
});

// A stand-in gh (RF_OPS_GH): prints the JSON of a PR view, or fails when GH_FAIL is set.
function fakeGh(dir, view) {
  const f = join(dir, "fake-gh.mjs");
  writeFileSync(
    f,
    `import { writeFileSync } from "node:fs";
if (process.env.GH_ARGV_LOG) writeFileSync(process.env.GH_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.GH_FAIL) process.exit(1);
if (process.env.GH_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.GH_DELAY_MS)));
console.log(JSON.stringify(${JSON.stringify(view)}));`,
  );
  return f;
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

test(
  "post-push hook: a silent (no-TTY) merge is confirmed by the detached recorder",
  rfOnly,
  async () => {
    const env = mkEnv();
    const repo = tempRepo(RF_URL);
    const file = actionsFile(env.home, "sess-conf");
    const gh = fakeGh(env.root, {
      number: 3515,
      state: "MERGED",
      mergedAt: new Date().toISOString(),
      headRefName: "feat/hook-test",
    });
    const r = run(POST, env, postIn("sess-conf", repo, "gh pr merge 3515 --squash", SILENT), {
      RF_OPS_GH: gh,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
    assert.ok(
      await waitFor(() => readActions(file).some((x) => x.kind === "pr")),
      "the confirmed merge is appended later",
    );
    const a = readActions(file).find((x) => x.kind === "pr");
    assert.equal(a.action, "merge");
    assert.equal(a.number, 3515);
    assert.equal(a.branch, "feat/hook-test", "the confirmed PR's own head branch is kept");
  },
);

test(
  "post-push hook: a merge candidate leaves a pending line, released by the confirmer",
  rfOnly,
  async () => {
    const env = mkEnv();
    const repo = tempRepo(RF_URL);
    const file = actionsFile(env.home, "sess-pend");
    const gh = fakeGh(env.root, {
      number: 3515,
      state: "MERGED",
      mergedAt: new Date().toISOString(),
      headRefName: "feat/hook-test",
    });
    // the pending line is synchronous, so it is there when the hook returns
    const r = run(POST, env, postIn("sess-pend", repo, "gh pr merge 3515 --squash", SILENT), {
      RF_OPS_GH: gh,
    });
    assert.equal(r.status, 0);
    const first = readActions(file)[0];
    assert.equal(first.kind, "pr-pending");
    assert.equal(first.number, 3515);
    assert.ok(await waitFor(() => readActions(file).some((a) => a.kind === "pr-pending-done")));
    const kinds = readActions(file).map((a) => a.kind);
    assert.deepEqual(kinds.sort(), ["pr", "pr-pending", "pr-pending-done"]);
  },
);

test(
  "post-push hook: an unnamed merge selects the branch checked out before gh switched",
  rfOnly,
  async () => {
    const env = mkEnv();
    const repo = tempRepo(RF_URL);
    gitIn(repo, "checkout", "-q", "-b", "feat/work");
    gitIn(repo, "checkout", "-q", "-b", "master"); // gh --delete-branch left us on the default
    const log = join(env.root, "argv.json");
    const gh = fakeGh(env.root, {
      number: 3600,
      state: "MERGED",
      mergedAt: new Date().toISOString(),
      headRefName: "feat/work",
    });
    run(POST, env, postIn("sess-unn", repo, "gh pr merge --squash --delete-branch", SILENT), {
      RF_OPS_GH: gh,
      GH_ARGV_LOG: log,
    });
    assert.ok(await waitFor(() => existsSync(log)));
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")).slice(0, 3), [
      "pr",
      "view",
      "feat/work",
    ]);
  },
);

test(
  "post-push hook: a branch name after gh pr merge is the selector passed to gh pr view",
  rfOnly,
  async () => {
    const env = mkEnv();
    const repo = tempRepo(RF_URL); // checkout HEAD is feat/hook-test, which must NOT be used
    const log = join(env.root, "argv-sel.json");
    const gh = fakeGh(env.root, {
      number: 3700,
      state: "MERGED",
      mergedAt: new Date().toISOString(),
      headRefName: "train/r27-1",
    });
    run(POST, env, postIn("sess-sel", repo, "gh pr merge train/r27-1 --squash", SILENT), {
      RF_OPS_GH: gh,
      GH_ARGV_LOG: log,
    });
    assert.ok(await waitFor(() => existsSync(log)));
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")).slice(0, 3), [
      "pr",
      "view",
      "train/r27-1",
    ]);
    const file = actionsFile(env.home, "sess-sel");
    assert.ok(await waitFor(() => readActions(file).some((x) => x.kind === "pr")));
    assert.equal(readActions(file).find((x) => x.kind === "pr").branch, "train/r27-1");
  },
);

test("post-push hook: a named ready carries the PR's head branch", rfOnly, async () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL);
  const gh = fakeGh(env.root, {
    number: 12,
    state: "OPEN",
    mergedAt: null,
    headRefName: "train/r27-2",
  });
  const out = { stderr: '✓ Pull request #12 is marked as "ready for review"' };
  run(POST, env, postIn("sess-rdy", repo, "gh pr ready 12", out), { RF_OPS_GH: gh });
  const file = actionsFile(env.home, "sess-rdy");
  assert.ok(await waitFor(() => readActions(file).some((x) => x.kind === "pr")));
  const a = readActions(file).find((x) => x.kind === "pr");
  assert.equal(a.action, "ready");
  assert.equal(a.branch, "train/r27-2");
  assert.ok(await waitFor(() => readActions(file).some((x) => x.kind === "pr-pending-done")));
});

test(
  "post-push hook: a re-run merge past the gate window, or one the clone holds, records nothing",
  rfOnly,
  async () => {
    const env = mkEnv();
    const repo = tempRepo(RF_URL);
    const old = fakeGh(env.root, {
      number: 3515,
      state: "MERGED",
      mergedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      headRefName: "feat/x",
    });
    const r = run(POST, env, postIn("sess-late", repo, "gh pr merge 3515 --squash", SILENT), {
      RF_OPS_GH: old,
    });
    assert.equal(r.status, 0);
    const file = actionsFile(env.home, "sess-late");
    assert.ok(await waitFor(() => readActions(file).some((x) => x.kind === "pr-pending-done")));
    assert.equal(
      readActions(file).some((x) => x.kind === "pr"),
      false,
      "6 minutes after the real merge nothing is recorded, and the gate is released",
    );
    // a fresh merge the local clone already holds as a pr event
    const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    writeEvents(env, [ev("pr", null, { number: 3516, action: "merge", branch: "feat/y" }, nowIso)]);
    const fresh = fakeGh(env.root, {
      number: 3516,
      state: "MERGED",
      mergedAt: new Date().toISOString(),
      headRefName: "feat/y",
    });
    run(POST, env, postIn("sess-dup", repo, "gh pr merge 3516 --squash", SILENT), {
      RF_OPS_GH: fresh,
    });
    const file2 = actionsFile(env.home, "sess-dup");
    assert.ok(await waitFor(() => readActions(file2).some((x) => x.kind === "pr-pending-done")));
    assert.equal(
      readActions(file2).some((x) => x.kind === "pr"),
      false,
      "a merge already in the clone is not recorded twice",
    );
  },
);

test(
  "post-push hook: a confirmer whose pending line was archived writes nothing",
  rfOnly,
  async () => {
    const env = mkEnv();
    const repo = tempRepo(RF_URL);
    const gh = fakeGh(env.root, {
      number: 3517,
      state: "MERGED",
      mergedAt: new Date().toISOString(),
      headRefName: "feat/z",
    });
    const file = actionsFile(env.home, "sess-arch");
    // a slow gh gives the Stop gate time to archive the turn's file before the confirmer finishes
    run(POST, env, postIn("sess-arch", repo, "gh pr merge 3517 --squash", SILENT), {
      RF_OPS_GH: gh,
      GH_DELAY_MS: "1500",
    });
    assert.equal(readActions(file)[0].kind, "pr-pending");
    archiveActions(file);
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(existsSync(file), false, "no later-turn file is created by the confirmer");
  },
);

test("post-push hook: gh pr create --head on a landing branch records that branch", rfOnly, () => {
  const env = mkEnv();
  const repo = tempRepo(RF_URL); // checkout HEAD is feat/hook-test
  const url = { stdout: "https://github.com/najathakram/routeflow/pull/4002\n" };
  run(POST, env, postIn("sess-head", repo, "gh pr create --head docs/bookkeeping-9", url));
  assert.equal(readActions(actionsFile(env.home, "sess-head"))[0].branch, "docs/bookkeeping-9");
});

test(
  "post-push hook: an unmerged or unverifiable silent merge records nothing",
  rfOnly,
  async () => {
    const env = mkEnv();
    const repo = tempRepo(RF_URL);
    const open = fakeGh(env.root, {
      number: 3515,
      state: "OPEN",
      mergedAt: null,
      headRefName: "x",
    });
    run(POST, env, postIn("sess-open", repo, "gh pr merge 3515 --auto", SILENT), {
      RF_OPS_GH: open,
    });
    run(POST, env, postIn("sess-open2", repo, "gh pr merge 3515 --squash", SILENT), {
      RF_OPS_GH: open,
    });
    run(POST, env, postIn("sess-fail", repo, "gh pr merge 3515 --squash", SILENT), {
      RF_OPS_GH: open,
      GH_FAIL: "1",
    });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(existsSync(actionsFile(env.home, "sess-open")), false, "--auto is no candidate");
    for (const sid of ["sess-open2", "sess-fail"])
      assert.equal(
        readActions(actionsFile(env.home, sid)).some((a) => a.kind === "pr"),
        false,
        sid,
      );
  },
);
