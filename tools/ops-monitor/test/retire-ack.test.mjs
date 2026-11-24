// Team board 7 (W-1309): the lead can clear alarms the CLI could not, with append-only events.
// `rf lane retire <lane> --note T` takes a lane out of the lane-silent alarm and the lanes list
// (its history stays); it refuses while the lane still holds a claim; `rf lane unretire` undoes
// it. `rf anomaly ack <anomaly-id> --note T` hides that one anomaly from the alarms; a NEW anomaly
// of the same kind still alarms.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvent } from "../lib/schema.mjs";
import { fold } from "../lib/fold.mjs";
import { readAllEvents, validateAgainstState } from "../lib/store.mjs";
import { reconcile } from "../lib/reconcile.mjs";
import { buildSnapshot } from "../lib/snapshot.mjs";
import { LEGACY_CONFIG } from "./legacy-config.mjs";
import { makeRegisterRepo } from "./register-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RF = resolve(HERE, "..", "bin", "rf.mjs");

let seq = 0;
function ev(kind, item, data, ts, { lane = "lead", actor = lane, machine = "testbox" } = {}) {
  const ms = Date.parse(ts);
  return {
    v: 1,
    id: `${machine}-${String(ms).padStart(13, "0")}-${(++seq).toString(36).padStart(4, "0").slice(-4)}`,
    ts,
    machine,
    actor,
    lane,
    kind,
    item,
    data,
  };
}
const T0 = "2026-11-22T08:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const NOW = Date.parse(at(600));
const alarmsOf = (state) =>
  reconcile({ state, prs: [], branches: [], sources: [], config: LEGACY_CONFIG, now: NOW });
const kinds = (alarms, kind) => alarms.filter((a) => a.kind === kind);

// ── schema ──────────────────────────────────────────────────────────────────
test("schema: lane.retire, lane.unretire and anomaly.ack are strict, with no item", () => {
  assert.deepEqual(
    validateEvent(ev("lane.retire", null, { lane: "macmini", note: "moved to the PC" }, T0)).errors,
    [],
  );
  assert.deepEqual(validateEvent(ev("lane.unretire", null, { lane: "macmini" }, T0)).errors, []);
  assert.deepEqual(
    validateEvent(
      ev("anomaly.ack", null, { eventId: "testbox-0000000000001-0001", note: "old import" }, T0),
    ).errors,
    [],
  );
  assert.ok(
    validateEvent(ev("lane.retire", null, { lane: "Mac Mini", note: "x" }, T0)).errors.length > 0,
  );
  assert.ok(
    validateEvent(ev("lane.retire", null, { lane: "macmini" }, T0)).errors.length > 0,
    "note required",
  );
  assert.ok(
    validateEvent(ev("anomaly.ack", null, { eventId: "x", note: "y", extra: 1 }, T0)).errors
      .length > 0,
  );
  assert.ok(
    validateEvent(ev("lane.retire", "W-1", { lane: "macmini", note: "x" }, T0)).errors.length > 0,
    "no item",
  );
});

// ── lane retire ─────────────────────────────────────────────────────────────
test("fold + reconcile: a retired lane leaves the lane-silent alarm; history stays; unretire brings it back", () => {
  const events = [
    ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "macmini" }),
  ];
  assert.equal(kinds(alarmsOf(fold(events)), "lane-silent").length, 1);
  events.push(
    ev("release", "W-1", {}, at(2), { lane: "macmini" }),
    ev("lane.retire", null, { lane: "macmini", note: "the Mac mini lane moved to the PC" }, at(3)),
  );
  const s = fold(events);
  assert.deepEqual(s.retiredLanes.get("macmini"), {
    lane: "macmini",
    at: Date.parse(at(3)),
    by: "lead",
    note: "the Mac mini lane moved to the PC",
  });
  assert.equal(s.lanes.get("macmini").lastEventKind, "release", "history stays");
  // A claim that lands on a retired lane anyway (another machine, not yet synced) never alarms.
  const late = fold([...events, ev("claim", "W-1", {}, at(4), { lane: "macmini" })]);
  assert.equal(kinds(alarmsOf(late), "lane-silent").length, 0);
  const back = fold([...events, ev("lane.unretire", null, { lane: "macmini" }, at(5))]);
  assert.equal(back.retiredLanes.has("macmini"), false);
});

test("store: retire refuses while the lane holds a claim, refuses twice; a claim on a retired lane is refused", () => {
  const held = fold([
    ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "macmini" }),
  ]);
  const retire = ev("lane.retire", null, { lane: "macmini", note: "gone" }, at(2));
  assert.deepEqual(validateAgainstState(retire, held), [
    "lane macmini still holds 1 claim (W-1); release it first (rf release W-1 --lane macmini)",
  ]);
  const free = fold([
    ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0),
    ev("lane.retire", null, { lane: "macmini", note: "gone" }, at(1)),
  ]);
  assert.deepEqual(validateAgainstState(retire, free), ["lane macmini is already retired"]);
  assert.deepEqual(validateAgainstState(ev("claim", "W-1", {}, at(2), { lane: "macmini" }), free), [
    "lane macmini is retired; rf lane unretire macmini first",
  ]);
  assert.deepEqual(validateAgainstState(ev("lane.unretire", null, { lane: "lead" }, at(2)), free), [
    "lane lead is not retired",
  ]);
});

