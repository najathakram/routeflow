import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  parsePlanTrains,
  parseRegisterReport,
  pickLatestPlan,
  trainMembers,
  planFamilies,
} from "../lib/backfill.mjs";
import { planSync } from "../lib/sync.mjs";
import { fold } from "../lib/fold.mjs";
import { buildSnapshot } from "../lib/snapshot.mjs";
import { validateEvent, validateItemFields } from "../lib/schema.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";
import { newEventId, tagRank, tagWords } from "../lib/ids.mjs";

const PLAN = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "plan-v2.md"),
  "utf8",
);
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const REG_HEAD =
  "| ID | Title | Type | Priority | Status | Lane | Train | Gate | ETA | Links | Updated |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|\n";
const regRow = (id, train, status = "planned") =>
  `| ${id} | Acme row ${id} | fix | P2 | ${status} | - | ${train} | - | - | - | 2026-10-15 |`;
const REGISTER =
  REG_HEAD + [regRow(498, "T5 (was: backlog)"), regRow(736, "T15 (was: R6 set)")].join("\n");

let n = 0;
const mk = (kind, item, data, actor = "tester") => {
  const at = NOW - 3600000 + n++ * 1000;
  return {
    v: 1,
    id: newEventId("pc", at, () => (n % 97) / 97),
    ts: new Date(at).toISOString(),
    machine: "pc",
    actor,
    lane: null,
    kind,
    item,
    data,
  };
};
let tick = 0;
const sync = (events, planMd = PLAN, registerMd = REGISTER) => {
  const out = planSync({
    state: fold(events),
    registerMd,
    planMd,
    planName: "PLAN-2026-10-23-v2.md",
    config: DEFAULT_CONFIG,
    machine: "pc",
    now: NOW + 600000 * ++tick,
    rand: () => 0.5,
  });
  for (const e of out.events) assert.deepEqual(validateEvent(e), { ok: true, errors: [] });
  return out;
};

test("pickLatestPlan: newest date, highest -vN, skips superseded, ignores other files", () => {
  const files = [
    "PLAN-2026-10-21.md",
    "PLAN-2026-10-23.md",
    "PLAN-2026-10-23-v2.md",
    "PLAN-2026-10-23.map.cjs",
    "FLEET-PLAN-2026-10-22.md",
    "MACMINI-CLEANUP-PLAN-2026-10-22.md",
  ];
  const heads = { "PLAN-2026-10-23.md": "# Plan\n\nThis plan is superseded by v2." };
  assert.equal(
    pickLatestPlan(files, (f) => heads[f] ?? ""),
    "PLAN-2026-10-23-v2.md",
  );
  assert.equal(
    pickLatestPlan(["PLAN-2026-10-23.md", "PLAN-2026-10-23-v2.md"]),
    "PLAN-2026-10-23-v2.md",
  );
  assert.equal(
    pickLatestPlan(["PLAN-2026-10-23-v2.md", "PLAN-2026-10-23-v10.md"]),
    "PLAN-2026-10-23-v10.md",
  );
  assert.equal(
    pickLatestPlan(["PLAN-2026-10-23.md"], () => "SUPERSEDED BY PLAN-2026-10-24.md"),
    null,
  );
  // only "superseded by" retires a plan, not any mention of the word
  assert.equal(
    pickLatestPlan(
      ["PLAN-2026-10-23.md"],
      () => "# Plan (supersedes PLAN-10-21; nothing superseded here)",
    ),
    "PLAN-2026-10-23.md",
  );
});

test("parsePlanTrains: # column ids, goals, members, tag cells; summary tables ignored", () => {
  const rows = parsePlanTrains(PLAN);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["T0", "T5a", "T12a", "T5b", "T12", "T16"],
  );
  const t5a = rows.find((r) => r.id === "T5a");
  assert.equal(t5a.title, "Counter, part 1");
  assert.deepEqual(t5a.lane, "MML");
  assert.equal(t5a.budget, "1.4");
  assert.equal(t5a.tag, "U");
});

