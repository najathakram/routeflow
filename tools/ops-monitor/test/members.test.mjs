// Team board, part 2: named members with roles in the specs ops/config.json. A member works from
// their own computer and Claude account; `rf whoami --member <id>` makes their id the name every
// event is written under, claims show their display name, and `rf next --role` filters the work.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  findMember,
  memberName,
  memberProblems,
  membersOf,
} from "../lib/config.mjs";
import { ROLES, validateEvent } from "../lib/schema.mjs";
import { fold } from "../lib/fold.mjs";
import { rankCandidates } from "../lib/next.mjs";
import { commentsFor } from "../lib/inbox.mjs";
import { buildSnapshot } from "../lib/snapshot.mjs";
import { LEGACY_CONFIG } from "./legacy-config.mjs";
import { makeRegisterRepo } from "./register-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RF = resolve(HERE, "..", "bin", "rf.mjs");

const MEMBERS = [
  { id: "alex", name: "Alex Rivera", machine: "alex-laptop", lanes: ["macmini"], role: "builder" },
  { id: "sam", name: "Sam Lee", machine: "sam-pc", lanes: ["qa"], role: "tester" },
  { id: "kim", name: "Kim Park", machine: null, lanes: [], role: "reviewer" },
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
function ev(kind, item, data, ts, { lane = "lead", actor = lane ?? "tester" } = {}) {
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

// ── config ──────────────────────────────────────────────────────────────────
test("roles: builder, tester, reviewer", () => {
  assert.deepEqual(ROLES, ["builder", "tester", "reviewer"]);
});

test("membersOf keeps valid members; memberProblems names every bad entry and never throws", () => {
  const cfg = {
    ...CONFIG,
    members: [
      ...MEMBERS,
      { id: "Bad Id", name: "x", lanes: [], role: "builder" },
      { id: "nolane", name: "No Lane", lanes: ["nope"], role: "builder" },
      { id: "norole", name: "No Role", lanes: [], role: "boss" },
      { id: "noname", lanes: [], role: "tester" },
      { id: "macmini", name: "Clash", lanes: [], role: "builder" },
      { id: "alex", name: "Twice", lanes: [], role: "builder" },
      "not an object",
    ],
  };
  assert.deepEqual(
    membersOf(cfg).map((m) => m.id),
    ["alex", "sam", "kim"],
  );
  const problems = memberProblems(cfg);
  assert.equal(problems.length, 7, problems.join("\n"));
  assert.ok(problems.some((p) => /"macmini" is also a lane id/.test(p)));
  assert.ok(problems.some((p) => /unknown lane "nope"/.test(p)));
  assert.ok(problems.some((p) => /role must be builder, tester or reviewer/.test(p)));
  assert.ok(problems.some((p) => /"alex" is listed twice/.test(p)));
  assert.deepEqual(membersOf(DEFAULT_CONFIG), []);
  assert.deepEqual(memberProblems({ ...CONFIG, members: "nope" }), ["members must be a list"]);
  assert.equal(findMember(CONFIG, "sam").role, "tester");
  assert.equal(findMember(CONFIG, "SAM")?.id, "sam");
  assert.equal(findMember(CONFIG, "nobody"), null);
  assert.equal(memberName(CONFIG, "alex"), "Alex Rivera");
  assert.equal(memberName(CONFIG, "macmini"), null);
});

// ── schema + fold ───────────────────────────────────────────────────────────
test("item role field: builder | tester | reviewer | null", () => {
  for (const role of [...ROLES, null])
    assert.deepEqual(
      validateEvent(ev("item.edit", "W-1", { fields: { role } }, T0)).errors,
      [],
      String(role),
    );
  assert.equal(validateEvent(ev("item.edit", "W-1", { fields: { role: "boss" } }, T0)).ok, false);
});

test("fold: a claim records who claimed it (claimedActor); release and done clear it", () => {
  const s1 = fold([
    ev("item.new", "W-1", { title: "Totals", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "macmini", actor: "alex" }),
  ]);
  const it = s1.items.get("W-1");
  assert.equal(it.claimedBy, "macmini");
  assert.equal(it.claimedActor, "alex");
  const s2 = fold([
    ev("item.new", "W-1", { title: "Totals", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "macmini", actor: "alex" }),
    ev("release", "W-1", {}, at(2), { lane: "macmini", actor: "alex" }),
  ]);
  assert.equal(s2.items.get("W-1").claimedActor, null);
  const s3 = fold([
    ev("item.new", "W-1", { title: "Totals", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "macmini", actor: "alex" }),
    ev("status", "W-1", { status: "live" }, at(2), { lane: "macmini", actor: "alex" }),
  ]);
  assert.equal(s3.items.get("W-1").claimedActor, null);
});

// ── next --role ─────────────────────────────────────────────────────────────
test("rankCandidates({ role }): an item's role defaults to builder; tester work only for testers", () => {
  const s = fold([
    ev("item.new", "W-1", { title: "Build it", type: "feature" }, T0),
    ev("item.new", "W-2", { title: "Test the counter", type: "audit", role: "tester" }, T0),
    ev("item.new", "W-3", { title: "Review the PR", type: "chore", role: "reviewer" }, T0),
  ]);
  const ids = (role) =>
    rankCandidates(s, "qa", CONFIG, { now: Date.parse(at(5)), role }).map((x) => x.item.id);
  assert.deepEqual(ids(undefined), ["W-1", "W-2", "W-3"]);
  assert.deepEqual(ids("tester"), ["W-2"]);
  assert.deepEqual(ids("builder"), ["W-1"]);
  assert.deepEqual(ids("reviewer"), ["W-3"]);
});

// ── inbox with a member ─────────────────────────────────────────────────────
test("inbox: a member reads mentions of their id and comments on the item THEY claimed, not every lane claim", () => {
  const s = fold([
    ev("item.new", "W-1", { title: "A", type: "feature" }, T0),
    ev("item.new", "W-2", { title: "B", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "macmini", actor: "alex" }),
    ev("claim", "W-2", {}, at(1), { lane: "macmini", actor: "macmini" }),
    ev("comment", "W-1", { text: "on alex's claim" }, at(2), { lane: "lead" }),
    ev("comment", "W-2", { text: "on the lane session's claim" }, at(3), { lane: "lead" }),
    ev("comment", "W-2", { text: "hey alex", to: ["alex"] }, at(4), { lane: "lead" }),
  ]);
  const alex = commentsFor(s, { lane: "macmini", actor: "alex", member: "alex" });
  assert.deepEqual(
    alex.map((x) => [x.comment.text, x.reason]),
    [
      ["on alex's claim", "claimed"],
      ["hey alex", "mention"],
    ],
  );
});

// ── snapshot ────────────────────────────────────────────────────────────────
test("snapshot: items carry claimedByName from the members list; members are listed without machines", () => {
  const NOW = Date.parse(at(10));
  const snap = buildSnapshot({
    sources: {
      specs: {
        ok: true,
        at: NOW,
        tried: NOW,
        error: null,
        intervalSec: 30,
        data: {
          config: CONFIG,
          events: [
            ev("item.new", "W-1", { title: "A", type: "feature" }, T0),
            ev("claim", "W-1", {}, at(1), { lane: "macmini", actor: "alex" }),
          ],
        },
      },
    },
    config: CONFIG,
    now: NOW,
    machine: "pc",
  });
  const it = snap.items.find((i) => i.id === "W-1");
  assert.equal(it.claimedBy, "macmini");
  assert.equal(it.claimedActor, "alex");
  assert.equal(it.claimedByName, "Alex Rivera");
  assert.deepEqual(snap.members, [
    { id: "alex", name: "Alex Rivera", lanes: ["macmini"], role: "builder" },
    { id: "sam", name: "Sam Lee", lanes: ["qa"], role: "tester" },
    { id: "kim", name: "Kim Park", lanes: [], role: "reviewer" },
  ]);
});

// ── CLI ─────────────────────────────────────────────────────────────────────
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let tmp;
let cliEnv;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-mem-"));
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
const T = { timeout: 600000 };

test(
  "rf whoami --member: unknown refused; known is recorded and becomes the event name, lane and role",
  T,
  async () => {
    let r = await rf(["whoami", "--member", "nobody"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown member "nobody"/);

    r = await rf(["whoami", "--member", "alex"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(tmp, "home", "member"), "utf8").trim(), "alex");
    assert.match(r.stdout, /member alex \(Alex Rivera, builder\)/);
    assert.match(r.stdout, /lane macmini/);
    assert.match(r.stdout, /name alex /);

    r = await rf(["item", "new", "--title", "Counter totals", "--type", "feature", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const made = JSON.parse(r.stdout).events[0];
    assert.equal(made.actor, "alex");
    assert.equal(made.lane, "macmini");
    r = await rf([
      "item",
      "new",
      "--title",
      "Walk the counter as a cashier",
      "--type",
      "audit",
      "--role",
      "tester",
    ]);
    assert.equal(r.code, 0, r.stderr);

    // A claim with no --lane uses the member's lane and shows the member's name.
    r = await rf(["claim", "W-1"]);
    assert.equal(r.code, 0, r.stderr);
    r = await rf(["item", "show", "W-1"]);
    assert.match(r.stdout, /claimed by macmini \(Alex Rivera\)/);
    r = await rf(["ls"]);
    assert.match(r.stdout, /^W-1 .* @macmini \(Alex Rivera\)$/m);

    // RF_ACTOR still wins over the recorded member (the lead's scripts set it).
    r = await rf(["whoami", "--json"], { RF_ACTOR: "hook:brief" });
    assert.equal(JSON.parse(r.stdout).actor, "hook:brief");

    // A tester gets tester work by default; --role overrides.
    r = await rf(["next", "--json"], { RF_MEMBER: "sam" });
    assert.equal(r.code, 0, r.stderr);
    let next = JSON.parse(r.stdout);
    assert.equal(next.lane, "qa");
    assert.equal(next.role, "tester");
    assert.equal(next.item.id, "W-2");
    r = await rf(["next", "--role", "builder", "--json"], { RF_MEMBER: "sam" });
    next = JSON.parse(r.stdout);
    assert.equal(next.item, null); // W-1 is claimed
    r = await rf(["next", "--role", "boss"], { RF_MEMBER: "sam" });
    assert.equal(r.code, 2);

    // Mentions resolve member ids.
    r = await rf(["comment", "W-1", "sam, can you test this after?", "--to", "sam", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).events[0].data.to, ["sam"]);
    r = await rf(["inbox"], { RF_MEMBER: "sam" });
    assert.match(r.stdout, /1 new comment for you \(sam\)/);

    // Clearing the member.
    r = await rf(["whoami", "--member", "-"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /member -/);
  },
);

test("rf doctor counts the members and names the bad entries", T, async () => {
  const r = await rf(["doctor"]);
  assert.match(r.stdout, /ok +members +3 members \(1 builder, 1 tester, 1 reviewer\)/);
});
