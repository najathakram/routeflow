import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseOwnerQueueRows, planSync, runSync, syncEvents } from "../lib/sync.mjs";
import { fold } from "../lib/fold.mjs";
import { validateEvent } from "../lib/schema.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";
import { newEventId } from "../lib/ids.mjs";
import { appendEvents, readAllEvents, withSpecsLock } from "../lib/store.mjs";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const config = DEFAULT_CONFIG;
let seq = 0;
let tick = 0;
const rand = () => (seq = (seq * 9301 + 49297) % 233280) / 233280;

// ---------------------------------------------------------------------------------------------
// Fixtures shaped like the real register and OWNER-QUEUE (acme placeholders only)

const REG_HEAD =
  "# Work register (open items)\n\nPreamble text.\n\n" +
  "| ID | Title | Type | Priority | Status | Lane | Train | Gate | ETA | Links | Updated |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|\n";
const row = (id, o = {}) =>
  `| ${id} | ${o.title ?? `Acme row ${id}`} | ${o.type ?? "fix"} | ${o.prio ?? "P2"} | ${
    o.status ?? "planned"
  } | ${o.lane ?? "Mac mini lane"} | ${o.train ?? "R1 window 2"} | ${o.gate ?? "-"} | ${
    o.eta ?? "-"
  } | ${o.links ?? "-"} | 2026-10-15 |`;
const register = (...rows) => `${REG_HEAD}${rows.join("\n")}\n`;

const OQ_HEAD = "| # | Item | Register | Recommended answer | Why |\n|---|---|---|---|---|\n";
const oq = (...rows) =>
  `# Owner queue\n\n**2026-10-18 20:20Z answered:** acme.\n\n## STATUS\n\n${OQ_HEAD}${rows.join("\n")}\n\n` +
  "## C. Steps\n\n| Step | What |\n|---|---|\n| 1 | not a decision table |\n";

let evCount = 0;
function mk(kind, item, data, extra = {}) {
  const at = NOW - 3600000 + evCount++ * 1000;
  return {
    v: 1,
    id: newEventId("pc", at, () => (evCount % 97) / 97),
    ts: new Date(at).toISOString(),
    machine: "pc",
    actor: extra.actor ?? "tester",
    lane: extra.lane ?? null,
    kind,
    item,
    data,
  };
}
const baseEvents = (...more) => [
  mk("item.new", "R1", { title: "Window 2", type: "release", status: "building" }),
  ...more,
];
const BACKFILL = { actor: "backfill" };
const regNew = (id, fields = {}) =>
  mk("item.new", id, { title: `Acme row ${id}`, type: "bug", source: "register", ...fields });
const run = (events, registerMd, ownerQueueMd = "") => {
  const state = fold(events);
  const out = planSync({
    state,
    registerMd,
    ownerQueueMd,
    config,
    machine: "pc",
    now: NOW + 600000 * ++tick, // each pass is later than the last, as in real use
    rand,
  });
  for (const e of out.events)
    assert.deepEqual(validateEvent(e), { ok: true, errors: [] }, JSON.stringify(e));
  return out;
};

// ---------------------------------------------------------------------------------------------
// Owner-queue parsing

test("parseOwnerQueueRows: key is the leading token; status word and decision file come out", () => {
  const md = oq(
    "| N1 · **ANSWERED 10-18 → D-2026-10-18-acme-say-no.md** | Make the legacy card read-only. | 568, 569 | Yes. | Why. |",
    "| N4 · **DEFAULT IN EFFECT (lead default: use it now)** | Till mode in orders. | 570 | Confirm. | Why. |",
    "| 11 · **BOOKED: merged into the R5 sitting → D-2026-10-18-acme-say-no.md** | Migration sitting. | 510 | Yes. | Why. |",
    "| 14 · **STANDING YES 10-19 → D-2026-10-19-acme-census.md (lead runs)** | Census. | 530 | Yes. | Why. |",
    "| 20 · **OPEN** | Something open. | 1 | Yes. | Why. |",
    "| 21 | Plain row, links [D](decisions/D-2026-10-01-acme-plain.md). | 2 | Yes. | Why. |",
    "| 22 · **DONE, nothing to do** | Done row. | 3 | Yes. | Why. |",
  );
  const rows = parseOwnerQueueRows(md);
  assert.deepEqual(
    rows.map((r) => [r.key, r.statusWord, r.decisionFile]),
    [
      ["N1", "ANSWERED", "D-2026-10-18-acme-say-no.md"],
      ["N4", "DEFAULT IN EFFECT", null],
      ["11", "BOOKED", "D-2026-10-18-acme-say-no.md"],
      ["14", "STANDING YES", "D-2026-10-19-acme-census.md"],
      ["20", "OPEN", null],
      ["21", null, "D-2026-10-01-acme-plain.md"],
      ["22", "DONE", null],
    ],
  );
  assert.equal(rows[0].title, "Make the legacy card read-only.");
  assert.deepEqual(rows[0].register, ["568", "569"]);
});