test("planFamilies: T5a + T5b group; parts keep their own tag; earliest first; members unioned", () => {
  const fams = planFamilies(parsePlanTrains(PLAN), {
    extraMembers: (id) => (id === "T5" ? ["999"] : []),
  });
  assert.deepEqual(
    fams.map((f) => f.id),
    ["T0", "T5", "T12", "T16"],
  );
  const t5 = fams.find((f) => f.id === "T5");
  assert.equal(t5.title, "Counter, part 1 · Counter, part 2");
  assert.deepEqual(
    t5.parts.map((p) => [p.id, p.tag, p.lane]),
    [
      ["T5a", "U", "MML"],
      ["T5b", "A1", "WIN"],
    ],
  );
  assert.deepEqual(t5.members, ["B501", "498", "746", "736", "737", "999"]);
  assert.equal(fams.find((f) => f.id === "T12").parts[0].tag, "U");
  assert.equal(fams.find((f) => f.id === "T12").parts[1].tag, "A1-A2");
});

test("schema: T ids, family train values and parts validate", () => {
  for (const id of ["T0", "T5a", "T12"])
    assert.deepEqual(
      validateItemFields({ title: "x", type: "bug", members: [id], train: id }, { full: true }),
      [],
    );
  assert.equal(
    validateItemFields({ parts: [{ id: "T5a", goal: "g", members: [] }] }, { full: false }).length,
    0,
  );
  assert.equal(
    validateItemFields({ parts: [{ id: "T5a", goal: "g" }] }, { full: false }).length,
    1,
  );
  assert.equal(
    validateItemFields({ parts: [{ id: "bad", goal: "g", members: [] }] }, { full: false }).length,
    1,
  );
});

test("register 'T5 (was: backlog)' reads as train T5", () => {
  const { drafts } = parseRegisterReport(REGISTER, DEFAULT_CONFIG);
  assert.equal(drafts.find((d) => d.id === "498").fields.train, "T5");
  assert.equal(drafts.find((d) => d.id === "736").fields.train, "T15");
});

test("planSync: families + linked register rows in one batch; second run is empty", () => {
  const first = sync([]);
  const kinds = first.events.map((e) => `${e.kind} ${e.item}`);
  assert.deepEqual(kinds.slice(0, 4), [
    "item.new T0",
    "item.new T5",
    "item.new T12",
    "item.new T16",
  ]);
  const row498 = first.events.find((e) => e.kind === "item.new" && e.item === "498");
  assert.equal(row498.data.train, "T5"); // known in the same batch
  const row736 = first.events.find((e) => e.kind === "item.new" && e.item === "736");
  assert.equal(row736.data.train, undefined); // T15 is not in the plan
  const second = sync(first.events.map((e) => e).length ? first.events : []);
  assert.deepEqual(second.events, []);
});

test("planSync: a changed goal emits one item.edit; old plan trains retire once; done ones stay", () => {
  const first = sync([]).events;
  const events = [
    mk("item.new", "R1", { title: "Old", type: "release", status: "planned", source: "plan" }),
    mk("item.new", "R2", { title: "Old live", type: "release", status: "live", source: "plan" }),
    mk("item.new", "R3", { title: "Own", type: "release", status: "planned", source: "register" }),
    mk("item.new", "R4", { title: "Backfilled", type: "release", status: "planned" }, "backfill"),
    ...first,
  ];
  const out = sync(events);
  const drops = out.events.filter((e) => e.kind === "status");
  assert.deepEqual(
    drops.map((e) => [e.item, e.data.status, e.data.note]),
    [
      ["R1", "dropped", "not in PLAN-2026-10-23-v2.md"],
      ["R4", "dropped", "not in PLAN-2026-10-23-v2.md"],
    ],
  );
  assert.equal(out.events.length, 2);
  assert.deepEqual(sync([...events, ...out.events]).events, []);
  const changed = sync(
    [...events, ...out.events],
    PLAN.replace("Deadlines and live hazards", "Deadlines"),
  );
  assert.deepEqual(
    changed.events.map((e) => [e.kind, e.item, Object.keys(e.data.fields)]),
    [["item.edit", "T0", ["title", "parts"]]],
  );
});

