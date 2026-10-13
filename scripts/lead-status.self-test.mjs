#!/usr/bin/env node
// lead-status.self-test.mjs — offline self-test for scripts/lead-status.mjs.
// Stubs the exec layer and the local-assets reader; touches no network, no git, no disk.
//
//   node scripts/lead-status.self-test.mjs        (also: node scripts/lead-status.mjs --self-test)

import assert from "node:assert/strict";
import { runSections, exitCodeFor, renderText, ALL_SECTION_IDS } from "./lead-status.mjs";

const MASTER = "a".repeat(40);
const HEAD_OLD = "1".repeat(40);
const HEAD_NEW = "2".repeat(40);
const TRAIN_MERGED = "b".repeat(40);
const TRAIN_OPEN = "c".repeat(40);

const ok = (out) => ({ ok: true, out });
const fail = (error, code) => ({ ok: false, error, code });

// exec stub: exact "cmd args" match, or a [regex, result] fallback list.
function makeExec(table) {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in table) {
      const v = table[key];
      return typeof v === "function" ? v() : v;
    }
    for (const [k, v] of Object.entries(table)) {
      if (k.startsWith("/") && new RegExp(k.slice(1, k.lastIndexOf("/"))).test(key)) return v;
    }
    return fail(`unstubbed: ${key}`);
  };
}

function makeCtx({ table, files = {}, strict = false }) {
  return {
    exec: makeExec(table),
    readText: (name) => (name in files ? files[name] : null),
    repo: "najathakram/routeflow",
    boardIssue: 2554,
    opts: { strict },
  };
}

const GH_PRS = JSON.stringify([
  {
    number: 10,
    title: "feat: reviewed at old sha",
    headRefName: "feat/a",
    headRefOid: HEAD_NEW,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "master",
  },
  {
    number: 11,
    title: "feat: stacked and conflicting",
    headRefName: "feat/b",
    headRefOid: HEAD_OLD,
    isDraft: true,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    baseRefName: "feat/a",
  },
  {
    number: 12,
    title: "feat: nobody looked yet",
    headRefName: "feat/c",
    headRefOid: HEAD_OLD,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "master",
  },
]);

const VERDICTS = [
  {
    pr: 10,
    sha: HEAD_OLD,
    verdict: "PASS",
    reviewer: "opus",
    at: "2026-10-08T01:00:00Z",
    ref: "c1",
  },
  {
    pr: 11,
    sha: HEAD_OLD,
    verdict: "FAIL",
    reviewer: "opus",
    at: "2026-10-08T01:00:00Z",
    ref: "c2",
  },
  {
    pr: 11,
    sha: HEAD_OLD,
    verdict: "PASS-WITH-NITS",
    reviewer: "opus",
    at: "2026-10-08T02:00:00Z",
    ref: "c3",
  },
]
  .map((v) => JSON.stringify(v))
  .join("\n");

const MIG = "apps/api/prisma/migrations";
const baseTable = {
  "git ls-remote origin refs/heads/master": ok(`${MASTER}\trefs/heads/master\n`),
  "/gh pr list .*--state merged/": ok(
    JSON.stringify([
      { number: 3, title: "third" },
      { number: 2, title: "second" },
      { number: 1, title: "first" },
    ]),
  ),
  "gh repo view najathakram/routeflow --json visibility": ok('{"visibility":"PRIVATE"}'),
  "git ls-remote origin refs/heads/train/*": ok(
    `${TRAIN_MERGED}\trefs/heads/train/w1\n${TRAIN_OPEN}\trefs/heads/train/w2\n`,
  ),
  [`git merge-base --is-ancestor ${TRAIN_MERGED} origin/master`]: ok(""),
  [`git merge-base --is-ancestor ${TRAIN_OPEN} origin/master`]: fail("", 1),
  "/gh pr list .*--state open --json number,title/": ok(GH_PRS),
  [`git ls-tree origin/master ${MIG}/`]: ok(
    `040000 tree x1\t${MIG}/20260101_a\n040000 tree x2\t${MIG}/20260102_b\n100644 blob x3\t${MIG}/migration_lock.toml\n`,
  ),
  "/gh pr list .*--state open --json number$/": ok('[{"number":10},{"number":11}]'),
  "gh pr diff 10 --name-only": ok(`${MIG}/20260103_c/migration.sql\napps/web/x.ts\n`),
  "gh pr diff 11 --name-only": ok(`apps/web/y.ts\n`),
};

