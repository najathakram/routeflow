// Team board fix round (W-1309, #4430 read A): read state by event id, not by time; the own-comment
// filter; masking before the clip; the prompt hook printing each comment once even when it arrives
// late; comment text scrubbed before it is stored and masked when rf item show prints it.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fold } from "../lib/fold.mjs";
import { readAllEvents } from "../lib/store.mjs";
import * as inbox from "../lib/inbox.mjs";
import * as config from "../lib/config.mjs";
import * as lanes from "../lib/lanes-local.mjs";
import * as brief from "../lib/brief.mjs";
import * as turn from "../lib/turn-actions.mjs";
import { LEGACY_CONFIG } from "./legacy-config.mjs";
import { makeRegisterRepo } from "./register-fixture.mjs";

const { commentsFor, isUnread, renderComment } = inbox;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
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
const at = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString();
const base = () => [
  ev("item.new", "W-1", { title: "Counter screen totals", type: "feature" }, T0),
  ev("item.new", "W-2", { title: "Invoice footer", type: "chore" }, T0),
];
const LEAD = { lane: "lead", actor: "lead" };
const texts = (list) => list.map((x) => x.comment.text);

// ── read state by id ────────────────────────────────────────────────────────
test("inbox: a mention that arrives late (older ts than one already read) is still unread", () => {
  // C's mention at ts 20 is already in the clone; lead reads it.
  const c = ev("comment", "W-1", { text: "from C", to: ["lead"] }, at(20), { lane: "sa" });
  let s = fold([...base(), c]);
  const seen = inbox.markSeen(
    null,
    commentsFor(s, LEAD).map((x) => x.comment),
  );
  // B's mention at ts 10 was written earlier on another machine and lands now.
  const b = ev("comment", "W-1", { text: "from B", to: ["lead"] }, at(10), {
    lane: "macmini",
    machine: "otherbox",
  });
  s = fold([...base(), c, b]);
  const unread = commentsFor(s, LEAD).filter((x) => isUnread(x.comment, seen));
  assert.equal(unread.length, 1);
  assert.deepEqual(texts(unread), ["from B"]);
});

test("inbox: the old { lastEventId, ts } marker upgrades; read ids are pruned behind a floor", () => {
  const legacy = inbox.normalizeSeen({ lastEventId: "x-1", ts: 1000 });
  assert.deepEqual(legacy, { v: 2, floorTs: 1000, ids: { "x-1": 1000 } });
  assert.equal(isUnread({ id: "y", ts: 999 }, legacy), false);
  assert.equal(isUnread({ id: "y", ts: 1001 }, legacy), true);
  assert.equal(inbox.normalizeSeen({ nonsense: true }), null);
  const day = 24 * 3600_000;
  const old = { id: "old", ts: 0 };
  const recent = { id: "new", ts: 40 * day };
  const m = inbox.markSeen(null, [old, recent]);
  assert.deepEqual(Object.keys(m.ids), ["new"]);
  assert.equal(m.floorTs, 40 * day - inbox.SEEN_KEEP_MS);
  assert.equal(isUnread(old, m), false, "older than the floor counts as read");
  assert.equal(isUnread({ id: "late", ts: 39 * day }, m), true, "inside the window, by id");
});

// ── the own-comment filter ──────────────────────────────────────────────────
test("inbox: a comment I wrote is never mine to read, even when it mentions me or sits on my claim", () => {
  const events = [
    ...base(),
    ev("claim", "W-1", {}, at(0), { lane: "lead" }),
    ev("comment", "W-1", { text: "note to self", to: ["lead"] }, at(1), { lane: "lead" }),
    ev("comment", "W-1", { text: "on my own claim" }, at(2), { lane: "lead" }),
    ev("comment", "W-1", { text: "from sa", to: ["lead"] }, at(3), { lane: "sa" }),
  ];
  assert.deepEqual(texts(commentsFor(fold(events), LEAD)), ["from sa"]);
});

