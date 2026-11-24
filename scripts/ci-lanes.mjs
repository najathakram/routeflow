#!/usr/bin/env node
/**
 * CI lanes (SA-1250). The ONE home of how ci.yml's Verify is split into parallel lanes.
 *
 *   node scripts/ci-lanes.mjs --list <id>     the spec files (or workspaces) the lane runs
 *   node scripts/ci-lanes.mjs --run <id>      run one lane (what ci.yml's `lanes` matrix calls)
 *   node scripts/ci-lanes.mjs --parity        every spec today's single Verify runs is in exactly ONE lane
 *
 * Until PR-2 lands this is the lane table and the parity check only; the ci.yml matrix that runs the lanes, and
 * its pin to LANES, come with PR-2. `chain` will be the old single job: `npm run verify` with RF_VERIFY_LANE=static
 * (CI only; scripts/verify-turbo.mjs plans only check-types + lint). A new lane is one row here plus one matrix entry.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "@routeflow/api";
const TURBO_TEST = [
  "turbo",
  "run",
  "test",
  "--concurrency=2",
  "--continue=dependencies-successful",
];

/** `jest` = a jest config of apps/api (null = package.json's), `shard` = k/n; `turbo` = filters of a turbo `test`. */
export const LANES = [
  { id: "chain", workspaces: [] },
  ...[1, 2, 3].map((k) => ({
    id: `api-unit-${k}/3`,
    workspaces: [API],
    jest: { config: null, shard: `${k}/3` },
  })),
  { id: "api-scripts", workspaces: [API], jest: { config: "jest.scripts.config.js" } },
  { id: "api-repo-truth", workspaces: [API], jest: { config: "jest.repo-truth.config.js" } },
  { id: "web", workspaces: ["@routeflow/web"], turbo: ["@routeflow/web"] },
  {
    id: "mobile+packages",
    workspaces: [
      "@routeflow/mobile",
      "@routeflow/pricing",
      "@routeflow/returns",
      "@routeflow/scanning",
    ],
    turbo: ["@routeflow/mobile", "@routeflow/pricing", "@routeflow/returns", "@routeflow/scanning"],
  },
];

/** Workspaces whose `test` the single Verify skips (their own workflow, control.yml). */
const OWN_WORKFLOW = ["@routeflow/control"];

/**
 * api spec files that exist but are NOT in today's Verify on purpose (run by test:db / test:smtp). Derived from
 * those two configs' own `testRegex`, never typed, so the list moves only with the configs (SA-1250 A1-3 a).
 */
const requireCfg = createRequire(import.meta.url);
// Literal paths, so a script scanner can follow the load (a computed require reads as a hidden DB client).
export const NOT_IN_VERIFY = [
  requireCfg("../apps/api/jest.db.config.js"),
  requireCfg("../apps/api/jest.smtp.config.js"),
].map((cfg) => new RegExp(cfg.testRegex));

// -- parity ----------------------------------------------------------------------------------------
/** expected: [file]; lanes: { id: [file] }. Red when a file is in zero lanes, two lanes, or a lane lists an unexpected one. */
export function parityCheck({ expected, lanes, excluded = [] }) {
  const where = new Map();
  for (const [id, files] of Object.entries(lanes))
    for (const f of new Set(files)) where.set(f, [...(where.get(f) ?? []), id]);
  const want = new Set(expected);
  const problems = [];
  for (const f of want) if (!where.has(f)) problems.push(`in NO lane: ${f}`);
  for (const [f, ids] of where) {
    if (ids.length > 1) problems.push(`in ${ids.length} lanes (${ids.join(", ")}): ${f}`);
    if (!want.has(f))
      problems.push(`lane ${ids.join(", ")} lists a file Verify does not expect: ${f}`);
  }
  // R-24 M1: a file the db/smtp exclusion matches is outside Verify by definition. If a lane runs it, or the expected
  // set lists it, a config was widened and the exclusion now hides real specs: fail, naming the file.
  for (const f of new Set([...want, ...where.keys()]))
    if (excluded.some((r) => r.test(f)))
      problems.push(
        `matched by NOT_IN_VERIFY yet expected or run by a lane (widened db/smtp config?): ${f}`,
      );
  return { ok: problems.length === 0, problems };
}

// -- jest / turbo plumbing (CLI only) --------------------------------------------------------------
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const apiDir = path.join(ROOT, "apps", "api");
const jestBin = () => createRequire(path.join(apiDir, "package.json")).resolve("jest/bin/jest");

