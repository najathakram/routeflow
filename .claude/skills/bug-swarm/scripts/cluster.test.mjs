// node --test cluster.test.mjs — contract tests for cluster.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scrubbedGitEnv } from "../../../../scripts/lib/check-git-hooks.mjs";
import {
  clusterBugs,
  parseCli,
  ratchetFilesFrom,
  resolveIdInSpace,
  workspaceOf,
  titlesMatch,
} from "./cluster.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(path.join(here, "fixtures", n), "utf8"));
const bug = (row, files, extra = {}) => ({
  row,
  risk: "LOW",
  status: "live",
  files,
  needsDb: false,
  ui: false,
  ...extra,
});

test("bugs sharing a file land in one cluster; files are sorted and unique", () => {
  const { clusters } = clusterBugs({
    bugs: [bug("2", ["a/x.ts", "a/y.ts"]), bug("1", ["a/y.ts", "a/z.ts"]), bug("3", ["a/z.ts"])],
  });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].files, ["a/x.ts", "a/y.ts", "a/z.ts"]);
  assert.deepEqual(
    clusters[0].bugs.map((b) => b.row),
    ["1", "2", "3"],
  );
});

test("disjoint bugs stay separate with deterministic ids c1..", () => {
  const m = { bugs: [bug("20", ["apps/web/b.ts"]), bug("10", ["apps/web/a.ts"])] };
  const r1 = clusterBugs(m);
  const r2 = clusterBugs({ bugs: [...m.bugs].reverse() });
  assert.deepEqual(r1, r2);
  assert.deepEqual(
    r1.clusters.map((c) => [c.id, c.bugs[0].row]),
    [
      ["c1", "10"],
      ["c2", "20"],
    ],
  );
});

test("W-ids sort after numeric rows", () => {
  const { clusters } = clusterBugs({ bugs: [bug("W-5", ["a.ts"]), bug("9", ["b.ts"])] });
  assert.deepEqual(
    clusters.map((c) => c.bugs[0].row),
    ["9", "W-5"],
  );
});

test("HIGH, fixed-on-master, unclear and no-files bugs are excluded with reasons", () => {
  const { clusters, excluded } = clusterBugs({
    bugs: [
      bug("1", ["a.ts"]),
      bug("2", ["b.ts"], { risk: "HIGH" }),
      bug("3", ["c.ts"], { status: "fixed-on-master" }),
      bug("4", ["d.ts"], { status: "unclear" }),
      bug("5", []),
      bug("6", ["e.ts"], { sub: "b" }),
    ],
  });
  assert.equal(clusters.length, 2);
  assert.deepEqual(
    excluded.map((e) => e.row),
    ["2", "3", "4", "5"],
  );
  assert.match(excluded[0].reason, /HIGH/);
  assert.match(excluded[1].reason, /fixed-on-master/);
  assert.match(excluded[2].reason, /unclear/);
  assert.match(excluded[3].reason, /no files/);
});

test("a ratchet file marks its cluster extractionFirst; needsDb and ui are any()", () => {
  const { clusters } = clusterBugs(
    {
      bugs: [
        bug("1", ["apps/api/src/orders/orders.service.ts"], { needsDb: true }),
        bug("2", ["apps/web/x.tsx"], { ui: true }),
      ],
    },
    { ratchetFiles: ["apps/api/src/orders/orders.service.ts"] },
  );
  assert.equal(clusters[0].extractionFirst, true);
  assert.equal(clusters[0].needsDb, true);
  assert.equal(clusters[1].extractionFirst, false);
  assert.equal(clusters[1].ui, true);
  assert.deepEqual(clusters[1].workspaces, ["apps/web"]);
});

test("over maxClusters merges the smallest into the closest same-workspace cluster", () => {
  const { clusters, overCap } = clusterBugs(
    {
      bugs: [
        bug("1", ["apps/web/app/orders/a.tsx"]),
        bug("2", ["apps/web/app/orders/b.tsx"]),
        bug("3", ["apps/web/app/invoices/c.tsx"]),
        bug("4", ["apps/mobile/app/d.tsx"]),
      ],
    },
    { maxClusters: 3 },
  );
  assert.equal(clusters.length, 3);
  assert.equal(overCap, undefined);
  const merged = clusters.find((c) => c.bugs.length === 2);
  assert.deepEqual(merged.bugs.map((b) => b.row).sort(), ["1", "2"]);
});

