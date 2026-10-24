import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStatusRecord,
  cachedPr,
  formatAge,
  lastAssistantText,
  orientationLines,
  scrubText,
  statusSyncDue,
} from "../../../.claude/hooks/ops-status.mjs";
import { fold } from "../lib/fold.mjs";
import { validateEvent } from "../lib/schema.mjs";
import { planStatusSync, runStatusSync } from "../lib/status-sync.mjs";
import { readAllEvents, withSpecsLock } from "../lib/store.mjs";
import { buildSnapshot } from "../lib/snapshot.mjs";
import { DEFAULT_CONFIG, normalizeLane } from "../lib/config.mjs";
import { maskText } from "../lib/mask.mjs";

const HOOK = fileURLToPath(new URL("../../../.claude/hooks/ops-status.mjs", import.meta.url));
const NOW = Date.parse("2026-10-22T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const facts = {
  worktree: "/w",
  branch: "feat/x",
  head: { sha: "abc1234", at: "2026-10-22T11:00:00Z" },
  pr: 12,
  lastText: "hello",
};
const build = (over = {}) =>
  buildStatusRecord({
    payload: { session_id: "s/1", cwd: "/w", hook_event_name: "Stop" },
    env: {},
    now: NOW,
    machine: "mbp",
    facts,
    mask: (t) => t,
    normalizeLane: (t) => normalizeLane(t, DEFAULT_CONFIG),
    ...over,
  });

test("status record: fields, session id sanitising, event name", () => {
  const r = build({ env: { RF_LANE: "macbook", CLAUDE_SESSION_TITLE: "t" } });
  assert.equal(r.v, 1);
  assert.equal(r.sessionId, "s_1");
  assert.equal(r.lane, "macbook");
  assert.equal(r.title, "t");
  assert.equal(r.pr, 12);
  assert.equal(r.event, "Stop");
  assert.equal(r.lastActiveAt, iso(NOW));
  assert.equal(
    build({ payload: { session_id: "a", hook_event_name: "SessionStart" } }).event,
    "SessionStart",
  );
});

test("status record: lane parsed from title, null when unknown", () => {
  assert.equal(build({ env: { CLAUDE_SESSION_TITLE: "Mac mini lane work" } }).lane, "macmini");
  assert.equal(build().lane, null);
});

test("status record: masks names, caps 300 chars, null when names unreadable", () => {
  const mask = (t) => maskText(t, ["Acme Foods"]);
  const r = build({ mask, facts: { ...facts, lastText: `Acme Foods ${"x".repeat(500)}` } });
  assert.ok(!r.lastMessage.includes("Acme"));
  assert.equal(r.lastMessage.length, 300);
  assert.equal(build({ mask: null }).lastMessage, null);
});

test("PR cache is fresh for 60 s only", () => {
  const cache = { "feat/x": { at: NOW - 59_000, number: 7 } };
  assert.equal(cachedPr(cache, "feat/x", NOW), 7);
  assert.equal(cachedPr(cache, "feat/x", NOW + 2000), undefined);
  assert.equal(cachedPr(cache, "other", NOW), undefined);
});

test("transcript tail: last assistant text, malformed lines ignored", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "first" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "second" },
          { type: "tool_use", name: "x" },
        ],
      },
    }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] },
    }),
    "{ not json",
    "",
  ].join("\n");
  assert.equal(lastAssistantText(lines), "second");
  assert.equal(lastAssistantText("garbage\n{"), null);
  assert.equal(lastAssistantText(null), null);
});

test("staleness formatting and orientation lines", () => {
  assert.equal(formatAge(30_000), "30s");
  assert.equal(formatAge(20 * 60_000), "20m");
  assert.equal(formatAge(5 * 3600_000), "5h");
  assert.equal(formatAge(3 * 86400_000), "3d");
  const recs = [
    { sessionId: "a", lane: "macbook", branch: "feat/a", pr: 3, lastActiveAt: iso(NOW - 600_000) },
    { sessionId: "old", branch: "x", lastActiveAt: iso(NOW - 5 * 86400_000) },
  ];
  const lines = orientationLines(recs, NOW);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /macbook · feat\/a PR #3 · 10m ago/);
});

