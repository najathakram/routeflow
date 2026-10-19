// P9a: rf brief, the plain-words renderers, and per-checkout lane identity.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fold } from "../lib/fold.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";
import {
  ageWords,
  etaWords,
  lastEventId,
  orderEvents,
  renderBrief,
  renderSince,
  splitAtMarker,
} from "../lib/brief.mjs";
import { laneForCwd, normalizeCwd, readLanes, setLane } from "../lib/lanes-local.mjs";

const RF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "rf.mjs");
const NOW = Date.parse("2026-10-19T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

// ── fixture ─────────────────────────────────────────────────────────────────
let seq = 0;
export function E(
  kind,
  item,
  data,
  ts,
  { lane = null, machine = "testbox", actor = "tester" } = {},
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
const mk = (id, fields, ts = "2026-10-19T08:00:00Z") =>
  E("item.new", id, { title: id, ...fields }, ts);

function baseEvents() {
  return [
    mk("525", {
      type: "bug",
      priority: "P0",
      status: "building",
      title: "Boxed line total",
      problem: "Customers are charged twice on boxed lines",
      impact: "Refunds every day",
      lane: "pc-lane",
      train: "R1",
    }),
    mk("700", {
      type: "incident",
      priority: "P1",
      title: "Checkout page returns errors for some tenants",
      status: "planned",
    }),
    mk("701", { type: "feature", priority: "P2", status: "planned", title: "Dark mode" }),
    mk("702", {
      type: "feature",
      priority: "P1",
      status: "planned",
      title: "Reprice order",
      problem: "Operators cannot reprice an order",
      impact: "Phone calls",
      train: "R1",
    }),
    mk("703", {
      type: "feature",
      priority: "P1",
      status: "planned",
      title: "Catalog import",
      area: "catalog",
      lane: "macmini",
    }),
    mk("R1", {
      type: "release",
      status: "building",
      title: "Window 2: back office fixes",
      eta: "10-20 ~18:00Z",
      members: ["525", "702"],
    }),
    mk("R2", { type: "release", status: "planned", title: "Counter sales", eta: "10-25" }),
    mk("R3", { type: "release", status: "planned", title: "Third release" }),
    mk("OQ-1", {
      type: "decision",
      status: "planned",
      title: "Approve billing go-live date",
      gate: "owner decides",
      ownerAsk: "Pick the go-live date",
    }),
    E("claim", "525", { branch: "fix/b525" }, "2026-10-19T09:00:00Z", { lane: "pc-lane" }),
    E("note", "525", { text: "started" }, "2026-10-19T11:50:00Z", { lane: "macmini" }),
  ];
}

const stateOf = (events) => fold(events);

// ── renderBrief ─────────────────────────────────────────────────────────────
test("brief: sections, plain words, ids only in brackets", () => {
  const text = renderBrief(stateOf(baseEvents()), {
    lane: "pc-lane",
    now: NOW,
    config: DEFAULT_CONFIG,
  });
  for (const head of [
    "Hurting now",
    "Shipping next",
    "Waiting on the owner",
    "Lanes",
    "Your queue",
  ])
    assert.match(text, new RegExp(`^${head}`, "m"), head);
  assert.match(text, /Customers are charged twice on boxed lines \[525\] · Urgent · Being built/);
  assert.match(
    text,
    /Checkout page returns errors for some tenants \[700\] · High · Incident · Planned/,
  );
  assert.match(
    text,
    /Window 2: back office fixes \[R1\] · Being built · 0 of 2 done · about Oct 20, evening/,
  );
  assert.match(
    text,
    /delivers: Customers are charged twice on boxed lines; Operators cannot reprice an order/,
  );
  assert.match(text, /Counter sales \[R2\] · Planned · about Oct 25, evening/);
  assert.doesNotMatch(text, /Third release/, "only the next two releases");
  assert.match(text, /Pick the go-live date \[OQ-1]/);
  assert.match(
    text,
    /- macmini \(RouteFlow Mac mini lane\): no claimed work \(last activity 10 min ago\)/,
  );
  assert.match(
    text,
    /- pc-lane \(RouteFlow PC lane planning\): working on Customers are charged twice on boxed lines \[525\]/,
  );
  assert.match(text, /- Now: Customers are charged twice on boxed lines \[525\] · Being built/);
  // The owner-facing words: no priority codes or raw status codes outside brackets.
  const bare = text.replace(/\[[^\]]*\]/g, "");
  assert.doesNotMatch(bare, /\bP[0-3]\b/);
  assert.doesNotMatch(bare, /\b(building|planned|review|shipping)\b/);
  assert.doesNotMatch(bare, /\bR[0-9]\b/);
});

test("brief: lane-less short mode keeps only the global part within 8 lines", () => {
  const text = renderBrief(stateOf(baseEvents()), {
    lane: null,
    now: NOW,
    short: true,
    maxLines: 8,
    config: DEFAULT_CONFIG,
  });
  assert.ok(text.split("\n").length <= 8);
  assert.match(text, /no lane set here: rf whoami --lane/);
  assert.match(text, /^Hurting now/m);
  assert.match(text, /^Waiting on the owner/m);
  assert.doesNotMatch(text, /Shipping next|^Lanes|Your queue/m);
});

test("brief: caps hold (5 hurting, <= 25 lines, trims the low-priority sections first)", () => {
  const events = baseEvents();
  for (let i = 0; i < 12; i++)
    events.push(
      mk(String(800 + i), {
        type: "bug",
        priority: "P0",
        status: "building",
        title: `Broken thing ${i}`,
      }),
    );
  for (let i = 0; i < 9; i++)
    events.push(
      mk(String(900 + i), {
        type: "decision",
        status: "planned",
        title: `Owner choice ${i}`,
        lane: "owner",
      }),
    );
  const state = stateOf(events);
  const full = renderBrief(state, { lane: "pc-lane", now: NOW, config: DEFAULT_CONFIG });
  assert.ok(full.split("\n").length <= 25, `lines ${full.split("\n").length}`);
  const hurt = full.split("\n").filter((l) => /\[(525|8\d\d)\] · Urgent/.test(l));
  assert.equal(hurt.length, 5);
  assert.match(full, /Hurting now \(showing 5 of 14\)/);
  assert.match(full, /Waiting on the owner \(showing 5 of 10\)/);
  const tight = renderBrief(state, {
    lane: "pc-lane",
    now: NOW,
    config: DEFAULT_CONFIG,
    maxLines: 10,
  });
  assert.ok(tight.split("\n").length <= 10);
  assert.match(tight, /^Hurting now/m, "the highest-priority section survives a tight budget");
  assert.doesNotMatch(tight, /^Lanes/m);
});

test("brief: drift counts and freshness come from the last snapshot only", () => {
  const state = stateOf(baseEvents());
  const snap = {
    generatedAt: iso(NOW - 12 * 60_000),
    alarms: [
      { severity: "error" },
      { severity: "warn" },
      { severity: "warn" },
      { severity: "info" },
    ],
  };
  const withSnap = renderBrief(state, {
    lane: "lead",
    now: NOW,
    snapshot: snap,
    config: DEFAULT_CONFIG,
  });
  assert.match(withSnap, /^Drift: 1 error, 2 warnings, 1 info/m);
  assert.match(withSnap, /^Monitor data as of 12 min ago\./m);
  const without = renderBrief(state, {
    lane: "lead",
    now: NOW,
    snapshot: null,
    config: DEFAULT_CONFIG,
  });
  assert.doesNotMatch(without, /^Drift:/m);
  assert.match(without, /Live monitor data is not available here/);
  const quiet = renderBrief(state, {
    lane: "lead",
    now: NOW,
    snapshot: { generatedAt: snap.generatedAt, alarms: [] },
    config: DEFAULT_CONFIG,
  });
  assert.match(quiet, /^Drift: none/m);
});

test("brief: the owner queue from the snapshot hides answered rows and marks booked ones", () => {
  const state = stateOf(baseEvents());
  const snap = {
    generatedAt: iso(NOW),
    alarms: [],
    ownerQueue: [{ id: "OQ-1", title: "Approve billing go-live date", state: "booked" }],
  };
  const text = renderBrief(state, {
    lane: "lead",
    now: NOW,
    snapshot: snap,
    config: DEFAULT_CONFIG,
  });
  assert.match(text, /Pick the go-live date \[OQ-1] \(booked\)/);
  const none = renderBrief(state, {
    lane: "lead",
    now: NOW,
    snapshot: { ...snap, ownerQueue: [] },
    config: DEFAULT_CONFIG,
  });
  assert.doesNotMatch(none, /Waiting on the owner/);
});

test("brief: your queue shows the next pick for the lane", () => {
  const text = renderBrief(stateOf(baseEvents()), {
    lane: "macmini",
    now: NOW,
    config: DEFAULT_CONFIG,
  });
  assert.match(text, /- Next up: Catalog import \[703\] · High/);
  const empty = renderBrief(stateOf([mk("1", { type: "chore", status: "live", title: "x" })]), {
    lane: "macbook",
    now: NOW,
    config: DEFAULT_CONFIG,
  });
  assert.match(empty, /- Nothing queued for you\./);
});

test("etaWords: a date means end of day, a clock time picks the part of day, text passes through", () => {
  assert.equal(etaWords("10-19", NOW), "about Oct 19, evening");
  assert.equal(etaWords("10-19 ~04:00Z", NOW), "about Oct 19, morning");
  assert.equal(etaWords("10-19 ~13:00Z", NOW), "about Oct 19, afternoon");
  assert.equal(
    etaWords("10-19 ~18:00Z", NOW, -600),
    "about Oct 19, morning",
    "viewer zone shifts the part of day",
  );
  assert.equal(etaWords("after census", NOW), "after census");
  assert.equal(etaWords(null, NOW), null);
  assert.equal(ageWords(NOW - 5_000, NOW), "just now");
  assert.equal(ageWords(NOW - 3 * 3600_000, NOW), "3 h ago");
  assert.equal(ageWords(NOW - 72 * 3600_000, NOW), "3 days ago");
});

// ── renderSince ─────────────────────────────────────────────────────────────
test("since: unchanged state gives an empty string", () => {
  const s = stateOf(baseEvents());
  assert.equal(renderSince(s, stateOf(baseEvents()), { lane: "lead", nowMs: NOW }), "");
});

test("since: every category, grouped, with ids in brackets", () => {
  const before = baseEvents();
  const after = [
    ...before,
    E("status", "702", { status: "live" }, "2026-10-19T12:01:00Z"),
    E("status", "701", { status: "verified" }, "2026-10-19T12:01:10Z"),
    mk("900", { type: "feature", title: "New thing" }, "2026-10-19T12:02:00Z"),
    mk("901", { type: "chore", title: "Another" }, "2026-10-19T12:02:10Z"),
    E("blocked", "703", { by: "vendor" }, "2026-10-19T12:03:00Z"),
    E("item.edit", "R1", { fields: { eta: "10-21" } }, "2026-10-19T12:04:00Z"),
    E("item.edit", "R2", { fields: { lane: "macbook" } }, "2026-10-19T12:04:30Z"),
    E("owner-decision", null, { question: "Q1", answer: "A1" }, "2026-10-19T12:05:00Z"),
    E("owner-decision", null, { question: "Q2", answer: "A2" }, "2026-10-19T12:05:10Z"),
  ];
  const line = renderSince(stateOf(before), stateOf(after), { lane: "pc-lane", nowMs: NOW });
  assert.equal(
    line,
    "Since you last looked: 2 items done [701, 702], 2 new, 1 blocked [703], 1 assigned or claimed [R2], " +
      "Window 2: back office fixes ETA moved to about Oct 21, evening; 2 owner decisions recorded.",
  );
  const unb = renderSince(
    stateOf(after),
    stateOf([...after, E("unblocked", "703", {}, "2026-10-19T12:06:00Z")]),
    { nowMs: NOW },
  );
  assert.equal(unb, "Since you last looked: 1 unblocked [703].");
});

test("since: a lane's own items are counted as 'in your lane'", () => {
  const before = baseEvents();
  const after = [...before, E("status", "525", { status: "live" }, "2026-10-19T12:01:00Z")];
  assert.equal(
    renderSince(stateOf(before), stateOf(after), { lane: "pc-lane", nowMs: NOW }),
    "Since you last looked: 1 item done [525] (1 in your lane).",
  );
});

test("since: events that touch a registry bug for the first time are not 'new' items", () => {
  const before = baseEvents();
  const after = [...before, E("note", "B999", { text: "seen in prod" }, "2026-10-19T12:01:00Z")];
  assert.equal(renderSince(stateOf(before), stateOf(after), { nowMs: NOW }), "");
});

// ── last-seen bookkeeping ───────────────────────────────────────────────────
test("markers: split at the last seen event; own events count as seen; a vanished id falls back to its time", () => {
  const evs = baseEvents();
  const marker = { lastEventId: lastEventId(evs), ts: NOW };
  const later = [
    E("status", "702", { status: "live" }, "2026-10-19T12:01:00Z", { lane: "lead" }),
    E("status", "701", { status: "live" }, "2026-10-19T12:02:00Z", { lane: "macmini" }),
  ];
  const all = [...evs, ...later];
  const { before, after } = splitAtMarker(all, marker);
  assert.equal(before.length, evs.length);
  assert.equal(after.length, 2);
  const own = splitAtMarker(all, marker, (e) => e.lane === "lead");
  assert.equal(own.after.length, 1);
  assert.equal(own.after[0].lane, "macmini");
  const gone = splitAtMarker(all, {
    lastEventId: "x-0000000000000-aaaa",
    ts: Date.parse("2026-10-19T12:00:30Z"),
  });
  assert.equal(gone.after.length, 2);
  assert.equal(splitAtMarker(all, null).before.length, 0);
  assert.equal(lastEventId([]), null);
  assert.equal(orderEvents([{ __invalid: true }, null, ...all]).length, all.length);
});

test("timing: fold + brief + since over 1,000 events stays well under the hook budget", () => {
  const events = [];
  for (let i = 0; i < 100; i++)
    events.push(
      mk(String(2000 + i), {
        type: "feature",
        priority: i % 7 === 0 ? "P0" : "P2",
        status: "planned",
        title: `Item ${i}`,
      }),
    );
  for (let i = 0; i < 900; i++)
    events.push(
      E(
        "note",
        String(2000 + (i % 100)),
        { text: `n${i}` },
        iso(Date.parse("2026-10-19T08:00:00Z") + i * 1000),
        { lane: "macmini" },
      ),
    );
  const t0 = performance.now();
  const state = fold(events);
  const text = renderBrief(state, { lane: "lead", now: NOW, config: DEFAULT_CONFIG });
  const { before, sorted } = splitAtMarker(events, {
    lastEventId: orderEvents(events)[500].id,
    ts: NOW,
  });
  renderSince(fold(before), fold(sorted), { lane: "lead", nowMs: NOW });
  const ms = performance.now() - t0;
  assert.ok(text.length > 0);
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});

// ── lane identity ───────────────────────────────────────────────────────────
function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("lanes-local: RF_LANE wins, then the own-checkout-root match, else null", () => {
  const home = tmp("rf-lanes-");
  try {
    const root = join(home, "work", "routeflow");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    const wt1 = join(root, ".claude", "worktrees", "wt1");
    const wt2 = join(root, ".claude", "worktrees", "wt2");
    for (const w of [wt1, wt2]) {
      mkdirSync(join(w, "apps"), { recursive: true });
      writeFileSync(join(w, ".git"), "gitdir: elsewhere\n");
    }
    setLane(home, root, "lead");
    setLane(home, wt1, "macmini");
    assert.deepEqual(Object.values(readLanes(home)).sort(), ["lead", "macmini"]);
    const at = (p, env = {}) => laneForCwd(p, env, { home });
    assert.equal(at(root), "lead");
    assert.equal(at(join(root, "apps", "web")), "lead", "a sub-directory inherits");
    assert.equal(at(join(wt1, "apps")), "macmini", "a worktree sub-directory uses its own root");
    assert.equal(
      at(wt2),
      null,
      "an unregistered nested worktree (own .git) never inherits the parent checkout's lane",
    );
    assert.equal(at(join(wt2, "apps")), null);
    assert.equal(
      at(`${root}-sibling`),
      null,
      "a sibling that merely shares the prefix does not match",
    );
    assert.equal(at(join(home, "elsewhere")), null);
    assert.equal(at(root, { RF_LANE: " MacBook " }), "macbook", "RF_LANE wins over lanes.json");
    assert.equal(
      laneForCwd(root, { RF_LANE: "macbook" }, { home, config: DEFAULT_CONFIG }),
      "macbook",
    );
    assert.equal(laneForCwd(root, { RF_LANE: "nonsense" }, { home, config: DEFAULT_CONFIG }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lanes-local: with no .git up the tree the old prefix rule still applies", () => {
  const home = tmp("rf-lanes-nogit-");
  try {
    const root = join(home, "plain");
    mkdirSync(join(root, "sub"), { recursive: true });
    setLane(home, root, "lead");
    assert.equal(laneForCwd(join(root, "sub"), {}, { home }), "lead");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lanes-local: Windows paths compare case-insensitively with either slash", () => {
  const home = tmp("rf-lanes-win-");
  try {
    setLane(home, "C:\\ClaudeCode\\RouteFlow", "lead", "win32");
    assert.equal(
      laneForCwd("c:/claudecode/routeflow/apps", {}, { home, platform: "win32" }),
      "lead",
    );
    assert.equal(laneForCwd("C:\\ClaudeCode\\routeflow", {}, { home, platform: "win32" }), "lead");
    assert.equal(normalizeCwd("C:\\A\\B\\", "win32"), "c:/a/b");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lanes-local: a damaged lanes.json reads as empty", () => {
  const home = tmp("rf-lanes-bad-");
  try {
    writeFileSync(join(home, "lanes.json"), "{not json");
    assert.deepEqual(readLanes(home), {});
    assert.equal(laneForCwd(home, {}, { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── CLI ─────────────────────────────────────────────────────────────────────
function cliEnv(root) {
  const specs = join(root, "specs");
  mkdirSync(join(specs, "events", "testbox"), { recursive: true });
  const env = {
    ...process.env,
    RF_OPS_HOME: join(root, "home"),
    RF_SPECS_DIR: specs,
    RF_SPECS_REMOTE: join(root, "no-remote.git"),
    RF_MACHINE: "testbox",
    RF_REPO_ROOT: join(root, "no-such-repo"),
    RF_NO_SYNC: "1",
    RF_ACTOR: "cli-test",
  };
  delete env.RF_LANE;
  return { env, specs };
}
const rf = (env, cwd, ...args) =>
  spawnSync(process.execPath, [RF, ...args], { env, cwd, encoding: "utf8", timeout: 120000 });

test("cli: whoami --lane records the checkout; brief and the default lane use it", () => {
  const root = tmp("rf-brief-cli-");
  try {
    const { env, specs } = cliEnv(root);
    const checkout = join(root, "checkout");
    mkdirSync(checkout, { recursive: true });
    const sub = join(checkout, "sub");
    mkdirSync(sub);
    const evs = baseEvents();
    writeFileSync(
      join(specs, "events", "testbox", "2026-10-19.jsonl"),
      `${evs.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );

    const bad = rf(env, checkout, "whoami", "--lane", "nonsense");
    assert.equal(bad.status, 2);
    assert.equal(rf(env, checkout, "whoami", "--lane", "lead").status, 0);
    const lanes = JSON.parse(readFileSync(join(root, "home", "lanes.json"), "utf8"));
    assert.deepEqual(Object.values(lanes), ["lead"]);
    assert.equal(JSON.parse(rf(env, sub, "whoami", "--json").stdout).lane, "lead");
    assert.equal(JSON.parse(rf(env, root, "whoami", "--json").stdout).lane, null);
    assert.equal(
      JSON.parse(rf({ ...env, RF_LANE: "macbook" }, sub, "whoami", "--json").stdout).lane,
      "macbook",
    );

    const out = rf(env, sub, "brief");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^Ops monitor brief for lane lead/);
    assert.match(out.stdout, /Hurting now/);
    assert.match(out.stdout, /Live monitor data is not available here/);

    const lastId = lastEventId(evs);
    const first = evs[0].id;
    void first;
    const since = rf(env, sub, "brief", "--since", evs[2].id, "--json");
    assert.equal(since.status, 0, since.stderr);
    const parsed = JSON.parse(since.stdout);
    assert.equal(parsed.lane, "lead");
    assert.equal(parsed.lastEventId, lastId);
    assert.match(parsed.since, /^Since you last looked: /);
    assert.equal(rf(env, sub, "brief", "--since", "e-0000000000000-zzzz").status, 2);
    assert.equal(
      rf(env, sub, "brief", "--lane", "macmini").stdout.split("\n")[0],
      "Ops monitor brief for lane macmini",
    );

    // A snapshot written by the local monitor adds drift and freshness.
    writeFileSync(
      join(root, "home", "last-snapshot.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), alarms: [{ severity: "warn" }] }),
    );
    assert.match(rf(env, sub, "brief").stdout, /^Drift: 1 warning/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: brief without a clone is an error; --quiet --refresh never prints and never fails", () => {
  const root = tmp("rf-brief-noclone-");
  try {
    const { env } = cliEnv(root);
    rmSync(join(root, "specs"), { recursive: true, force: true });
    const r = rf(env, root, "brief");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no ops clone/);
    const q = rf(env, root, "brief", "--refresh", "--quiet");
    assert.equal(q.status, 0);
    assert.equal(q.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: claim without --lane takes the lane recorded for the directory", () => {
  const root = tmp("rf-brief-claim-");
  try {
    const { env, specs } = cliEnv(root);
    const g = (...a) => execFileSync("git", a, { cwd: specs, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    g("config", "user.name", "T");
    g("config", "user.email", "t@example.com");
    writeFileSync(
      join(specs, "events", "testbox", "2026-10-19.jsonl"),
      `${[mk("525", { type: "bug", priority: "P2", status: "planned", title: "Thing" })].map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    const noLane = rf(env, checkout, "claim", "525", "--no-push");
    assert.equal(noLane.status, 2, "no lane known yet");
    assert.equal(rf(env, checkout, "whoami", "--lane", "pc-lane").status, 0);
    const ok = rf(env, checkout, "claim", "525", "--no-push");
    assert.equal(ok.status === 0 || ok.status === 3, true, ok.stderr + ok.stdout);
    const dirEv = join(specs, "events", "testbox");
    const lines = readdirSync(dirEv)
      .flatMap((f) => readFileSync(join(dirEv, f), "utf8").trim().split(/\r?\n/))
      .map((l) => JSON.parse(l));
    const claim = lines.find((e) => e.kind === "claim");
    assert.ok(claim, "a claim event was written");
    assert.equal(claim.lane, "pc-lane");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