test("cannot merge across workspaces: keeps the first N, parks the rest, sets overCap", () => {
  const r = clusterBugs(
    {
      bugs: [
        bug("1", ["apps/web/a.ts"]),
        bug("2", ["apps/mobile/b.ts"]),
        bug("3", ["apps/api/c.ts"]),
      ],
    },
    { maxClusters: 2 },
  );
  assert.equal(r.clusters.length, 2);
  assert.equal(r.overCap, true);
  assert.equal(r.parked.length, 1);
  assert.equal(r.parked[0].reason, "over cap 2");
  assert.equal(r.parked[0].cluster.bugs[0].row, "3");
  assert.equal(r.parked[0].cluster.id, "c3");
});

test("avoidFiles excludes any bug touching an avoided file", () => {
  const { clusters, excluded } = clusterBugs(
    { bugs: [bug("1", ["a.ts", "b.ts"]), bug("2", ["c.ts"])] },
    { avoidFiles: ["b.ts"] },
  );
  assert.equal(clusters.length, 1);
  assert.deepEqual(excluded, [{ row: "1", reason: "touches avoided file b.ts" }]);
});

test("rows requested but in neither bugs nor excluded are unaccounted", () => {
  const r = clusterBugs(
    { bugs: [bug("1", ["a.ts"]), bug("2", [], {})], excluded: [{ row: "7, 8", why: "x" }] },
    { requestedRows: ["1", "2", "7", "9", "W-3"] },
  );
  assert.deepEqual(r.unaccounted, ["9", "W-3"]);
  assert.equal(clusterBugs({ bugs: [] }).unaccounted, undefined);
});

test("parseCli reads --max, repeatable --avoid, --rows, --write and the manifest path", () => {
  const o = parseCli([
    "m.json",
    "--max",
    "3",
    "--avoid",
    "x",
    "--avoid",
    "y",
    "--rows",
    "1,2",
    "--write",
  ]);
  assert.deepEqual(o, {
    file: "m.json",
    write: true,
    maxClusters: 3,
    avoidFiles: ["x", "y"],
    requestedRows: ["1", "2"],
  });
  assert.throws(() => parseCli(["m.json", "--max", "zero"]), /--max/);
});

test("run 1 manifest (14 rows, disjoint files) fits maxClusters 4 or flags overCap", () => {
  const r = clusterBugs(fixture("manifest-run1.json"), { maxClusters: 4 });
  assert.ok(r.clusters.length <= 4 || r.overCap === true);
  assert.ok(r.excluded.some((e) => e.row === "182" && e.sub === "c"));
  const ids = r.clusters.map((c) => c.id);
  assert.deepEqual(
    ids,
    ids.map((_, i) => `c${i + 1}`),
  );
});

test("run 2 manifest: three LOW web bugs, one file each, three clusters", () => {
  const r = clusterBugs(fixture("manifest-run2.json"));
  assert.equal(r.excluded.length, 0);
  assert.equal(r.clusters.length, 3);
  assert.deepEqual(r.clusters[0].workspaces, ["apps/web"]);
});

test("ratchetFilesFrom reads BASELINE keys from the real spec shape", () => {
  const spec = `const HEADROOM = 5;
const BASELINE: Record<string, number> = {
  // a comment mentioning "apps/api/src/not-a-key.ts": 12 inside prose
  "apps/api/src/orders/orders.service.ts": 5325, // B297 PR3: moved (was 5345)
  "apps/web/app/(dashboard)/orders/page.tsx": 900,
};
it("x", () => { expect("apps/api/src/other.ts": 1) });
`;
  assert.deepEqual(ratchetFilesFrom(spec), [
    "apps/api/src/orders/orders.service.ts",
    "apps/web/app/(dashboard)/orders/page.tsx",
  ]);
  assert.deepEqual(ratchetFilesFrom("nothing here"), []);
});