// ---------------------------------------------------------------------------------------------
// Register rows

test("syncEvents: new register rows become item.new (source register); unchanged rows nothing", () => {
  const md = register(row(201, { eta: "10-19 to 10-21", links: "[#4001](https://x/pull/4001)" }));
  const first = run(baseEvents(), md);
  assert.equal(first.events.length, 1);
  const e = first.events[0];
  assert.equal(e.kind, "item.new");
  assert.equal(e.item, "201");
  assert.equal(e.data.source, "register");
  assert.equal(e.data.train, "R1");
  assert.equal(e.data.eta, "10-19 to 10-21");
  assert.deepEqual(e.data.links, { prs: [4001] });
  assert.equal(e.actor, "register-sync");
  const second = run([...baseEvents(), e], md);
  assert.deepEqual(second.events, []);
});

test("syncEvents: a changed register cell is an item.edit with only that field plus source", () => {
  const v1 = register(row(201, { status: "planned", eta: "10-19" }), row(202));
  const ev1 = run(baseEvents(), v1).events;
  const state1 = [...baseEvents(), ...ev1];
  const v2 = register(row(201, { status: "building", eta: "10-19" }), row(202));
  const out = run(state1, v2);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].kind, "item.edit");
  assert.equal(out.events[0].item, "201");
  assert.deepEqual(out.events[0].data.fields, { status: "building", source: "register" });
  // applying it makes the next run empty (idempotent)
  assert.deepEqual(run([...state1, ...out.events], v2).events, []);
});

test("syncEvents: an emptied nullable cell clears the field once", () => {
  const v1 = register(row(201, { eta: "10-19", gate: "Opus review" }));
  const ev1 = run(baseEvents(), v1).events;
  const v2 = register(row(201, { eta: "-", gate: "Opus review" }));
  const out = run([...baseEvents(), ...ev1], v2);
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.events[0].data.fields, { eta: null, source: "register" });
  assert.deepEqual(run([...baseEvents(), ...ev1, ...out.events], v2).events, []);
});

test("syncEvents does not clobber a lane's own status edit when the register cell is unchanged", () => {
  const v1 = register(row(201, { status: "planned" }));
  const ev1 = run(baseEvents(), v1).events;
  const laneEdit = mk("status", "201", { status: "building" }, { lane: "pc-lane" });
  const out = run([...baseEvents(), ...ev1, laneEdit], v1);
  assert.deepEqual(out.events, []);
});

test("syncEvents: register PRs are sent as links (fold keeps them as refs, not fix links)", () => {
  const v1 = register(row(201, { links: "[#4001](https://x/pull/4001) merged" }));
  const ev1 = run(baseEvents(), v1).events;
  const v2 = register(
    row(201, { links: "[#4001](https://x/pull/4001) merged [#4002](https://x/pull/4002)" }),
  );
  const out = run([...baseEvents(), ...ev1], v2);
  assert.deepEqual(out.events[0].data.fields, { links: { prs: [4001, 4002] }, source: "register" });
  const st = fold([...baseEvents(), ...ev1, ...out.events]);
  assert.deepEqual(st.items.get("201").refPrs, [4001, 4002]);
  assert.deepEqual(st.items.get("201").links.prs, []);
});

test("syncEvents: an unknown train is left out, still idempotent", () => {
  const md = register(row(201, { train: "R9 later" }));
  const out = run(baseEvents(), md);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].data.train, undefined);
  assert.equal(out.events[0].data.trainLabel, "R9 later");
  assert.deepEqual(run([...baseEvents(), ...out.events], md).events, []);
});

