import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  plain,
  parseRegister,
  parseRegisterReport,
  parsePlanTrains,
  trainMembers,
  parseOwnerQueue,
  parseBoardState,
  buildBackfillEvents,
  runBackfill,
} from "../lib/backfill.mjs";
import { validateEvent } from "../lib/schema.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(FIX, f), "utf8");
const NOW = Date.UTC(2026, 9, 19, 4, 0, 0);
const config = DEFAULT_CONFIG;

function emptyState(ids = []) {
  const items = new Map();
  for (const [id, title] of ids) items.set(id, { id, title: title ?? `t${id}` });
  return { items };
}
let seed = 0;
const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const parsedFixtures = () => ({
  register: parseRegister(read("register.md"), config),
  plan: parsePlanTrains(read("plan.md")),
  ownerQueue: parseOwnerQueue(read("owner-queue.md")),
  board: parseBoardState(read("board-state.json")),
});
const build = (state = emptyState(), parsed = null) => {
  seed = 1;
  return buildBackfillEvents(parsed ?? parsedFixtures(), {
    state,
    config,
    machine: "pc",
    now: NOW,
    actor: "backfill",
    rand,
  });
};

test("plain strips links, bold, code and br", () => {
  assert.equal(
    plain("[item](items/1.md) **bold** `code`<br>next [#3](https://x/pull/3) merged"),
    "item bold code next #3 merged",
  );
  assert.equal(plain(null), "");
});

test("parseRegister: rows, fields and failures", () => {
  const { drafts, failed } = parseRegisterReport(read("register.md"), config);
  assert.deepEqual(
    drafts.map((d) => d.id),
    ["101", "102", "103", "104", "105", "106", "107", "108"],
  );
  assert.equal(failed.length, 2);
  assert.match(failed[0].reason, /id/);
  assert.equal(parseRegister(read("register.md"), config).length, 8);
  const byId = Object.fromEntries(drafts.map((d) => [d.id, d.fields]));
  const a = byId["101"];
  assert.equal(a.type, "bug");
  assert.equal(a.priority, "P0");
  assert.equal(a.status, "planned");
  assert.equal(a.lane, "macmini");
  assert.equal(a.train, "R1");
  assert.equal(a.trainLabel, "R1 window 2");
  assert.equal(a.gate, "Opus (money); repro first");
  assert.equal(a.eta, "10-19 to 10-21");
  assert.deepEqual(a.links.prs, [4001, 4002]);
  assert.equal(a.source, "register");
  assert.equal(a.area, "domain:catalog"); // "tier prices" -> price
  assert.deepEqual(byId["102"].links.prs, [4010, 4020, 4011]);
  assert.equal(byId["102"].eta, undefined);
  assert.equal(byId["102"].train, undefined);
  assert.equal(byId["102"].trainLabel, "Own window");
  assert.equal(byId["103"].lane, undefined);
  assert.equal(byId["103"].status, "spec");
  assert.equal(byId["104"].links, undefined);
  assert.equal(byId["106"].status, "idea");
  assert.equal(byId["106"].type, "audit");
  assert.equal(byId["107"].type, "chore");
  assert.equal(byId["107"].priority, "P2");
  assert.equal(byId["107"].status, "building");
  assert.ok(byId["107"].lane);
  assert.equal(byId["108"].title, "Fix a | b split in the vendor bill list");
  assert.equal(byId["105"].type, "decision");
});

test("parseRegister: every draft validates as item.new data", () => {
  for (const d of parseRegister(read("register.md"), config)) {
    const ev = {
      v: 1,
      id: "pc-1760846400000-abcd",
      ts: "2026-10-19T04:00:00.000Z",
      machine: "pc",
      actor: "backfill",
      lane: null,
      kind: "item.new",
      item: d.id,
      data: d.fields,
    };
    assert.deepEqual(validateEvent(ev), { ok: true, errors: [] }, d.id);
  }
});

test("parseRegister truncates long cells", () => {
  const md = `| ID | Title | Type | Priority | Status | Lane | Train | Gate | ETA | Links | Updated |\n|---|---|---|---|---|---|---|---|---|---|---|\n| 5 | ${"t".repeat(400)} | fix | P1 | planned | Lead | ${"x".repeat(200)} | ${"g".repeat(500)} | ${"e".repeat(120)} | - | 2026-10-15 |\n`;
  const [d] = parseRegister(md, config);
  assert.equal(d.fields.title.length, 300);
  assert.equal(d.fields.trainLabel.length, 120);
  assert.equal(d.fields.gate.length, 400);
  assert.equal(d.fields.eta.length, 80);
});