// ── mask before the clip ────────────────────────────────────────────────────
test("renderComment: a client name across the clip point is masked whole, never left as a fragment", () => {
  // The name starts at char 128 and the clip is at 140, so clipping first would leave
  // "Acmeco Whol…", which the outer mask cannot match.
  const text = `${"z".repeat(127)} Acmeco Wholesale called`;
  const s = fold([...base(), ev("comment", "W-1", { text, to: ["lead"] }, at(1), { lane: "sa" })]);
  const line = renderComment(s.comments[0], s, {
    now: Date.parse(at(60)),
    clientNames: ["Acmeco Wholesale"],
  });
  assert.doesNotMatch(line, /Acmeco|Whol/);
  assert.match(line, /z a live busi|z a live business/);
});

test("scrubCommentText: client names, emails and tokens never reach the stored text", () => {
  const out = inbox.scrubCommentText(
    "Acmeco Wholesale (buyer@acmeco-mail.com) sent ghp_abcdefghijklmnopqrstuvwxyz0123456789 again",
    ["Acmeco Wholesale"],
  );
  assert.doesNotMatch(out, /Acmeco|acmeco-mail|ghp_/);
  assert.match(out, /^a live business \(a live business\) sent \[redacted\] again$/);
  assert.equal(inbox.scrubCommentText("ask qa@example.com", []), "ask qa@example.com");
});

// ── the prompt hook ─────────────────────────────────────────────────────────
const { briefFor } = await import(
  pathToFileURL(resolve(REPO, ".claude", "hooks", "ops-brief.mjs")).href
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
  inbox,
  machine: "testbox",
});