test("syncEvents skips registry bug ids and never merges into an item the register never owned", () => {
  // R2 is a lane's own release item; the register has a row with the same id: refused, not merged.
  const lane = mk("item.new", "R2", { title: "Lane's own train", type: "release" });
  const md = register(row("R2", { title: "Same id, register text" }), row("B1234"));
  const out = run([...baseEvents(), lane], md);
  assert.deepEqual(out.events, []);
  assert.equal(out.summary.skipped.length >= 1, true);
  assert.deepEqual(out.collisions, ["R2"]);
});

test("syncEvents never drops a register row item, even one that vanished from the register", () => {
  const v1 = register(row(201), row(202));
  const ev1 = run(baseEvents(), v1).events;
  const out = run([...baseEvents(), ...ev1], register(row(201)));
  assert.deepEqual(out.events, []);
});

// ---------------------------------------------------------------------------------------------
// Owner queue

const dec = (id, title, tags) =>
  mk("item.new", id, {
    title,
    type: "decision",
    lane: "owner",
    priority: "P1",
    tags,
    source: "owner-queue",
  });

test("syncEvents: answered owner-queue rows become one owner-decision each; booked and open do not", () => {
  const events = [
    ...baseEvents(),
    dec("401", "Make the legacy card read-only.", [
      "owner-queue",
      "N1 · ANSWERED 10-18 → D-2026-10",
    ]),
    dec("402", "Migration sitting.", ["owner-queue", "11 · BOOKED: merged into the R5"]),
    dec("403", "Something open.", ["owner-queue", "20 · OPEN"]),
    dec("404", "Plain row with a decision file.", ["owner-queue", "21"]),
    dec("405", "Done row.", ["owner-queue", "22 · DONE"]),
  ];
  const md = oq(
    "| N1 · **ANSWERED 10-18 → D-2026-10-18-acme-say-no.md** | Make the legacy card read-only. | 568 | Yes, do it. | Why. |",
    "| 11 · **BOOKED: merged into the R5 sitting → D-2026-10-18-acme-say-no.md** | Migration sitting. | 510 | Yes. | Why. |",
    "| 20 · **OPEN** | Something open. | 1 | Yes. | Why. |",
    "| 21 | Plain row with a decision file. [D](decisions/D-2026-10-01-acme-plain.md) | 2 | Yes. | Why. |",
    "| 22 · **DONE, nothing to do** | Done row. | 3 | Yes. | Why. |",
  );
  const out = run(events, "", md);
  const byItem = Object.fromEntries(out.events.map((e) => [e.item, e]));
  assert.deepEqual(Object.keys(byItem).sort(), ["401", "404", "405"]);
  assert.equal(byItem["401"].kind, "owner-decision");
  assert.equal(byItem["401"].data.question, "Make the legacy card read-only.");
  assert.equal(byItem["401"].data.answer, "ANSWERED → D-2026-10-18-acme-say-no.md");
  assert.equal(byItem["401"].data.recommended, "Yes, do it.");
  assert.equal(byItem["405"].data.answer, "DONE → -");
  assert.equal(byItem["404"].data.answer, "ANSWERED → D-2026-10-01-acme-plain.md");
  // after folding, the decisions are answered and the next run is empty
  const next = [...events, ...out.events];
  const st = fold(next);
  assert.equal(st.items.get("401").status, "verified");
  assert.ok(st.items.get("401").answeredAt > 0);
  assert.deepEqual(run(next, "", md).events, []);
});

test("syncEvents: owner-decision question and answer are capped at 600", () => {
  const long = "x".repeat(900);
  const events = [...baseEvents(), dec("401", long.slice(0, 300), ["owner-queue", "N1"])];
  const md = oq(`| N1 · **ANSWERED 10-18** | ${long} | 1 | Yes. | Why. |`);
  const out = run(events, "", md);
  // the row text is longer than the stored title (300 clip), so it matches by key
  assert.equal(out.events.length, 1);
  assert.ok(out.events[0].data.question.length <= 600);
});

// ---------------------------------------------------------------------------------------------
// Board-sourced items

