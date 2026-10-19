import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exec,
  withSpecsLock,
  ensureClone,
  syncSpecs,
  readAllEvents,
  loadBugIds,
  appendEvents,
  validateAgainstState,
} from "../lib/store.mjs";
import { fold } from "../lib/fold.mjs";
import { newEventId } from "../lib/ids.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let tmp;
let remote;
let A; // machine "m-a"
let B; // machine "m-b"
let homeA;
let homeB;
let counter = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-store-"));
  remote = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const seed = join(tmp, "seed");
  git(tmp, "clone", "--quiet", remote, seed);
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  writeFileSync(join(seed, "README.md"), "specs\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", "-u", "origin", "main");
  A = join(tmp, "clone-a");
  B = join(tmp, "clone-b");
  for (const [dir, who] of [
    [A, "a"],
    [B, "b"],
  ]) {
    git(tmp, "clone", "--quiet", remote, dir);
    git(dir, "config", "user.name", `Machine ${who}`);
    git(dir, "config", "user.email", `${who}@example.com`);
  }
  homeA = join(tmp, "home-a");
  homeB = join(tmp, "home-b");
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ev(machine, kind, item, data, { lane = "pc-lane", ms } = {}) {
  const at = ms ?? Date.UTC(2026, 9, 19, 4, 0, 0) + counter++ * 1000;
  return {
    v: 1,
    id: newEventId(machine, at, () => (counter % 97) / 97),
    ts: new Date(at).toISOString(),
    machine,
    actor: "tester",
    lane,
    kind,
    item,
    data,
  };
}
const newItem = (machine, id, title, extra = {}) =>
  ev(machine, "item.new", id, { title, type: "feature", ...extra });
const optsA = (extra = {}) => ({ dir: A, home: homeA, ...extra });
const optsB = (extra = {}) => ({ dir: B, home: homeB, ...extra });
const stateOf = (dir) => fold(readAllEvents(dir));