// ── anomaly ack ─────────────────────────────────────────────────────────────
test("anomaly ack hides that one anomaly; a NEW anomaly of the same kind still alarms", () => {
  const dup1 = ev("item.new", "W-1", { title: "Counter totals again", type: "feature" }, at(1));
  const events = [ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0), dup1];
  const s1 = fold(events);
  assert.equal(s1.anomalies.length, 1);
  assert.equal(s1.anomalies[0].eventId, dup1.id);
  assert.equal(kinds(alarmsOf(s1), "anomaly").length, 1);
  events.push(
    ev("anomaly.ack", null, { eventId: dup1.id, note: "old import, nothing to fix" }, at(2)),
  );
  const s2 = fold(events);
  assert.equal(s2.anomalies[0].acked.note, "old import, nothing to fix");
  assert.equal(kinds(alarmsOf(s2), "anomaly").length, 0);
  // The same kind again, on the same item: alarms.
  const dup2 = ev(
    "item.new",
    "W-1",
    { title: "Counter totals, third time", type: "feature" },
    at(3),
  );
  const s3 = fold([...events, dup2]);
  const left = kinds(alarmsOf(s3), "anomaly");
  assert.equal(left.length, 1);
  assert.match(left[0].message, /Counter totals, third time|W-1/);
  assert.equal(s3.anomalies.find((a) => a.eventId === dup2.id).acked, null);
});

test("store: an ack names an anomaly that exists and is not acked yet", () => {
  const dup = ev("item.new", "W-1", { title: "again", type: "feature" }, at(1));
  const s = fold([ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0), dup]);
  assert.deepEqual(
    validateAgainstState(
      ev("anomaly.ack", null, { eventId: "testbox-0000000000009-zzzz", note: "x" }, at(2)),
      s,
    ),
    ["no anomaly for event testbox-0000000000009-zzzz (rf anomaly ls lists them)"],
  );
  const acked = fold([
    ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0),
    dup,
    ev("anomaly.ack", null, { eventId: dup.id, note: "x" }, at(2)),
  ]);
  assert.deepEqual(
    validateAgainstState(ev("anomaly.ack", null, { eventId: dup.id, note: "x" }, at(3)), acked),
    [`anomaly for event ${dup.id} is already acknowledged`],
  );
});

test("snapshot: a retired lane leaves the lanes list and the alarms; unretired, it is back", () => {
  const base = [
    ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "macmini" }),
  ];
  const snapOf = (events) =>
    buildSnapshot({
      sources: {
        specs: {
          ok: true,
          at: NOW,
          tried: NOW,
          error: null,
          intervalSec: 30,
          data: { config: LEGACY_CONFIG, events },
        },
      },
      config: LEGACY_CONFIG,
      now: NOW,
      machine: "pc",
    });
  const retired = [
    ...base,
    ev("release", "W-1", {}, at(2), { lane: "macmini" }),
    ev("lane.retire", null, { lane: "macmini", note: "moved to the PC" }, at(3)),
  ];
  const ids = (snap) => snap.lanes.map((l) => l.id);
  assert.ok(ids(snapOf(base)).includes("macmini"));
  assert.ok(!ids(snapOf(retired)).includes("macmini"), "retired: off the list");
  assert.ok(ids(snapOf(retired)).includes("lead"), "other lanes stay");
  const late = snapOf([...retired, ev("claim", "W-1", {}, at(4), { lane: "macmini" })]);
  assert.equal(late.alarms.filter((a) => a.kind === "lane-silent").length, 0);
  const back = [...retired, ev("lane.unretire", null, { lane: "macmini" }, at(5))];
  assert.ok(ids(snapOf(back)).includes("macmini"));
});

test("anomaly alarm suggests the ack; a claim conflict cannot be acked (the loser releases)", () => {
  const dup = ev("item.new", "W-1", { title: "again", type: "feature" }, at(1));
  const s = fold([ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0), dup]);
  const [alarm] = kinds(alarmsOf(s), "anomaly");
  assert.equal(alarm.suggest, `rf anomaly ack ${dup.id} --note "<why>"`);
  const steal = ev("claim", "W-1", {}, at(3), { lane: "qa" });
  const c = fold([
    ev("item.new", "W-1", { title: "Counter totals", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(2), { lane: "macmini" }),
    steal,
  ]);
  const conflict = c.anomalies.find((a) => a.kind === "claim-conflict");
  assert.ok(conflict, "a claim conflict anomaly");
  assert.match(
    validateAgainstState(
      ev("anomaly.ack", null, { eventId: conflict.eventId, note: "x" }, at(4)),
      c,
    )[0],
    /is a claim conflict: it clears when the loser releases/,
  );
});