const BRANCHES = JSON.stringify([
  { machine: "pc", branch: "feat/found", sha: "d".repeat(40), expectOnOrigin: true, note: "" },
  { machine: "pc", branch: "feat/moved", sha: "e".repeat(40), expectOnOrigin: true, note: "" },
  { machine: "pc", branch: "feat/gone", sha: "f".repeat(40), expectOnOrigin: true, note: "" },
  { machine: "mini", branch: "feat/local", sha: "9".repeat(40), expectOnOrigin: false, note: "" },
  {
    machine: "mini",
    branch: "feat/surprise",
    sha: "8".repeat(40),
    expectOnOrigin: false,
    note: "",
  },
]);
const branchTable = {
  "git ls-remote origin refs/heads/feat/found": ok(`${"d".repeat(40)}\trefs/heads/feat/found\n`),
  "git ls-remote origin refs/heads/feat/moved": ok(`${"7".repeat(40)}\trefs/heads/feat/moved\n`),
  "git ls-remote origin refs/heads/feat/gone": ok(""),
  "git ls-remote origin refs/heads/feat/local": ok(""),
  "git ls-remote origin refs/heads/feat/surprise": ok(
    `${"8".repeat(40)}\trefs/heads/feat/surprise\n`,
  ),
};

const FILES = {
  "verdicts.jsonl": VERDICTS,
  "branches.json": BRANCHES,
  "prod-migrations.json": JSON.stringify({
    recordedAt: "2026-10-08T00:00:00Z",
    sittingRef: "sitting-1",
    folders: ["20260101_a", "20260199_prod_only"],
  }),
};

