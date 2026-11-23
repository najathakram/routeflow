// Agent-to-agent work hand-off (team board): members share one GitHub account but run different
// Claude accounts on different computers, so the board is how they hand work over and hear about
// it. `rf assign <id> --to <member>` puts the item at the top of that member's `rf next` and in their
// inbox; `rf inbox --wait` polls the specs repo and EXITS when something arrives, so an idle agent
// running it in the background wakes up.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateEvent } from "../lib/schema.mjs";
import { fold } from "../lib/fold.mjs";
import { readAllEvents } from "../lib/store.mjs";
import { rankCandidates } from "../lib/next.mjs";
import { commentsFor, inboxHeadline, renderComment } from "../lib/inbox.mjs";
import { renderBrief } from "../lib/brief.mjs";
import * as config from "../lib/config.mjs";
import * as inboxLib from "../lib/inbox.mjs";
import * as identity from "../lib/identity.mjs";
import * as lanes from "../lib/lanes-local.mjs";
import * as brief from "../lib/brief.mjs";
import * as turn from "../lib/turn-actions.mjs";
import { LEGACY_CONFIG } from "./legacy-config.mjs";
import { makeRegisterRepo } from "./register-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RF = resolve(HERE, "..", "bin", "rf.mjs");
const REPO = resolve(HERE, "..", "..", "..");

const MEMBERS = [
  { id: "alex", name: "Alex Rivera", machine: null, lanes: ["macmini"], role: "builder" },
  { id: "sam", name: "Sam Lee", machine: null, lanes: ["qa"], role: "tester" },
];
const CONFIG = {
  ...structuredClone(LEGACY_CONFIG),
  lanes: [
    ...LEGACY_CONFIG.lanes,
    { id: "qa", title: "Agent beta testing", machine: null, areas: [] },
  ],
  members: MEMBERS,
};

let seq = 0;
function ev(kind, item, data, ts, { lane = "lead", actor = lane } = {}) {
  const ms = Date.parse(ts);
  return {
    v: 1,
    id: `testbox-${String(ms).padStart(13, "0")}-${(++seq).toString(36).padStart(4, "0").slice(-4)}`,
    ts,
    machine: "testbox",
    actor,
    lane,
    kind,
    item,
    data,
  };
}
const T0 = "2026-11-22T08:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const base = () => [
  ev("item.new", "W-1", { title: "Counter totals", type: "feature", lane: "macmini" }, at(0)),
  ev("item.new", "W-2", { title: "Walk the counter", type: "audit", lane: "macmini" }, at(1)),
];

test("schema: assign names one member, or null to clear; the item is required", () => {
  assert.deepEqual(validateEvent(ev("assign", "W-1", { to: "sam" }, T0)).errors, []);
  assert.deepEqual(
    validateEvent(ev("assign", "W-1", { to: "sam", note: "after the fix lands" }, T0)).errors,
    [],
  );
  assert.deepEqual(validateEvent(ev("assign", "W-1", { to: null }, T0)).errors, []);
  assert.equal(validateEvent(ev("assign", "W-1", { to: "Sam Lee" }, T0)).ok, false);
  assert.equal(validateEvent(ev("assign", "W-1", {}, T0)).ok, false);
  assert.equal(validateEvent(ev("assign", null, { to: "sam" }, T0)).ok, false);
  assert.equal(
    validateEvent(ev("assign", "W-1", { to: "sam", note: "x".repeat(501) }, T0)).ok,
    false,
  );
});

test("fold: an assign sets the assignee and who assigned it; null clears; a rename carries it", () => {
  const events = [...base(), ev("assign", "W-1", { to: "sam", note: "please test" }, at(2))];
  let state = fold(events);
  const w1 = state.items.get("W-1");
  assert.equal(w1.assignee, "sam");
  assert.equal(w1.assignedBy, "lead");
  assert.equal(state.assignments.length, 1);
  assert.equal(state.assignments[0].note, "please test");
  state = fold([...events, ev("assign", "W-1", { to: null }, at(3))]);
  assert.equal(state.items.get("W-1").assignee, null);
  assert.equal(state.assignments.length, 1, "clearing is not a new assignment for anyone");
  state = fold([...events, ev("item.rename", "W-1", { to: "W-9" }, at(4))]);
  assert.equal(state.assignments[0].item, "W-9");
});