// ---- snapshot: derived release state, tag ordering, Shipping next ----
const CFG = DEFAULT_CONFIG;
const snap = (events, prs = []) =>
  buildSnapshot({
    sources: {
      specs: {
        ok: true,
        at: NOW,
        tried: NOW,
        error: null,
        intervalSec: 30,
        data: { events, config: CFG },
      },
      github: {
        ok: true,
        at: NOW,
        tried: NOW,
        error: null,
        intervalSec: 60,
        data: { prs: { open: prs, merged: [] }, checks: [] },
      },
    },
    config: CFG,
    now: NOW,
    machine: "pc",
  });
const part = (id, tag, members) => ({ id, goal: `Goal ${id}`, tag, members });
const rel = (id, parts, extra = {}) =>
  mk("item.new", id, {
    title: `Release ${id}`,
    type: "release",
    status: "planned",
    source: "plan",
    members: parts.flatMap((p) => p.members),
    parts,
    ...extra,
  });
const bug = (id, status) => mk("item.new", id, { title: `Row ${id}`, type: "bug", status });
const trainOf = (s, id) => s.trains.find((t) => t.id === id);

test("snapshot: shipped only when EVERY part is done; dropped/parked members ignored", () => {
  const s = snap([
    bug("1", "live"),
    bug("2", "verified"),
    bug("3", "dropped"),
    rel("T1", [part("T1a", "U", ["1", "3"]), part("T1b", "A1", ["2"])]),
    rel("T2", [part("T2a", "U", ["1"]), part("T2b", "A1", ["2", "4"])]),
    bug("4", "building"),
  ]);
  assert.equal(trainOf(s, "T1").stateText, "Shipped");
  assert.equal(trainOf(s, "T1").status, "live");
  const t2 = trainOf(s, "T2");
  assert.equal(t2.stateText, "In progress 1 of 2 parts");
  assert.deepEqual([t2.partsDone, t2.partsTotal], [1, 2]);
  assert.deepEqual(
    t2.parts.map((p) => [p.itemsDone, p.itemsTotal]),
    [
      [1, 1],
      [1, 2],
    ],
  );
  assert.deepEqual(
    t2.parts.map((p) => p.stateText),
    ["Done", "1 of 2 items"],
  );
});

test("snapshot: late past the earliest unfinished part's due date; dropped stays dropped", () => {
  const s = snap([
    bug("5", "building"),
    rel("T3", [part("T3a", "U", ["5"])]), // NOW is 10-22: U is due 10-26, not late yet
  ]);
  assert.equal(trainOf(s, "T3").state, "progress");
  const later = buildSnapshot({
    sources: {
      specs: {
        ok: true,
        at: NOW,
        tried: NOW,
        error: null,
        intervalSec: 30,
        data: {
          events: [
            bug("5", "building"),
            rel("T3", [part("T3a", "U", ["5"])]),
            rel("T4", [part("T4a", "A3", ["5"])], { status: "dropped" }),
          ],
          config: CFG,
        },
      },
    },
    config: CFG,
    now: Date.UTC(2026, 9, 27),
    machine: "pc",
  });
  assert.equal(trainOf(later, "T3").stateText, "Late");
  assert.equal(trainOf(later, "T3").parts[0].stateText, "Late");
  assert.equal(trainOf(later, "T4").stateText, "Dropped");
});

test("snapshot: only current-plan releases are derived; R1-R5 set live by the lead stay live (history)", () => {
  const members = Array.from({ length: 11 }, (_, i) => String(100 + i));
  const s = snap([
    ...members.map((m) => bug(m, "planned")),
    ...["R1", "R2", "R3", "R4", "R5"].map((id) =>
      mk("item.new", id, { title: `Old ${id}`, type: "release", status: "live", members }),
    ),
    rel("T9", [part("T9a", "U", members)], { status: "verified" }),
  ]);
  for (const id of ["R1", "R2", "R3", "R4", "R5"]) {
    assert.equal(trainOf(s, id).status, "live", id);
    assert.notEqual(trainOf(s, id).stateText, `In progress 0 of 11 items`);
  }
  // a current-plan release never reads Shipped/Fixed with unfinished parts
  const t9 = trainOf(s, "T9");
  assert.notEqual(t9.stateText, "Shipped");
  assert.equal(t9.status, "building");
  assert.equal(t9.stateText, "In progress 0 of 1 parts");
});

