// node --test cluster.test.mjs — contract tests for cluster.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { clusterBugs, parseCli, ratchetFilesFrom } from "./cluster.mjs";

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
  });
  assert.equal(out.status, 0);
  assert.deepEqual(JSON.parse(out.stdout).excluded, [{ row: "2", reason: "no context pack" }]);
});
