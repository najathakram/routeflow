// P9b: session-start brief, per-prompt "since" line, plan-change recorder, Stop-gate extension,
// settings.json retirements.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const url = (p) => new URL(`file:///${p.replace(/\\/g, "/")}`).href;
const BRIEF = join(REPO, ".claude", "hooks", "ops-brief.mjs");
const HOOKS = process.env.RF_HOOKS_DIR || join(REPO, ".claude", "hooks");
const PLAN = join(HOOKS, "ops-post-plan.mjs");
const STOP = join(REPO, ".claude", "hooks", "ops-stop.mjs");
const LIB = join(REPO, "tools", "ops-monitor", "lib");

const { briefFor } = await import(url(BRIEF));
const { planActions, isPlanPath, specsRelative } = await import(url(PLAN));
const { evaluateGate } = await import(url(STOP));
const config = await import(url(join(LIB, "config.mjs")));
const { readAllEvents } = await import(url(join(LIB, "store.mjs")));
const { fold } = await import(url(join(LIB, "fold.mjs")));
const lanes = await import(url(join(LIB, "lanes-local.mjs")));
const brief = await import(url(join(LIB, "brief.mjs")));
const turn = await import(url(join(LIB, "turn-actions.mjs")));

// ── helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
function ev(kind, item, data, ts, { lane = null, machine = "testbox", actor = "tester" } = {}) {
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
const item = (id, fields, ts = "2026-01-05T08:00:00Z") =>
  ev("item.new", id, { title: id, ...fields }, ts);

function mkEnv() {
  const root = mkdtempSync(join(tmpdir(), "rf-hsync-"));
  const home = join(root, "home");
  const specs = join(root, "specs");
  mkdirSync(join(specs, "events", "testbox"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, specs };
}
function writeEvents(env, events, name = "2026-10-19.jsonl") {
  writeFileSync(
    join(env.specs, "events", "testbox", name),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}
function run(script, env, payload, extra = {}) {
  return spawnSync(process.execPath, [script], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    cwd: REPO,
    timeout: 60000,
    env: {
      ...process.env,
      RF_OPS_HOME: env.home,
      RF_SPECS_DIR: env.specs,
      RF_MACHINE: "testbox",
      RF_BRIEF_NO_REFRESH: "1",
      RF_OPS_RETRY_MS: "10",
      CI: "",
      RF_OPS_GATE: "",
      RF_LANE: "",
      ...extra,
    },
  });
}
const checkout = (env, lane) => {
  const dir = join(env.root, `checkout-${lane}`);
  mkdirSync(dir, { recursive: true });
  lanes.setLane(env.home, dir, lane);
  return dir;
};
const start = (sid, cwd) => ({
  hook_event_name: "SessionStart",
  session_id: sid,
  cwd,
  source: "startup",
});
const prompt = (sid, cwd) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sid,
  cwd,
  prompt: "hi",
});
const baseItems = () => [
  item("525", {
    type: "bug",
    priority: "P0",
    status: "building",
    title: "Boxed total",
    problem: "Customers are charged twice",
    impact: "Refunds",
    lane: "lead",
  }),
  item("526", { type: "feature", priority: "P2", status: "planned", title: "Dark mode" }),
  item("R1", {
    type: "release",
    status: "building",
    title: "Window 2",
    eta: "10-20",
    members: ["525"],
  }),
];

