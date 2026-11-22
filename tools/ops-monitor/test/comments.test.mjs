// Team board, part 1: threaded comments with mentions, the inbox, and "N new comments for you" in
// the brief and the per-prompt hook. Members on other computers and other Claude accounts cannot
// message a session, so a comment on the item is the only channel.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateEvent } from "../lib/schema.mjs";
import { fold } from "../lib/fold.mjs";
import { validateAgainstState, readAllEvents } from "../lib/store.mjs";
import { renderBrief } from "../lib/brief.mjs";
import { commentsFor, isUnread, renderComment, threadOf } from "../lib/inbox.mjs";
import * as config from "../lib/config.mjs";
import * as lanes from "../lib/lanes-local.mjs";
import * as brief from "../lib/brief.mjs";
import * as turn from "../lib/turn-actions.mjs";
import { LEGACY_CONFIG } from "./legacy-config.mjs";
import { makeRegisterRepo } from "./register-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const RF = resolve(HERE, "..", "bin", "rf.mjs");

let seq = 0;
function ev(
  kind,
  item,
  data,
  ts,
  { lane = "lead", actor = lane ?? "tester", machine = "testbox" } = {},
) {
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
const base = () => [
  ev("item.new", "W-1", { title: "Counter screen totals", type: "feature" }, T0),
  ev("item.new", "W-2", { title: "Invoice footer", type: "chore" }, T0),
];

// ── schema ──────────────────────────────────────────────────────────────────
test("comment schema: text required, optional to[] and replyTo, strict keys, needs an item", () => {
  const ok = ev("comment", "W-1", { text: "Can you take this?", to: ["macmini"] }, T0);
  assert.deepEqual(validateEvent(ok).errors, []);
  const reply = ev("comment", "W-1", { text: "Yes", replyTo: ok.id }, at(1));
  assert.deepEqual(validateEvent(reply).errors, []);
  const bad = [
    ev("comment", null, { text: "no item" }, T0),
    ev("comment", "W-1", {}, T0),
    ev("comment", "W-1", { text: "   " }, T0),
    ev("comment", "W-1", { text: "x".repeat(2001) }, T0),
    ev("comment", "W-1", { text: "x", to: "macmini" }, T0),
    ev("comment", "W-1", { text: "x", to: ["Not A Lane"] }, T0),
    ev("comment", "W-1", { text: "x", to: [] }, T0),
    ev("comment", "W-1", { text: "x", to: new Array(11).fill("lead") }, T0),
    ev("comment", "W-1", { text: "x", replyTo: "not-an-event-id" }, T0),
    ev("comment", "W-1", { text: "x", mention: ["lead"] }, T0),
  ];
  for (const b of bad)
    assert.equal(validateEvent(b).ok, false, JSON.stringify(b.data).slice(0, 60));
});

// ── fold ────────────────────────────────────────────────────────────────────
test("fold: comments land in state.comments in order, touch the item, and follow a rename", () => {
  const c1 = ev("comment", "W-1", { text: "first", to: ["macmini"] }, at(1));
  const c2 = ev("comment", "W-1", { text: "reply", replyTo: c1.id }, at(2), { lane: "macmini" });
  const s = fold([...base(), c2, c1, ev("item.rename", "W-1", { to: "W-9" }, at(3))]);
  assert.deepEqual(
    s.comments.map((c) => [c.id, c.item, c.text, c.replyTo, c.to]),
    [
      [c1.id, "W-9", "first", null, ["macmini"]],
      [c2.id, "W-9", "reply", c1.id, []],
    ],
  );
  assert.equal(s.comments[1].actor, "macmini");
  assert.equal(s.items.get("W-9").updatedAt, Date.parse(at(2)));
  assert.ok(s.items.get("W-9").history.some((h) => h.kind === "comment"));
  assert.equal(s.anomalies.length, 0);
});

test("fold: a reply to an unknown comment, or one on another item, is an anomaly and reads as top-level", () => {
  const c1 = ev("comment", "W-1", { text: "on W-1" }, at(1));
  const stray = ev("comment", "W-2", { text: "wrong item", replyTo: c1.id }, at(2));
  const s = fold([...base(), c1, stray]);
  assert.equal(s.comments.length, 2);
  assert.ok(s.anomalies.some((a) => a.kind === "orphan-reply" && a.eventId === stray.id));
  assert.deepEqual(
    threadOf(s, "W-2").map((r) => [r.depth, r.comment.text]),
    [[0, "wrong item"]],
  );
});

test("store: a reply must name a comment on the same item", () => {
  const c1 = ev("comment", "W-1", { text: "on W-1" }, at(1));
  const s = fold([...base(), c1]);
  const good = ev("comment", "W-1", { text: "ok", replyTo: c1.id }, at(2));
  assert.deepEqual(validateAgainstState(good, s), []);
  const otherItem = ev("comment", "W-2", { text: "x", replyTo: c1.id }, at(2));
  assert.match(validateAgainstState(otherItem, s).join(), /comment .* is on W-1, not W-2/);
  const missing = ev("comment", "W-1", { text: "x", replyTo: "testbox-0000000000001-zzzz" }, at(2));
  assert.match(validateAgainstState(missing, s).join(), /no comment testbox-0000000000001-zzzz/);
  const unknown = ev("comment", "W-77", { text: "x" }, at(2));
  assert.match(validateAgainstState(unknown, s).join(), /unknown item W-77/);
});

// ── inbox ───────────────────────────────────────────────────────────────────
test("inbox: mentions, replies to you and comments on your claimed item are yours; your own are not", () => {
  const mine = ev("comment", "W-1", { text: "macmini, can you check?" }, at(1), { lane: "lead" });
  const events = [
    ...base(),
    ev("claim", "W-2", {}, at(0), { lane: "macmini" }),
    mine,
    ev("comment", "W-1", { text: "to lead", to: ["lead"] }, at(2), { lane: "macmini" }),
    ev("comment", "W-1", { text: "reply to lead", replyTo: mine.id }, at(3), { lane: "sa" }),
    ev("comment", "W-1", { text: "to sa only", to: ["sa"] }, at(4), { lane: "macmini" }),
    ev("comment", "W-2", { text: "on macmini's card" }, at(5), { lane: "lead" }),
    ev("comment", "W-1", { text: "to a person", to: ["alex"] }, at(6), {
      lane: null,
      actor: "sam",
    }),
  ];
  const s = fold(events);
  const lead = commentsFor(s, { lane: "lead", actor: "lead" });
  assert.deepEqual(
    lead.map((x) => [x.comment.text, x.reason]),
    [
      ["to lead", "mention"],
      ["reply to lead", "reply"],
    ],
  );
  const mm = commentsFor(s, { lane: "macmini", actor: "macmini" });
  assert.deepEqual(
    mm.map((x) => [x.comment.text, x.reason]),
    [["on macmini's card", "claimed"]],
  );
  // A person is matched on the actor a member writes under, with no lane at all.
  const alex = commentsFor(s, { lane: null, actor: "alex" });
  assert.deepEqual(
    alex.map((x) => x.comment.text),
    ["to a person"],
  );
});

test("inbox: unread is everything after the read marker, in fold order", () => {
  const c1 = ev("comment", "W-1", { text: "one", to: ["lead"] }, at(1), { lane: "sa" });
  const c2 = ev("comment", "W-1", { text: "two", to: ["lead"] }, at(2), { lane: "sa" });
  const s = fold([...base(), c1, c2]);
  const mine = commentsFor(s, { lane: "lead", actor: "lead" });
  assert.equal(mine.filter((x) => isUnread(x.comment, null)).length, 2);
  const seen = { lastEventId: c1.id, ts: Date.parse(c1.ts) };
  assert.deepEqual(
    mine.filter((x) => isUnread(x.comment, seen)).map((x) => x.comment.text),
    ["two"],
  );
});

test("renderComment: one line with item, author, age, text and the reply id; client names masked before the clip", () => {
  const c1 = ev(
    "comment",
    "W-1",
    { text: `Acmeco Wholesale asked again ${"z".repeat(300)}`, to: ["lead"] },
    at(1),
    { lane: "sa" },
  );
  const s = fold([...base(), c1]);
  const line = renderComment(s.comments[0], s, {
    now: Date.parse(at(6)),
    clientNames: ["Acmeco Wholesale"],
  });
  assert.match(line, /^- \[W-1\] sa, 5 min ago: a live business asked again z+…/);
  assert.match(line, new RegExp(`\\(reply: rf comment W-1 --reply-to ${c1.id}\\)$`));
  assert.doesNotMatch(line, /Acmeco/);
  assert.ok(line.length < 260, String(line.length));
});

test("threadOf: replies sit under their parent, oldest first", () => {
  const a = ev("comment", "W-1", { text: "a" }, at(1));
  const b = ev("comment", "W-1", { text: "b" }, at(2));
  const a1 = ev("comment", "W-1", { text: "a1", replyTo: a.id }, at(3));
  const a1x = ev("comment", "W-1", { text: "a1x", replyTo: a1.id }, at(4));
  const s = fold([...base(), a, b, a1, a1x]);
  assert.deepEqual(
    threadOf(s, "W-1").map((r) => `${r.depth}:${r.comment.text}`),
    ["0:a", "1:a1", "2:a1x", "0:b"],
  );
});

// ── brief ───────────────────────────────────────────────────────────────────
test("renderBrief: 'N new comments for you' leads the brief with the text, and only unread ones", () => {
  const c1 = ev("comment", "W-1", { text: "seen already", to: ["lead"] }, at(1), { lane: "sa" });
  const c2 = ev("comment", "W-1", { text: "please review the totals", to: ["lead"] }, at(2), {
    lane: "sa",
  });
  const c3 = ev("comment", "W-2", { text: "and the footer", to: ["lead"] }, at(3), { lane: "sa" });
  const s = fold([...base(), c1, c2, c3]);
  const text = renderBrief(s, {
    lane: "lead",
    me: { lane: "lead", actor: "lead" },
    inboxSeen: { lastEventId: c1.id, ts: Date.parse(c1.ts) },
    now: Date.parse(at(10)),
    config: LEGACY_CONFIG,
  });
  const lines = text.split("\n");
  assert.equal(lines[1], "2 new comments for you (rf inbox):");
  assert.match(lines[2], /\[W-1\] sa, 8 min ago: please review the totals/);
  assert.match(lines[3], /\[W-2\] sa, 7 min ago: and the footer/);
  assert.doesNotMatch(text, /seen already/);
  // Nothing unread: no section at all.
  const quiet = renderBrief(s, {
    lane: "lead",
    me: { lane: "lead", actor: "lead" },
    inboxSeen: { lastEventId: c3.id, ts: Date.parse(c3.ts) },
    now: Date.parse(at(10)),
    config: LEGACY_CONFIG,
  });
  assert.doesNotMatch(quiet, /comments? for you/);
});

test("renderBrief: a single unread comment reads '1 new comment for you'", () => {
  const c = ev("comment", "W-1", { text: "hi", to: ["lead"] }, at(1), { lane: "sa" });
  const text = renderBrief(fold([...base(), c]), {
    lane: "lead",
    me: { lane: "lead", actor: "lead" },
    now: Date.parse(at(2)),
  });
  assert.match(text, /^1 new comment for you \(rf inbox\):$/m);
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
  inbox: { commentsFor, renderComment },
  machine: "testbox",
});

test("prompt hook: new comments for this lane print with their text; the session's own do not", () => {
  const root = mkdtempSync(join(tmpdir(), "rf-cmt-hook-"));
  try {
    const home = join(root, "home");
    const specs = join(root, "specs");
    mkdirSync(join(specs, "events", "testbox"), { recursive: true });
    const cwd = join(root, "checkout");
    mkdirSync(cwd, { recursive: true });
    lanes.setLane(home, cwd, "macmini");
    const write = (events) =>
      writeFileSync(
        join(specs, "events", "testbox", "2026-11-22.jsonl"),
        `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
    const events = base();
    write(events);
    const env = { RF_OPS_HOME: home, RF_SPECS_DIR: specs };
    const now = Date.parse(at(30));
    briefFor({ hook_event_name: "SessionStart", session_id: "s1", cwd }, env, now, hookDeps());
    events.push(
      ev("comment", "W-1", { text: "can you pick up the totals?", to: ["macmini"] }, at(31), {
        lane: "lead",
      }),
      ev("comment", "W-1", { text: "my own note", to: ["macmini"] }, at(32), { lane: "macmini" }),
      ev("comment", "W-2", { text: "not for you", to: ["sa"] }, at(33), { lane: "lead" }),
    );
    write(events);
    const out = briefFor(
      { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt: "hi" },
      env,
      Date.parse(at(35)),
      hookDeps(),
    );
    assert.match(out.text, /\[ops monitor\] 1 new comment for you:/);
    assert.match(out.text, /\[W-1\] lead, 4 min ago: can you pick up the totals\?/);
    assert.doesNotMatch(out.text, /my own note|not for you/);
    // Seen once: the next prompt is quiet.
    const again = briefFor(
      { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt: "hi" },
      env,
      Date.parse(at(36)),
      hookDeps(),
    );
    assert.doesNotMatch(again.text, /comment/);
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
  tmp = mkdtempSync(join(tmpdir(), "rfops-cmt-"));
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

test(
  "rf comment -> rf inbox (marks read) -> reply -> rf item show thread; bad mentions and replies refused",
  T,
  async () => {
    let r = await rf(["item", "new", "--title", "Counter totals", "--type", "feature"], {
      RF_LANE: "lead",
    });
    assert.equal(r.code, 0, r.stderr);
    r = await rf(
      ["comment", "W-1", "--text", "macmini, can you take this?", "--to", "macmini", "--json"],
      {
        RF_LANE: "lead",
      },
    );
    assert.equal(r.code, 0, r.stderr);
    const asked = JSON.parse(r.stdout).events[0];
    assert.equal(asked.kind, "comment");
    assert.deepEqual(asked.data, { text: "macmini, can you take this?", to: ["macmini"] });

    // Unknown mention: usage error before anything is written.
    r = await rf(["comment", "W-1", "--text", "x", "--to", "nobody-here"], { RF_LANE: "lead" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown lane or member "nobody-here"/);
    // A reply to an event that is not a comment on this item: refused by the store.
    r = await rf(["comment", "W-1", "--text", "x", "--reply-to", "testbox-0000000000001-zzzz"], {
      RF_LANE: "lead",
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no comment testbox-0000000000001-zzzz/);

    r = await rf(["inbox"], { RF_LANE: "macmini" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 new comment for you/);
    assert.match(r.stdout, /\[W-1\] lead, .*: macmini, can you take this\?/);
    r = await rf(["inbox"], { RF_LANE: "macmini" });
    assert.match(r.stdout, /no new comments for you/);
    r = await rf(["inbox", "--all"], { RF_LANE: "macmini" });
    assert.match(r.stdout, /can you take this/);

    // Positional text works too; the reply goes back to the asker's inbox with no --to.
    r = await rf(["comment", "W-1", "yes, taking it", "--reply-to", asked.id], {
      RF_LANE: "macmini",
    });
    assert.equal(r.code, 0, r.stderr);
    r = await rf(["inbox", "--json"], { RF_LANE: "lead" });
    const inbox = JSON.parse(r.stdout);
    assert.deepEqual(
      inbox.comments.map((c) => [c.text, c.reason, c.replyTo]),
      [["yes, taking it", "reply", asked.id]],
    );

    r = await rf(["item", "show", "W-1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /comments \(2\):\n {2}\S+ lead → macmini: macmini, can you take this\? {2}\[\S+\]\n {4}\S+ macmini: yes, taking it {2}\[\S+\]/,
    );
  },
);