test("rf next: an item assigned to me comes first, whatever its lane or role; nobody else gets it", () => {
  const state = fold([...base(), ev("assign", "W-2", { to: "sam" }, at(2))]);
  const now = Date.parse(at(5));
  const forSam = rankCandidates(state, "qa", CONFIG, { now, role: "tester", member: "sam" });
  assert.equal(forSam[0].item.id, "W-2");
  assert.match(forSam[0].reason, /assigned to you/);
  const forAlex = rankCandidates(state, "macmini", CONFIG, { now, member: "alex" });
  assert.deepEqual(
    forAlex.map((c) => c.item.id),
    ["W-1"],
  );
  const lane = rankCandidates(state, "macmini", CONFIG, { now });
  assert.deepEqual(
    lane.map((c) => c.item.id),
    ["W-1"],
  );
});

test("inbox: my assignments arrive with my comments, in order; the headline counts both", () => {
  const state = fold([
    ...base(),
    ev("comment", "W-1", { text: "sam, a quick look?", to: ["sam"] }, at(2)),
    ev("assign", "W-2", { to: "sam", note: "after W-1" }, at(3)),
    ev("assign", "W-1", { to: "alex" }, at(4)),
  ]);
  const me = { lane: "qa", actor: "sam", member: "sam" };
  const mine = commentsFor(state, me);
  assert.deepEqual(
    mine.map((x) => [x.comment.item, x.reason]),
    [
      ["W-1", "mention"],
      ["W-2", "assigned"],
    ],
  );
  const line = renderComment(mine[1].comment, state, { now: Date.parse(at(5)) });
  assert.equal(line, "- [W-2] lead, 2 min ago: assigned to you: after W-1 (rf next; rf claim W-2)");
  assert.equal(inboxHeadline(mine), "1 new comment and 1 assignment");
  assert.equal(inboxHeadline(mine.slice(0, 1)), "1 new comment");
  assert.equal(inboxHeadline(mine.slice(1)), "1 new assignment");
  assert.equal(inboxHeadline([...mine, ...mine]), "2 new comments and 2 assignments");
  const out = renderBrief(state, {
    config: CONFIG,
    now: Date.parse(at(5)),
    me,
    inboxSeen: null,
  });
  assert.match(out, /1 new comment and 1 assignment for you \(rf inbox\):/);
});

// ── prompt hook ─────────────────────────────────────────────────────────────
const { briefFor } = await import(
  pathToFileURL(join(REPO, ".claude", "hooks", "ops-brief.mjs")).href
);
const hookDeps = () => ({
  opsHome: config.opsHome,
  specsDir: config.specsDir,
  loadConfig: config.loadConfig,
  readAllEvents,
  fold,
  lanes,
  brief,
  turn,
  inbox: inboxLib,
  identity,
  machine: "testbox",
});