test("exec never rejects; ENOENT -> 127", { timeout: 240000 }, async () => {
  const r = await exec("definitely-not-a-real-binary-xyz", ["--version"]);
  assert.equal(r.code, 127);
  const ok = await exec("git", ["--version"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /git version/);
  const hashed = await exec("git", ["hash-object", "--stdin"], { input: "hello\n" });
  assert.equal(hashed.code, 0);
  assert.equal(hashed.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
  const hashedBuf = await exec("git", ["hash-object", "--stdin"], {
    input: Buffer.from("hello\n"),
  });
  assert.equal(hashedBuf.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
  const bad = await exec("git", ["not-a-subcommand"]);
  assert.notEqual(bad.code, 0);
});

test(
  "lock dir is removed after an exception, and a held lock serializes",
  { timeout: 240000 },
  async () => {
    const home = join(tmp, "lock-home");
    await assert.rejects(
      withSpecsLock(
        async () => {
          assert.ok(existsSync(join(home, "specs.lock")));
          throw new Error("boom");
        },
        { home },
      ),
      /boom/,
    );
    assert.equal(existsSync(join(home, "specs.lock")), false);

    const order = [];
    await Promise.all([
      withSpecsLock(
        async () => {
          order.push("a1");
          await new Promise((r) => setTimeout(r, 150));
          order.push("a2");
        },
        { home },
      ),
      withSpecsLock(
        async () => {
          order.push("b1");
          order.push("b2");
        },
        { home },
      ),
    ]);
    assert.equal(order.slice(0, 2).join(""), order[0] === "a1" ? "a1a2" : "b1b2");
    assert.equal(existsSync(join(home, "specs.lock")), false);
  },
);

test("a stale lock is reclaimed; a fresh held lock times out", { timeout: 240000 }, async () => {
  const home = join(tmp, "lock-home2");
  const lock = join(home, "specs.lock");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 300000);
  utimesSync(lock, old, old);
  let ran = false;
  await withSpecsLock(
    async () => {
      ran = true;
    },
    { home },
  );
  assert.ok(ran);
  mkdirSync(lock, { recursive: true });
  await assert.rejects(
    withSpecsLock(async () => {}, { home, waitMs: 250, pollMs: 50 }),
    /lock/i,
  );
  rmSync(lock, { recursive: true, force: true });
});

test("ensureClone clones once, is a no-op when .git exists", { timeout: 240000 }, async () => {
  const dir = join(tmp, "cloned-by-tool");
  await ensureClone({ dir, remote });
  assert.ok(existsSync(join(dir, ".git")));
  assert.ok(existsSync(join(dir, "README.md")));
  await ensureClone({ dir, remote: "/nonexistent" }); // no-op
});

test(
  "(1) appends from both machines interleave with no conflict and both push",
  { timeout: 240000 },
  async () => {
    const batchA = [];
    const batchB = [];
    for (let i = 0; i < 2; i++) {
      batchA.push(() => appendEvents([ev("m-a", "note", null, { text: `a${i}` })], optsA()));
      batchB.push(() => appendEvents([ev("m-b", "note", null, { text: `b${i}` })], optsB()));
    }
    const run = async (fns) => {
      const out = [];
      for (const f of fns) out.push(await f());
      return out;
    };
    const [ra, rb] = await Promise.all([run(batchA), run(batchB)]);
    assert.ok([...ra, ...rb].every((r) => r.pushed === true));
    // Fresh view of the remote: every note is there, no anomalies.
    const check = join(tmp, "check-1");
    git(tmp, "clone", "--quiet", remote, check);
    const s = stateOf(check);
    const texts = s.notes.map((n) => n.text).sort();
    assert.deepEqual(texts, ["a0", "a1", "b0", "b1"]);
    assert.equal(s.anomalies.length, 0);
    assert.equal(git(A, "status", "--porcelain").trim(), "");
    assert.equal(git(B, "status", "--porcelain").trim(), "");
    assert.match(git(check, "log", "-1", "--format=%s", "--", "events"), /^ops\(m-[ab]\): note -/);
    // One file per machine, dated by UTC event date.
    assert.ok(existsSync(join(A, "events", "m-a", "2026-10-19.jsonl")));
    const line = readFileSync(join(A, "events", "m-a", "2026-10-19.jsonl"), "utf8")
      .trim()
      .split("\n")[0];
    assert.equal(JSON.parse(line).kind, "note");
  },
);

test(
  "(2) an item.new id collision after rebase is re-allocated to the next free id",
  { timeout: 240000 },
  async () => {
    await syncSpecs(A);
    await syncSpecs(B);
    const mine = newItem("m-a", null, "Item from A");
    const res = await appendEvents(
      [mine],
      optsA({
        _beforePush: async () => {
          // Machine B grabs the same next id and pushes first.
          const r = await appendEvents([newItem("m-b", null, "Item from B")], optsB());
          assert.equal(r.pushed, true);
          assert.equal(r.events[0].item, "1");
        },
      }),
    );
    assert.equal(res.pushed, true);
    assert.ok(res.attempts >= 2);
    assert.equal(res.events[0].item, "2");
    assert.ok(res.warnings.some((w) => /re-allocated/i.test(w)));
    await syncSpecs(B);
    for (const dir of [A, B]) {
      const s = stateOf(dir);
      assert.equal(s.anomalies.length, 0, JSON.stringify(s.anomalies));
      assert.equal(s.items.get("1").title, "Item from B");
      assert.equal(s.items.get("2").title, "Item from A");
    }
    assert.equal(git(A, "status", "--porcelain").trim(), "");
  },
);

test(
  "(3) unknown item ids are refused (and nothing is committed)",
  { timeout: 240000 },
  async () => {
    const before = git(A, "rev-parse", "HEAD").trim();
    await assert.rejects(
      appendEvents([ev("m-a", "status", "999", { status: "live" })], optsA()),
      (e) => e.refused === true && e.errors.some((m) => /unknown item/i.test(m)),
    );
    await assert.rejects(
      appendEvents([ev("m-a", "status", "B77", { status: "live" })], optsA()),
      /unknown item/i,
    );
    assert.equal(git(A, "rev-parse", "HEAD").trim(), before);
    // A registry bug id is fine when the registry lists it.
    const r = await appendEvents(
      [ev("m-a", "note", "B77", { text: "bug note" })],
      optsA({ bugIds: new Set(["B77"]) }),
    );
    assert.equal(r.pushed, true);
    // Parent/train must exist; train must be a release.
    await assert.rejects(
      appendEvents([newItem("m-a", null, "x", { parent: "4040" })], optsA()),
      /parent/i,
    );
    await assert.rejects(
      appendEvents([newItem("m-a", null, "x", { train: "R9" })], optsA()),
      /train/i,
    );
  },
);

test("(4) a claim held by another lane is refused unless steal", { timeout: 240000 }, async () => {
  await appendEvents([ev("m-a", "claim", "1", {}, { lane: "lane-x" })], optsA());
  await syncSpecs(B);
  await assert.rejects(
    appendEvents([ev("m-b", "claim", "1", {}, { lane: "lane-y" })], optsB()),
    (e) =>
      e.refused === true &&
      e.errors.some((m) => /held by lane-x since .*; pass --steal to take it/.test(m)),
  );
  const r = await appendEvents(
    [ev("m-b", "claim", "1", { steal: true }, { lane: "lane-y" })],
    optsB(),
  );
  assert.equal(r.pushed, true);
  await syncSpecs(A);
  assert.equal(stateOf(A).items.get("1").claimedBy, "lane-y");
  // Re-claim by the holder is fine.
  await appendEvents([ev("m-b", "claim", "1", {}, { lane: "lane-y" })], optsB());
});

test(
  "(5) an invalid JSON line surfaces as an invalid-event anomaly, not a crash",
  { timeout: 240000 },
  async () => {
    const dir = join(tmp, "check-5");
    git(tmp, "clone", "--quiet", remote, dir);
    mkdirSync(join(dir, "events", "m-z"), { recursive: true });
    writeFileSync(join(dir, "events", "m-z", "2026-10-19.jsonl"), "{not json\n\n");
    writeFileSync(join(dir, "events", "m-z", "notes.txt"), "ignored");
    const evs = readAllEvents(dir);
    const bad = evs.filter((e) => e.__invalid);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].raw, "{not json");
    assert.equal(bad[0].line, 1);
    assert.match(bad[0].file, /m-z/);
    const s = fold(evs);
    assert.equal(s.anomalies.filter((a) => a.kind === "invalid-event").length, 1);
    assert.ok(s.items.size >= 2);
  },
);

