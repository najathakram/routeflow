// Team board, part 3: tester intake. A tester files a bug as a DRAFT item (steps, the screen, an
// evidence link); the lead or coordinator promotes it into the bug registry (one minter) or rejects
// it, and the reporter hears back as a comment on the item. The board shows a Triage panel.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { STATUSES, validateEvent } from "../lib/schema.mjs";
import { fold } from "../lib/fold.mjs";
import { rankCandidates } from "../lib/next.mjs";
import { buildSnapshot, statusLabelFor } from "../lib/snapshot.mjs";
import { draftsOf, promotionSymptom, TRIAGE_STATUS } from "../lib/triage.mjs";
import { LEGACY_CONFIG } from "./legacy-config.mjs";
import { makeRegisterRepo } from "./register-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RF = resolve(HERE, "..", "bin", "rf.mjs");

const MEMBERS = [
  { id: "alex", name: "Alex Rivera", machine: null, lanes: ["macmini"], role: "builder" },
  { id: "sam", name: "Sam Lee", machine: null, lanes: ["qa"], role: "tester" },
];
const CONFIG = {
  ...structuredClone(LEGACY_CONFIG),
  lanes: [
    ...LEGACY_CONFIG.lanes,
    { id: "qa", title: "Agent beta testing", machine: null, areas: ["*"] },
  ],
  members: MEMBERS,
};

let seq = 0;
function ev(kind, item, data, ts, { lane = "qa", actor = "sam" } = {}) {
  const ms = Date.parse(ts);
  return {
    v: 1,
    id: `testbox-${String(ms).padStart(13, "0")}-${(++seq).toString(36).padStart(4, "0").slice(-4)}`,
    ts,
    machine: "testbox",
    actor,
    lane,
    kind,
    item,
    data,
  };
}
const T0 = "2026-11-22T08:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const draft = (id, title, min, extra = {}) =>
  ev(
    "item.new",
    id,
    { title, type: "bug", status: "draft", steps: "1. open orders\n2. tap Save", ...extra },
    at(min),
  );

test("schema: draft is a status; steps, screen and evidence are item fields", () => {
  assert.equal(TRIAGE_STATUS, "draft");
  assert.ok(STATUSES.includes("draft"));
  const ok = draft("W-1", "Save does nothing", 0, {
    screen: "/orders/new",
    evidence: "https://example.com/shot.png",
  });
  assert.deepEqual(validateEvent(ok).errors, []);
  const bad = (fields) =>
    validateEvent(ev("item.new", "W-2", { title: "x", type: "bug", ...fields }, T0)).ok;
  assert.equal(bad({ steps: "x".repeat(2001) }), false);
  assert.equal(bad({ screen: "x".repeat(201) }), false);
  assert.equal(bad({ evidence: "file:///C:/shot.png" }), false, "a link, never a local file");
  assert.equal(bad({ evidence: "javascript:alert(1)" }), false);
  assert.equal(bad({ evidence: null, steps: null, screen: null }), true);
});

test("fold: an item remembers who reported it; a draft is never handed out by rf next", () => {
  const state = fold([
    draft("W-1", "Save does nothing", 0, { role: "builder", lane: "macmini" }),
    ev("item.new", "W-2", { title: "Build it", type: "feature", lane: "macmini" }, at(1), {
      lane: "lead",
      actor: "lead",
    }),
  ]);
  const w1 = state.items.get("W-1");
  assert.equal(w1.reportedBy, "sam");
  assert.equal(w1.steps, "1. open orders\n2. tap Save");
  assert.equal(w1.screen, null);
  assert.equal(w1.evidence, null);
  assert.equal(state.items.get("W-2").reportedBy, "lead");
  const ids = rankCandidates(state, "macmini", CONFIG, { now: Date.parse(at(5)) }).map(
    (c) => c.item.id,
  );
  assert.deepEqual(ids, ["W-2"]);
});