test("prompt hook: a member (rf whoami --member) hears their assignments and mentions", () => {
  const root = mkdtempSync(join(tmpdir(), "rf-asg-hook-"));
  try {
    const home = join(root, "home");
    const specs = join(root, "specs");
    mkdirSync(join(specs, "events", "testbox"), { recursive: true });
    mkdirSync(join(specs, "ops"), { recursive: true });
    writeFileSync(join(specs, "ops", "config.json"), JSON.stringify(CONFIG));
    const cwd = join(root, "checkout");
    mkdirSync(cwd, { recursive: true });
    const write = (events) =>
      writeFileSync(
        join(specs, "events", "testbox", "2026-11-22.jsonl"),
        `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
    const events = base();
    write(events);
    // No lane recorded for the checkout: the member's identity alone must be enough.
    const env = { RF_OPS_HOME: home, RF_SPECS_DIR: specs, RF_MEMBER: "sam" };
    briefFor(
      { hook_event_name: "SessionStart", session_id: "s1", cwd },
      env,
      Date.parse(at(5)),
      hookDeps(),
    );
    events.push(
      ev("assign", "W-2", { to: "sam" }, at(6)),
      ev("comment", "W-2", { text: "steps are in the item", to: ["sam"] }, at(7)),
    );
    write(events);
    const out = briefFor(
      { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt: "hi" },
      env,
      Date.parse(at(8)),
      hookDeps(),
    );
    assert.match(out.text, /\[ops monitor\] 1 new comment and 1 assignment for you:/);
    assert.match(out.text, /\[W-2\] lead, 2 min ago: assigned to you/);
    assert.match(out.text, /steps are in the item/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── CLI ─────────────────────────────────────────────────────────────────────
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let tmp;
let cliEnv;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-asg-"));
  const remote = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const specs = join(tmp, "specs");
  git(tmp, "clone", "--quiet", remote, specs);
  git(specs, "config", "user.name", "CLI Test");
  git(specs, "config", "user.email", "cli@example.com");
  writeFileSync(join(specs, "README.md"), "specs\n");
  mkdirSync(join(specs, "ops"), { recursive: true });
  writeFileSync(join(specs, "ops", "config.json"), JSON.stringify(CONFIG));
  git(specs, "add", "README.md");
  git(specs, "commit", "--quiet", "-m", "init");
  git(specs, "push", "--quiet", "-u", "origin", "main");
  cliEnv = {
    ...process.env,
    RF_OPS_HOME: join(tmp, "home"),
    RF_SPECS_DIR: specs,
    RF_SPECS_REMOTE: remote,
    RF_MACHINE: "testbox",
    RF_REPO_ROOT: makeRegisterRepo(join(tmp, "product")),
    RF_NO_SYNC: "1",
    RF_INBOX_POLL_MS: "300",
  };
  for (const k of ["RF_LANE", "RF_ACTOR", "RF_MEMBER"]) delete cliEnv[k];
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function rf(args, extra = {}) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [RF, ...args],
      { env: { ...cliEnv, ...extra }, encoding: "utf8", timeout: 200000, cwd: tmp },
      (err, stdout, stderr) =>
        res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}
/** Starts `rf inbox --wait ...` and resolves with { code, stdout, ms } when it exits. */
function waiter(args, extra = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [RF, "inbox", "--wait", ...args], {
    env: { ...cliEnv, ...extra },
    cwd: tmp,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((res) =>
    child.on("close", (code) => res({ code, stdout, stderr, ms: Date.now() - started })),
  );
}
const T = { timeout: 600000 };
const SAM = { RF_MEMBER: "sam" };
const ALEX = { RF_MEMBER: "alex" };

test(
  "rf assign hands work to a member; rf inbox --wait wakes them when it arrives",
  T,
  async () => {
    let r = await rf(
      ["item", "new", "--title", "Counter totals", "--type", "feature", "--lane", "macmini"],
      ALEX,
    );
    assert.equal(r.code, 0, r.stderr);

    r = await rf(["assign", "W-1", "--to", "nobody"], ALEX);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown member "nobody"/);
    r = await rf(["assign", "W-1"], ALEX);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--to/);

    // Nothing yet: --wait times out with exit 3 and says so.
    let w = await waiter(["--timeout", "1"], SAM);
    assert.equal(w.code, 3, w.stderr);
    assert.match(w.stdout, /no new messages for you/);

    // A waiting member wakes as soon as an assignment lands, and sees it.
    const pending = waiter(["--timeout", "60"], SAM);
    await new Promise((ok) => setTimeout(ok, 1500));
    r = await rf(["assign", "W-1", "--to", "sam", "--note", "test it on the counter"], ALEX);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /assigned W-1 to sam \(Sam Lee\)/);
    w = await pending;
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /1 new assignment for you \(sam\):/);
    assert.match(w.stdout, /\[W-1\] alex, .*assigned to you: test it on the counter/);
    assert.ok(w.ms < 30000, `woke in ${w.ms} ms`);

    // Read once: an immediate re-wait does not fire on the same assignment.
    w = await waiter(["--timeout", "1"], SAM);
    assert.equal(w.code, 3);

    // Already-unread messages return at once.
    r = await rf(
      ["comment", "W-1", "--to", "sam", "--text", "the seed has a boxed product now"],
      ALEX,
    );
    assert.equal(r.code, 0, r.stderr);
    w = await waiter(["--timeout", "30"], SAM);
    assert.equal(w.code, 0);
    assert.match(w.stdout, /1 new comment for you \(sam\):/);

    // The assigned item tops sam's rf next even though it is builder work on another lane.
    r = await rf(["next", "--json"], SAM);
    const next = JSON.parse(r.stdout);
    assert.equal(next.item.id, "W-1");
    r = await rf(["item", "show", "W-1"], SAM);
    assert.match(r.stdout, /assigned to sam \(Sam Lee\) by alex/);

    // Clearing.
    r = await rf(["assign", "W-1", "--to", "-"], ALEX);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /unassigned W-1/);
  },
);
