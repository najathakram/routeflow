import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "rf.mjs");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let tmp;
let env;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-cli-"));
  const remote = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const specs = join(tmp, "specs");
  git(tmp, "clone", "--quiet", remote, specs);
  git(specs, "config", "user.name", "CLI Test");
  git(specs, "config", "user.email", "cli@example.com");
  writeFileSync(join(specs, "README.md"), "specs\n");
  git(specs, "add", "README.md");
  git(specs, "commit", "--quiet", "-m", "init");
  git(specs, "push", "--quiet", "-u", "origin", "main");
  env = {
    ...process.env,
    RF_OPS_HOME: join(tmp, "home"),
    RF_SPECS_DIR: specs,
    RF_SPECS_REMOTE: remote,
    RF_MACHINE: "testbox",
    RF_REPO_ROOT: join(tmp, "no-such-repo"),
    RF_NO_SYNC: "1",
    RF_ACTOR: "cli-test",
  };
  delete env.RF_LANE;
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function rf(...args) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [RF, ...args],
      { env, encoding: "utf8", timeout: 200000 },
      (err, stdout, stderr) => {
        res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
      },
    );
  });
}
const T = { timeout: 600000 };

test("usage errors exit 2 without touching git", T, async () => {
  assert.equal((await rf()).code, 2);
  assert.equal((await rf("bogus")).code, 2);
  const noId = await rf("claim");
  assert.equal(noId.code, 2);
  assert.match(noId.stderr, /item id/);
  assert.equal((await rf("item", "new", "--title", "x")).code, 2); // no --type
  assert.equal((await rf("item")).code, 2);
  assert.equal((await rf("claim", "5", "--lane", "no-such-lane-xyz")).code, 2);
  assert.equal((await rf("event", "nope", "5")).code, 2);
});

test("item new -> claim -> next -> status -> ls --json, with refusals (exit 1)", T, async () => {
  let r = await rf(
    "item",
    "new",
    "--title",
    "Acme order screen",
    "--type",
    "feature",
    "--priority",
    "P1",
    "--lane",
    "pc-lane",
    "--problem",
    "Acme staff cannot finish an order quickly",
    "--impact",
    "Acme loses time on every order",
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /created item 1\b/);
  // P1 feature without the business story is a usage error (exit 2)
  const noStory = await rf(
    "item",
    "new",
    "--title",
    "No story",
    "--type",
    "feature",
    "--priority",
    "P1",
  );
  assert.equal(noStory.code, 2);
  r = await rf(
    "item",
    "new",
    "--title",
    "Acme invoice total",
    "--type",
    "bug",
    "--priority",
    "P2",
    "--lane",
    "pc-lane",
    "--json",
  );
  assert.equal(r.code, 0, r.stderr);
  const created = JSON.parse(r.stdout);
  assert.equal(created.ok, true);
  assert.equal(created.pushed, true);
  assert.equal(created.events[0].item, "2");
  assert.equal(created.events[0].machine, "testbox");

  r = await rf("next", "--lane", "pc-lane", "--json");
  assert.equal(r.code, 0, r.stderr);
  let nx = JSON.parse(r.stdout);
  assert.equal(nx.item.id, "1");
  assert.equal(nx.runnersUp[0].id, "2");
  assert.match(nx.item.reason, /^P1 · assigned to pc-lane/);

  r = await rf("claim", "1", "--lane", "pc-lane", "--branch", "feat/1-acme");
  assert.equal(r.code, 0, r.stderr);

  // Held by pc-lane: another lane is refused (exit 1) unless --steal.
  r = await rf("claim", "1", "--lane", "macmini");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /held by pc-lane since .*--steal/);

  // Unknown item is refused (exit 1).
  r = await rf("status", "999", "live");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown item 999/);

  // Claimed items drop out of next; --claim takes the top pick.
  r = await rf("next", "--lane", "pc-lane", "--claim", "--json");
  assert.equal(r.code, 0, r.stderr);
  nx = JSON.parse(r.stdout);
  assert.equal(nx.item.id, "2");
  assert.equal(nx.claimed, true);

  r = await rf("status", "1", "building", "--note", "go");
  assert.equal(r.code, 0, r.stderr);

  r = await rf("ls", "--json", "--open");
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(
    rows.map((i) => i.id),
    ["1", "2"],
  );
  const one = rows.find((i) => i.id === "1");
  assert.equal(one.status, "building");
  assert.equal(one.claimedBy, "pc-lane");
  assert.deepEqual(one.links.branches, ["feat/1-acme"]);

  r = await rf("ls", "--status", "building");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Acme order screen/);
  assert.doesNotMatch(r.stdout, /invoice total/);

  r = await rf("next", "--lane", "pc-lane");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to pick/);

  r = await rf("item", "show", "1", "--json");
  assert.equal(JSON.parse(r.stdout).title, "Acme order screen");
  r = await rf("item", "show", "404");
  assert.equal(r.code, 1);
});

test("whoami and doctor do not fail hard", T, async () => {
  let r = await rf("whoami", "--json");
  assert.equal(r.code, 0, r.stderr);
  const w = JSON.parse(r.stdout);
  assert.equal(w.machine, "testbox");
  assert.equal(w.clone, "present");
  r = await rf("doctor");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /git/);
  assert.match(r.stdout, /gh/);
});