// ── SessionStart ────────────────────────────────────────────────────────────
test("brief hook: no ops clone -> exit 0, no output, no marker", () => {
  const env = mkEnv();
  try {
    const r = run(BRIEF, { ...env, specs: join(env.root, "nowhere") }, start("sess-a", env.root));
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
    assert.equal(existsSync(join(env.home, "seen")), false);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("brief hook: garbage stdin, gate off and CI exit 0 silently", () => {
  const env = mkEnv();
  try {
    writeEvents(env, baseItems());
    for (const [input, extra] of [
      ["not json {{", {}],
      ["", {}],
      ["[]", {}],
      [start("sess-b", env.root), { RF_OPS_GATE: "off" }],
      [start("sess-b", env.root), { CI: "1" }],
      [{ hook_event_name: "SessionStart" }, {}],
      [{ hook_event_name: "Notification", session_id: "x", cwd: env.root }, {}],
    ]) {
      const r = run(BRIEF, env, input, extra);
      assert.equal(r.status, 0);
      assert.equal(r.stdout + r.stderr, "");
    }
    assert.equal(existsSync(join(env.home, "seen")), false);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("brief hook: SessionStart prints the lane's brief and saves the seen marker", () => {
  const env = mkEnv();
  try {
    const events = baseItems();
    writeEvents(env, events);
    const cwd = checkout(env, "lead");
    const r = run(BRIEF, env, start("sess-lead", cwd));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Ops monitor brief for lane lead/);
    assert.match(r.stdout, /Customers are charged twice \[525\] · Urgent · Being built/);
    assert.match(r.stdout, /Shipping next:/);
    assert.ok(r.stdout.trim().split("\n").length <= 25);
    const marker = JSON.parse(readFileSync(join(env.home, "seen", "sess-lead.json"), "utf8"));
    assert.equal(marker.lastEventId, brief.lastEventId(events));
    assert.ok(marker.ts > 0);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("brief hook: a session with no lane gets the short global part (<= 8 lines)", () => {
  const env = mkEnv();
  try {
    writeEvents(env, baseItems());
    const r = run(BRIEF, env, start("sess-nolane", join(env.root, "somewhere")));
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().split("\n").length <= 8);
    assert.match(r.stdout, /no lane set here: rf whoami --lane/);
    assert.match(r.stdout, /^Hurting now/m);
    assert.doesNotMatch(r.stdout, /Shipping next|^Lanes/m);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

// ── UserPromptSubmit ────────────────────────────────────────────────────────
test("brief hook: a prompt after another lane's event prints the since line; unchanged prints nothing", () => {
  const env = mkEnv();
  try {
    const first = baseItems();
    writeEvents(env, first);
    const cwd = checkout(env, "lead");
    assert.equal(run(BRIEF, env, start("sess-p", cwd)).status, 0);

    const quiet = run(BRIEF, env, prompt("sess-p", cwd));
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "", "nothing changed");

    writeEvents(env, [
      ...first,
      ev(
        "status",
        "526",
        { status: "live" },
        new Date(Date.now() + 1000).toISOString().replace(/\.\d+Z$/, "Z"),
        { lane: "macmini" },
      ),
      item(
        "900",
        { type: "feature", title: "New thing" },
        new Date(Date.now() + 2000).toISOString().replace(/\.\d+Z$/, "Z"),
      ),
    ]);
    const r = run(BRIEF, env, prompt("sess-p", cwd));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "[ops monitor] Since you last looked: 1 item done [526], 1 new.");
    // The marker advanced: the same events are not announced twice.
    assert.equal(run(BRIEF, env, prompt("sess-p", cwd)).stdout, "");
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("brief hook: the session's own lane events never appear in its since line", () => {
  const env = mkEnv();
  try {
    const first = baseItems();
    writeEvents(env, first);
    const cwd = checkout(env, "lead");
    run(BRIEF, env, start("sess-own", cwd));
    const t = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, "Z");
    writeEvents(env, [
      ...first,
      ev("status", "526", { status: "live" }, t(1000), { lane: "lead" }),
    ]);
    assert.equal(run(BRIEF, env, prompt("sess-own", cwd)).stdout, "");
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("brief hook: prompts from a non-lead session without a marker stay silent; a lead without one just starts tracking", () => {
  const env = mkEnv();
  try {
    writeEvents(env, baseItems());
    const other = checkout(env, "macmini");
    const r = run(BRIEF, env, prompt("sess-x", other));
    assert.equal(r.stdout, "");
    assert.equal(existsSync(join(env.home, "seen", "sess-x.json")), false);
    const lead = checkout(env, "lead");
    const l = run(BRIEF, env, prompt("sess-y", lead));
    assert.equal(l.stdout, "");
    assert.equal(existsSync(join(env.home, "seen", "sess-y.json")), true);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

// ── freshness / timing ──────────────────────────────────────────────────────
function loadDeps(machine = "testbox") {
  return {
    opsHome: config.opsHome,
    specsDir: config.specsDir,
    loadConfig: config.loadConfig,
    readAllEvents,
    fold,
    lanes,
    brief,
    turn,
    machine,
  };
}

test("brief hook: SessionStart always asks for a refresh; prompts ask at most every 2 minutes", () => {
  const env = mkEnv();
  try {
    writeEvents(env, baseItems());
    const cwd = checkout(env, "lead");
    const e = { RF_OPS_HOME: env.home, RF_SPECS_DIR: env.specs };
    const deps = loadDeps();
    const now = Date.now();
    assert.equal(briefFor(start("s1", cwd), e, now, deps).refresh, true);
    // no stamp yet -> due; a fresh stamp -> not due; an old stamp -> due
    const stamp = join(env.home, "last-refresh");
    assert.equal(briefFor(prompt("s1", cwd), e, now, deps).refresh, true);
    writeFileSync(stamp, String(now));
    assert.equal(briefFor(prompt("s1", cwd), e, now, deps).refresh, false);
    const old = new Date(now - 5 * 60_000);
    utimesSync(stamp, old, old);
    assert.equal(briefFor(prompt("s1", cwd), e, now, deps).refresh, true);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("brief hook: finishes in < 1.5 s on a 1,000-event fixture (process wall time and sync work)", () => {
  const env = mkEnv();
  try {
    const events = [];
    for (let i = 0; i < 100; i++)
      events.push(
        item(String(2000 + i), {
          type: "feature",
          priority: i % 9 === 0 ? "P0" : "P2",
          status: "planned",
          title: `Item ${i}`,
          lane: i % 2 ? "macmini" : "lead",
        }),
      );
    events.push(
      item("R1", {
        type: "release",
        status: "building",
        title: "Window 2",
        eta: "10-20",
        members: ["2000", "2001"],
      }),
    );
    for (let i = 0; i < 899; i++)
      events.push(
        ev(
          "note",
          String(2000 + (i % 100)),
          { text: `n${i}` },
          new Date(Date.parse("2026-01-05T08:00:00Z") + i * 1000)
            .toISOString()
            .replace(/\.\d+Z$/, "Z"),
          { lane: "macmini" },
        ),
      );
    assert.equal(events.length, 1000);
    writeEvents(env, events);
    const cwd = checkout(env, "lead");

    const t0 = performance.now();
    const r = run(BRIEF, env, start("sess-big", cwd));
    const wall = performance.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Ops monitor brief for lane lead/);
    assert.ok(wall < 1500, `process wall time ${wall.toFixed(0)} ms`);

    const e = { RF_OPS_HOME: env.home, RF_SPECS_DIR: env.specs };
    const s0 = performance.now();
    const out = briefFor(prompt("sess-big", cwd), e, Date.now(), loadDeps());
    const sync = performance.now() - s0;
    assert.equal(typeof out.text, "string");
    assert.ok(sync < 500, `sync work ${sync.toFixed(0)} ms`);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

// ── plan recorder ───────────────────────────────────────────────────────────
const NOW = 1_760_000_000_000;

test("plan paths: plan files in a routeflow-specs checkout count; events/handoff/log/ops do not", () => {
  const root = "C:\\Users\\x\\.routeflow\\ops\\routeflow-specs";
  const yes = [
    `${root}\\decisions\\D-2026-10-19-x.md`,
    `${root}\\releases\\R3.md`,
    `${root}\\briefs\\b1.md`,
    `${root}\\roadmap\\Q4.md`,
    `${root}\\specs\\k11.md`,
    `${root}\\DASHBOARD.md`,
    "C:/ClaudeCode/rf-specs-handoff/decisions/D-1.md",
    "/home/u/work/ROUTEFLOW-SPECS/Decisions/D-1.md",
  ];
  for (const p of yes) assert.equal(isPlanPath(p), true, p);
  const no = [
    `${root}\\events\\pc\\2026-10-19.jsonl`,
    `${root}\\handoff\\h.md`,
    `${root}\\log\\l.md`,
    `${root}\\ops\\config.json`,
    `${root}\\views\\ITEMS.md`,
    `${root}\\README.md`,
    "C:/ClaudeCode/routeflow/decisions/D-1.md",
    "C:/ClaudeCode/routeflow/apps/api/src/specs/x.ts",
    "",
  ];
  for (const p of no) assert.equal(isPlanPath(p), false, p);
  // under the configured specs dir even without the repo name in the path
  assert.equal(isPlanPath("D:/data/clone/decisions/D-9.md", "D:/data/clone"), true);
  assert.equal(isPlanPath("D:/data/clone/events/a.jsonl", "D:/data/clone"), false);
  assert.equal(specsRelative("D:/data/other/decisions/D-9.md", "D:/data/clone"), null);
});

test("plan paths: the register files are plan files only in generated register mode", () => {
  const root = "C:\\Users\\x\\.routeflow\\ops\\routeflow-specs";
  const files = [`${root}\\register\\WORK-REGISTER.md`, `${root}\\priorities\\OWNER-QUEUE.md`];
  for (const f of files) {
    assert.equal(isPlanPath(f, null, "generated"), true, f);
    assert.equal(isPlanPath(f, null, "human"), false, f);
    assert.equal(isPlanPath(f, null, null), false, f);
    assert.equal(isPlanPath(f), false, f);
  }
  assert.equal(isPlanPath(`${root}\\decisions\\D-1.md`, null, "human"), true);
  const edit = { tool_name: "Edit", tool_input: { file_path: files[0] } };
  assert.deepEqual(planActions(edit, { now: NOW }), []);
  assert.deepEqual(planActions(edit, { now: NOW, registerMode: "human" }), []);
  assert.equal(planActions(edit, { now: NOW, registerMode: "generated" }).length, 1);
});

test("plan hook: reads registerMode from the specs ops/config.json (missing or bad = exclude)", () => {
  const env = mkEnv();
  try {
    const reg = join(env.specs, "register", "WORK-REGISTER.md");
    const send = (sid) =>
      run(PLAN, env, {
        session_id: sid,
        cwd: env.root,
        tool_name: "Edit",
        tool_input: { file_path: reg },
      });
    send("s-none");
    assert.equal(existsSync(turn.actionsFile(env.home, "s-none")), false);
    mkdirSync(join(env.specs, "ops"), { recursive: true });
    const cfg = join(env.specs, "ops", "config.json");
    writeFileSync(cfg, "{bad");
    send("s-bad");
    assert.equal(existsSync(turn.actionsFile(env.home, "s-bad")), false);
    writeFileSync(cfg, JSON.stringify({ registerMode: "human" }));
    send("s-human");
    assert.equal(existsSync(turn.actionsFile(env.home, "s-human")), false);
    writeFileSync(cfg, JSON.stringify({ registerMode: "generated" }));
    send("s-gen");
    assert.equal(turn.readActions(turn.actionsFile(env.home, "s-gen")).length, 1);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("plan actions: a Write/Edit/MultiEdit of a plan file records plan-change with the path", () => {
  const p = "C:/x/routeflow-specs/decisions/D-1.md";
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    assert.deepEqual(planActions({ tool_name: tool, tool_input: { file_path: p } }, { now: NOW }), [
      { ts: NOW, kind: "plan-change", path: p },
    ]);
  }
  assert.deepEqual(
    planActions(
      { tool_name: "Edit", tool_input: { file_path: "C:/x/routeflow-specs/events/a.jsonl" } },
      { now: NOW },
    ),
    [],
  );
  assert.deepEqual(planActions({ tool_name: "Edit", tool_input: {} }, { now: NOW }), []);
  assert.deepEqual(
    planActions({ tool_name: "Bash", tool_input: { command: "ls" } }, { now: NOW }),
    [],
  );
  // relative path resolves against the session cwd
  assert.equal(
    planActions(
      {
        tool_name: "Edit",
        cwd: "C:/x/routeflow-specs",
        tool_input: { file_path: "releases/R3.md" },
      },
      { now: NOW },
    ).length,
    1,
  );
});

test("plan actions: only the lead's assignment-like SendMessage records assign", () => {
  const msg = (text, extra = {}) => ({
    tool_name: "SendMessage",
    tool_input: { to: "macmini", message: text, ...extra },
  });
  assert.deepEqual(planActions(msg("take R3 next"), { lane: "lead", now: NOW }), [
    { ts: NOW, kind: "assign", to: "macmini" },
  ]);
  for (const t of [
    "Please start the catalog job on row 525",
    "your next task is item 525",
    "take B1234 next",
    "start R2 now",
  ])
    assert.equal(planActions(msg(t), { lane: "lead", now: NOW }).length, 1, t);
  // an assignment word without naming work (status pings) is not an assignment
  for (const t of ["fix pushed?", "next window at 18:00", "priority changed", "R2 is yours"])
    assert.equal(planActions(msg(t), { lane: "lead", now: NOW }).length, 0, t);
  assert.deepEqual(
    planActions(msg("take R3 next"), { lane: "macmini", now: NOW }),
    [],
    "lanes reporting to the lead never trigger it",
  );
  assert.deepEqual(planActions(msg("take R3 next"), { lane: null, now: NOW }), []);
  assert.deepEqual(planActions(msg("thanks, got it"), { lane: "lead", now: NOW }), []);
  assert.deepEqual(
    planActions(
      { tool_name: "SendMessage", tool_input: { to: "x", message: { type: "shutdown_request" } } },
      { lane: "lead", now: NOW },
    ),
    [],
  );
});

test("plan hook: records to the turn-actions file; events/ edits and non-lead messages record nothing", () => {
  const env = mkEnv();
  try {
    const file = turn.actionsFile(env.home, "sess-plan");
    const plan = join(env.specs, "decisions", "D-1.md");
    const ok = run(PLAN, env, {
      session_id: "sess-plan",
      cwd: env.root,
      tool_name: "Write",
      tool_input: { file_path: plan },
    });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout + ok.stderr, "");
    const rows = turn.readActions(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "plan-change");
    assert.equal(rows[0].path, plan.replace(/\\/g, "/"));

    const noise = run(PLAN, env, {
      session_id: "sess-noise",
      cwd: env.root,
      tool_name: "Edit",
      tool_input: { file_path: join(env.specs, "events", "testbox", "x.jsonl") },
    });
    assert.equal(noise.status, 0);
    assert.equal(existsSync(turn.actionsFile(env.home, "sess-noise")), false);

    const leadDir = checkout(env, "lead");
    const send = (sid, cwd, extra = {}) =>
      run(
        PLAN,
        env,
        {
          session_id: sid,
          cwd,
          tool_name: "SendMessage",
          tool_input: { to: "macmini", message: "take R3 next" },
        },
        extra,
      );
    send("sess-lead", leadDir);
    const lead = turn.readActions(turn.actionsFile(env.home, "sess-lead"));
    assert.equal(lead.length, 1);
    assert.equal(lead[0].kind, "assign");
    assert.equal(lead[0].to, "macmini");
    send("sess-lane", checkout(env, "macmini"));
    assert.equal(existsSync(turn.actionsFile(env.home, "sess-lane")), false);
    send("sess-envlead", env.root, { RF_LANE: "lead" });
    assert.equal(turn.readActions(turn.actionsFile(env.home, "sess-envlead")).length, 1);
    send("sess-off", leadDir, { RF_OPS_GATE: "off" });
    assert.equal(existsSync(turn.actionsFile(env.home, "sess-off")), false);
    assert.equal(run(PLAN, env, "garbage {").status, 0);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("plan hook: a Write/Edit outside a specs checkout (or a chatty SendMessage) imports no ops-monitor module", () => {
  const env = mkEnv();
  try {
    const preload = join(env.root, "log-imports.mjs");
    const log = join(env.root, "imports.log");
    writeFileSync(
      preload,
      [
        'import { registerHooks } from "node:module";',
        'import { appendFileSync } from "node:fs";',
        "registerHooks({ resolve(spec, ctx, next) {",
        '  appendFileSync(process.env.IMPORT_LOG, spec + "|");',
        "  return next(spec, ctx);",
        "} });",
      ].join(" "),
    );
    const runLogged = (payload) => {
      writeFileSync(log, "");
      const r = spawnSync(process.execPath, ["--import", url(preload), PLAN], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        cwd: REPO,
        timeout: 60000,
        env: {
          ...process.env,
          IMPORT_LOG: log,
          RF_OPS_HOME: env.home,
          RF_SPECS_DIR: env.specs,
          RF_MACHINE: "testbox",
          CI: "",
          RF_OPS_GATE: "",
          RF_LANE: "",
        },
      });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(log, "utf8");
    };
    const libLoads = (txt) => txt.split("|").filter((l) => /ops-monitor[\\/]lib/.test(l));
    for (const payload of [
      { tool_name: "Write", tool_input: { file_path: join(env.root, "src", "app.ts") } },
      { tool_name: "Edit", tool_input: { file_path: "relative/notes.md" } },
      { tool_name: "SendMessage", tool_input: { to: "macmini", message: "thanks, all good" } },
    ]) {
      const txt = runLogged({ session_id: "s-cheap", cwd: env.root, ...payload });
      assert.deepEqual(libLoads(txt), [], payload.tool_name);
    }
    // a specs path still loads the libs and records
    const txt = runLogged({
      session_id: "s-cheap2",
      cwd: env.root,
      tool_name: "Write",
      tool_input: { file_path: join(env.specs, "decisions", "D-2.md") },
    });
    assert.ok(libLoads(txt).length > 0);
    assert.equal(turn.readActions(turn.actionsFile(env.home, "s-cheap2")).length, 1);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

// ── gate ────────────────────────────────────────────────────────────────────
const T0 = Date.parse("2026-10-19T10:00:00Z");
const emptyState = { items: new Map(), pushes: [], prEvents: [] };
const planAct = { ts: T0, kind: "plan-change", path: "C:/x/routeflow-specs/decisions/D-1.md" };
const assignAct = { ts: T0, kind: "assign", to: "macmini" };
const noteAt = (offsetMs, extra = {}) => ({
  ...ev(
    "note",
    null,
    { text: "plan updated" },
    new Date(T0 + offsetMs).toISOString().replace(/\.\d+Z$/, "Z"),
  ),
  ...extra,
});

test("gate: a plan change with no event is missing, with the why and the rf fixes", () => {
  const r = evaluateGate({ actions: [planAct], state: emptyState, events: [], machine: "testbox" });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1);
  assert.equal(
    r.missing[0].why,
    "you changed a plan or assigned work (C:/x/routeflow-specs/decisions/D-1.md) but recorded nothing on the monitor",
  );
  for (const frag of [
    "item new",
    "item edit <id> --lane <lane> --train R3 --eta",
    "event owner-decision --question",
    "event note --text",
  ])
    assert.ok(r.missing[0].fix.includes(frag), frag);
});

test("gate: any human event on this machine since the plan change satisfies it", () => {
  assert.deepEqual(
    evaluateGate({
      actions: [planAct],
      state: emptyState,
      events: [noteAt(5000)],
      machine: "testbox",
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateGate({
      actions: [assignAct],
      state: emptyState,
      events: [noteAt(-30_000)],
      machine: "testbox",
    }),
    { ok: true },
    "1 minute of slack before the action",
  );
  const old = evaluateGate({
    actions: [planAct],
    state: emptyState,
    events: [noteAt(-5 * 60_000)],
    machine: "testbox",
  });
  assert.equal(old.ok, false, "an event from before the turn does not count");
});

test("gate: push/pr events, other machines and the register-sync robot do not count", () => {
  const push = ev(
    "push",
    null,
    { branch: "feat/x", sha: "a".repeat(40), repo: "najathakram/routeflow" },
    new Date(T0 + 1000).toISOString().replace(/\.\d+Z$/, "Z"),
  );
  const pr = ev(
    "pr",
    null,
    { number: 5, action: "create" },
    new Date(T0 + 2000).toISOString().replace(/\.\d+Z$/, "Z"),
  );
  const other = noteAt(3000, { machine: "macbook" });
  const robot = noteAt(4000, { actor: "register-sync" });
  const r = evaluateGate({
    actions: [planAct],
    state: emptyState,
    events: [push, pr, other, robot, { __invalid: true }],
    machine: "testbox",
  });
  assert.equal(r.ok, false);
});

test("gate: assignments name the recipient; several actions give one entry; unknown events fail open", () => {
  const r = evaluateGate({
    actions: [assignAct, planAct, { ...planAct, path: "C:/x/routeflow-specs/releases/R3.md" }],
    state: emptyState,
    events: [],
    machine: "testbox",
  });
  assert.equal(r.missing.length, 1);
  assert.match(
    r.missing[0].why,
    /assignment to macmini, C:\/x\/routeflow-specs\/decisions\/D-1\.md, C:\/x\/routeflow-specs\/releases\/R3\.md\)/,
  );
  const many = evaluateGate({
    actions: ["a", "b", "c", "d"].map((n) => ({ ts: T0, kind: "plan-change", path: `p/${n}.md` })),
    state: emptyState,
    events: [],
    machine: "testbox",
  });
  assert.match(many.missing[0].why, /\+1 more/);
  assert.deepEqual(
    evaluateGate({ actions: [planAct], state: emptyState }),
    { ok: true },
    "no events given -> fail open",
  );
});

test("stop hook: an unrecorded plan change blocks with the fix; a note event releases it", () => {
  const env = mkEnv();
  try {
    writeEvents(env, baseItems());
    const sid = "sess-gate";
    const file = turn.actionsFile(env.home, sid);
    turn.appendAction(file, {
      ts: Date.now(),
      kind: "plan-change",
      path: "C:/x/routeflow-specs/decisions/D-1.md",
    });
    const stopIn = JSON.stringify({ session_id: sid, cwd: REPO, stop_hook_active: false });
    const blocked = run(STOP, env, stopIn);
    assert.equal(blocked.status, 2);
    assert.match(
      blocked.stderr,
      /you changed a plan or assigned work \(C:\/x\/routeflow-specs\/decisions\/D-1\.md\) but recorded nothing on the monitor/,
    );
    assert.match(blocked.stderr, /event note --text/);

    // Record it the way the lead would (a note on this machine, now).
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const all = [...baseItems(), ev("note", null, { text: "Counter sales moved to R3" }, now)];
    writeEvents(env, all);
    const ok = run(STOP, env, stopIn);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(existsSync(file), false, "the actions file is archived");
    assert.ok(readdirSync(join(env.home, "turn-actions")).some((n) => n.includes(".done-")));
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("stop hook: the plan rule honours RF_OPS_GATE=off, a missing clone and the 3-block loop guard", () => {
  const env = mkEnv();
  try {
    writeEvents(env, baseItems());
    const sid = "sess-guard";
    const file = turn.actionsFile(env.home, sid);
    turn.appendAction(file, { ts: Date.now(), kind: "assign", to: "macmini" });
    const stopIn = JSON.stringify({ session_id: sid, cwd: REPO, stop_hook_active: false });
    assert.equal(run(STOP, env, stopIn, { RF_OPS_GATE: "off" }).status, 0);
    assert.equal(run(STOP, { ...env, specs: join(env.root, "nowhere") }, stopIn).status, 0);
    const first = run(STOP, env, stopIn);
    assert.equal(first.status, 2);
    assert.match(first.stderr, /assignment to macmini/);
    assert.equal(run(STOP, env, stopIn).status, 2);
    const third = run(STOP, env, stopIn);
    assert.equal(third.status, 0);
    assert.match(third.stderr, /allowing the turn to close/);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

// ── settings.json ───────────────────────────────────────────────────────────
test("settings.json: the old trackers are retired, the ops hooks are appended, the rest is kept", () => {
  const settings = JSON.parse(readFileSync(join(REPO, ".claude", "settings.json"), "utf8"));
  const cmds = (event) =>
    (settings.hooks[event] ?? []).flatMap((g) =>
      (g.hooks ?? []).map((h) => ({ matcher: g.matcher ?? null, command: h.command })),
    );
  const start_ = cmds("SessionStart").map((c) => c.command);
  // The Plane triage brief stays until the lead retires Plane (scripts/campaign/plane-docs.self-test
  // T14 pins it); only the old GitHub-Project trigger hook is retired here.
  assert.ok(
    start_.some((c) => c.includes("plane-triage")),
    "plane triage brief kept (pinned by T14)",
  );
  assert.ok(start_.includes("node scripts/check-git-hooks.mjs --warn"), "git-hooks warning kept");
  assert.ok(start_.includes("node .claude/hooks/ops-brief.mjs"), "ops brief on SessionStart");
  assert.deepEqual(cmds("UserPromptSubmit"), [
    { matcher: null, command: "node .claude/hooks/ops-brief.mjs" },
  ]);
  const post = cmds("PostToolUse");
  assert.ok(
    !post.some((c) => c.command.includes("scripts/work/claude-hook.mjs")),
    "GitHub-Project trigger retired",
  );
  assert.deepEqual(
    post.map((c) => [c.matcher, c.command]),
    [
      ["Write|Edit|MultiEdit", "node .claude/hooks/post_tool_use.mjs"],
      ["Bash", "node .claude/hooks/ops-post-push.mjs"],
      ["Write|Edit|MultiEdit|SendMessage", "node .claude/hooks/ops-post-plan.mjs"],
    ],
  );
  assert.deepEqual(
    cmds("Stop").map((c) => c.command),
    ["node .claude/hooks/stop.mjs", "node .claude/hooks/ops-stop.mjs"],
  );
  assert.ok(
    Array.isArray(settings.permissions.allow) && settings.permissions.allow.includes("WebFetch"),
    "permissions untouched",
  );
});