test("triage exclusions are carried into excluded (one per row) and requested rows are accounted", () => {
  const r = clusterBugs(
    { bugs: [bug("1", ["a.ts"])], excluded: [{ row: "7, 8", why: "x" }] },
    { requestedRows: ["1", "7", "8"] },
  );
  assert.deepEqual(r.excluded, [
    { row: "7", reason: "x", source: "triage" },
    { row: "8", reason: "x", source: "triage" },
  ]);
  assert.deepEqual(r.unaccounted, []);
  // a re-run over a --write'n manifest does not duplicate them
  const again = clusterBugs(
    { bugs: [bug("1", ["a.ts"])], excluded: r.excluded },
    { requestedRows: ["1", "7", "8", "9"] },
  );
  assert.equal(again.excluded.length, 2);
  assert.deepEqual(again.unaccounted, ["9"]);
});

test("--packs: a bug without pack-<row>.md next to the manifest is excluded as no context pack", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cl-packs-"));
  writeFileSync(path.join(dir, "pack-1.md"), "pack");
  const packExists = (row) => existsSync(path.join(dir, `pack-${row}.md`));
  const r = clusterBugs({ bugs: [bug("1", ["a.ts"]), bug("2", ["b.ts"])] }, { packExists });
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.excluded, [{ row: "2", reason: "no context pack" }]);
  assert.equal(parseCli(["m.json", "--packs"]).packs, true);
  assert.equal(parseCli(["m.json"]).packs, undefined);
  // CLI: resolves the pack dir from the manifest's directory.
  const mf = path.join(dir, "manifest.json");
  writeFileSync(mf, JSON.stringify({ bugs: [bug("1", ["a.ts"]), bug("2", ["b.ts"])] }));
  const out = spawnSync(process.execPath, [path.join(here, "cluster.mjs"), mf, "--packs"], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
  assert.equal(out.status, 0);
  assert.deepEqual(JSON.parse(out.stdout).excluded, [{ row: "2", reason: "no context pack" }]);
});

test("titlesMatch: whitespace/case-insensitive, prefix of 40 chars, truncation marks ignored", () => {
  assert.ok(
    titlesMatch("Settings  Business NAME never saves", "settings business name never saves"),
  );
  const long = "BUG P2: Settings > Business profile > Business Name never saves: toast shows";
  assert.ok(titlesMatch(long, `${long.slice(0, 50)}...`));
  assert.ok(!titlesMatch("Parked sales label", "Customer invoice email"));
  assert.ok(!titlesMatch("", "x"));
  assert.ok(!titlesMatch("x", ""));
});

test("resolveId (injected): non-zero, unparsable, empty title and mismatch are unaccounted with a reason", () => {
  const titles = { 1: "Parked sales label", 2: "Other thing" };
  const resolveId = (id) => {
    if (id === "3") return { ok: false, reason: "not found in row: resolver exited non-zero" };
    if (id === "4") return { ok: false, reason: "not found in row: rf.mjs output unparsable" };
    return titles[id]
      ? { ok: true, title: titles[id] }
      : { ok: false, reason: "not found in row: empty title" };
  };
  const mk = (row, title) => ({ ...bug(row, [`f${row}.ts`]), resolvedTitle: title });
  const r = clusterBugs(
    {
      bugs: [
        mk("1", "parked sales  label"),
        mk("2", "Wrong title"),
        mk("3", "x"),
        mk("4", "x"),
        mk("5", "x"),
      ],
    },
    { resolveId, requestedRows: ["1", "2", "3", "4", "5"] },
  );
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.clusters[0].bugs, [{ row: "1" }]);
  assert.deepEqual(
    r.unresolved.map((u) => u.row),
    ["2", "3", "4", "5"],
  );
  assert.match(r.unresolved[0].reason, /title mismatch/);
  assert.deepEqual([...r.unaccounted].sort(), ["2", "3", "4", "5"]);
  assert.deepEqual(r.excluded, []);
});