test("draftsOf: drafts only, oldest first; promotionSymptom masks client names and points back", () => {
  const state = fold([
    draft("W-2", "Later one", 5),
    draft("W-1", "Earlier one", 1, { screen: "/orders/new" }),
    ev("item.new", "W-3", { title: "Not a draft", type: "bug" }, at(2)),
  ]);
  assert.deepEqual(
    draftsOf(state).map((it) => it.id),
    ["W-1", "W-2"],
  );
  const it = {
    ...state.items.get("W-1"),
    steps: "Zorbex Traders order: tap Save",
    evidence: "https://example.com/a.png",
  };
  const s = promotionSymptom(it, ["Zorbex Traders"]);
  assert.doesNotMatch(s, /Zorbex/);
  assert.match(s, /a live business order: tap Save/);
  assert.match(s, /screen \/orders\/new/);
  assert.match(s, /evidence https:\/\/example\.com\/a\.png/);
  assert.match(s, /reported by sam on W-1/);
  assert.ok(promotionSymptom({ ...it, steps: "y".repeat(3000) }, []).length <= 1000);
});

test("snapshot: a draft reads 'Waiting for triage'; a promoted draft reads 'Promoted'", () => {
  assert.equal(statusLabelFor({ status: "draft", type: "bug" }), "Waiting for triage");
  assert.equal(statusLabelFor({ status: "dropped", type: "bug", tags: ["promoted"] }), "Promoted");
  assert.equal(statusLabelFor({ status: "dropped", type: "bug", tags: [] }), "Dropped");
  const NOW = Date.parse(at(10));
  const snap = buildSnapshot({
    sources: {
      specs: {
        ok: true,
        at: NOW,
        tried: NOW,
        error: null,
        intervalSec: 30,
        data: { config: CONFIG, events: [draft("W-1", "Save does nothing", 0)] },
      },
    },
    config: CONFIG,
    now: NOW,
    machine: "pc",
  });
  const it = snap.items.find((i) => i.id === "W-1");
  assert.equal(it.statusLabel, "Waiting for triage");
  assert.equal(it.reportedBy, "sam");
  assert.equal(it.reportedByName, "Sam Lee");
});

test("board: triageRows lists drafts oldest first with the reporter's name", () => {
  const src = readFileSync(join(HERE, "..", "public", "app.js"), "utf8");
  const ctx = {};
  vm.runInNewContext(src, ctx);
  const rows = JSON.parse(
    JSON.stringify(
      ctx.__opsUi.triageRows([
        {
          id: "W-2",
          title: "B",
          status: "draft",
          createdAt: at(5),
          reportedBy: "x:y",
          reportedByName: null,
        },
        { id: "W-9", title: "C", status: "planned", createdAt: at(0) },
        {
          id: "W-1",
          title: "A",
          status: "draft",
          createdAt: at(1),
          reportedBy: "sam",
          reportedByName: "Sam Lee",
          screen: "/orders/new",
          evidence: "https://example.com/a.png",
        },
      ]),
    ),
  );
  assert.deepEqual(rows, [
    {
      id: "W-1",
      title: "A",
      who: "Sam Lee",
      at: at(1),
      screen: "/orders/new",
      evidence: "https://example.com/a.png",
    },
    { id: "W-2", title: "B", who: "x:y", at: at(5), screen: null, evidence: null },
  ]);
  assert.equal(ctx.__opsUi.panelCountLine("triage", { items: [] }), "Triage (0 drafts)");
});

// ── CLI ─────────────────────────────────────────────────────────────────────
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let tmp;
let cliEnv;
let product;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-tri-"));
  const remote = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const specs = join(tmp, "specs");
  git(tmp, "clone", "--quiet", remote, specs);
  git(specs, "config", "user.name", "CLI Test");
  git(specs, "config", "user.email", "cli@example.com");
  writeFileSync(join(specs, "README.md"), "specs\n");
  mkdirSync(join(specs, "ops"), { recursive: true });
  writeFileSync(join(specs, "ops", "config.json"), JSON.stringify(CONFIG));
  git(specs, "add", "README.md");
  git(specs, "commit", "--quiet", "-m", "init");
  git(specs, "push", "--quiet", "-u", "origin", "main");
  product = makeRegisterRepo(join(tmp, "product"));
  // A stand-in for scripts/campaign/bugs.mjs: records its args, prints what the real one prints.
  mkdirSync(join(product, "scripts", "campaign"), { recursive: true });
  writeFileSync(
    join(product, "scripts", "campaign", "bugs.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync(new URL("./args.json", import.meta.url), JSON.stringify(process.argv.slice(2)));\n' +
      "console.log(`filed B999 — ${process.argv[3]}`);\n",
  );
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "client-names.json"), JSON.stringify(["Zorbex Traders"]));
  cliEnv = {
    ...process.env,
    RF_OPS_HOME: home,
    RF_SPECS_DIR: specs,
    RF_SPECS_REMOTE: remote,
    RF_MACHINE: "testbox",
    RF_REPO_ROOT: product,
    RF_NO_SYNC: "1",
  };
  for (const k of ["RF_LANE", "RF_ACTOR", "RF_MEMBER"]) delete cliEnv[k];
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function rf(args, extra = {}) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [RF, ...args],
      { env: { ...cliEnv, ...extra }, encoding: "utf8", timeout: 200000, cwd: tmp },
      (err, stdout, stderr) =>
        res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}