test("hook fails open: bad stdin and sample stdin exit 0, status file written", () => {
  const home = mkdtempSync(join(tmpdir(), "opsls-"));
  const env = { ...process.env, RF_OPS_HOME: home, CI: "", RF_OPS_GATE: "", RF_STATUS_BRIEF: "0" };
  const bad = spawnSync(process.execPath, [HOOK], { input: "{{{", env, encoding: "utf8" });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  const tr = join(home, "t.jsonl");
  writeFileSync(
    tr,
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done it" }] },
    }) + "\n",
  );
  const input = JSON.stringify({
    session_id: "sess-1",
    cwd: process.cwd(),
    hook_event_name: "Stop",
    transcript_path: tr,
  });
  const t0 = Date.now();
  const ok = spawnSync(process.execPath, [HOOK], { input, env, encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "");
  assert.ok(Date.now() - t0 < 2500);
  const f = join(home, "status", "sess-1.json");
  assert.ok(existsSync(f));
  const rec = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(rec.lastMessage, "done it");
  assert.equal(rec.sessionId, "sess-1");
});

// ---- heartbeat events ----
let seq = 0;
const hb = (session, data = {}, { ts = NOW, lane = "macbook" } = {}) => ({
  v: 1,
  id: `mbp-${String(ts).padStart(13, "0")}-a${(1000 + seq++).toString().slice(-3)}`,
  ts: iso(ts),
  machine: "mbp",
  actor: "status-sync",
  lane,
  kind: "heartbeat",
  item: null,
  data: { session, lastActiveAt: iso(ts), ...data },
});

test("heartbeat schema: valid, needs session + lastActiveAt, no unknown keys", () => {
  assert.deepEqual(
    validateEvent(hb("s1", { branch: "b", pr: 3, head: "abc1234", last: "x" })).errors,
    [],
  );
  const bad = hb("s1");
  delete bad.data.session;
  assert.equal(validateEvent(bad).ok, false);
  assert.equal(validateEvent(hb("s1", { bogus: 1 })).ok, false);
  assert.equal(validateEvent(hb("s1", { last: "x".repeat(301) })).ok, false);
  assert.equal(validateEvent(hb("s1", {}, { lane: null })).ok, true);
});

test("fold: heartbeat updates lane activity + sessions, creates no items", () => {
  const s = fold([hb("s1", { branch: "feat/a" }, { ts: NOW - 5 * 60_000 })]);
  assert.equal(s.items.size, 0);
  assert.equal(s.anomalies.length, 0);
  assert.equal(s.lanes.get("macbook").lastEventAt, NOW - 5 * 60_000);
  assert.equal(s.sessions.get("s1").branch, "feat/a");
  assert.equal(s.sessions.get("s1").machine, "mbp");
});

test("status-sync: change detection, jitter, 24 h cutoff", () => {
  const rec = {
    sessionId: "s1",
    machine: "mbp",
    lane: "macbook",
    branch: "feat/a",
    pr: null,
    head: { sha: "abc1234" },
    lastActiveAt: iso(NOW - 60_000),
    lastMessage: "m",
  };
  const plan = (records, events = []) =>
    planStatusSync({ records, state: fold(events), machine: "mbp", now: NOW }).events;
  const first = plan([rec]);
  assert.equal(first.length, 1);
  assert.deepEqual(validateEvent(first[0]).errors, []);
  assert.equal(plan([rec], first).length, 0, "same file twice -> one event");
  assert.equal(plan([{ ...rec, lastActiveAt: iso(NOW - 10_000) }], first).length, 0, "no change");
  assert.equal(
    plan([{ ...rec, last: undefined, lastMessage: "other" }], first).length,
    0,
    "last only",
  );
  assert.equal(plan([{ ...rec, branch: "feat/b" }], first).length, 1, "branch change");
  assert.equal(plan([{ ...rec, lastActiveAt: iso(NOW - 25 * 3600_000) }]).length, 0, "stale file");
});

