import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  chmodSync,
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
import * as storeNs from "../lib/store.mjs";
import { fold } from "../lib/fold.mjs";
import { newEventId } from "../lib/ids.mjs";
import { writeViews } from "../lib/views.mjs";

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

// --- F2: lock ownership, reconcile before push, views never under events ----------------------

const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const ageLock = (lock, ms = 300000) => {
  const old = new Date(Date.now() - ms);
  for (const p of [join(lock, "owner.json"), lock]) {
    try {
      utimesSync(p, old, old);
    } catch {
      /* no owner.json on the old implementation */
    }
  }
};

test(
  "lock release only deletes the lock dir when the owner token is still ours",
  { timeout: 240000 },
  async () => {
    const home = join(tmp, "lock-home3");
    const lock = join(home, "specs.lock");
    let freeA;
    let freeB;
    let bRunning = false;
    const holdA = new Promise((r) => (freeA = r));
    const holdB = new Promise((r) => (freeB = r));
    const pA = withSpecsLock(async () => holdA, { home, heartbeatMs: 3600000 });
    await until(() => existsSync(lock));
    ageLock(lock); // A looks dead: no heartbeat for 5 minutes
    const pB = withSpecsLock(
      async () => {
        bRunning = true;
        await holdB;
      },
      { home, staleMs: 120000, heartbeatMs: 3600000 },
    );
    await until(() => bRunning);
    freeA(); // the old holder finishes late
    await pA;
    assert.ok(existsSync(lock), "A's release must not delete B's lock");
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    assert.equal(typeof owner.token, "string");
    assert.equal(owner.pid, process.pid);
    freeB();
    await pB;
    assert.equal(existsSync(lock), false);
  },
);

test(
  "tryWithSpecsLock runs when free, returns ran:false at once when busy; heartbeat keeps it fresh",
  { timeout: 240000 },
  async () => {
    const home = join(tmp, "lock-home4");
    const free = await storeNs.tryWithSpecsLock(async () => 42, { home });
    assert.deepEqual(free, { ran: true, value: 42 });
    assert.equal(existsSync(join(home, "specs.lock")), false);
    let release;
    const hold = new Promise((r) => (release = r));
    const holder = withSpecsLock(async () => hold, { home, heartbeatMs: 40 });
    await until(() => existsSync(join(home, "specs.lock", "owner.json")));
    await new Promise((r) => setTimeout(r, 400)); // 10 heartbeats; staleMs 250 would expire it
    let ran = false;
    const t0 = Date.now();
    const busy = await storeNs.tryWithSpecsLock(
      async () => {
        ran = true;
      },
      { home, staleMs: 250 },
    );
    assert.deepEqual(busy, { ran: false });
    assert.equal(ran, false);
    assert.ok(Date.now() - t0 < 2000, "no waiting when busy");
    release();
    await holder;
  },
);

function mkPair(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const rem = join(dir, "remote.git");
  git(dir, "init", "--bare", "--quiet", "--initial-branch=main", rem);
  const seed = join(dir, "seed");
  git(dir, "clone", "--quiet", rem, seed);
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  writeFileSync(join(seed, "README.md"), "specs\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", "-u", "origin", "main");
  const out = { remote: rem, A: join(dir, "a"), B: join(dir, "b") };
  for (const k of ["A", "B"]) {
    git(dir, "clone", "--quiet", rem, out[k]);
    git(out[k], "config", "user.name", `Machine ${k}`);
    git(out[k], "config", "user.email", `${k}@example.com`);
  }
  out.homeA = join(dir, "home-a");
  out.homeB = join(dir, "home-b");
  out.dir = dir;
  return out;
}