test("parsePlanTrains reads the Trains table only", () => {
  const trains = parsePlanTrains(read("plan.md"));
  assert.deepEqual(
    trains.map((t) => t.id),
    ["R1", "R2", "R3"],
  );
  assert.equal(trains[0].title, "window 2: back office + widget fixes");
  assert.equal(trains[1].title, "widget guards");
  assert.match(trains[0].membersText, /rows 101\/102/);
  assert.equal(trains[0].lanes, "MB push; PC-L BO fixes");
  assert.equal(trains[0].gates, "MB single verified push; Opus review");
  assert.equal(trains[0].eta, "10-18 ~23:30Z");
  assert.deepEqual(parsePlanTrains("no tables"), []);
});

test("trainMembers: rows lists, single row, B ids; known filter", () => {
  const known = new Set(["101", "102", "103", "555", "556"]);
  assert.deepEqual(trainMembers("rows 101/102, row 103 · B1036 · rows 555, 556", known), [
    "101",
    "102",
    "103",
    "B1036",
    "555",
    "556",
  ]);
  assert.deepEqual(trainMembers("rows 101/999 and B6 and B12", known), ["101", "B12"]);
  assert.deepEqual(trainMembers("row 101 row 101", known), ["101"]);
  assert.deepEqual(trainMembers("nothing", known), []);
});

test("parseOwnerQueue: only tables with a Recommended answer header", () => {
  const q = parseOwnerQueue(read("owner-queue.md"));
  assert.deepEqual(
    q.map((r) => r.key),
    ["N1", "N2", "1", "2"],
  );
  assert.deepEqual(q[0].register, ["101", "107"]);
  assert.equal(q[0].title, "Make the legacy UNITS card read-only. Pairs with the held F08.");
  assert.equal(q[0].recommended, "Yes.");
  assert.match(q[0].why, /3 places/);
  assert.deepEqual(q[3].register, ["104", "105", "106"]);
});

test("parseOwnerQueue: real rows put status word and decision file in the first cell", () => {
  const md = [
    "## S",
    "",
    "| # | Item | Register | Recommended answer | Why |",
    "|---|---|---|---|---|",
    "| N1 · **ANSWERED 10-18 → D-2026-10-18-acme-say-no.md** | Legacy card read-only. | 568, 569 | Yes. | W. |",
    "| 11 · **BOOKED: merged into the R5 sitting** | Migration sitting. | 510 | Yes. | W. |",
  ].join("\n");
  const q = parseOwnerQueue(md);
  assert.deepEqual(
    q.map((r) => [r.key, r.statusWord, r.decisionFile]),
    [
      ["N1", "ANSWERED", "D-2026-10-18-acme-say-no.md"],
      ["11", "BOOKED", null],
    ],
  );
});

test("parseBoardState accepts text or object and defaults arrays", () => {
  const b = parseBoardState(read("board-state.json"));
  assert.equal(b.trains.length, 4);
  assert.equal(b.owner.length, 2);
  assert.equal(b.problems.length, 2);
  const empty = { asOf: null, trains: [], lanes: [], owner: [], problems: [] };
  assert.deepEqual(parseBoardState({}), empty);
  assert.deepEqual(parseBoardState("not json"), empty);
});

test("buildBackfillEvents: order, validity and ids", () => {
  const evs = build();
  for (const e of evs)
    assert.deepEqual(validateEvent(e), { ok: true, errors: [] }, JSON.stringify(e));
  assert.ok(
    evs.every((e) => e.kind === "item.new" && e.actor === "backfill" && e.machine === "pc"),
  );
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length);
  const ids = evs.map((e) => e.item);
  assert.deepEqual(ids.slice(0, 4), ["R1", "R2", "R3", "R4"]);
  assert.deepEqual(ids.slice(4, 12), ["101", "102", "103", "104", "105", "106", "107", "108"]);
  const rest = evs.slice(12);
  // owner queue (4) only: the board snapshot is a generated view, never an input (lead 10-19)
  assert.deepEqual(
    rest.map((e) => e.item),
    ["109", "110", "111", "112"],
  );
  assert.deepEqual(
    rest.map((e) => e.data.type),
    ["decision", "decision", "decision", "decision"],
  );
  const ts = evs.map((e) => Date.parse(e.ts));
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1]);
});

test("buildBackfillEvents: trains (status map, members, eta, gate)", () => {
  const evs = build();
  const t = Object.fromEntries(evs.slice(0, 4).map((e) => [e.item, e.data]));
  assert.equal(t.R1.type, "release");
  assert.equal(t.R1.title, "Back office and widget fixes"); // board name wins
  assert.equal(t.R1.status, "building"); // proofs
  assert.equal(t.R2.status, "building"); // fixing
  assert.equal(t.R3.status, "planned"); // waiting
  assert.equal(t.R4.status, "live"); // shipped
  assert.equal(t.R1.eta, "2026-10-19");
  assert.equal(t.R1.gate, "MB single verified push; Opus review");
  assert.deepEqual([...t.R1.members].sort(), ["101", "102", "103", "106", "108", "B1036"]);
  assert.deepEqual([...t.R2.members].sort(), ["105", "B1234"]); // 999 unknown dropped
  assert.deepEqual([...t.R3.members].sort(), ["107", "108"]); // register rows with train R3
  assert.deepEqual(t.R4.members, ["B1090"]);
  const planOnly = build(emptyState(), {
    register: [],
    plan: parsePlanTrains(read("plan.md")),
    ownerQueue: [],
    board: parseBoardState({}),
  });
  assert.deepEqual(
    planOnly.map((e) => e.item),
    ["R1", "R2", "R3"],
  );
  assert.equal(planOnly[0].data.title, "window 2: back office + widget fixes");
  assert.equal(planOnly[0].data.status, "planned");
  assert.equal(planOnly[0].data.eta, "10-18 ~23:30Z");
});