test("syncEvents: board-sourced items (problem / owner-ask) are dropped once; others untouched", () => {
  const events = [
    ...baseEvents(),
    mk(
      "item.new",
      "501",
      {
        title: "A board problem",
        type: "incident",
        priority: "P0",
        tags: ["problem"],
        source: "board",
      },
      BACKFILL,
    ),
    mk(
      "item.new",
      "502",
      {
        title: "A board ask",
        type: "decision",
        tags: ["owner-ask"],
        source: "board",
      },
      BACKFILL,
    ),
    mk("item.new", "503", {
      title: "A queue decision",
      type: "decision",
      tags: ["owner-queue", "N9"],
      source: "owner-queue",
    }),
    regNew("201"),
  ];
  const out = run(events, "", "");
  assert.deepEqual(
    out.events.map((e) => [e.kind, e.item, e.data.status]),
    [
      ["status", "501", "dropped"],
      ["status", "502", "dropped"],
    ],
  );
  assert.equal(
    out.events[0].data.note,
    "board snapshot is a generated view, not a source (lead 10-19)",
  );
  const next = [...events, ...out.events];
  assert.equal(fold(next).items.get("501").status, "dropped");
  assert.deepEqual(run(next, "", "").events, []);
});

test("syncEvents: only backfill-imported board items are dropped; a lane's own problem/owner-ask item is never touched", () => {
  const events = [
    ...baseEvents(),
    mk(
      "item.new",
      "601",
      { title: "Lane problem", type: "incident", tags: ["problem"] },
      { lane: "pc-lane" },
    ),
    mk(
      "item.new",
      "602",
      { title: "Lane ask", type: "decision", tags: ["owner-ask"] },
      { actor: "pc-lane" },
    ),
    mk(
      "item.new",
      "603",
      { title: "Imported", type: "incident", tags: ["problem"], source: "board" },
      BACKFILL,
    ),
  ];
  const out = run(events, "", "");
  assert.deepEqual(
    out.events.map((e) => [e.kind, e.item]),
    [["status", "603"]],
  );
});

test("syncEvents: a revived board item (status changed after the drop) is not dropped again", () => {
  const events = [
    ...baseEvents(),
    mk(
      "item.new",
      "701",
      { title: "Imported", type: "incident", tags: ["problem"], source: "board" },
      BACKFILL,
    ),
  ];
  const first = run(events, "", "");
  assert.equal(first.events.length, 1);
  const revived = {
    ...mk("status", "701", { status: "planned" }, { actor: "lead" }),
    ts: new Date(NOW + 600000 * 50).toISOString(), // after the drop pass
  };
  const next = [...events, ...first.events, revived];
  assert.equal(fold(next).items.get("701").status, "planned");
  assert.deepEqual(run(next, "", "").events, []);
});

test("syncEvents with everything at once is idempotent and exports the plain-events form", () => {
  const events = [
    ...baseEvents(),
    dec("401", "Make the legacy card read-only.", ["owner-queue", "N1"]),
    mk(
      "item.new",
      "501",
      { title: "B", type: "incident", tags: ["problem"], source: "board" },
      BACKFILL,
    ),
  ];
  const md = register(row(201), row(202, { status: "building" }));
  const q = oq("| N1 · **ANSWERED 10-18** | Make the legacy card read-only. | 1 | Yes. | W. |");
  const first = syncEvents({
    state: fold(events),
    registerMd: md,
    ownerQueueMd: q,
    config,
    machine: "pc",
    now: NOW,
    rand,
  });
  assert.ok(Array.isArray(first));
  assert.equal(first.length, 4);
  const all = [...events, ...first];
  const second = syncEvents({
    state: fold(all),
    registerMd: md,
    ownerQueueMd: q,
    config,
    machine: "pc",
    now: NOW + 5000,
    rand,
  });
  assert.deepEqual(second, []);
});