test("prompt hook: each comment prints once, a late one still prints, and rf inbox's read state counts", () => {
  const root = mkdtempSync(join(tmpdir(), "rf-inbox-hook-"));
  try {
    const home = join(root, "home");
    const specs = join(root, "specs");
    mkdirSync(join(specs, "events", "testbox"), { recursive: true });
    mkdirSync(join(specs, "events", "otherbox"), { recursive: true });
    const cwd = join(root, "checkout");
    mkdirSync(cwd, { recursive: true });
    lanes.setLane(home, cwd, "lead");
    const write = (machine, events) =>
      writeFileSync(
        join(specs, "events", machine, "2026-11-22.jsonl"),
        `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
    const env = { RF_OPS_HOME: home, RF_SPECS_DIR: specs };
    const hook = (mode, sec) =>
      briefFor(
        { hook_event_name: mode, session_id: "s1", cwd, prompt: "hi" },
        env,
        Date.parse(at(sec)),
        hookDeps(),
      );
    const mine = base();
    write("testbox", mine);
    hook("SessionStart", 5);
    mine.push(ev("comment", "W-1", { text: "from C", to: ["lead"] }, at(20), { lane: "sa" }));
    write("testbox", mine);
    let out = hook("UserPromptSubmit", 30);
    assert.match(out.text, /1 new comment for you:\n.*from C/);

    // Something unrelated arrives: the comment already printed is not printed again.
    mine.push(ev("item.new", "W-3", { title: "Route sheet", type: "chore" }, at(31)));
    write("testbox", mine);
    out = hook("UserPromptSubmit", 32);
    assert.doesNotMatch(out.text, /from C|new comment/);

    // B's mention, written at ts 10 on another machine, reaches the clone now.
    write("otherbox", [
      ev("comment", "W-1", { text: "from B", to: ["lead"] }, at(10), {
        lane: "macmini",
        machine: "otherbox",
      }),
    ]);
    out = hook("UserPromptSubmit", 40);
    assert.match(out.text, /1 new comment for you:\n.*from B/);
    assert.doesNotMatch(out.text, /from C/);

    // Read in rf inbox: a new session's first prompt after it prints nothing for it.
    const s = fold(readAllEvents(specs));
    inbox.writeInboxSeen(
      home,
      LEAD,
      commentsFor(s, LEAD).map((x) => x.comment),
    );
    const fresh = (mode, sec) =>
      briefFor(
        { hook_event_name: mode, session_id: "s2", cwd, prompt: "hi" },
        env,
        Date.parse(at(sec)),
        hookDeps(),
      );
    assert.doesNotMatch(fresh("SessionStart", 50).text, /new comment/);
    mine.push(ev("item.new", "W-4", { title: "Stop list", type: "chore" }, at(51)));
    write("testbox", mine);
    assert.doesNotMatch(fresh("UserPromptSubmit", 52).text, /new comment/);
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
  tmp = mkdtempSync(join(tmpdir(), "rfops-inbox-"));
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
  mkdirSync(join(tmp, "home"), { recursive: true });
  writeFileSync(join(tmp, "home", "client-names.json"), JSON.stringify(["Acmeco Wholesale"]));
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
  delete cliEnv.CLIENT_NAMES_JSON;
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
  "cli: comment text is scrubbed before it is stored; rf item show masks; a late mention is unread",
  T,
  async () => {
    let r = await rf(["item", "new", "--title", "Counter totals", "--type", "feature"], {
      RF_LANE: "lead",
    });
    assert.equal(r.code, 0, r.stderr);
    r = await rf(
      [
        "comment",
        "W-1",
        "--text",
        "Acmeco Wholesale asked, see buyer@acmeco-mail.com",
        "--to",
        "lead",
      ],
      { RF_LANE: "sa" },
    );
    assert.equal(r.code, 0, r.stderr);
    const stored = readAllEvents(cliEnv.RF_SPECS_DIR).find((e) => e.kind === "comment");
    assert.equal(stored.data.text, "a live business asked, see a live business");

    // A comment stored before this fix (raw text) prints masked in rf item show, text and --json.
    const dir = join(cliEnv.RF_SPECS_DIR, "events", "otherbox");
    mkdirSync(dir, { recursive: true });
    // Written on another machine between the item and the comment lead is about to read, so its ts
    // is older than that comment (and the fold, which orders by ts, still has the item).
    const made = readAllEvents(cliEnv.RF_SPECS_DIR).find((e) => e.kind === "item.new");
    const lateTs = new Date((Date.parse(made.ts) + Date.parse(stored.ts)) / 2).toISOString();
    assert.ok(
      Date.parse(lateTs) < Date.parse(stored.ts) && Date.parse(lateTs) > Date.parse(made.ts),
    );
    const raw = ev("comment", "W-1", { text: "Acmeco Wholesale again", to: ["lead"] }, lateTs, {
      lane: "macmini",
      machine: "otherbox",
    });
    r = await rf(["inbox"], { RF_LANE: "lead" });
    assert.match(r.stdout, /1 new comment for you/);
    // ...and it arrives after lead read the newer one: unread, though its ts is older.
    writeFileSync(join(dir, `${lateTs.slice(0, 10)}.jsonl`), `${JSON.stringify(raw)}\n`);
    r = await rf(["inbox"], { RF_LANE: "lead" });
    assert.match(r.stdout, /1 new comment for you/);
    assert.match(r.stdout, /macmini, .*: a live business again/);
    r = await rf(["item", "show", "W-1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Acmeco/);
    assert.match(r.stdout, /macmini → lead: a live business again/);
    r = await rf(["item", "show", "W-1", "--json"]);
    assert.doesNotMatch(r.stdout, /Acmeco/);

    // A mask list that does not parse refuses the comment, and nothing is written.
    writeFileSync(join(cliEnv.RF_OPS_HOME, "client-names.json"), '["Acmeco Wholesale", nope');
    const before = readFileSync(
      join(cliEnv.RF_SPECS_DIR, "events", "testbox", stored.ts.slice(0, 10) + ".jsonl"),
      "utf8",
    );
    r = await rf(["comment", "W-1", "--text", "hello", "--to", "lead"], { RF_LANE: "sa" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /client-names\.json unreadable; fix it before commenting/);
    assert.equal(
      readFileSync(
        join(cliEnv.RF_SPECS_DIR, "events", "testbox", stored.ts.slice(0, 10) + ".jsonl"),
        "utf8",
      ),
      before,
    );
    r = await rf(["item", "show", "W-1"]);
    assert.doesNotMatch(r.stdout, /Acmeco/);
    assert.match(r.stdout, /\[hidden: client-names\.json unreadable\]/);
  },
);