test(
  "offline item.new whose id another machine took is renumbered by syncSpecs before it pushes",
  { timeout: 600000 },
  async () => {
    const p = mkPair("rec-collide");
    git(p.A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));
    const ra = await appendEvents([newItem("m-a", null, "Offline item")], {
      dir: p.A,
      home: p.homeA,
    });
    assert.equal(ra.pushed, false);
    assert.equal(ra.events[0].item, "1");
    const rb = await appendEvents([newItem("m-b", null, "Other item")], {
      dir: p.B,
      home: p.homeB,
    });
    assert.equal(rb.pushed, true);
    assert.equal(rb.events[0].item, "1");
    git(p.A, "remote", "set-url", "origin", p.remote);
    const sync = await syncSpecs(p.A);
    assert.equal(sync.ok, true, sync.error);
    assert.equal(sync.pushed, true);
    const check = join(p.dir, "check");
    git(p.dir, "clone", "--quiet", p.remote, check);
    const s = stateOf(check);
    assert.equal(s.anomalies.length, 0, JSON.stringify(s.anomalies));
    assert.equal(s.items.get("1")?.title, "Other item");
    assert.equal(s.items.get("2")?.title, "Offline item");
    assert.equal(git(p.A, "status", "--porcelain").trim(), "");
    assert.equal(git(p.A, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  },
);

test(
  "a claim another lane won while our push was rejected is refused after the rebase",
  { timeout: 600000 },
  async () => {
    const p = mkPair("rec-claim");
    const oA = { dir: p.A, home: p.homeA };
    await appendEvents([newItem("m-a", "1", "Contested")], oA);
    await syncSpecs(p.B);
    const res = await appendEvents([ev("m-b", "claim", "1", {}, { lane: "lane-y" })], {
      dir: p.B,
      home: p.homeB,
      _beforePush: async () => {
        const r = await appendEvents([ev("m-a", "claim", "1", {}, { lane: "lane-x" })], oA);
        assert.equal(r.pushed, true);
      },
    });
    assert.equal(res.refused.length, 1, JSON.stringify(res));
    assert.match(res.refused[0].error, /held by lane-x/);
    assert.equal(res.events.length, 0);
    const claims = readAllEvents(p.B).filter((e) => e.kind === "claim");
    assert.deepEqual(
      claims.map((c) => c.lane),
      ["lane-x"],
    );
    await syncSpecs(p.A);
    for (const d of [p.A, p.B]) assert.equal(stateOf(d).items.get("1").claimedBy, "lane-x");
    assert.equal(git(p.B, "status", "--porcelain").trim(), "");
    assert.equal(git(p.B, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  },
);

test(
  "writeViews whose push loses to a conflicting views commit aborts, resets to upstream, and event appends still push",
  { timeout: 600000 },
  async () => {
    const p = mkPair("views-conflict");
    const vitem = (id, title) => ({
      id,
      title,
      type: "feature",
      priority: "P2",
      status: "planned",
      lane: null,
      train: null,
      trainLabel: null,
      gate: null,
      eta: null,
      links: { prs: [], branches: [], urls: [] },
      claimedBy: null,
      blocked: null,
      updatedAt: "2026-10-18T10:00:00.000Z",
    });
    const snap = (title) => ({
      generatedAt: "2026-10-19T04:00:00.000Z",
      machine: "pc",
      sources: {},
      items: [vitem("1", title)],
    });
    const depsFor = (home, extraSync) => ({
      withLock: (fn) => withSpecsLock(fn, { home }),
      syncSpecs: async (d) => {
        const r = await syncSpecs(d);
        if (extraSync) await extraSync();
        return r;
      },
      exec,
    });
    let raced = false;
    const rA = await writeViews({
      registerMode: "views",
      specsDir: p.A,
      boardDir: join(p.dir, "board-a"),
      snapshot: snap("From machine A"),
      deps: depsFor(p.homeA, async () => {
        if (raced) return;
        raced = true;
        const rB = await writeViews({
          registerMode: "views",
          specsDir: p.B,
          boardDir: join(p.dir, "board-b"),
          snapshot: snap("From machine B"),
          deps: depsFor(p.homeB),
        });
        assert.equal(rB.pushed, true);
      }),
    });
    assert.equal(rA.pushed, false);
    assert.equal(rA.retryLater, true);
    const gitDir = join(p.A, ".git");
    assert.equal(existsSync(join(gitDir, "rebase-merge")), false, "rebase left in progress");
    assert.equal(existsSync(join(gitDir, "rebase-apply")), false, "rebase left in progress");
    assert.equal(git(p.A, "rev-parse", "HEAD").trim(), git(p.A, "rev-parse", "@{u}").trim());
    assert.equal(git(p.A, "status", "--porcelain").trim(), "");
    assert.match(readFileSync(join(p.A, "register", "WORK-REGISTER.md"), "utf8"), /From machine B/);
    const r = await appendEvents([ev("m-a", "note", null, { text: "after views" })], {
      dir: p.A,
      home: p.homeA,
    });
    assert.equal(r.pushed, true);
  },
);

// --- A3: generated register mode (events commit + a disposable views-only commit) ---------------

import { registerHook, renderGeneratedRegister } from "../lib/views.mjs";
import { dropUnpushedViews } from "../lib/store.mjs";

const subjects = (dir, range) => git(dir, "log", "--format=%s", range).split("\n").filter(Boolean);
const filesOf = (dir, rev) =>
  git(dir, "show", "--name-only", "--format=", rev).split("\n").filter(Boolean);

test(
  "generated mode, two machines append concurrently: both land and the remote register is render(fold(all events))",
  { timeout: 900000 },
  async () => {
    const p = mkPair("gen-two-machines");
    const hook = registerHook();
    let bReady;
    let aDone;
    const bCommitted = new Promise((r) => (bReady = r));
    const aPushed = new Promise((r) => (aDone = r));
    const [ra, rb] = await Promise.all([
      appendEvents([newItem("m-a", null, "Item from machine A")], {
        dir: p.A,
        home: p.homeA,
        afterCommit: hook,
        _beforePush: async () => {
          await bCommitted; // both machines have committed before either pushes
        },
      }).then((r) => {
        aDone();
        return r;
      }),
      appendEvents([newItem("m-b", null, "Item from machine B")], {
        dir: p.B,
        home: p.homeB,
        afterCommit: hook,
        _beforePush: async () => {
          bReady();
          await aPushed; // A pushes first, so B's push is rejected
        },
      }),
    ]);
    assert.equal(ra.pushed, true);
    assert.equal(rb.pushed, true);
    assert.ok(rb.attempts >= 2, `B must have been rejected once (attempts ${rb.attempts})`);

    const check = join(p.dir, "check");
    git(p.dir, "clone", "--quiet", p.remote, check);
    const state = stateOf(check);
    assert.equal(state.anomalies.length, 0, JSON.stringify(state.anomalies));
    assert.equal(state.items.size, 2);
    assert.deepEqual([...state.items.values()].map((i) => i.title).sort(), [
      "Item from machine A",
      "Item from machine B",
    ]);
    const onRemote = readFileSync(join(check, "register", "WORK-REGISTER.md"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    assert.equal(onRemote, renderGeneratedRegister(state, { itemFileExists: () => false }));
    assert.match(onRemote, /Item from machine A/);
    assert.match(onRemote, /Item from machine B/);
    // The tip is a views-only commit, the commit under it is B's events.
    const subs = subjects(check, "HEAD");
    assert.match(subs[0], /^ops\(views\):/);
    assert.match(subs[1], /^ops\(m-b\): item\.new/);
    assert.deepEqual(filesOf(check, "HEAD"), ["register/WORK-REGISTER.md"]);
    for (const d of [p.A, p.B]) {
      assert.equal(git(d, "status", "--porcelain").trim(), "");
    }
  },
);

test(
  "dropUnpushedViews drops only our unpushed views-only tip, never events and never over a dirty tree",
  { timeout: 600000 },
  async () => {
    const p = mkPair("drop-tip");
    const hook = registerHook();
    // events commit + views commit, kept local (no push)
    await appendEvents([newItem("m-a", null, "Local only")], {
      dir: p.A,
      home: p.homeA,
      push: false,
      afterCommit: hook,
    });
    assert.match(subjects(p.A, "@{u}..HEAD")[0], /^ops\(views\):/);
    writeFileSync(join(p.A, "stray.txt"), "dirty\n");
    git(p.A, "add", "stray.txt");
    assert.equal(await dropUnpushedViews(p.A), false, "dirty tree: nothing dropped");
    git(p.A, "reset", "--quiet", "--hard", "HEAD");
    assert.equal(await dropUnpushedViews(p.A), true);
    assert.deepEqual(
      subjects(p.A, "@{u}..HEAD").map((s) => s.replace(/\(.*$/, "")),
      ["ops"],
    );
    assert.match(subjects(p.A, "@{u}..HEAD")[0], /^ops\(m-a\): item\.new/);
    assert.equal(await dropUnpushedViews(p.A), false, "an events commit is never dropped");
    // the dropped views commit took its register text with it
    assert.doesNotMatch(
      readFileSync(join(p.A, "register", "WORK-REGISTER.md"), "utf8"),
      /Local only/,
    );
  },
);

test(
  "generated mode offline: events + views stay local, then syncSpecs pushes events and a fresh register",
  { timeout: 900000 },
  async () => {
    const p = mkPair("gen-offline");
    const hook = registerHook();
    git(p.A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));
    const ra = await appendEvents([newItem("m-a", null, "Made offline")], {
      dir: p.A,
      home: p.homeA,
      afterCommit: hook,
    });
    assert.equal(ra.pushed, false);
    const rb = await appendEvents([newItem("m-b", null, "Made online")], {
      dir: p.B,
      home: p.homeB,
      afterCommit: hook,
    });
    assert.equal(rb.pushed, true);
    git(p.A, "remote", "set-url", "origin", p.remote);
    const sync = await syncSpecs(p.A, { afterCommit: hook });
    assert.equal(sync.ok, true, sync.error);
    assert.equal(sync.pushed, true);
    const check = join(p.dir, "check");
    git(p.dir, "clone", "--quiet", p.remote, check);
    const state = stateOf(check);
    assert.equal(state.anomalies.length, 0, JSON.stringify(state.anomalies));
    assert.equal(state.items.size, 2);
    assert.equal(
      readFileSync(join(check, "register", "WORK-REGISTER.md"), "utf8").replace(/\r\n/g, "\n"),
      renderGeneratedRegister(state, { itemFileExists: () => false }),
    );
    assert.equal(git(p.A, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  },
);

// --- H4: plain syncSpecs in generated mode, register-sourced collisions, stale-lock race -------

test(
  "generated mode: a plain syncSpecs (no afterCommit) drops a leftover views tip and lands cleanly",
  { timeout: 900000 },
  async () => {
    const p = mkPair("gen-plain-sync");
    const hook = registerHook();
    mkdirSync(join(p.A, "ops"), { recursive: true });
    writeFileSync(join(p.A, "ops", "config.json"), JSON.stringify({ registerMode: "generated" }));
    git(p.A, "add", "ops/config.json");
    git(p.A, "commit", "--quiet", "-m", "config");
    git(p.A, "push", "--quiet");
    git(p.B, "pull", "--quiet", "--rebase");
    await appendEvents([newItem("m-a", null, "From machine A")], {
      dir: p.A,
      home: p.homeA,
      push: false,
      afterCommit: hook,
    });
    assert.match(subjects(p.A, "@{u}..HEAD")[0], /^ops\(views\):/, "A holds a leftover views tip");
    await appendEvents([newItem("m-b", null, "From machine B")], {
      dir: p.B,
      home: p.homeB,
      afterCommit: hook,
    });
    const sync = await syncSpecs(p.A); // the collector / rf sync call shape: no afterCommit
    assert.equal(sync.ok, true, sync.error);
    assert.equal(sync.pushed, true);
    assert.equal(git(p.A, "status", "--porcelain").trim(), "");
    const check = join(p.dir, "check");
    git(p.dir, "clone", "--quiet", p.remote, check);
    const state = stateOf(check);
    assert.equal(state.items.size, 2);
    assert.equal(
      readFileSync(join(check, "register", "WORK-REGISTER.md"), "utf8").replace(/\r\n/g, "\n"),
      renderGeneratedRegister(state, { itemFileExists: () => false }),
    );
  },
);

test(
  "a register-sourced item.new whose id another machine already created is dropped, not renumbered",
  { timeout: 600000 },
  async () => {
    const p = mkPair("rec-register-dup");
    git(p.A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));
    await appendEvents([newItem("m-a", "300", "Register row", { source: "register" })], {
      dir: p.A,
      home: p.homeA,
    });
    await appendEvents([newItem("m-b", "300", "Register row", { source: "register" })], {
      dir: p.B,
      home: p.homeB,
    });
    git(p.A, "remote", "set-url", "origin", p.remote);
    const sync = await syncSpecs(p.A);
    assert.equal(sync.ok, true, sync.error);
    assert.equal(sync.reconciled.changes.size, 0, "no renumbering");
    assert.equal(sync.reconciled.dropped.length, 1);
    const state = stateOf(p.A);
    assert.deepEqual([...state.items.keys()], ["300"]);
    assert.equal(git(p.A, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  },
);

test(
  "a stale lock whose holder refreshed it before the rename is given back, not reclaimed",
  { timeout: 240000 },
  async () => {
    const home = join(tmp, "lock-home-race");
    const lock = join(home, "specs.lock");
    const owner = join(lock, "owner.json");
    mkdirSync(lock, { recursive: true });
    writeFileSync(owner, JSON.stringify({ token: "T-old", pid: 1, host: "x", at: "x" }));
    ageLock(lock);
    let ran = false;
    await assert.rejects(
      withSpecsLock(
        async () => {
          ran = true;
        },
        {
          home,
          waitMs: 300,
          pollMs: 50,
          _beforeReclaim: () =>
            // a new holder takes over right after the waiter judged the lock stale
            writeFileSync(owner, JSON.stringify({ token: "T-new", pid: 2, host: "x", at: "x" })),
        },
      ),
      /lock/i,
    );
    assert.equal(ran, false);
    assert.equal(JSON.parse(readFileSync(owner, "utf8")).token, "T-new");
    rmSync(lock, { recursive: true, force: true });
  },
);

// --- R3: views never buried under events, register-collision ownership, same-holder heartbeat ---

test(
  "dropUnpushedViews removes a views commit buried under events and keeps the events in order",
  { timeout: 600000 },
  async () => {
    const p = mkPair("drop-buried");
    const hook = registerHook();
    await appendEvents([newItem("m-a", null, "First local")], {
      dir: p.A,
      home: p.homeA,
      push: false,
      afterCommit: hook,
    });
    // Human mode (no config), no hook, offline (the sync would push the first two): this event
    // lands ABOVE the views commit.
    git(p.A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));
    await appendEvents([newItem("m-a", null, "Second local")], {
      dir: p.A,
      home: p.homeA,
      push: false,
    });
    git(p.A, "remote", "set-url", "origin", p.remote);
    const before = subjects(p.A, "@{u}..HEAD").reverse();
    assert.match(before[0], /^ops\(m-a\): item\.new/);
    assert.match(before[1], /^ops\(views\):/);
    assert.match(before[2], /^ops\(m-a\): item\.new/);
    assert.equal(await dropUnpushedViews(p.A), true);
    const after = subjects(p.A, "@{u}..HEAD").reverse();
    assert.equal(after.length, 2);
    assert.ok(
      after.every((x) => /^ops\(m-a\): item\.new/.test(x)),
      after.join(" | "),
    );
    const s = stateOf(p.A);
    assert.deepEqual([...s.items.values()].map((i) => i.title).sort(), [
      "First local",
      "Second local",
    ]);
    assert.equal(git(p.A, "status", "--porcelain").trim(), "");
  },
);

test(
  "a kill mid-replay of dropUnpushedViews (detached HEAD) is healed by the next sync: nothing lost, nothing dropped",
  { timeout: 600000 },
  async () => {
    for (const picked of [false, true]) {
      const p = mkPair(`drop-crash-${picked}`);
      await appendEvents([newItem("m-a", null, "First local")], {
        dir: p.A,
        home: p.homeA,
        push: false,
        afterCommit: registerHook(),
      });
      git(p.A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));
      await appendEvents([newItem("m-a", null, "Second local")], {
        dir: p.A,
        home: p.homeA,
        push: false,
      });
      git(p.A, "remote", "set-url", "origin", p.remote);
      const shas = git(p.A, "rev-list", "--reverse", "@{u}..HEAD").trim().split(/\s+/);
      assert.equal(shas.length, 3);
      const tip = git(p.A, "rev-parse", "HEAD").trim();
      const branch = git(p.A, "symbolic-ref", "--short", "HEAD").trim();
      // What the replay does up to the kill: detach below the views commit, (maybe) the first pick.
      git(p.A, "checkout", "--quiet", "--detach", `${shas[1]}~1`);
      if (picked) git(p.A, "-c", "commit.gpgsign=false", "cherry-pick", "--no-edit", shas[2]);
      const r = await syncSpecs(p.A);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.pushed, true);
      assert.equal(git(p.A, "symbolic-ref", "--short", "HEAD").trim(), branch, "re-attached");
      assert.equal(git(p.A, "rev-parse", branch).trim(), tip, "the branch was never moved");
      const check = join(p.dir, "check");
      git(p.dir, "clone", "--quiet", p.remote, check);
      assert.deepEqual([...stateOf(check).items.values()].map((x) => x.title).sort(), [
        "First local",
        "Second local",
      ]);
      assert.equal(git(check, "rev-parse", "HEAD").trim(), tip, "every event commit pushed");
    }
  },
);

test(
  "generated mode: a sync push that loses a race leaves no views commit under the next events",
  { timeout: 900000 },
  async () => {
    const p = mkPair("gen-buried");
    const hook = registerHook();
    mkdirSync(join(p.A, "ops"), { recursive: true });
    writeFileSync(join(p.A, "ops", "config.json"), JSON.stringify({ registerMode: "generated" }));
    git(p.A, "add", "ops/config.json");
    git(p.A, "commit", "--quiet", "-m", "config");
    git(p.A, "push", "--quiet");
    git(p.B, "pull", "--quiet", "--rebase");
    await appendEvents([newItem("m-a", null, "E0 local")], {
      dir: p.A,
      home: p.homeA,
      push: false,
      afterCommit: hook,
    });
    await appendEvents([newItem("m-b", null, "Remote item")], {
      dir: p.B,
      home: p.homeB,
      push: false,
      afterCommit: hook,
    });
    // A's first push is preceded by B pushing: A's sync push (after its pull) is rejected.
    const fwd = (x) => x.split("\\").join("/");
    const marker = fwd(join(p.dir, "b-pushed"));
    const hookFile = join(p.A, ".git", "hooks", "pre-push");
    mkdirSync(join(p.A, ".git", "hooks"), { recursive: true });
    writeFileSync(
      hookFile,
      [
        "#!/bin/sh",
        `if [ ! -f "${marker}" ]; then`,
        `  : > "${marker}"`,
        "  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
        `  git -C "${fwd(p.B)}" push --quiet origin HEAD >/dev/null 2>&1`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(hookFile, 0o755);
    const r = await appendEvents([newItem("m-a", null, "E1 after")], {
      dir: p.A,
      home: p.homeA,
      afterCommit: hook,
    });
    assert.ok(existsSync(join(p.dir, "b-pushed")), "the racing push happened");
    assert.equal(r.pushed, true, JSON.stringify(r.warnings));
    const check = join(p.dir, "check");
    git(p.dir, "clone", "--quiet", p.remote, check);
    const state = stateOf(check);
    assert.equal(state.anomalies.length, 0, JSON.stringify(state.anomalies));
    assert.deepEqual([...state.items.values()].map((i) => i.title).sort(), [
      "E0 local",
      "E1 after",
      "Remote item",
    ]);
    assert.equal(
      readFileSync(join(check, "register", "WORK-REGISTER.md"), "utf8").replace(/\r\n/g, "\n"),
      renderGeneratedRegister(state, { itemFileExists: () => false }),
    );
    const log = git(check, "log", "--format=%x00%s", "--name-only").split("\0").filter(Boolean);
    for (const entry of log) {
      const [subject, ...names] = entry.split(/\r?\n/).filter(Boolean);
      if (/^ops\((?!views)/.test(subject))
        assert.ok(!names.some((n) => /WORK-REGISTER/.test(n)), `${subject} holds the register`);
    }
  },
);

test(
  "a register-sourced item.new colliding with a non-register item is renumbered, not dropped",
  { timeout: 600000 },
  async () => {
    const p = mkPair("rec-register-vs-plain");
    git(p.A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));
    await appendEvents([newItem("m-a", "300", "Register row", { source: "register" })], {
      dir: p.A,
      home: p.homeA,
    });
    await appendEvents([newItem("m-b", "300", "Plain row")], { dir: p.B, home: p.homeB });
    git(p.A, "remote", "set-url", "origin", p.remote);
    const sync = await syncSpecs(p.A);
    assert.equal(sync.ok, true, sync.error);
    assert.equal(sync.reconciled.dropped.length, 0, "nothing dropped");
    assert.equal(sync.reconciled.changes.size, 1, "renumbered");
    const state = stateOf(p.A);
    assert.deepEqual([...state.items.values()].map((i) => i.title).sort(), [
      "Plain row",
      "Register row",
    ]);
    assert.equal(git(p.A, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  },
);

test(
  "a stale lock whose same holder heartbeated before the rename is given back, not reclaimed",
  { timeout: 240000 },
  async () => {
    const home = join(tmp, "lock-home-heartbeat");
    const lock = join(home, "specs.lock");
    const owner = join(lock, "owner.json");
    mkdirSync(lock, { recursive: true });
    writeFileSync(owner, JSON.stringify({ token: "T-same", pid: 1, host: "x", at: "x" }));
    ageLock(lock);
    let ran = false;
    await assert.rejects(
      withSpecsLock(
        async () => {
          ran = true;
        },
        {
          home,
          waitMs: 300,
          pollMs: 50,
          _beforeReclaim: () => {
            const now = new Date(); // the same holder's heartbeat lands after the judgment
            utimesSync(owner, now, now);
          },
        },
      ),
      /lock/i,
    );
    assert.equal(ran, false);
    assert.equal(JSON.parse(readFileSync(owner, "utf8")).token, "T-same");
    rmSync(lock, { recursive: true, force: true });
  },
);