const byId = (sections, id) => sections.find((s) => s.id === id);
const text = (s) => s.lines.join("\n");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.stack || err}`);
    process.exitCode = 1;
  }
}

await test("master: sha and last 3 merged subjects", async () => {
  const s = byId(await runSections(["master"], makeCtx({ table: baseTable })), "master");
  assert.equal(s.status, "OK");
  assert.match(text(s), new RegExp(MASTER));
  assert.match(text(s), /#3 third/);
  assert.match(text(s), /#1 first/);
});

await test("visibility: PRIVATE is quiet, PUBLIC prints banner + runner minter note", async () => {
  const priv = byId(await runSections(["visibility"], makeCtx({ table: baseTable })), "visibility");
  assert.doesNotMatch(text(priv), /PUBLIC/);
  const pub = byId(
    await runSections(
      ["visibility"],
      makeCtx({
        table: {
          ...baseTable,
          "gh repo view najathakram/routeflow --json visibility": ok('{"visibility":"PUBLIC"}'),
        },
      }),
    ),
    "visibility",
  );
  assert.match(text(pub), /\*\*\* REPO IS PUBLIC \*\*\*/);
  assert.match(text(pub), /runner minter must be off/);
});

await test("trains: merged vs not merged, unknown object", async () => {
  const s = byId(await runSections(["trains"], makeCtx({ table: baseTable })), "trains");
  assert.match(text(s), /train\/w1.*merged into master/);
  assert.match(text(s), /train\/w2.*NOT merged/);
  const u = byId(
    await runSections(
      ["trains"],
      makeCtx({
        table: {
          ...baseTable,
          [`git merge-base --is-ancestor ${TRAIN_OPEN} origin/master`]: fail("bad object", 128),
        },
      }),
    ),
    "trains",
  );
  assert.equal(u.status, "UNKNOWN");
});

await test("prs: verdict at an old sha is STALE; none is NO VERDICT; latest verdict wins", async () => {
  const s = byId(await runSections(["prs"], makeCtx({ table: baseTable, files: FILES })), "prs");
  const t = text(s);
  assert.match(t, /#10[^\n]*STALE[^\n]*PASS/);
  assert.match(t, /#11[^\n]*PASS-WITH-NITS/);
  assert.doesNotMatch(t, /#11[^\n]*FAIL/);
  assert.match(t, /#12[^\n]*NO VERDICT/);
  assert.match(t, /#11[^\n]*draft[^\n]*conflicting[^\n]*stacked:feat\/a/);
  assert.equal(s.status, "STALE");
});

await test("prs: missing verdicts file -> UNKNOWN", async () => {
  const s = byId(await runSections(["prs"], makeCtx({ table: baseTable })), "prs");
  assert.equal(s.status, "UNKNOWN");
  assert.match(text(s), /UNKNOWN: .*verdicts\.jsonl/);
});

await test("ledger: FOUND / MOVED / MISSING / LOCAL-ONLY / now on origin", async () => {
  const files = { ...FILES, "branches.json": BRANCHES };
  const s = byId(
    await runSections(["ledger"], makeCtx({ table: { ...baseTable, ...branchTable }, files })),
    "ledger",
  );
  const t = text(s);
  assert.match(t, /feat\/found[^\n]*FOUND/);
  assert.match(t, /feat\/moved[^\n]*MOVED/);
  assert.match(t, /feat\/gone[^\n]*MISSING/);
  assert.match(t, /LOCAL-ONLY on mini @9{7,}[^\n]*\(not verifiable from here\)/);
  assert.match(t, /feat\/surprise[^\n]*now on origin/);
  assert.equal(s.status, "STALE");
});

await test("migrations: all three diff directions + carrying PRs", async () => {
  const s = byId(
    await runSections(["migrations"], makeCtx({ table: baseTable, files: FILES })),
    "migrations",
  );
  const t = text(s);
  assert.match(t, /in prod, not on master[\s\S]*20260199_prod_only/);
  assert.match(t, /on master, not in prod[\s\S]*DANGER[\s\S]*20260102_b/);
  assert.match(t, /pending in open PRs[\s\S]*20260103_c[^\n]*#10/);
  assert.doesNotMatch(t, /migration_lock/);
});

await test("migrations: --prod only prints the read-only command", async () => {
  const calls = [];
  const ctx = makeCtx({ table: baseTable, files: FILES });
  const inner = ctx.exec;
  ctx.exec = async (cmd, args) => (calls.push(cmd), inner(cmd, args));
  ctx.opts.prod = true;
  const s = byId(await runSections(["migrations"], ctx), "migrations");
  assert.match(
    text(s),
    /railway run --service postgres node apps\/api\/scripts\/schema-drift\.mjs/,
  );
  assert.match(text(s), /NOT run/);
  assert.ok(!calls.includes("railway"), "railway must never be executed");
});

await test("board: last 5 comments", async () => {
  const mk = (id) => ({ id, created_at: `2026-10-08T0${id % 10}:00:00Z`, body: `comment ${id}` });
  const s = byId(
    await runSections(
      ["board"],
      makeCtx({
        table: {
          "gh api repos/najathakram/routeflow/issues/2554": ok('{"comments":7}'),
          "gh api repos/najathakram/routeflow/issues/2554/comments?per_page=5&page=2": ok(
            JSON.stringify([mk(6), mk(7)]),
          ),
          "gh api repos/najathakram/routeflow/issues/2554/comments?per_page=5&page=1": ok(
            JSON.stringify([mk(1), mk(2), mk(3), mk(4), mk(5)]),
          ),
        },
      }),
    ),
    "board",
  );
  const t = text(s);
  assert.match(t, /comment 7/);
  assert.match(t, /comment 3/);
  assert.doesNotMatch(t, /comment 2\b/);
});

await test("gh missing: every gh section UNKNOWN, exit 0 (3 under --strict)", async () => {
  // Wrap exec so any gh invocation fails like a missing binary.
  const ctx = makeCtx({ table: { ...baseTable, ...branchTable }, files: FILES });
  const inner = ctx.exec;
  ctx.exec = async (cmd, args) => (cmd === "gh" ? fail("spawn gh ENOENT") : inner(cmd, args));
  const sections = await runSections(["master", "visibility", "prs", "migrations", "board"], ctx);
  for (const id of ["master", "visibility", "prs", "migrations", "board"]) {
    assert.equal(byId(sections, id).status, "UNKNOWN", `${id} should be UNKNOWN`);
  }
  assert.match(renderText(sections), /UNKNOWN: spawn gh ENOENT/);
  assert.equal(exitCodeFor(sections, false), 0);
  assert.equal(exitCodeFor(sections, true), 3);
});

await test("strict: clean run exits 0", async () => {
  const sections = await runSections(
    ["master", "visibility", "trains"],
    makeCtx({ table: baseTable }),
  );
  assert.equal(exitCodeFor(sections, true), 0);
});

await test("zero sections configured is an error, never a silent pass", async () => {
  await assert.rejects(() => runSections([], makeCtx({ table: baseTable })), /no sections/i);
  await assert.rejects(
    () => runSections(["nope"], makeCtx({ table: baseTable })),
    /unknown section/i,
  );
});

await test("section ids are stable", () => {
  assert.deepEqual(ALL_SECTION_IDS, [
    "master",
    "visibility",
    "trains",
    "prs",
    "ledger",
    "migrations",
  ]);
});

console.log(`\n${passed} passed${process.exitCode ? ", with FAILURES" : ""}`);
