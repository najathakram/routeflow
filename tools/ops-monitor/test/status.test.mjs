import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStatusRecord,
  cachedPr,
  formatAge,
  lastAssistantText,
  orientationLines,
} from "../../../.claude/hooks/ops-status.mjs";
import { fold } from "../lib/fold.mjs";
import { validateEvent } from "../lib/schema.mjs";
import { planStatusSync } from "../lib/status-sync.mjs";
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
    planStatusSync({ records, state: fold(events), machine: "mbp", now: NOW });
  const first = plan([rec]);
  assert.equal(first.length, 1);
  assert.deepEqual(validateEvent(first[0]).errors, []);
  assert.equal(plan([rec], first).length, 0, "same file twice -> one event");
  assert.equal(plan([{ ...rec, lastActiveAt: iso(NOW - 10_000) }], first).length, 0, "jitter");
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
