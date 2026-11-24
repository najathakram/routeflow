// Team board fix round (W-1309, #4431 read A): claims are keyed by member, not only by lane; one
// shared rule for "who is working here" that the CLI and the prompt hook both use (pinned); and a
// warning when the member's machine is not this one, because the member name is a label.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateEvent } from "../lib/schema.mjs";
import { fold } from "../lib/fold.mjs";
import { readAllEvents, validateAgainstState } from "../lib/store.mjs";
import { commentsFor } from "../lib/inbox.mjs";
import * as inbox from "../lib/inbox.mjs";
import * as identity from "../lib/identity.mjs";
import * as config from "../lib/config.mjs";
import * as lanes from "../lib/lanes-local.mjs";
import * as brief from "../lib/brief.mjs";
import * as turn from "../lib/turn-actions.mjs";
import { LEGACY_CONFIG } from "./legacy-config.mjs";
import { makeRegisterRepo } from "./register-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const RF = resolve(HERE, "..", "bin", "rf.mjs");

const MEMBERS = [
  { id: "alex", name: "Alex Rivera", machine: "alex-laptop", lanes: ["qa"], role: "tester" },
  { id: "sam", name: "Sam Lee", machine: "sam-pc", lanes: ["qa"], role: "tester" },
];
const CONFIG = {
  ...structuredClone(LEGACY_CONFIG),
  lanes: [
    ...LEGACY_CONFIG.lanes,
    { id: "qa", title: "Agent beta testing", machine: null, areas: ["*"] },
  ],
  members: MEMBERS,
};

let seq = 0;
function ev(kind, item, data, ts, { lane = "qa", actor = lane } = {}) {
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
const base = () => [ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0)];
const claimBy = (m, min, extra = {}) =>
  ev("claim", "W-1", { member: m, ...extra }, at(min), { lane: "qa", actor: m });
const releaseBy = (m, min) =>
  ev("release", "W-1", { member: m }, at(min), { lane: "qa", actor: m });

// ── claims keyed by member ──────────────────────────────────────────────────
test("schema: claim and release carry an optional member id", () => {
  assert.deepEqual(validateEvent(claimBy("alex", 1)).errors, []);
  assert.deepEqual(validateEvent(releaseBy("alex", 2)).errors, []);
  assert.ok(validateEvent(ev("claim", "W-1", { member: "Not An Id" }, at(1))).errors.length > 0);
});

test("store: a second member's claim on the same lane is refused; --steal takes it", () => {
  const s = fold([...base(), claimBy("alex", 1)]);
  const errs = validateAgainstState(claimBy("sam", 2), s);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /item W-1 is held by qa \(alex\) since .*; pass --steal to take it/);
  assert.deepEqual(validateAgainstState(claimBy("sam", 2, { steal: true }), s), []);
  // The holder re-claiming (a refresh) is fine; the lane session with no member is another holder.
  assert.deepEqual(validateAgainstState(claimBy("alex", 2), s), []);
  assert.equal(validateAgainstState(ev("claim", "W-1", {}, at(2)), s).length, 1);
});

test("store: only the holder releases", () => {
  const s = fold([...base(), claimBy("alex", 1)]);
  const errs = validateAgainstState(releaseBy("sam", 2), s);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /W-1 belongs to qa \(alex\); only that holder can release it/);
  assert.deepEqual(validateAgainstState(releaseBy("alex", 2), s), []);
});

test("fold: A claims, B claims -> A still holds it, with a conflict; B releases -> A still holds it", () => {
  const s = fold([...base(), claimBy("alex", 1), claimBy("sam", 2), releaseBy("sam", 3)]);
  const it = s.items.get("W-1");
  assert.equal(it.claimedBy, "qa");
  assert.equal(it.claimedMember, "alex");
  assert.ok(s.anomalies.some((a) => a.kind === "claim-conflict" && /qa \(sam\)/.test(a.detail)));
  assert.equal(it.claimConflict, null, "the loser's release clears only the conflict");
  // A steal takes it and leaves an anomaly to see.
  const t = fold([...base(), claimBy("alex", 1), claimBy("sam", 2, { steal: true })]);
  assert.equal(t.items.get("W-1").claimedMember, "sam");
  assert.ok(
    t.anomalies.some(
      (a) => a.kind === "claim-steal" && /sam took W-1 from qa \(alex\)/.test(a.detail),
    ),
  );
  // The holder's own release clears it.
  const u = fold([...base(), claimBy("alex", 1), releaseBy("alex", 2)]);
  assert.equal(u.items.get("W-1").claimedBy, null);
  assert.equal(u.items.get("W-1").claimedMember, null);
});