const T = { timeout: 600000 };
const SAM = { RF_MEMBER: "sam" };
const LEAD = { RF_LANE: "lead" };

test(
  "a tester files drafts only; the lead promotes one into the registry and rejects another",
  T,
  async () => {
    // A tester's bug is a draft by default; any other status or type is refused.
    let r = await rf(
      [
        "item",
        "new",
        "--title",
        "Save on a new order for Zorbex Traders does nothing",
        "--type",
        "bug",
        "--steps",
        "1. New order\n2. Add a line\n3. Tap Save",
        "--screen",
        "/orders/new",
        "--evidence",
        "https://example.com/shot.png",
        "--json",
      ],
      SAM,
    );
    assert.equal(r.code, 0, r.stderr);
    const made = JSON.parse(r.stdout).events[0];
    assert.equal(made.data.status, "draft");
    assert.equal(made.actor, "sam");
    r = await rf(["item", "new", "--title", "x", "--type", "bug", "--status", "planned"], SAM);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /a tester files a draft/);
    r = await rf(["item", "new", "--title", "x", "--type", "feature"], SAM);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /a tester files bugs/);
    r = await rf(["item", "new", "--title", "Total off by a cent", "--type", "bug"], SAM);
    assert.equal(r.code, 0, r.stderr);

    // Anyone can read the triage list.
    r = await rf(["triage"], SAM);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /2 drafts waiting for triage/);
    assert.match(r.stdout, /W-1 .*Sam Lee.*\/orders\/new/);
    assert.match(r.stdout, /W-2 .*Total off by a cent/);

    // Only the minter lanes promote (one minter of bug numbers).
    r = await rf(["triage", "promote", "W-1", "--location", "orders", "--severity", "high"], SAM);
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /refused: rf triage promote is limited to the lanes lead and coordinator/,
    );
    r = await rf(["triage", "promote", "W-1", "--severity", "high"], LEAD);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--location/);

    r = await rf(["triage", "promote", "W-1", "--location", "orders", "--severity", "high"], LEAD);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /promoted W-1 to B999/);
    const args = JSON.parse(
      readFileSync(join(product, "scripts", "campaign", "args.json"), "utf8"),
    );
    assert.equal(args[0], "file");
    assert.doesNotMatch(args.join(" "), /Zorbex/, "no client name reaches the in-repo registry");
    assert.deepEqual(args.slice(2, 6), ["--location", "orders", "--severity", "high"]);
    assert.equal(args[6], "--symptom");
    assert.match(args[7], /reported by sam on W-1/);

    r = await rf(["item", "show", "W-1", "--json"], SAM);
    const w1 = JSON.parse(r.stdout);
    assert.equal(w1.status, "dropped");
    assert.ok(w1.related.includes("B999"));
    assert.ok(w1.tags.includes("promoted"));
    r = await rf(["inbox"], SAM);
    assert.match(r.stdout, /1 new comment for you \(sam\)/);
    assert.match(r.stdout, /Filed as B999 \(high\)/);

    // A draft can be promoted once; a non-draft is not triage work.
    r = await rf(["triage", "promote", "W-1", "--location", "orders", "--severity", "high"], LEAD);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /W-1 is not a draft/);

    r = await rf(["triage", "reject", "W-2"], LEAD);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--reason/);
    r = await rf(["triage", "reject", "W-2", "--reason", "Rounding is per line by design"], LEAD);
    assert.equal(r.code, 0, r.stderr);
    r = await rf(["item", "show", "W-2", "--json"], SAM);
    const w2 = JSON.parse(r.stdout);
    assert.equal(w2.status, "dropped");
    assert.ok(w2.tags.includes("rejected"));
    r = await rf(["inbox"], SAM);
    assert.match(r.stdout, /Not filed: Rounding is per line by design/);

    r = await rf(["triage"], SAM);
    assert.match(r.stdout, /no drafts waiting for triage/);
  },
);