test("store: a lane with two claims names both", () => {
  const s = fold([
    ev("item.new", "W-1", { title: "A", type: "feature" }, T0),
    ev("item.new", "W-2", { title: "B", type: "feature" }, T0),
    ev("claim", "W-1", {}, at(1), { lane: "old-box" }),
    ev("claim", "W-2", {}, at(2), { lane: "old-box" }),
  ]);
  assert.deepEqual(
    validateAgainstState(ev("lane.retire", null, { lane: "old-box", note: "gone" }, at(3)), s),
    [
      "lane old-box still holds 2 claims (W-1, W-2); release them first (rf release W-1 --lane old-box)",
    ],
  );
});

// ── CLI ─────────────────────────────────────────────────────────────────────
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let tmp;
let cliEnv;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-retire-"));
  const remote = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const specs = join(tmp, "specs");
  git(tmp, "clone", "--quiet", remote, specs);
  git(specs, "config", "user.name", "CLI Test");
  git(specs, "config", "user.email", "cli@example.com");
  writeFileSync(join(specs, "README.md"), "specs\n");
  mkdirSync(join(specs, "ops"), { recursive: true });
  writeFileSync(join(specs, "ops", "config.json"), JSON.stringify(LEGACY_CONFIG));
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

test("cli: rf lane retire / unretire and rf anomaly ls / ack", T, async () => {
  const L = { RF_LANE: "lead" };
  let r = await rf(["item", "new", "--title", "Counter totals", "--type", "feature"], L);
  assert.equal(r.code, 0, r.stderr);
  r = await rf(["claim", "W-1"], { RF_LANE: "macmini" });
  assert.equal(r.code, 0, r.stderr);
  r = await rf(["lane", "retire", "macmini", "--note", "moved to the PC"], L);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /lane macmini still holds 1 claim \(W-1\)/);
  r = await rf(["lane", "retire", "macmini"], L);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--note/);
  r = await rf(["lane", "retire", "nope", "--note", "x"], L);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown lane "nope"/);
  r = await rf(["release", "W-1"], { RF_LANE: "macmini" });
  assert.equal(r.code, 0, r.stderr);
  r = await rf(["lane", "retire", "macmini", "--note", "moved to the PC"], L);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /retired lane macmini/);
  const ret = readAllEvents(cliEnv.RF_SPECS_DIR).find((e) => e.kind === "lane.retire");
  assert.deepEqual([ret.item, ret.data], [null, { lane: "macmini", note: "moved to the PC" }]);
  r = await rf(["claim", "W-1"], { RF_LANE: "macmini" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /lane macmini is retired/);
  r = await rf(["lane", "unretire", "macmini"], L);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /lane macmini is back/);
  r = await rf(["lane", "unretire", "macmini"], L);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /lane macmini is not retired/);
  r = await rf(["lane", "retire", "macmini", "--note", "again"], L);
  assert.equal(r.code, 0, r.stderr);
  r = await rf(["lane", "unretire", "macmini"], L);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /lane macmini is back/);

  // An anomaly to acknowledge: an item.new for an existing item, written straight to the log.
  const dir = join(cliEnv.RF_SPECS_DIR, "events", "otherbox");
  mkdirSync(dir, { recursive: true });
  const dup = ev(
    "item.new",
    "W-1",
    { title: "Counter totals", type: "feature" },
    new Date().toISOString(),
    {
      machine: "otherbox",
    },
  );
  writeFileSync(join(dir, `${dup.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(dup)}\n`);
  r = await rf(["anomaly", "ls"], L);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${dup.id}\\s+\\S+\\s+W-1`));
  r = await rf(["anomaly", "ack", dup.id], L);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--note/);
  r = await rf(["anomaly", "ack", dup.id, "--note", "a duplicate import"], L);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`acknowledged anomaly ${dup.id}`));
  r = await rf(["anomaly", "ls"], L);
  assert.doesNotMatch(r.stdout, new RegExp(dup.id));
  r = await rf(["anomaly", "ls", "--all"], L);
  assert.match(r.stdout, new RegExp(`${dup.id}.*acknowledged by lead: a duplicate import`));

  // A lane the config no longer lists, known only from its events, can still be retired.
  const old = join(cliEnv.RF_SPECS_DIR, "events", "oldbox");
  mkdirSync(old, { recursive: true });
  const st = ev("status", "W-1", { status: "building" }, new Date().toISOString(), {
    lane: "old-box",
    machine: "oldbox",
  });
  writeFileSync(
    join(old, `${st.ts.slice(0, 10)}.jsonl`),
    `${JSON.stringify(st)}
`,
  );
  r = await rf(["lane", "retire", "old-box", "--note", "the old box is gone"], L);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /retired lane old-box/);
});