test("fold: old claims with no member keep the lane rule", () => {
  const s = fold([
    ...base(),
    ev("claim", "W-1", {}, at(1), { lane: "macmini" }),
    ev("claim", "W-1", {}, at(2), { lane: "macmini" }),
    ev("release", "W-1", {}, at(3), { lane: "macmini" }),
  ]);
  assert.equal(s.items.get("W-1").claimedBy, null);
  assert.equal(s.anomalies.filter((a) => a.kind.startsWith("claim")).length, 0);
});

test("inbox: a claim made under RF_ACTOR on the lane, with no member, still feeds the lane", () => {
  const s = fold([
    ...base(),
    ev("claim", "W-1", {}, at(1), { lane: "qa", actor: "hook:abc12345" }),
    ev("comment", "W-1", { text: "on the card" }, at(2), { lane: "lead" }),
  ]);
  assert.deepEqual(
    commentsFor(s, { lane: "qa", actor: "qa" }).map((x) => x.reason),
    ["claimed"],
  );
  const m = fold([
    ...base(),
    claimBy("alex", 1),
    ev("comment", "W-1", { text: "x" }, at(2), { lane: "lead" }),
  ]);
  assert.deepEqual(commentsFor(m, { lane: "qa", actor: "sam", member: "sam" }), []);
  assert.equal(commentsFor(m, { lane: "qa", actor: "alex", member: "alex" }).length, 1);
});

// ── one actor rule ──────────────────────────────────────────────────────────
test("identity: RF_ACTOR, else the member, else the lane, else machine:folder", () => {
  const home = mkdtempSync(join(tmpdir(), "rf-id-"));
  try {
    const env = { RF_OPS_HOME: home };
    const who = (extra, lane) =>
      identity.whoIsHere({
        env: { ...env, ...extra },
        machine: "box",
        config: CONFIG,
        cwd: join(home, "co"),
        lane,
      });
    assert.deepEqual(who({ RF_MEMBER: "alex" }), { lane: "qa", actor: "alex", member: "alex" });
    assert.deepEqual(who({ RF_MEMBER: "alex", RF_ACTOR: "hook:x" }), {
      lane: "qa",
      actor: "hook:x",
      member: "alex",
    });
    assert.deepEqual(who({ RF_LANE: "lead" }), { lane: "lead", actor: "lead", member: null });
    assert.deepEqual(who({}, null), { lane: null, actor: "box:co", member: null });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pin: the actor rule lives only in lib/identity.mjs", () => {
  const roots = [
    join(REPO, "tools", "ops-monitor", "bin"),
    join(REPO, "tools", "ops-monitor", "lib"),
    join(REPO, ".claude", "hooks"),
  ];
  const offenders = [];
  for (const dir of roots) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".mjs")) continue;
      const path = join(dir, f);
      if (path === join(REPO, "tools", "ops-monitor", "lib", "identity.mjs")) continue;
      const src = readFileSync(path, "utf8");
      if (/RF_ACTOR\s*\|\|/.test(src) || /\$\{[^}]*machine\}:\$\{basename\(/.test(src))
        offenders.push(relative(REPO, path));
    }
  }
  assert.deepEqual(offenders, []);
});

