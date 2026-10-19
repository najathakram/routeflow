import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderRegister,
  registerWritePolicy,
  renderDashboardSections,
  applyDashboardMarkers,
  boardJson,
  writeViews,
} from "../lib/views.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const sha = (t) => createHash("sha256").update(t).digest("hex");

const item = (id, o = {}) => ({
  id,
  title: `Acme item ${id}`,
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
  ...o,
});

function snapshot() {
  return {
    generatedAt: "2026-10-19T04:00:00.000Z",
    machine: "pc",
    sources: {
      specs: { ok: true, stale: false, error: null, ageSec: 12 },
      github: { ok: false, stale: true, error: "gh failed", ageSec: 900 },
    },
    items: [
      item("12", {
        priority: "P1",
        type: "bug",
        status: "building",
        lane: "pc-lane",
        train: "R1",
        trainLabel: "R1 window 2",
        gate: "Opus | review",
        eta: "10-19",
        links: { prs: [4001, 4002], branches: [], urls: [] },
        claimedBy: "pc-lane",
      }),
      item("9", { priority: "P0", type: "incident", status: "building", gate: "R2 fix" }),
      item("100", { priority: "P2", status: "planned", train: "R2", lane: "macmini" }),
      item("B77", { priority: "P2", type: "bug", title: "Acme registry bug", status: "planned" }),
      item("20", { priority: "P3", status: "verified" }),
      item("21", { priority: "P3", status: "dropped" }),
      item("R1", { type: "release", title: "Back office", status: "building", priority: "P1" }),
      item("30", {
        type: "decision",
        lane: "owner",
        priority: "P1",
        gate: "Recommended: yes",
        eta: "10-20",
        title: "Owner picks acme",
      }),
      item("40", {
        priority: "P1",
        status: "ready",
        blocked: { by: "acme review", unblocker: "sa", at: "2026-10-18T09:00:00.000Z" },
      }),
    ],
    bugs: [],
    trains: [
      {
        id: "R1",
        title: "Back office",
        status: "building",
        eta: "2026-10-19",
        members: ["12", "40"],
      },
      {
        id: "R2",
        title: "Billing guards",
        status: "planned",
        eta: "10-19 ~04:00Z",
        members: ["100"],
      },
    ],
    lanes: [
      {
        id: "pc-lane",
        title: "PC lane planning",
        machine: "pc",
        lastEventAt: "2026-10-19T03:00:00.000Z",
        silentMin: 60,
        now: ["12"],
        next: { id: "100", title: "Acme item 100", reason: "P2" },
      },
      {
        id: "macmini",
        title: "Mac mini lane",
        machine: "macmini",
        lastEventAt: null,
        silentMin: null,
        now: [],
        next: null,
      },
    ],
    ownerQueue: [
      {
        id: "30",
        title: "Owner picks acme",
        gate: "Recommended: yes",
        eta: "10-20",
        status: "planned",
      },
    ],
    decisions: [],
    problems: ["9"],
    prs: {
      open: [
        {
          number: 4002,
          title: "x",
          draft: false,
          branch: "b",
          headSha: "abc",
          checks: "SUCCESS",
          updatedAt: "",
          url: "",
          areas: [],
          item: "12",
        },
      ],
      merged: [
        { number: 4001, title: "y", branch: "c", mergedAt: "", mergeSha: "d", url: "", item: "12" },
      ],
    },
    branches: [],
    ci: {
      master: { sha: "abc1234", date: "", headline: "h", checks: "SUCCESS" },
      visibility: "PRIVATE",
      deploys: [],
    },
    map: { domains: [] },
    alarms: [
      { id: "a", kind: "past-eta", severity: "warn", message: "m" },
      { id: "b", kind: "anomaly", severity: "error", message: "m" },
    ],
    stats: { events: 3, items: 9, openBugs: 0, anomalies: 0 },
  };
}