function jestArgs(lane, extra = []) {
  const { config, shard } = lane.jest;
  return [...(config ? ["-c", config] : []), ...(shard ? [`--shard=${shard}`] : []), ...extra];
}
function listApi(jest) {
  const r = spawnSync(process.execPath, [jestBin(), ...jestArgs({ jest }, ["--listTests"])], {
    cwd: apiDir,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0)
    throw new Error(`jest --listTests failed (${JSON.stringify(jest)}): ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map(rel).sort();
}
const base = { config: null };

/** Each api lane's files. api-repo-truth lists only what the shards do not already run (they overlap by design). */
function apiLaneFiles() {
  const lanes = {};
  for (const l of LANES.filter((x) => x.jest)) lanes[l.id] = listApi(l.jest);
  const inShards = new Set(
    Object.entries(lanes)
      .filter(([id]) => id.startsWith("api-unit"))
      .flatMap(([, f]) => f),
  );
  lanes["api-repo-truth"] = lanes["api-repo-truth"].filter((f) => !inShards.has(f));
  return lanes;
}

function runParity() {
  const git = spawnSync("git", ["ls-files", "apps/api/src"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const specFiles = git.stdout.split(/\r?\n/).filter((f) => /\.(spec|test)\.[cm]?[tj]sx?$/.test(f));
  const census = specFiles.filter((f) => !NOT_IN_VERIFY.some((r) => r.test(f)));
  const excludedCount = specFiles.length - census.length;
  const expected = [
    ...new Set([
      ...listApi(base),
      ...listApi({ config: "jest.scripts.config.js" }),
      ...listApi({ config: "jest.repo-truth.config.js" }),
      ...census,
    ]),
  ];
  const lanes = apiLaneFiles();
  const res = parityCheck({ expected, lanes, excluded: NOT_IN_VERIFY });
  const covered = new Set(LANES.flatMap((l) => l.workspaces));
  const tested = [];
  for (const dir of ["apps", "packages"])
    for (const p of spawnSync("git", ["ls-files", `${dir}/*/package.json`], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .stdout.split(/\r?\n/)
      .filter(Boolean)) {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
      if (pkg.scripts?.test && !OWN_WORKFLOW.includes(pkg.name)) tested.push(pkg.name);
    }
  for (const w of tested)
    if (!covered.has(w)) res.problems.push(`workspace ${w} has a test script and no lane`);
  const ok = res.problems.length === 0;
  console.log(
    `ci-lanes parity: ${expected.length} api spec files, ${Object.keys(lanes).length} api lanes, ${tested.length} workspaces with tests; ${excludedCount} spec files outside Verify by the db/smtp configs`,
  );
  for (const [id, f] of Object.entries(lanes)) console.log(`  ${id}: ${f.length} files`);
  for (const p of res.problems) console.error(`PARITY FAIL: ${p}`);
  return ok ? 0 : 1;
}

function spawnLane(cmd, args, cwd, env = {}) {
  console.log(`ci-lanes: ${cmd} ${args.join(" ")} (cwd ${rel(cwd) || "."})`);
  const shell = process.platform === "win32";
  return (
    spawnSync(cmd, args, { cwd, stdio: "inherit", shell, env: { ...process.env, ...env } })
      .status ?? 1
  );
}

function runLane(id) {
  const lane = LANES.find((l) => l.id === id);
  if (!lane) throw new Error(`unknown lane ${id}; known: ${LANES.map((l) => l.id).join(", ")}`);
  if (id === "chain")
    throw new Error("chain is `npm run verify` with RF_VERIFY_LANE=static (ci.yml)");
  if (lane.turbo) {
    const filters = lane.turbo.map((w) => `--filter=${w}`);
    return spawnLane("npx", [...TURBO_TEST, ...filters, "--", "--maxWorkers=2"], ROOT);
  }
  // api lanes call jest directly: turbo's `test` would also run the other api lane. Build its deps first, as turbo does.
  const built = spawnLane("npx", ["turbo", "run", "build", `--filter=${API}^...`], ROOT);
  if (built !== 0) return built;
  const args = [jestBin(), ...jestArgs(lane, ["--maxWorkers=2"])];
  if (id === "api-repo-truth") {
    const files = apiLaneFiles()["api-repo-truth"].map((f) => path.join(ROOT, f));
    if (!files.length) return 0;
    args.push("--runTestsByPath", ...files);
  }
  return spawnLane(process.execPath, args, apiDir, {
    RF_CAMPAIGN_RUN_ID: process.env.RF_CAMPAIGN_RUN_ID || randomUUID(),
  });
}

function main() {
  const [flag, arg] = process.argv.slice(2);
  if (flag === "--parity") process.exit(runParity());
  if (flag === "--run") process.exit(runLane(arg));
  if (flag === "--list") {
    const lane = LANES.find((l) => l.id === arg);
    if (!lane) throw new Error(`unknown lane ${arg}`);
    const out = lane.jest ? apiLaneFiles()[arg] : lane.workspaces;
    console.log(out.join("\n"));
    return;
  }
  console.error("usage: ci-lanes.mjs --list <id> | --run <id> | --parity");
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