test("prompt hook: a member with RF_MEMBER sees a mention by member id (the hook uses identity)", () => {
  const root = mkdtempSync(join(tmpdir(), "rf-member-hook-"));
  try {
    const home = join(root, "home");
    const specs = join(root, "specs");
    mkdirSync(join(specs, "events", "testbox"), { recursive: true });
    mkdirSync(join(specs, "ops"), { recursive: true });
    writeFileSync(join(specs, "ops", "config.json"), JSON.stringify(CONFIG));
    const cwd = join(root, "checkout");
    mkdirSync(cwd, { recursive: true });
    const events = base();
    const write = () =>
      writeFileSync(
        join(specs, "events", "testbox", "2026-11-22.jsonl"),
        `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
    write();
    const env = { RF_OPS_HOME: home, RF_SPECS_DIR: specs, RF_MEMBER: "alex" };
    const deps = {
      opsHome: config.opsHome,
      specsDir: config.specsDir,
      loadConfig: config.loadConfig,
      readAllEvents,
      fold,
      lanes,
      brief,
      turn,
      inbox,
      identity,
      machine: "testbox",
    };
    const hook = (mode, min) =>
      briefFor(
        { hook_event_name: mode, session_id: "s1", cwd, prompt: "hi" },
        env,
        Date.parse(at(min)),
        deps,
      );
    hook("SessionStart", 5);
    events.push(
      ev("comment", "W-1", { text: "alex, can you test this?", to: ["alex"] }, at(6), {
        lane: "lead",
      }),
    );
    write();
    assert.match(
      hook("UserPromptSubmit", 7).text,
      /1 new comment for you:\n.*alex, can you test this\?/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
const { briefFor } = await import(
  pathToFileURL(resolve(REPO, ".claude", "hooks", "ops-brief.mjs")).href
);

test("identity: a member listed on another machine gets a warning; the same machine or none does not", () => {
  const home = mkdtempSync(join(tmpdir(), "rf-id-"));
  try {
    const env = { RF_OPS_HOME: home, RF_MEMBER: "alex" };
    assert.match(
      identity.memberMachineWarning(CONFIG, env, "pc"),
      /member alex is listed on machine alex-laptop, but this is pc\. The member name is a label, not a login/,
    );
    assert.equal(identity.memberMachineWarning(CONFIG, env, "alex-laptop"), null);
    assert.equal(identity.memberMachineWarning(CONFIG, { RF_OPS_HOME: home }, "pc"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── CLI ─────────────────────────────────────────────────────────────────────
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let tmp;
let cliEnv;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-mfix-"));
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
  };
  delete cliEnv.RF_LANE;
  delete cliEnv.RF_ACTOR;
  delete cliEnv.RF_MEMBER;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function rf(args, extra = {}) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [RF, ...args],
      { env: { ...cliEnv, ...extra }, encoding: "utf8", timeout: 200000 },
      (err, stdout, stderr) =>
        res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}
const T = { timeout: 600000 };

test(
  "cli: A claims, B claims -> refused; B releases -> refused, A still holds it; whoami warns on another machine",
  T,
  async () => {
    let r = await rf(["item", "new", "--title", "Counter totals", "--type", "feature"], {
      RF_LANE: "lead",
    });
    assert.equal(r.code, 0, r.stderr);
    r = await rf(["claim", "W-1"], { RF_MEMBER: "alex" });
    assert.equal(r.code, 0, r.stderr);
    const claim = readAllEvents(cliEnv.RF_SPECS_DIR).find((e) => e.kind === "claim");
    assert.deepEqual([claim.lane, claim.actor, claim.data.member], ["qa", "alex", "alex"]);
    r = await rf(["claim", "W-1"], { RF_MEMBER: "sam" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /W-1 is held by qa \(alex\) since/);
    r = await rf(["release", "W-1"], { RF_MEMBER: "sam" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /only that holder can release it/);
    r = await rf(["item", "show", "W-1"]);
    assert.match(r.stdout, /claimed by qa \(Alex Rivera\)/);
    r = await rf(["whoami"], { RF_MEMBER: "alex" });
    assert.match(r.stderr, /member alex is listed on machine alex-laptop, but this is testbox/);
    r = await rf(["release", "W-1"], { RF_MEMBER: "alex" });
    assert.equal(r.code, 0, r.stderr);
  },
);