test("snapshot: a part with no linked items is not done and blocks Shipped", () => {
  const s = snap([
    bug("1", "live"),
    rel("T14", [part("T14a", "A2", ["1"]), part("T14b", "A3", [])]),
    rel("T16", [part("T16", "A3", [])]),
  ]);
  const t14 = trainOf(s, "T14");
  assert.equal(t14.stateText, "In progress 1 of 2 parts");
  assert.equal(t14.parts.find((p) => p.id === "T14b").stateText, "no items linked");
  assert.notEqual(trainOf(s, "T16").stateText, "Shipped");
  assert.equal(trainOf(s, "T16").parts[0].stateText, "no items linked");
});

test("trainMembers bare: known bare numbers count; PRs, dates, decimals and counts do not", () => {
  const known = new Set(["740", "741", "551", "26", "27", "683"]);
  assert.deepEqual(
    trainMembers("740 · 741 · 551 · (27 rows) on 10-26, #3597, budget 1.4; row 683", known, {
      bare: true,
    }),
    ["683", "740", "741", "551"],
  );
  // without bare, only "row N" forms count
  assert.deepEqual(trainMembers("740 · 741 · row 683", known), ["683"]);
});

test("tagWords: ranges show both ends", () => {
  assert.equal(tagWords("A1-A2"), "weeks of 10-26 to 11-02");
  assert.equal(tagWords("A2-A3"), "week of 11-02 or later");
  assert.equal(tagWords("U"), "before 10-26");
});

test("snapshot: releases order by earliest part tag, then id; tag words", () => {
  const s = snap([
    bug("6", "planned"),
    rel("T20", [part("T20a", "A2", ["6"])]),
    rel("T21", [part("T21a", "A3", ["6"]), part("T21b", "U", ["6"])]),
    rel("T3", [part("T3a", "A1", ["6"])]),
    rel("T2", [part("T2a", "A1", ["6"])]),
  ]);
  assert.deepEqual(
    s.trains.map((t) => t.id),
    ["T21", "T2", "T3", "T20"],
  );
  assert.equal(trainOf(s, "T21").tagWords, "before 10-26");
  assert.equal(tagWords("A2"), "week of 11-02");
  assert.equal(tagWords("A3"), "later");
  assert.equal(tagWords("Z9"), "Z9");
  assert.ok(tagRank("U") < tagRank("A1"));
});

test("snapshot: Shipping next lists unfinished releases by tag with ready PRs, oldest first", () => {
  const pr = (number, branch, over = {}) => ({
    number,
    title: `PR ${number} for row 7`,
    draft: false,
    branch,
    headSha: "abc1234",
    updatedAt: new Date(NOW - number * 1000).toISOString(),
    url: null,
    runs: [{ name: "verify", state: "success" }],
    files: [],
    body: "",
    ...over,
  });
  const s = snap(
    [
      bug("7", "building"),
      rel("T30", [part("T30a", "A1", ["7"])]),
      rel("T31", [part("T31a", "U", ["7"])]),
    ],
    [
      pr(10, "fix/a"),
      pr(20, "fix/b"),
      pr(30, "fix/c", { draft: true }),
      pr(40, "fix/d", { runs: [{ name: "verify", state: "failure" }] }),
    ],
  );
  assert.deepEqual(
    s.shippingNext.map((r) => r.id),
    ["T31", "T30"],
  );
  for (const r of s.shippingNext) {
    assert.ok(r.prs.length <= 3);
    for (const p of r.prs) assert.ok(![30, 40].includes(p.number));
  }
});