// ---------------------------------------------------------------------------------------------
// IO with real git (temp repos)

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function mkRepo(name) {
  const tmp = mkdtempSync(join(tmpdir(), `rfops-sync-${name}-`));
  const rem = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", rem);
  const seed = join(tmp, "seed");
  git(tmp, "clone", "--quiet", rem, seed);
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  mkdirSync(join(seed, "register"));
  mkdirSync(join(seed, "priorities"));
  writeFileSync(
    join(seed, "register", "WORK-REGISTER.md"),
    register(row(201, { eta: "10-19" }), row(202)),
  );
  writeFileSync(
    join(seed, "priorities", "OWNER-QUEUE.md"),
    oq("| N1 · **ANSWERED 10-18** | Acme question? | 1 | Yes. | W. |"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", "-u", "origin", "main");
  const dir = join(tmp, "clone");
  git(tmp, "clone", "--quiet", rem, dir);
  git(dir, "config", "user.name", "Sync Test");
  git(dir, "config", "user.email", "sync@example.com");
  return { tmp, rem, dir, home: join(tmp, "home") };
}

test(
  "runSync: appends once, second run appends nothing, busy lock skips, dry writes nothing",
  {
    timeout: 600000,
  },
  async () => {
    const r = mkRepo("io");
    try {
      // an owner-queue decision item exists first (as the backfill would have made it)
      await appendEvents(
        [
          mk("item.new", "R1", { title: "Window 2", type: "release" }),
          dec("401", "Acme question?", ["owner-queue", "N1"]),
        ],
        { dir: r.dir, home: r.home },
      );
      const common = { dir: r.dir, home: r.home, machine: "pc", env: {}, now: NOW + 3600000 };
      const dry = await runSync({ ...common, dry: true });
      assert.equal(dry.ran, true);
      assert.equal(dry.events.length, 3); // 2 register rows + 1 owner-decision
      assert.equal(readAllEvents(r.dir).length, 2, "dry run appends nothing");

      const first = await runSync(common);
      assert.equal(first.ran, true);
      assert.equal(first.appended, 3);
      assert.equal(first.pushed, true);
      assert.equal(git(r.dir, "rev-list", "--count", "@{u}..HEAD").trim(), "0");

      const second = await runSync({ ...common, now: NOW + 7200000 });
      assert.equal(second.ran, true);
      assert.equal(second.appended, 0);

      await withSpecsLock(
        async () => {
          const busy = await runSync({ ...common, now: NOW + 9000000 });
          assert.deepEqual(busy, { ran: false, reason: "busy" });
        },
        { home: r.home, heartbeatMs: 3600000 },
      );
    } finally {
      rmSync(r.tmp, { recursive: true, force: true });
    }
  },
);

test("runSync does nothing in generated register mode", { timeout: 600000 }, async () => {
  const r = mkRepo("gen");
  try {
    mkdirSync(join(r.dir, "ops"), { recursive: true });
    writeFileSync(join(r.dir, "ops", "config.json"), JSON.stringify({ registerMode: "generated" }));
    const out = await runSync({ dir: r.dir, home: r.home, machine: "pc", env: {} });
    assert.deepEqual(out, { ran: false, reason: "generated" });
  } finally {
    rmSync(r.tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The monitor's 5-minute sync (server.mjs): only on the --views writer, never in cloud

import { resolveListenOptions, shouldRunRegisterSync, startRegisterSync } from "../server.mjs";

test("shouldRunRegisterSync: only the local --views writer; never cloud, once or fixture", () => {
  const o = (argv, env = {}) => resolveListenOptions(argv, env);
  assert.equal(shouldRunRegisterSync(o([])), false);
  assert.equal(shouldRunRegisterSync(o(["--views"])), true);
  assert.equal(shouldRunRegisterSync(o(["--views", "--once"])), false);
  assert.equal(shouldRunRegisterSync(o(["--views", "--fixture", "x.json"])), false);
  assert.equal(shouldRunRegisterSync(o(["--views", "--cloud"])), false);
  assert.equal(shouldRunRegisterSync(o(["--views"], { RF_CLOUD: "1" })), false);
});

function fakeTimers() {
  const pending = [];
  return {
    schedule: (fn, ms) => {
      const h = { fn, ms, live: true };
      pending.push(h);
      return h;
    },
    cancel: (h) => {
      h.live = false;
    },
    // run the next live timer and let its async work settle
    async fire() {
      const h = pending.find((x) => x.live);
      assert.ok(h, "a timer is pending");
      h.live = false;
      await h.fn();
      await new Promise((r) => setImmediate(r));
      return h.ms;
    },
    live: () => pending.filter((x) => x.live).length,
  };
}

test("startRegisterSync: first run after the delay, then every interval; errors never stop it", async () => {
  const t = fakeTimers();
  const calls = [];
  const done = [];
  const logs = [];
  let n = 0;
  const stop = startRegisterSync({
    run: async () => {
      calls.push(++n);
      if (n === 2) throw new Error("boom");
      return { ran: true, appended: n === 1 ? 3 : 0 };
    },
    onDone: (r) => done.push(r),
    log: (m) => logs.push(m),
    firstDelayMs: 1000,
    intervalMs: 300000,
    schedule: t.schedule,
    cancel: t.cancel,
  });
  assert.equal(t.live(), 1);
  assert.equal(await t.fire(), 1000);
  assert.deepEqual(calls, [1]);
  assert.deepEqual(done, [{ ran: true, appended: 3 }]); // only passes that appended notify
  assert.equal(await t.fire(), 300000);
  assert.deepEqual(calls, [1, 2]);
  assert.match(logs.join("\n"), /boom/);
  assert.equal(await t.fire(), 300000); // still scheduled after the error
  assert.deepEqual(done.length, 1); // a pass that appended nothing does not notify
  stop();
  assert.equal(t.live(), 0);
});

// ---------------------------------------------------------------------------------------------
// Register numbers belong to the register (lead 10-19)

const applyAll = (events, more) => {
  const st = fold([...events, ...more]);
  assert.deepEqual(st.anomalies, [], JSON.stringify(st.anomalies));
  return st;
};

test("syncEvents: legacy monitor items squatting on register numbers are renamed, then the row is created; idempotent", () => {
  const oqA = mk(
    "item.new",
    "614",
    { title: "Say no?", type: "decision", tags: ["owner-queue", "N1"], source: "owner-queue" },
    BACKFILL,
  );
  const oqB = mk(
    "item.new",
    "615",
    {
      title: "Say no again?",
      type: "decision",
      tags: ["owner-queue", "N1"],
      source: "owner-queue",
    },
    BACKFILL,
  );
  const board = mk(
    "item.new",
    "616",
    { title: "Board problem", type: "chore", tags: ["problem"] },
    BACKFILL,
  );
  const cli = mk(
    "item.new",
    "651",
    { title: "Monitor's own item", type: "feature" },
    { actor: "lead" },
  );
  const events = [...baseEvents(), oqA, oqB, board, cli];
  const md = register(row(614), row(615), row(616), row(651), row(652));
  const out = run(events, md);
  const kinds = out.events.map((e) => `${e.kind} ${e.item}${e.data.to ? `>${e.data.to}` : ""}`);
  assert.deepEqual(kinds, [
    "item.rename 614>OQ-N1",
    "item.new 614",
    "item.rename 615>OQ-N1.2",
    "item.new 615",
    "item.rename 616>BOARD-616",
    "item.new 616",
    "item.rename 651>W-651",
    "item.new 651",
    "item.new 652",
    "status BOARD-616", // the board drop follows the item to its alias, never the register row
  ]);
  assert.deepEqual(out.collisions, []);
  const st = applyAll(events, out.events);
  assert.equal(st.items.get("OQ-N1").title, "Say no?");
  assert.equal(st.items.get("OQ-N1.2").title, "Say no again?");
  assert.equal(st.items.get("BOARD-616").status, "dropped");
  assert.equal(st.items.get("W-651").title, "Monitor's own item");
  for (const id of ["614", "615", "616", "651", "652"]) {
    assert.equal(st.items.get(id).source, "register", id);
    assert.equal(st.items.get(id).status, "planned", id);
  }
  // the second pass has nothing to do
  assert.deepEqual(run([...events, ...out.events], md).events, []);
});

test("syncEvents: an answered owner-queue row answers the renamed item, not the register row", () => {
  const oq = mk(
    "item.new",
    "614",
    { title: "Say no?", type: "decision", tags: ["owner-queue", "N1"], source: "owner-queue" },
    BACKFILL,
  );
  const queue = oq_N1_answered();
  const out = run([...baseEvents(), oq], register(row(614)), queue);
  const decision = out.events.find((e) => e.kind === "owner-decision");
  assert.equal(decision.item, "OQ-N1");
});
function oq_N1_answered() {
  return oq("| N1 · ANSWERED | Say no? | - | yes | because |");
}

test("syncEvents: a register row sharing its number with a non-legacy monitor item is refused and reported", () => {
  const lane = mk(
    "item.new",
    "R2",
    { title: "Lane's own train", type: "release", priority: "P1" },
    { lane: "pc-lane" },
  );
  const md = register(
    row("R2", { title: "Register text", prio: "P3", status: "building" }),
    row(700),
  );
  const events = [...baseEvents(), lane];
  const out = run(events, md);
  assert.deepEqual(out.collisions, ["R2"]);
  assert.deepEqual(
    out.events.map((e) => `${e.kind} ${e.item}`),
    ["item.new 700"],
  ); // other rows still sync
  const st = applyAll(events, out.events);
  const r2 = st.items.get("R2");
  assert.equal(r2.title, "Lane's own train");
  assert.equal(r2.priority, "P1");
  assert.equal(r2.status, "planned"); // the register row said building: nothing merged
  assert.equal(r2.source, null);
  assert.deepEqual(r2.registerFields, {});
  // still refused (and still silent) on the next pass
  const again = run([...events, ...out.events], md);
  assert.deepEqual(again.events, []);
  assert.deepEqual(again.collisions, ["R2"]);
});

test("syncEvents: duplicate register row ids refuse the whole register but still sync the owner queue", () => {
  const oqItem = mk(
    "item.new",
    "W-1",
    { title: "Say no?", type: "decision", tags: ["owner-queue", "N1"], source: "owner-queue" },
    BACKFILL,
  );
  const md = register(row(500), row(501), row(500, { title: "Phantom copy" }));
  const out = run([...baseEvents(), oqItem], md, oq_N1_answered());
  assert.equal(out.refused, "duplicate register row ids: 500");
  assert.equal(out.summary.refused, out.refused);
  assert.deepEqual(
    out.events.map((e) => e.kind),
    ["owner-decision"],
  );
  assert.equal(out.summary.registerNew, 0);
  // a clean register is not refused
  assert.equal(run(baseEvents(), register(row(500), row(501))).refused, null);
});

// ---------------------------------------------------------------------------------------------
// Accuracy round 2 (X1): status words

test("X1 sync: a row already ingested as planned gets the corrected status when the parser knows its word", () => {
  // The old parser read "done" as planned and recorded that in registerFields.
  const stale = [
    ...baseEvents(),
    regNew("530", { type: "ops", status: "planned", priority: "P1" }),
  ];
  const out = run(stale, register(row(530, { type: "ops", prio: "P1", status: "done" })));
  const edit = out.events.find((e) => e.kind === "item.edit");
  assert.equal(edit.data.fields.status, "verified");
  assert.equal(fold([...stale, ...out.events]).items.get("530").status, "verified");
  // second pass: nothing
  assert.deepEqual(
    run([...stale, ...out.events], register(row(530, { type: "ops", prio: "P1", status: "done" })))
      .events,
    [],
  );
});

test("X1 sync: an unknown status word sets statusText once, and clears it when the word becomes known", () => {
  const md1 = register(row(531, { status: "triaged" }));
  const first = run(baseEvents(), md1);
  assert.equal(first.events[0].data.status, "planned");
  assert.equal(first.events[0].data.statusText, "triaged");
  const ev1 = [...baseEvents(), ...first.events];
  assert.equal(fold(ev1).items.get("531").statusText, "triaged");
  assert.deepEqual(run(ev1, md1).events, []);
  const second = run(ev1, register(row(531, { status: "building" })));
  assert.equal(second.events[0].data.fields.statusText, null);
  assert.equal(fold([...ev1, ...second.events]).items.get("531").statusText, null);
});

test("X1 sync: a blocked row keeps the item's status and raises a blocked event, once; leaving blocked unblocks", () => {
  const ev0 = [
    ...baseEvents(),
    ...run(baseEvents(), register(row(532, { status: "building" }))).events,
  ];
  const md = register(row(532, { status: "blocked (waiting on acme)" }));
  const out = run(ev0, md);
  assert.deepEqual(
    out.events.map((e) => e.kind),
    ["blocked"],
  );
  assert.match(out.events[0].data.by, /^register status: blocked/);
  const ev1 = [...ev0, ...out.events];
  const it = fold(ev1).items.get("532");
  assert.equal(it.status, "building");
  assert.ok(it.blocked);
  assert.deepEqual(run(ev1, md).events, []);
  const back = run(ev1, register(row(532, { status: "building" })));
  assert.deepEqual(
    back.events.map((e) => e.kind),
    ["unblocked"],
  );
  // a block a lane raised itself is never lifted by the register
  const laneBlocked = [...ev0, mk("blocked", "532", { by: "lane says wait" })];
  assert.deepEqual(run(laneBlocked, register(row(532, { status: "building" }))).events, []);
});