test("renderRegister: header hash, filter, sort, links, escaping", () => {
  const md = renderRegister(snapshot(), { itemFileExists: (id) => id === "12" });
  const nl = md.indexOf("\n");
  const first = md.slice(0, nl);
  const m = /^<!-- ops:generated register v1 sha256=([0-9a-f]{64}) -->$/.exec(first);
  assert.ok(m, first);
  assert.equal(m[1], sha(md.slice(nl + 1)));
  assert.match(md, /# Work register \(generated\)/);
  assert.match(md, /generated from items and events by tools\/ops-monitor/);
  assert.match(md, /rf/);
  const rows = md.split("\n").filter((l) => /^\| \S/.test(l) && !l.startsWith("| ID"));
  const ids = rows.map((l) => l.split("|")[1].trim());
  // no releases, no verified/dropped; sorted by priority then numeric id
  assert.deepEqual(ids, ["9", "12", "30", "40", "100", "B77"]);
  assert.match(md, /P0 1, P1 3, P2 2, P3 0/);
  assert.match(
    md,
    /\| ID \| Title \| Type \| Priority \| Status \| Lane \| Train \| Gate \| ETA \| Links \| Updated \|/,
  );
  const row12 = rows.find((l) => l.startsWith("| 12 |"));
  assert.match(
    row12,
    /\| fix \| P1 \| building \| pc-lane \| R1 window 2 \| Opus \\\| review \| 10-19 \|/,
  );
  assert.match(
    row12,
    /\[item\]\(items\/12\.md\) \[#4001\]\(https:\/\/github\.com\/najathakram\/routeflow\/pull\/4001\) merged \[#4002\]\(https:\/\/github\.com\/najathakram\/routeflow\/pull\/4002\) \| 2026-10-18 \|$/,
  );
  const row100 = rows.find((l) => l.startsWith("| 100 |"));
  assert.doesNotMatch(row100, /items\//);
  assert.match(row100, /\| - \|[^|]*\| 2026-10-18 \|$/);
});

test("renderRegister is deterministic", () => {
  const a = renderRegister(snapshot(), { itemFileExists: () => false });
  const b = renderRegister(snapshot(), { itemFileExists: () => false });
  assert.equal(a, b);
  const s2 = snapshot();
  s2.generatedAt = "2030-01-01T00:00:00.000Z";
  s2.sources.specs.ageSec = 99999;
  assert.equal(renderRegister(s2, { itemFileExists: () => false }), a);
});

test("registerWritePolicy: missing, intact generated, backfill sha, hand-edited", () => {
  const gen = renderRegister(snapshot(), { itemFileExists: () => false });
  assert.deepEqual(registerWritePolicy(null, {}), {
    allowed: true,
    reason: "no register file yet",
  });
  assert.equal(registerWritePolicy(gen, { backfillSha256: "x" }).allowed, true);
  // CRLF checkout of an intact generated file is still intact
  assert.equal(registerWritePolicy(gen.replace(/\n/g, "\r\n"), {}).allowed, true);
  const hand = "# Work register (open items)\n\n| ID | Title |\n|---|---|\n";
  assert.equal(registerWritePolicy(hand, { backfillSha256: sha(hand) }).allowed, true);
  const refused = registerWritePolicy(hand, { backfillSha256: "0".repeat(64) });
  assert.deepEqual(refused, { allowed: false, reason: "hand-edited since last generation" });
  // generate, change one cell -> refused
  const edited = gen.replace("| P1 | building |", "| P0 | building |");
  assert.notEqual(edited, gen);
  assert.deepEqual(registerWritePolicy(edited, { backfillSha256: sha(hand) }), {
    allowed: false,
    reason: "hand-edited since last generation",
  });
});

test("renderDashboardSections: all sections, deterministic, no ages", () => {
  const sec = renderDashboardSections(snapshot());
  assert.deepEqual(Object.keys(sec), ["now", "blocked", "problems", "next", "owner", "health"]);
  assert.match(sec.now, /\| Lane \| Building \| Next gate \|/);
  assert.match(
    sec.now,
    /\| PC lane planning \(pc-lane\) \| 12 Acme item 12 \| 100 Acme item 100 \|/,
  );
  assert.match(sec.now, /\| Mac mini lane \(macmini\) \| - \| - \|/);
  assert.match(sec.blocked, /\| 40 Acme item 40 \| acme review \| sa \|/);
  assert.match(sec.problems, /\| 9 Acme item 9 \| P0 \| building \| R2 fix \|/);
  // next up: open, not release/decision?, priority then train; blocked ok; max 10
  const nextIds = sec.next
    .split("\n")
    .filter((l) => /^\| \d|^\| B/.test(l))
    .map((l) => l.split("|")[1].trim().split(" ")[0]);
  assert.deepEqual(nextIds, ["9", "40", "100", "B77"]); // claimed 12, decision 30 excluded
  assert.match(sec.owner, /\| 30 Owner picks acme \| Recommended: yes \| 10-20 \|/);
  assert.match(sec.health, /PRIVATE/);
  assert.match(sec.health, /Open PRs \| 1/);
  assert.match(sec.health, /1 error, 1 warn, 0 info/);
  assert.match(sec.health, /github \| stale/);
  assert.match(sec.health, /specs \| ok/);
  assert.doesNotMatch(sec.health, /900/);
  assert.deepEqual(renderDashboardSections(snapshot()), sec);
  const empty = snapshot();
  empty.items = [];
  empty.problems = [];
  empty.ownerQueue = [];
  empty.lanes = [];
  const e = renderDashboardSections(empty);
  assert.match(e.blocked, /Nothing is blocked/);
  assert.match(e.problems, /None/);
});

test("renderDashboardSections limits next up to 10", () => {
  const s = snapshot();
  s.items = Array.from({ length: 15 }, (_, i) => item(String(200 + i)));
  const ids = renderDashboardSections(s)
    .next.split("\n")
    .filter((l) => /^\| \d/.test(l));
  assert.equal(ids.length, 10);
});

test("applyDashboardMarkers replaces between markers, reports missing, leaves the rest", () => {
  const text = readFileSync(join(FIX, "dashboard.md"), "utf8");
  const sec = renderDashboardSections(snapshot());
  const r = applyDashboardMarkers(text, sec);
  assert.deepEqual(r.replaced, ["now", "blocked", "owner"]);
  assert.deepEqual(r.missing, ["problems", "next", "health"]);
  assert.match(r.text, /<!-- ops:now:begin -->\n\| Lane \| Building/);
  assert.doesNotMatch(r.text, /old now table/);
  assert.doesNotMatch(r.text, /\nstale\n/);
  assert.match(r.text, /Keep this paragraph\./);
  assert.match(r.text, /Startup prompts: elsewhere\./);
  assert.match(r.text, /<!-- ops:owner:begin -->\n[^]*<!-- ops:owner:end -->/);
  // idempotent
  const again = applyDashboardMarkers(r.text, sec);
  assert.equal(again.text, r.text);
  // no markers -> unchanged
  const plainText = "# nothing here\n";
  const n = applyDashboardMarkers(plainText, sec);
  assert.equal(n.text, plainText);
  assert.deepEqual(n.replaced, []);
  assert.equal(n.missing.length, 6);
});

test("boardJson: exact row shapes", () => {
  const b = boardJson(snapshot());
  assert.deepEqual(Object.keys(b), ["register", "trains", "lanes", "owner", "problems"]);
  assert.equal(b.register.length, 6);
  assert.deepEqual(b.register[0], {
    id: 9,
    title: "Acme item 9",
    type: "incident",
    priority: "P0",
    status: "building",
    lane: null,
    train: null,
    gate: "R2 fix",
    eta: null,
    updated: "2026-10-18",
  });
  assert.equal(b.register.find((r) => r.id === "B77").type, "fix");
  assert.equal(typeof b.register.find((r) => r.id === 12).id, "number");
  assert.equal(b.register.find((r) => r.id === 12).train, "R1 window 2");
  assert.deepEqual(b.trains[0], {
    order: 1,
    train: "R1",
    name: "Back office",
    members: "12, 40",
    lanes: "pc-lane",
    target: "2026-10-19",
    state: "building",
    next: "",
  });
  assert.deepEqual(b.lanes[0], {
    lane: "PC lane planning",
    machine: "pc",
    model: "",
    now: "12 Acme item 12",
    next: "100 Acme item 100",
  });
  assert.deepEqual(b.owner[0], {
    ask: "Owner picks acme",
    when: "10-20",
    recommended: "Recommended: yes",
    state: "planned",
  });
  assert.deepEqual(b.problems[0], {
    problem: "Acme item 9",
    impact: "",
    fix: "R2 fix",
    state: "building",
  });
  assert.deepEqual(boardJson(snapshot()), b);
});

// --- writeViews with injected fakes ---------------------------------------------------------

function fakeEnv(files = {}) {
  const fs = new Map(Object.entries(files));
  const calls = [];
  const writes = [];
  const deps = {
    readText: (p) => fs.get(p.replace(/\\/g, "/")) ?? null,
    exists: (p) => fs.has(p.replace(/\\/g, "/")),
    writeText: (p, t) => {
      const k = p.replace(/\\/g, "/");
      fs.set(k, t);
      writes.push(k);
    },
    withLock: async (fn) => fn(),
    syncSpecs: async () => calls.push(["sync"]),
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: args[0] === "status" ? " M DASHBOARD.md\n" : "", stderr: "" };
    },
  };
  return { fs, calls, writes, deps };
}

test("writeViews dry run writes nothing", async () => {
  const dash = readFileSync(join(FIX, "dashboard.md"), "utf8");
  const env = fakeEnv({ "/specs/DASHBOARD.md": dash });
  const r = await writeViews({
    registerMode: "views",
    specsDir: "/specs",
    boardDir: "/board",
    snapshot: snapshot(),
    push: true,
    dry: true,
    deps: env.deps,
  });
  assert.equal(env.writes.length, 0);
  assert.equal(r.registerWritten, true);
  assert.equal(r.refused, null);
  assert.deepEqual(r.dashboardReplaced, ["now", "blocked", "owner"]);
  assert.equal(r.pushed, false);
  assert.equal(env.calls.filter((c) => c[0] === "git").length, 0);
});

test("writeViews writes register, dashboard, board json, commits and pushes", async () => {
  const dash = readFileSync(join(FIX, "dashboard.md"), "utf8");
  const env = fakeEnv({ "/specs/DASHBOARD.md": dash, "/specs/register/items/12.md": "x" });
  const r = await writeViews({
    registerMode: "views",
    specsDir: "/specs",
    boardDir: "/board",
    snapshot: snapshot(),
    push: true,
    dry: false,
    deps: env.deps,
  });
  assert.equal(r.registerWritten, true);
  assert.equal(r.refused, null);
  assert.deepEqual(r.dashboardReplaced, ["now", "blocked", "owner"]);
  assert.deepEqual(r.boardWritten, ["register", "trains", "lanes", "owner", "problems"]);
  assert.equal(r.pushed, true);
  assert.match(env.fs.get("/specs/register/WORK-REGISTER.md"), /^<!-- ops:generated register v1/);
  assert.match(env.fs.get("/specs/register/WORK-REGISTER.md"), /\[item\]\(items\/12\.md\)/);
  assert.ok(env.fs.has("/board/out/register.json"));
  assert.equal(JSON.parse(env.fs.get("/board/out/problems.json"))[0].problem, "Acme item 9");
  const git = env.calls.filter((c) => c[0] === "git").map((c) => c.slice(1).join(" "));
  assert.ok(
    git.some((g) => /^add .*register\/WORK-REGISTER\.md/.test(g) && /DASHBOARD\.md/.test(g)),
  );
  assert.ok(git.some((g) => /^commit -m ops\(views\)/.test(g)));
  assert.ok(git.some((g) => g === "push"));
  // second run with same snapshot: nothing changes, no commit
  const env2 = fakeEnv(Object.fromEntries(env.fs));
  env2.deps.exec = async (cmd, args) => {
    env2.calls.push([cmd, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const r2 = await writeViews({
    specsDir: "/specs",
    boardDir: "/board",
    snapshot: snapshot(),
    push: true,
    dry: false,
    deps: env2.deps,
  });
  assert.equal(r2.registerWritten, false);
  assert.deepEqual(r2.dashboardReplaced, []);
  assert.equal(env2.calls.filter((c) => c[1] === "commit").length, 0);
  assert.equal(r2.pushed, false);
});

test("writeViews refuses a hand-edited register but still writes dashboard and board", async () => {
  const dash = readFileSync(join(FIX, "dashboard.md"), "utf8");
  const gen = renderRegister(snapshot(), { itemFileExists: () => false });
  const edited = gen.replace("| P1 | building |", "| P0 | building |");
  const env = fakeEnv({ "/specs/DASHBOARD.md": dash, "/specs/register/WORK-REGISTER.md": edited });
  const r = await writeViews({
    registerMode: "views",
    specsDir: "/specs",
    boardDir: "/board",
    snapshot: snapshot(),
    push: false,
    dry: false,
    deps: env.deps,
  });
  assert.equal(r.registerWritten, false);
  assert.equal(r.refused, "hand-edited since last generation");
  assert.equal(env.fs.get("/specs/register/WORK-REGISTER.md"), edited);
  assert.deepEqual(r.dashboardReplaced, ["now", "blocked", "owner"]);
  assert.equal(r.boardWritten.length, 5);
  assert.equal(r.pushed, false);
});

test("writeViews with a push that cannot land aborts the rebase and resets to upstream", async () => {
  const dash = readFileSync(join(FIX, "dashboard.md"), "utf8");
  const env = fakeEnv({ "/specs/DASHBOARD.md": dash });
  env.deps.exec = async (cmd, args) => {
    env.calls.push([cmd, ...args]);
    if (args[0] === "status") return { code: 0, stdout: " M DASHBOARD.md\n", stderr: "" };
    if (args[0] === "push") return { code: 1, stdout: "", stderr: "! [rejected] (fetch first)" };
    if (args[0] === "pull") return { code: 1, stdout: "", stderr: "CONFLICT (add/add)" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await writeViews({
    specsDir: "/specs",
    boardDir: "/board",
    snapshot: snapshot(),
    push: true,
    dry: false,
    deps: env.deps,
  });
  const git = env.calls.filter((c) => c[0] === "git").map((c) => c.slice(1).join(" "));
  assert.equal(r.pushed, false);
  assert.equal(r.retryLater, true);
  assert.equal(git.filter((g) => g === "push").length, 1, "no push retry after a failed rebase");
  const abort = git.indexOf("rebase --abort");
  const reset = git.indexOf("reset --hard --quiet @{u}");
  assert.ok(abort >= 0, "rebase aborted");
  assert.ok(reset > abort, "then reset to upstream");
  assert.equal(r.boardWritten.length, 5, "board json is machine-local and still written");
});

test("writeViews writes no view file while unpushed commits exist (views never sit under events)", async () => {
  const dash = readFileSync(join(FIX, "dashboard.md"), "utf8");
  const env = fakeEnv({ "/specs/DASHBOARD.md": dash });
  env.deps.exec = async (cmd, args) => {
    env.calls.push([cmd, ...args]);
    if (args[0] === "rev-list") return { code: 0, stdout: "2\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await writeViews({
    specsDir: "/specs",
    boardDir: "/board",
    snapshot: snapshot(),
    push: true,
    dry: false,
    deps: env.deps,
  });
  assert.equal(r.skipped, "unpushed commits");
  assert.equal(r.retryLater, true);
  assert.equal(r.pushed, false);
  assert.equal(env.writes.filter((w) => w.startsWith("/specs/")).length, 0);
  assert.equal(env.calls.filter((c) => c[1] === "commit").length, 0);
  assert.equal(env.fs.get("/specs/DASHBOARD.md"), dash);
});

// --- generated register mode (events -> register, no snapshot needed) ---------------------------

import { fold } from "../lib/fold.mjs";
import { newEventId } from "../lib/ids.mjs";
import { renderGeneratedRegister, stateToSnapshot } from "../lib/views.mjs";

let evn = 0;
const gev = (kind, itemId, data, lane = null) => {
  const at = Date.UTC(2026, 9, 19, 4, 0, 0) + evn++ * 1000;
  return {
    v: 1,
    id: newEventId("pc", at, () => 0.5),
    ts: new Date(at).toISOString(),
    machine: "pc",
    actor: "tester",
    lane,
    kind,
    item: itemId,
    data,
  };
};

test("renderRegister shows register-cited PRs (refPrs) after the item's own PRs", () => {
  const snap = snapshot();
  snap.items = [
    item("12", {
      priority: "P1",
      links: { prs: [4001], branches: [], urls: [] },
      refPrs: [3467, 3470],
    }),
  ];
  snap.prs = { open: [], merged: [{ number: 4001 }, { number: 3467 }] };
  const md = renderRegister(snap, { itemFileExists: () => false });
  assert.match(
    md,
    /\[#4001\]\(https:\/\/github\.com\/[^)]+\/pull\/4001\) merged \[#3467\]\([^)]+\) merged \[#3470\]\([^)]+\) \|/,
  );
});

test("renderGeneratedRegister: a pure function of the fold, equal to the snapshot render", () => {
  const events = [
    gev("item.new", "R1", { title: "Window 2", type: "release" }),
    gev("item.new", "12", {
      title: "Acme order total",
      type: "bug",
      priority: "P1",
      train: "R1",
      trainLabel: "R1 window 2",
      source: "register",
      links: { prs: [3467] },
    }),
    gev("item.new", "9", { title: "Acme outage", type: "incident", priority: "P0" }),
    gev("item.new", "14", { title: "Done thing", type: "chore", status: "verified" }),
    gev("claim", "12", {}, "pc-lane"),
  ];
  const state = fold(events);
  const md = renderGeneratedRegister(state, { itemFileExists: (id) => id === "12" });
  assert.match(md, /^<!-- ops:generated register v1 sha256=[0-9a-f]{64} -->\n/);
  const rows = md.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  assert.deepEqual(
    rows.map((r) => r.split(" | ")[0]),
    ["| 9", "| 12"],
  ); // priority order; the release and the verified item are not rows
  assert.match(rows[1], /\[item\]\(items\/12\.md\) \[#3467\]/);
  assert.match(rows[1], /\| 2026-10-19 \|$/);
  assert.equal(md, renderGeneratedRegister(fold(events), { itemFileExists: (id) => id === "12" }));
  assert.equal(md, renderRegister(stateToSnapshot(state), { itemFileExists: (id) => id === "12" }));
});

test("writeViews in generated register mode leaves the register to the event-driven writer", async () => {
  const dash = readFileSync(join(FIX, "dashboard.md"), "utf8");
  const env = fakeEnv({ "/specs/DASHBOARD.md": dash });
  const r = await writeViews({
    specsDir: "/specs",
    boardDir: "/board",
    snapshot: snapshot(),
    registerMode: "generated",
    push: true,
    dry: false,
    deps: env.deps,
  });
  assert.equal(r.registerWritten, false);
  assert.equal(r.refused, null);
  assert.ok(!env.writes.some((w) => w.endsWith("WORK-REGISTER.md")));
  assert.deepEqual(r.dashboardReplaced, ["now", "blocked", "owner"]);
});

test("writeViews never writes the register in human (default) or generated mode", async () => {
  for (const registerMode of [undefined, "human", "generated"]) {
    const env = fakeEnv({ "/specs/register/WORK-REGISTER.md": "hand-kept register" });
    const r = await writeViews({
      ...(registerMode ? { registerMode } : {}),
      specsDir: "/specs",
      boardDir: "/board",
      snapshot: snapshot(),
      push: false,
      deps: env.deps,
    });
    assert.equal(r.registerWritten, false, String(registerMode));
    assert.ok(!env.writes.some((w) => /WORK-REGISTER/.test(w)), String(registerMode));
    assert.equal(env.fs.get("/specs/register/WORK-REGISTER.md"), "hand-kept register");
  }
});