test("buildBackfillEvents: owner decisions only; board asks and problems are never imported", () => {
  const evs = build();
  const byItem = Object.fromEntries(evs.map((e) => [e.item, e.data]));
  const n1 = byItem["109"];
  assert.equal(n1.lane, "owner");
  assert.equal(n1.priority, "P1");
  assert.equal(n1.status, "planned");
  assert.equal(n1.gate, "Recommended: Yes.");
  assert.deepEqual(n1.related, ["101", "107"]);
  assert.deepEqual(n1.tags, ["owner-queue", "N1"]);
  assert.equal(
    evs.filter((e) => e.data.tags?.includes("owner-ask") || e.data.tags?.includes("problem"))
      .length,
    0,
  );
  assert.equal(evs.filter((e) => e.data.type === "incident").length, 0);
  assert.equal(evs.filter((e) => e.data.source === "board" && e.data.type !== "release").length, 0);
  const autoConfirm = evs.filter((e) => /Auto-confirm of staff orders/.test(e.data.title));
  assert.equal(autoConfirm.length, 1);
});

test("buildBackfillEvents: skips register rows already in state and continues ids past them", () => {
  const evs = build(
    emptyState([
      ["101", "x"],
      ["102", "y"],
      ["900", "z"],
    ]),
  );
  const reg = evs.filter((e) => e.data.source === "register").map((e) => e.item);
  assert.ok(!reg.includes("101") && !reg.includes("102"));
  assert.equal(reg.length, 6);
  const firstOwner = evs.find((e) => e.data.tags?.[0] === "owner-queue");
  assert.equal(firstOwner.item, "901");
  const withR1 = build(emptyState([["R1", "Existing"]]));
  assert.ok(!withR1.some((e) => e.item === "R1"));
});

test("buildBackfillEvents is idempotent (ids for register rows, titles for owner/problems)", () => {
  const first = build();
  const state = emptyState();
  for (const e of first) state.items.set(e.item, { id: e.item, title: e.data.title });
  assert.deepEqual(build(state), []);
  const evs = build(emptyState([["500", "  hide the DETAILS   tiers row. "]]));
  assert.ok(!evs.some((e) => e.data.title === "Hide the Details tiers row."));
});

test("runBackfill dry run uses injected readers and appenders", async () => {
  const files = new Map([
    ["/specs/register/WORK-REGISTER.md", read("register.md")],
    ["/specs/releases/PLAN-2026-10-18.md", read("plan.md")],
    ["/specs/priorities/OWNER-QUEUE.md", read("owner-queue.md")],
    ["/board/state.json", read("board-state.json")],
  ]);
  const appended = [];
  const written = [];
  seed = 1;
  const deps = {
    readText: (p) => files.get(p.replace(/\\/g, "/")) ?? null,
    listDir: (p) =>
      p.replace(/\\/g, "/") === "/specs/releases"
        ? ["PLAN-2026-10-11.md", "PLAN-2026-10-18.md", "RELEASES.md"]
        : [],
    readAllEvents: async () => [],
    fold: () => emptyState(),
    appendEvents: async (events) => {
      appended.push(...events);
      return { events, pushed: true, attempts: 1, warnings: [] };
    },
    writeText: (p, t) => written.push([p, t]),
    loadConfig: () => config,
    machineId: () => "pc",
    now: () => NOW,
    rand,
  };
  const dry = await runBackfill({ specsDir: "/specs", boardDir: "/board", dry: true, deps });
  assert.equal(dry.dry, true);
  assert.equal(appended.length, 0);
  assert.equal(written.length, 0);
  assert.deepEqual(dry.counts, {
    trains: 4,
    register: 8,
    owner: 4,
    problems: 0,
    events: 16,
    failedRows: 2,
  });
  const real = await runBackfill({ specsDir: "/specs", boardDir: "/board", dry: false, deps });
  assert.equal(appended.length, 16);
  assert.equal(real.pushed, true);
  assert.equal(written.length, 1);
  const rec = JSON.parse(written[0][1]);
  assert.match(written[0][0].replace(/\\/g, "/"), /\/specs\/ops\/state\/backfill\.json$/);
  assert.match(rec.registerSha256, /^[0-9a-f]{64}$/);
  assert.equal(rec.counts.events, 16);
  assert.equal(rec.at, new Date(NOW).toISOString());
});