test("--quiet prints nothing on success", { timeout: 600000 }, async () => {
  const r = await rf("event", "note", "--text", "quiet note", "--quiet");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
});

// --- A3: sync, audit, bug file, story edits, generated mode --------------------------------------

import { mkdirSync, readFileSync } from "node:fs";

const REG_HEAD =
  "| ID | Title | Type | Priority | Status | Lane | Train | Gate | ETA | Links | Updated |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|\n";
const regRow = (id, status = "planned") =>
  `| ${id} | Acme register row ${id} | fix | P2 | ${status} | Mac mini lane | - | - | - | - | 2026-10-15 |`;
const OQ =
  "# Owner queue\n\n| # | Item | Register | Recommended answer | Why |\n|---|---|---|---|---|\n" +
  "| N1 · **ANSWERED 10-18 → D-2026-10-18-acme-say-no.md** | Acme sync question? | 201 | Yes. | W. |\n";

test("rf sync --dry plans, rf sync appends once, a second rf sync appends nothing", T, async () => {
  const specs = env.RF_SPECS_DIR;
  mkdirSync(join(specs, "register"), { recursive: true });
  mkdirSync(join(specs, "priorities"), { recursive: true });
  writeFileSync(join(specs, "register", "WORK-REGISTER.md"), `# R\n\n${REG_HEAD}${regRow(201)}\n`);
  writeFileSync(join(specs, "priorities", "OWNER-QUEUE.md"), OQ);
  git(specs, "add", "-A");
  git(specs, "commit", "--quiet", "-m", "register + queue");
  git(specs, "push", "--quiet");
  let r = await rf(
    "item",
    "new",
    "--title",
    "Acme sync question?",
    "--type",
    "decision",
    "--tags",
    "owner-queue,N1",
  );
  assert.equal(r.code, 0, r.stderr);
  const decisionId = /created item (\d+)/.exec(r.stdout)[1];

  r = await rf("sync", "--dry", "--json");
  assert.equal(r.code, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.equal(out.ran, true);
  assert.equal(out.dry, true);
  assert.deepEqual(out.events.map((e) => [e.kind, e.item]).sort(), [
    ["item.new", "201"],
    ["owner-decision", decisionId],
  ]);
  assert.equal(out.appended, 0);

  r = await rf("sync", "--json");
  assert.equal(r.code, 0, r.stderr);
  out = JSON.parse(r.stdout);
  assert.equal(out.appended, 2);
  assert.equal(out.pushed, true);
  r = await rf("sync", "--json");
  out = JSON.parse(r.stdout);
  assert.equal(out.ran, true);
  assert.equal(out.appended, 0);
  r = await rf("item", "show", "201", "--json");
  assert.equal(JSON.parse(r.stdout).title, "Acme register row 201");
});

test(
  "rf audit --json counts from events, or from a snapshot file / the last snapshot",
  T,
  async () => {
    let r = await rf("audit", "--json");
    assert.equal(r.code, 0, r.stderr);
    let a = JSON.parse(r.stdout);
    assert.equal(a.source, "events");
    const ls = JSON.parse((await rf("ls", "--json")).stdout);
    assert.equal(a.items.total, ls.length);
    assert.equal(a.items.byStatus.planned >= 1, true);
    assert.equal(a.ownerQueue.answered, 1);
    assert.equal(a.ownerQueue.open, 0);

    const snap = {
      generatedAt: "2026-10-19T12:00:00.000Z",
      items: [{ status: "planned" }, { status: "building" }, { status: "planned" }],
      alarms: [{ kind: "x" }, { kind: "x" }, { kind: "y" }],
      problems: ["1", "2"],
      ownerQueue: [{ state: "open" }, { state: "booked" }, { state: "open" }],
      answeredRecently: [{}, {}],
      prs: { open: [{ item: null }, { item: "3" }], merged: [{ item: null }] },
      bugs: [{ fix: "none" }, { fix: "merged" }, { fix: "none" }],
    };
    const file = join(tmp, "snap.json");
    writeFileSync(file, JSON.stringify(snap));
    r = await rf("audit", "--json", "--snapshot", file);
    assert.equal(r.code, 0, r.stderr);
    a = JSON.parse(r.stdout);
    assert.equal(a.source, "snapshot");
    assert.deepEqual(a.items.byStatus, { planned: 2, building: 1 });
    assert.deepEqual(a.alarms.byKind, { x: 2, y: 1 });
    assert.equal(a.alarms.total, 3);
    assert.equal(a.problems, 2);
    assert.deepEqual(a.ownerQueue, { open: 2, booked: 1, answered: 2 });
    assert.deepEqual(a.untrackedPrs, { open: 1, merged: 1 });
    assert.deepEqual(a.bugs.byFix, { none: 2, merged: 1 });

    mkdirSync(env.RF_OPS_HOME, { recursive: true });
    writeFileSync(join(env.RF_OPS_HOME, "last-snapshot.json"), JSON.stringify(snap));
    a = JSON.parse((await rf("audit", "--json")).stdout);
    assert.equal(a.source, "snapshot");
    r = await rf("audit");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /items by status/i);
    assert.match(r.stdout, /alarms by kind/i);
    rmSync(join(env.RF_OPS_HOME, "last-snapshot.json"));
  },
);