test("snapshot: machines list newest first, hides > 3 days", () => {
  const events = [
    hb("old", { branch: "o" }, { ts: NOW - 4 * 86400_000 }),
    hb("a", { branch: "a" }, { ts: NOW - 3600_000 }),
    hb("b", { branch: "b", pr: 9 }, { ts: NOW - 60_000, lane: null }),
  ];
  const snap = buildSnapshot({
    sources: { specs: { data: { events } } },
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  assert.deepEqual(
    snap.machines.map((m) => m.session),
    ["b", "a"],
  );
  assert.equal(snap.machines[0].pr, 9);
  assert.equal(snap.machines[1].lane, "macbook");
});

// ---- writer model, volume, scrub, watchdog ----
const rec0 = (id, over = {}) => ({
  sessionId: id,
  machine: "mbp",
  lane: "macbook",
  branch: "feat/a",
  pr: null,
  head: { sha: "abc1234" },
  lastActiveAt: iso(NOW - 60_000),
  lastMessage: "m",
  ...over,
});
const planWith = (records, events = [], extra = {}) =>
  planStatusSync({ records, state: fold(events), machine: "mbp", now: NOW, ...extra });

test("plan: only this machine's sessions; keep-alive after 10 min; cap 20 oldest first", () => {
  assert.equal(planWith([rec0("s1", { machine: "pc" })]).events.length, 0, "other machine");
  const prev = (agoMs) => [
    hb("s1", { branch: "feat/a", head: "abc1234", last: "m" }, { ts: NOW - agoMs }),
  ];
  const quiet = rec0("s1", { lastActiveAt: iso(NOW - 30_000), lastMessage: "new text" });
  assert.equal(planWith([quiet], prev(5 * 60_000)).events.length, 0, "last-only < 10 min");
  assert.equal(planWith([quiet], prev(11 * 60_000)).events.length, 1, "keep-alive >= 10 min");
  const same = rec0("s1", { lastActiveAt: iso(NOW - 11 * 60_000) });
  assert.equal(planWith([same], prev(11 * 60_000)).events.length, 0, "idle session: nothing");
  assert.equal(
    planWith([rec0("s1", { branch: "feat/b" })], prev(60_000)).events.length,
    1,
    "real change",
  );
  assert.equal(
    planWith([rec0("s1", { title: "t" })], prev(60_000)).events.length,
    1,
    "title change",
  );
  const many = Array.from({ length: 25 }, (_, i) =>
    rec0(`s${i}`, { lastActiveAt: iso(NOW - (100 - i) * 1000) }),
  );
  const r = planWith(many);
  assert.equal(r.events.length, 20);
  assert.equal(r.capped, 5);
  assert.equal(r.events[0].data.session, "s0", "oldest first");
});

const git = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function mkRepo() {
  const tmp = mkdtempSync(join(tmpdir(), "rfops-st-"));
  const rem = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", rem);
  const seed = join(tmp, "seed");
  git(tmp, "clone", "--quiet", rem, seed);
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  mkdirSync(join(seed, "register"));
  writeFileSync(join(seed, "register", "WORK-REGISTER.md"), "# Work register\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", "-u", "origin", "main");
  const dir = join(tmp, "clone");
  git(tmp, "clone", "--quiet", rem, dir);
  git(dir, "config", "user.name", "T");
  git(dir, "config", "user.email", "t@example.com");
  const home = join(tmp, "home");
  mkdirSync(join(home, "status"), { recursive: true });
  return { tmp, rem, dir, home };
}
const putStatus = (home, r) =>
  writeFileSync(join(home, "status", `${r.sessionId}.json`), JSON.stringify(r));

test(
  "runStatusSync lockHeld: takes no lock (a held lock is not a busy skip), skips the pull, still appends",
  { timeout: 120000 },
  async () => {
    const r = mkRepo();
    try {
      putStatus(r.home, rec0("s1"));
      await withSpecsLock(
        async () => {
          const res = await runStatusSync({
            dir: r.dir,
            home: r.home,
            machine: "mbp",
            env: {},
            now: NOW,
            push: false,
            lockHeld: true,
          });
          assert.equal(res.ran, true);
          assert.equal(res.appended, 1);
          assert.equal(res.pullError, undefined);
        },
        { home: r.home, heartbeatMs: 3600000 },
      );
      assert.equal(readAllEvents(r.dir).filter((e) => e.kind === "heartbeat").length, 1);
    } finally {
      rmSync(r.tmp, { recursive: true, force: true });
    }
  },
);

test(
  "runStatusSync: pull+append+push, own machine only, busy skip, pull failure, no-push",
  { timeout: 120000 },
  async () => {
    const r = mkRepo();
    try {
      const base = { dir: r.dir, home: r.home, machine: "mbp", env: {}, now: NOW };
      putStatus(r.home, rec0("s1"));
      putStatus(r.home, rec0("s2", { machine: "pc" }));
      const first = await runStatusSync(base);
      assert.equal(first.appended, 1);
      assert.equal(first.pushed, true);
      assert.equal(git(r.dir, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
      const evs = readAllEvents(r.dir).filter((e) => e.kind === "heartbeat");
      assert.deepEqual(
        evs.map((e) => e.data.session),
        ["s1"],
      );
      assert.ok(existsSync(join(r.dir, "events", "mbp")), "own machine events dir");
      assert.equal((await runStatusSync(base)).appended, 0, "second run: nothing");

      putStatus(r.home, rec0("s1", { branch: "feat/z" }));
      const local = await runStatusSync({ ...base, now: NOW + 1000, push: false });
      assert.equal(local.appended, 1);
      assert.equal(local.pushed, false);
      assert.equal(
        git(r.dir, "rev-list", "--count", "@{u}..HEAD").trim(),
        "1",
        "committed, not pushed",
      );

      putStatus(r.home, rec0("s1", { branch: "feat/y" }));
      await withSpecsLock(
        async () => {
          const busy = await runStatusSync({ ...base, now: NOW + 2000 });
          assert.deepEqual(busy, { ran: false, reason: "busy", appended: 0 });
        },
        { home: r.home, heartbeatMs: 3600000 },
      );

      git(r.dir, "remote", "set-url", "origin", join(r.tmp, "missing.git"));
      const before = readAllEvents(r.dir).length;
      const failed = await runStatusSync({ ...base, now: NOW + 3000 });
      assert.equal(failed.appended, 0);
      assert.ok(failed.pullError, "pull error returned");
      assert.equal(readAllEvents(r.dir).length, before, "nothing appended on pull failure");
    } finally {
      rmSync(r.tmp, { recursive: true, force: true });
    }
  },
);

test("scrubText: home dirs, tokens, env pairs; paths and branches survive", () => {
  const h = "/Users/zed";
  const t = (x) => scrubText(x, h);
  assert.equal(t("in /Users/zed/code/x"), "in ~/code/x");
  assert.equal(
    t("also /home/amy/a and C:\\Users\\Bob\\a and c:/users/Eve/b"),
    "also ~/a and ~\\a and ~/b",
  );
  for (const secret of [
    "ghp_" + "a1".repeat(15),
    "github_pat_" + "A1b2".repeat(8),
    "sk_live_" + "x9".repeat(8),
    "sk-" + "q7".repeat(12),
    "whsec_" + "k3".repeat(8),
    "Bearer abc.def-123_456",
    "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2",
    "d".repeat(16) + "0".repeat(16),
    "Zk9" + "aB1".repeat(15),
  ])
    assert.equal(t(`x ${secret} y`), "x [redacted] y", secret);
  assert.equal(t("run STRIPE_KEY=abc123 now"), "run STRIPE_KEY=[redacted] now");
  assert.equal(
    t("~/code/rf-wt-opsls/tools/ops-monitor/lib/status feat/ops-lane-status"),
    "~/code/rf-wt-opsls/tools/ops-monitor/lib/status feat/ops-lane-status",
  );
  const rec = build({
    payload: { session_id: "s", cwd: "/Users/zed/w", hook_event_name: "Stop" },
    env: { CLAUDE_SESSION_TITLE: "t ghp_" + "a1".repeat(15) },
    facts: {
      ...facts,
      worktree: "/Users/zed/w",
      branch: "feat/acme-x",
      lastText: "see /Users/zed/q",
    },
    mask: (x) => maskText(x, ["acme"]),
    home: h,
  });
  assert.equal(rec.cwd, "~/w");
  assert.equal(rec.worktree, "~/w");
  assert.equal(rec.lastMessage, "see ~/q");
  assert.ok(!rec.title.includes("ghp_"));
  assert.ok(!rec.branch.includes("acme"), "branch masked");
});

test("hook watchdog: slow git and gh stubs, exits 0 within the budget", { timeout: 20000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "opsls-wd-"));
  try {
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    for (const n of ["git", "gh"]) {
      writeFileSync(join(bin, n), "#!/bin/sh\nsleep 5\n");
      chmodSync(join(bin, n), 0o755);
    }
    const cwd = join(tmp, "cwd");
    mkdirSync(cwd);
    const env = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      RF_OPS_HOME: join(tmp, "home"),
      CI: "",
      RF_OPS_GATE: "",
    };
    const input = JSON.stringify({ session_id: "wd", cwd, hook_event_name: "SessionStart" });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [HOOK], {
      input,
      env,
      cwd,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("statusSyncDue: only with a specs clone, at most every 2 min, never under RF_NO_SYNC / CI / gate off", () => {
  const base = { home: "/h", specs: "/s", env: {}, now: 1_000_000_000, exists: () => true };
  assert.equal(statusSyncDue({ ...base, mtimeMs: () => null }), true, "no stamp yet");
  assert.equal(
    statusSyncDue({ ...base, mtimeMs: () => base.now - 119_000 }),
    false,
    "stamped 119 s ago",
  );
  assert.equal(
    statusSyncDue({ ...base, mtimeMs: () => base.now - 120_000 }),
    true,
    "stamped 120 s ago",
  );
  assert.equal(
    statusSyncDue({ ...base, exists: () => false, mtimeMs: () => null }),
    false,
    "no specs clone",
  );
  for (const env of [{ RF_NO_SYNC: "1" }, { CI: "1" }, { RF_OPS_GATE: "off" }]) {
    assert.equal(statusSyncDue({ ...base, env, mtimeMs: () => null }), false);
  }
});