test(
  "(6) the lock dir is also removed when appendEvents refuses",
  { timeout: 240000 },
  async () => {
    await assert.rejects(appendEvents([ev("m-a", "status", "888", { status: "live" })], optsA()));
    assert.equal(existsSync(join(homeA, "specs.lock")), false);
  },
);

test(
  "offline push: commit stays local (pushed:false), next append pushes both",
  { timeout: 240000 },
  async () => {
    git(A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));
    const r = await appendEvents([ev("m-a", "note", null, { text: "offline note" })], optsA());
    assert.equal(r.pushed, false);
    assert.equal(git(A, "status", "--porcelain").trim(), "");
    git(A, "remote", "set-url", "origin", remote);
    const r2 = await appendEvents([ev("m-a", "note", null, { text: "back online" })], optsA());
    assert.equal(r2.pushed, true);
    const check = join(tmp, "check-off");
    git(tmp, "clone", "--quiet", remote, check);
    const texts = stateOf(check).notes.map((n) => n.text);
    assert.ok(texts.includes("offline note") && texts.includes("back online"));
  },
);

test("push:false commits but does not push", { timeout: 240000 }, async () => {
  const r = await appendEvents(
    [ev("m-a", "note", null, { text: "local only" })],
    optsA({ push: false }),
  );
  assert.equal(r.pushed, false);
  const ahead = git(A, "rev-list", "--count", "@{u}..HEAD").trim();
  assert.equal(ahead, "1");
  await syncSpecs(A); // pushes
  assert.equal(git(A, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
});

test(
  "batch: auto ids allocate sequentially and later events can reference them",
  { timeout: 240000 },
  async () => {
    const r = await appendEvents(
      [
        newItem("m-a", null, "Batch one"),
        newItem("m-a", null, "Batch two"),
        ev("m-a", "claim", null, {}, { lane: "lane-q" }),
      ],
      optsA(),
    ).catch((e) => e);
    // A claim without an item is structurally invalid, so the whole batch is refused.
    assert.equal(r.refused, true);
    const ok = await appendEvents(
      [newItem("m-a", null, "Batch one"), newItem("m-a", null, "Batch two")],
      optsA(),
    );
    assert.deepEqual(
      ok.events.map((e) => e.item),
      ["3", "4"],
    );
  },
);

test("validateAgainstState", () => {
  const s = fold([
    newItem("m", "5", "Five"),
    newItem("m", "R1", "Train", { type: "release" }),
    ev("m", "claim", "5", {}, { lane: "x" }),
  ]);
  const v = (e, bugIds = new Set()) => validateAgainstState(e, s, { bugIds });
  assert.deepEqual(v(newItem("m", "6", "ok", { parent: "5", train: "R1" })), []);
  assert.match(v(newItem("m", "5", "dup"))[0], /exists/);
  assert.match(v(newItem("m", "B9", "bug"))[0], /bug/i);
  assert.match(v(newItem("m", "7", "x", { train: "5" }))[0], /release/);
  assert.match(v(ev("m", "note", "nope", { text: "t" }))[0], /unknown item/);
  assert.deepEqual(v(ev("m", "note", "B9", { text: "t" }), new Set(["B9"])), []);
  assert.deepEqual(v(ev("m", "note", null, { text: "t" })), []);
  assert.match(v(ev("m", "claim", "5", {}, { lane: "y" }))[0], /held by x since .*--steal/);
  assert.deepEqual(v(ev("m", "claim", "5", { steal: true }, { lane: "y" })), []);
  assert.deepEqual(v(ev("m", "claim", "5", {}, { lane: "x" })), []);
  assert.match(v(ev("m", "item.edit", "5", { fields: { parent: "404" } }))[0], /parent/);
});

test(
  "loadBugIds reads origin/master's bug files; failure -> empty set",
  { timeout: 240000 },
  async () => {
    const repo = join(tmp, "bugrepo");
    mkdirSync(join(repo, ".claude", "campaign", "bugs"), { recursive: true });
    git(tmp, "init", "--quiet", "--initial-branch=main", repo);
    git(repo, "config", "user.name", "T");
    git(repo, "config", "user.email", "t@example.com");
    writeFileSync(join(repo, ".claude", "campaign", "bugs", "B12.md"), "---\nid: B12\n---\n");
    writeFileSync(join(repo, ".claude", "campaign", "bugs", "B7.md"), "---\nid: B7\n---\n");
    writeFileSync(join(repo, ".claude", "campaign", "bugs", "README.md"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "bugs");
    git(repo, "update-ref", "refs/remotes/origin/master", "HEAD");
    const ids = await loadBugIds(repo);
    assert.deepEqual([...ids].sort(), ["B12", "B7"]);
    const none = await loadBugIds(join(tmp, "not-a-repo-dir"));
    assert.equal(none.size, 0);
    mkdirSync(join(tmp, "plain"), { recursive: true });
    assert.equal((await loadBugIds(join(tmp, "plain"))).size, 0);
  },
);

test(
  "progressive batch validation: a train and a member in one batch; members/related are pattern-only",
  { timeout: 240000 },
  async () => {
    const r = await appendEvents(
      [
        newItem("m-a", "R1", "Train one", { type: "release", members: ["900", "777"] }),
        newItem("m-a", "900", "Member", { train: "R1", related: ["12345", "K9-1"] }),
      ],
      optsA(),
    );
    assert.deepEqual(
      r.events.map((e) => e.item),
      ["R1", "900"],
    );
    assert.equal(r.pushed, true);
    const s = stateOf(A);
    assert.equal(s.items.get("900").train, "R1");
    assert.deepEqual(s.items.get("R1").members, ["900", "777"]); // 777 does not exist: not checked
  },
);