test(
  "rf bug file passes args through unchanged; only lead and coordinator may run it",
  T,
  async () => {
    const repo = join(tmp, "fake-repo");
    mkdirSync(join(repo, "scripts", "campaign"), { recursive: true });
    writeFileSync(
      join(repo, "scripts", "campaign", "bugs.mjs"),
      "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n" +
        "process.exit(process.argv.includes('--fail') ? 7 : 0);\n",
    );
    const withEnv =
      (extra) =>
      (...args) =>
        new Promise((res) => {
          execFile(
            process.execPath,
            [RF, ...args],
            { env: { ...env, RF_REPO_ROOT: repo, ...extra }, encoding: "utf8", timeout: 200000 },
            (err, stdout, stderr) =>
              res({
                code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
                stdout,
                stderr,
              }),
          );
        });
    const asLead = withEnv({ RF_LANE: "lead" });
    let r = await asLead(
      "bug",
      "file",
      "--title",
      "Acme total wrong",
      "--severity",
      "high",
      "--odd",
    );
    assert.equal(r.code, 0, r.stderr);
    const echoed = JSON.parse(r.stdout);
    assert.deepEqual(echoed.argv, [
      "file",
      "--title",
      "Acme total wrong",
      "--severity",
      "high",
      "--odd",
    ]);
    assert.match(echoed.cwd.replace(/\\/g, "/").toLowerCase(), /fake-repo$/);

    r = await withEnv({ RF_LANE: "coordinator" })("bug", "file", "--title", "x");
    assert.equal(r.code, 0, r.stderr);
    r = await asLead("bug", "file", "--fail");
    assert.equal(r.code, 7); // the script's exit code comes through

    r = await withEnv({ RF_LANE: "pc-lane" })("bug", "file", "--title", "x");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /one minter/i);
    assert.match(r.stderr, /lead/);
    assert.match(r.stderr, /coordinator/);
    assert.equal(r.stdout, "");
    r = await withEnv({ RF_LANE: "" })("bug", "file", "--title", "x");
    assert.equal(r.code, 1);
    r = await asLead("bug", "nope");
    assert.equal(r.code, 2);
  },
);

test("a story-field edit sends summaryDraft:false", T, async () => {
  let r = await rf("item", "edit", "1", "--problem", "Orders are slow", "--json");
  assert.equal(r.code, 0, r.stderr);
  const sent = JSON.parse(r.stdout).events[0].data.fields;
  assert.equal(sent.problem, "Orders are slow");
  assert.equal(sent.summaryDraft, false);
  r = await rf("item", "edit", "1", "--priority", "P1", "--json");
  assert.equal(JSON.parse(r.stdout).events[0].data.fields.summaryDraft, undefined);
});

test(
  "registerMode generated: rf writes events and a views-only commit; rf sync is off",
  T,
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rfops-cli-gen-"));
    try {
      const remote = join(dir, "remote.git");
      git(dir, "init", "--bare", "--quiet", "--initial-branch=main", remote);
      const specs = join(dir, "specs");
      git(dir, "clone", "--quiet", remote, specs);
      git(specs, "config", "user.name", "CLI Gen");
      git(specs, "config", "user.email", "gen@example.com");
      mkdirSync(join(specs, "ops"));
      writeFileSync(
        join(specs, "ops", "config.json"),
        JSON.stringify({ registerMode: "generated" }),
      );
      git(specs, "add", "-A");
      git(specs, "commit", "--quiet", "-m", "init");
      git(specs, "push", "--quiet", "-u", "origin", "main");
      const genEnv = {
        ...env,
        RF_OPS_HOME: join(dir, "home"),
        RF_SPECS_DIR: specs,
        RF_SPECS_REMOTE: remote,
      };
      const run = (...args) =>
        new Promise((res) => {
          execFile(
            process.execPath,
            [RF, ...args],
            { env: genEnv, encoding: "utf8", timeout: 200000 },
            (err, stdout, stderr) =>
              res({
                code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
                stdout,
                stderr,
              }),
          );
        });
      let r = await run("item", "new", "--title", "Acme generated item", "--type", "feature");
      assert.equal(r.code, 0, r.stderr);
      const check = join(dir, "check");
      git(dir, "clone", "--quiet", remote, check);
      const reg = readFileSync(join(check, "register", "WORK-REGISTER.md"), "utf8").replace(
        /\r\n/g,
        "\n",
      );
      assert.match(reg, /^<!-- ops:generated register v1 /);
      assert.match(reg, /Acme generated item/);
      const subs = git(check, "log", "--format=%s", "-3").split("\n").filter(Boolean);
      assert.match(subs[0], /^ops\(views\):/);
      assert.match(subs[1], /^ops\(testbox\): item\.new/);
      r = await run("sync", "--json");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { ran: false, reason: "generated" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