test("resolveIdInSpace builds the row and bug commands without a shell, with a scrubbed env", () => {
  const seen = [];
  const exec = (cmd, args, opts) => {
    seen.push({ cmd, args, opts });
    return args.includes("--json")
      ? JSON.stringify({ title: "T row" })
      : "---\nid: B302\ntitle: T bug\n---\n";
  };
  const row = resolveIdInSpace({ space: "row", id: "W-652", repo: "/r", exec });
  assert.deepEqual(row, { ok: true, title: "T row" });
  assert.equal(seen[0].cmd, process.execPath);
  assert.deepEqual(seen[0].args.slice(1), ["item", "show", "W-652", "--json"]);
  assert.match(seen[0].args[0].split(path.sep).join("/"), /tools\/ops-monitor\/bin\/rf\.mjs$/);
  assert.equal(seen[0].opts.env.GIT_DIR, undefined);
  const bugR = resolveIdInSpace({ space: "bug", id: "B302", repo: "/r", exec });
  assert.deepEqual(bugR, { ok: true, title: "T bug" });
  assert.deepEqual(seen[1].args.slice(1), ["show", "B302"]);
  const bad = resolveIdInSpace({
    space: "row",
    id: "9",
    repo: "/r",
    exec: () => {
      throw new Error("exit 1");
    },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not found in row/);
});

test("resolveIdInSpace against the real rf.mjs: an id that does not exist is unresolved", () => {
  const repo = path.resolve(here, "../../../..");
  const r = resolveIdInSpace({ space: "row", id: "999999999", repo });
  assert.equal(r.ok, false);
});

test("parseCli reads --id-space and --repo", () => {
  const o = parseCli(["m.json", "--id-space", "bug", "--repo", "/x"]);
  assert.equal(o.idSpace, "bug");
  assert.equal(o.repo, "/x");
  assert.throws(() => parseCli(["m.json", "--id-space", "other"]));
});

test("titlesMatch decodes HTML entities and folds the angle quotes (run 4: row 302 &gt; vs ›)", () => {
  assert.ok(titlesMatch("Settings &gt; Business &amp; profile", "Settings › Business & profile"));
  assert.ok(
    titlesMatch("A &#39;quoted&#39; &quot;x&quot; &lt;b&gt; &#x3E;", "A 'quoted' \"x\" <b> >"),
  );
  assert.ok(titlesMatch("Back » Next", "Back &gt; Next"));
  assert.ok(!titlesMatch("A &gt; B", "A < B"));
});

test("resolveIdInSpace uses the scripts' own checkout first, --repo only as a fallback", () => {
  const seen = [];
  const exec = (cmd, args) => (seen.push(args[0]), JSON.stringify({ title: "T" }));
  const own = path.resolve("/own/checkout");
  const stale = path.resolve("/stale/main");
  const has = (p) => p.startsWith(own);
  resolveIdInSpace({ space: "row", id: "1", repo: stale, exec, ownRoot: own, exists: has });
  assert.equal(seen[0], path.join(own, "tools/ops-monitor/bin/rf.mjs"));
  resolveIdInSpace({ space: "row", id: "1", repo: stale, exec, ownRoot: own, exists: () => false });
  assert.equal(seen[1], path.join(stale, "tools/ops-monitor/bin/rf.mjs"));
  resolveIdInSpace({
    space: "bug",
    id: "B1",
    repo: stale,
    exec: () => "title: T",
    ownRoot: own,
    exists: has,
  });
});

test("a failing resolver puts the first 200 chars of its stderr in the reason", () => {
  const exec = () => {
    const e = new Error("exit 1");
    e.stderr = Buffer.from(`cannot find module ${"x".repeat(400)}`);
    throw e;
  };
  const r = resolveIdInSpace({ space: "row", id: "1", repo: "/r", exec });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot find module x+/);
  assert.ok(r.reason.length < 300);
});

test("workspaceOf: outside apps/* and packages/* the key is the top-level dir, or the file name at the root", () => {
  assert.equal(workspaceOf("tools/ops-monitor/bin/rf.mjs"), "tools");
  assert.equal(workspaceOf("docker-compose.yml"), "docker-compose.yml");
  assert.equal(workspaceOf("scripts/lib/x.mjs"), "scripts");
  assert.equal(workspaceOf("apps/api/src/a.ts"), "apps/api");
});

test("run 4 shape: a root docker-compose change and a tools/ change are never merged by the cap", () => {
  const r = clusterBugs(
    {
      bugs: [
        bug("599", ["docker-compose.yml", "apps/api/src/a.ts"]),
        bug("W-652", ["tools/ops-monitor/x.mjs"]),
      ],
    },
    { maxClusters: 1 },
  );
  assert.equal(r.overCap, true);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.parked.length, 1);
});
