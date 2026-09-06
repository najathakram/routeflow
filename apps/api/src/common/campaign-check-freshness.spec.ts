import { spawnSync, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// campaign-check freshness guard — pins the T1/T2/T3 (F01–F09) requirements from
// .claude/pipeline/2026-09-06-campaign-check-freshness/spec.md: a `.campaign/runs/<ws>.json`
// report older than the newest commit touching its workspace's tests or the ledger shards must
// refuse BEFORE any REG-token scan (full mode), and `--freshness-only` must predict the same
// outcome cheaply via `turbo run test --dry-run=json` before the real jest/turbo pass runs.
// None of R0–R8 are implemented yet on this tree — every case below (bar the T4 positive
// control) is expected to be RED until they land.
//
// Fixture git repos are throwaway (mkdtempSync + `git init`), one per case, removed in
// `finally`. Git EXPORTS repo-scoped variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …) into
// every child process, so a fixture repo built or read from inside an inherited one of those
// silently re-points at the wrong repository (see scripts/campaign/bugs.mjs's `self-test`,
// which hit exactly this) — scrubbed below for both the fixture-building `git` calls and the
// script-under-test's own env.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/campaign-check.mjs");
const REPORTER = path.join(REPO_ROOT, "scripts/jest-campaign-reporter.cjs");
const ROOT_PKG_PATH = path.join(REPO_ROOT, "package.json");

const T0 = 1_800_000_000; // arbitrary fixed epoch anchor — only relative offsets matter

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

// Scrub every repo-scoped GIT_* var (the full set scripts/campaign/bugs.mjs's self-test
// scrubs, not just the three the harness spec names) so a fixture repo can never silently
// re-point at this checkout's own .git.
function scrubGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_QUARANTINE_PATH",
    "GIT_PREFIX",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function git(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): void {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: scrubGitEnv(extraEnv),
    shell: false,
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${res.stderr || res.stdout}`);
  }
}

function initFixtureRepo(dir: string): void {
  git(["init", "-q"], dir);
  git(["config", "user.email", "campaign-check-fixture@example.invalid"], dir);
  git(["config", "user.name", "Campaign Check Fixture"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  git(["config", "tag.gpgsign", "false"], dir);
}

function commitAt(dir: string, epochSeconds: number, message: string): void {
  git(["add", "-A"], dir);
  const dateStr = `${epochSeconds} +0000`;
  git(["commit", "-q", "-m", message], dir, {
    GIT_AUTHOR_DATE: dateStr,
    GIT_COMMITTER_DATE: dateStr,
  });
}

// Commits `apps/api/src/fixture.spec.ts` — matches the api workspace's
// `:(glob)apps/api/**/*.spec.ts` freshness glob (R1).
function writeApiSpecCommit(dir: string, epochSeconds: number): void {
  const specDir = path.join(dir, "apps", "api", "src");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "fixture.spec.ts"), "// campaign-check freshness fixture\n");
  commitAt(dir, epochSeconds, "test: touch apps/api fixture spec");
}

// Commits the F01 ledger shard — matches the `.claude/campaign/status` freshness glob (R1).
function writeLedgerCommit(
  dir: string,
  epochSeconds: number,
  rows: Record<string, unknown>[],
): void {
  const statusDir = path.join(dir, ".claude", "campaign", "status");
  fs.mkdirSync(statusDir, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(statusDir, "F01.jsonl"), body);
  commitAt(dir, epochSeconds, "chore: ledger F01 shard");
}

// Writes a campaign report in the shape jest-campaign-reporter.cjs currently produces, plus the
// R0 `generatedAt` stamp when a test asks for one (the field the real reporter does not write
// yet — see T10). `tokens` become passing REG-title assertionResults; default is one REG-B1 hit.
function writeReport(
  runsDir: string,
  name: string,
  opts: { generatedAt?: string; tokens?: string[] } = {},
): void {
  fs.mkdirSync(runsDir, { recursive: true });
  const tokens = opts.tokens ?? ["REG-B1 passes"];
  const report: Record<string, unknown> = {
    numTotalTests: tokens.length,
    numPassedTests: tokens.length,
    numFailedTests: 0,
    testResults: [{ assertionResults: tokens.map((t) => ({ fullName: t, status: "passed" })) }],
  };
  if (opts.generatedAt !== undefined) report.generatedAt = opts.generatedAt;
  fs.writeFileSync(path.join(runsDir, `${name}.json`), JSON.stringify(report));
}

function writeTurboDryRunFile(dir: string, cacheStatus: string): string {
  const p = path.join(dir, "turbo-dry-run.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      tasks: [
        {
          taskId: "@routeflow/api#test",
          package: "@routeflow/api",
          cache: { status: cacheStatus },
        },
      ],
    }),
  );
  return p;
}

const B1_DONE_ROW = {
  id: "B1",
  batch: "F01",
  tier: "T1",
  state: "done",
  proof: "REG-B1 …",
};

function combined(res: SpawnSyncReturns<string>): string {
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

// Harness per .claude/pipeline/2026-09-06-campaign-check-freshness/spec.md's "Harness"
// paragraph: spawns the REAL script, `cwd` = the fixture repo, `--runs-dir` pointed at the
// fixture's own `.campaign/runs`, `CAMPAIGN_CHECK_STATUS_DIR` pointed at the fixture's own
// `.claude/campaign/status`.
function runCampaignCheck(opts: {
  fixtureDir: string;
  runsDir: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  deleteJestWorkerId?: boolean;
}): SpawnSyncReturns<string> {
  const { fixtureDir, runsDir, args = [], env: extraEnv = {}, deleteJestWorkerId = false } = opts;
  const env = scrubGitEnv();
  delete env.CAMPAIGN_CHECK_TURBO_DRY_RUN;
  env.CAMPAIGN_CHECK_STATUS_DIR = path.join(fixtureDir, ".claude", "campaign", "status");
  Object.assign(env, extraEnv);
  if (deleteJestWorkerId) delete env.JEST_WORKER_ID;
  return spawnSync(process.execPath, [SCRIPT, "--runs-dir", runsDir, ...args], {
    cwd: fixtureDir,
    env,
    encoding: "utf8",
    timeout: 60_000,
    shell: false,
  });
}

function mkFixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "campaign-check-freshness-"));
}

describe("campaign-check freshness guard (spec T1–T14)", () => {
  it("T1 (R1,R2): a report older than a later ledger-shard commit refuses in full mode before any token scan", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 600, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      // api.json's own generatedAt is real proof (REG-B1 passing) but predates the ledger
      // commit — R1's staleness rule must refuse before that proof is ever consulted.
      writeReport(runsDir, "api", { generatedAt: iso(T0 + 300) });
      writeReport(runsDir, "mobile", { generatedAt: iso(T0 + 10_000), tokens: [] });
      writeReport(runsDir, "pricing", { generatedAt: iso(T0 + 10_000), tokens: [] });

      const res = runCampaignCheck({ fixtureDir: dir, runsDir });
      const out = combined(res);

      expect(out).toContain("STALE");
      expect(out).toContain("api.json");
      expect(out).toContain("the ledger shards");
      expect(out).toContain(iso(T0 + 600));
      expect(out).toContain("cd apps/api && npx jest --maxWorkers=2");
      expect(out).toContain("ritual:");
      expect(out).not.toContain("no test titled");
      expect(res.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T2 (R1): a report older than a later apps/api test-file commit refuses, naming the test files", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeLedgerCommit(dir, T0, [B1_DONE_ROW]);
      writeApiSpecCommit(dir, T0 + 600);
      const runsDir = path.join(dir, ".campaign", "runs");
      writeReport(runsDir, "api", { generatedAt: iso(T0 + 300) });
      writeReport(runsDir, "mobile", { generatedAt: iso(T0 + 10_000), tokens: [] });
      writeReport(runsDir, "pricing", { generatedAt: iso(T0 + 10_000), tokens: [] });

      const res = runCampaignCheck({ fixtureDir: dir, runsDir });
      const out = combined(res);

      expect(out).toContain("apps/api test files");
      expect(res.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T3 (R1): a report newer than both commits is fresh, and full mode says so", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0 - 200);
      writeLedgerCommit(dir, T0 - 100, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      writeReport(runsDir, "api", { generatedAt: iso(T0 + 600) });
      writeReport(runsDir, "mobile", { generatedAt: iso(T0 + 600), tokens: [] });
      writeReport(runsDir, "pricing", { generatedAt: iso(T0 + 600), tokens: [] });

      const res = runCampaignCheck({ fixtureDir: dir, runsDir });
      const out = combined(res);

      expect(out).toContain("api.json fresh");
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Positive control (R3 scoping): a row that makes no affirmative claim must never trigger a
  // consult, so a stale api.json sitting right next to it is simply never looked at. Green
  // today AND after — excluded from the "every other test is red today" claim.
  it("T4 (R3): a queued row never consults api.json, so a stale report next to it changes nothing", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 600, [
        { id: "B1", batch: "F01", tier: "T1", state: "queued", proof: null },
      ]);
      const runsDir = path.join(dir, ".campaign", "runs");
      writeReport(runsDir, "api", { generatedAt: iso(T0 - 1000) }); // stale, but never consulted

      const res = runCampaignCheck({ fixtureDir: dir, runsDir });
      const out = combined(res);

      expect(out).not.toContain("STALE");
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T5 (R3): a missing consulted T1 report keeps the existing artifact-missing text and appends the regenerate line", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 10, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      fs.mkdirSync(runsDir, { recursive: true }); // api.json/mobile.json/pricing.json all absent

      const res = runCampaignCheck({ fixtureDir: dir, runsDir });
      const out = combined(res);

      expect(out).toContain("at least one T1 obligation is claimed, but none of");
      expect(out).toContain("regenerate: cd apps/api && npx jest --maxWorkers=2");
      expect(res.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T6 (R4,R6): --freshness-only refuses a stale report that turbo predicts a cache HIT for, without ever running the token scan", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 600, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      // Wrong token on purpose: if a full scan ever ran against this fixture it would find
      // neither REG-B1 (the claim) nor cite REG-B2 (what's actually here) in a passing way —
      // freshness-only must never reach that scan at all.
      writeReport(runsDir, "api", { generatedAt: iso(T0 + 300), tokens: ["REG-B2 passes"] });
      const dryRunFile = writeTurboDryRunFile(dir, "HIT");

      const res = runCampaignCheck({
        fixtureDir: dir,
        runsDir,
        args: ["--freshness-only"],
        env: { CAMPAIGN_CHECK_TURBO_DRY_RUN: dryRunFile, JEST_WORKER_ID: "1" },
      });
      const out = combined(res);

      expect(out).toContain("would replay");
      expect(out).toContain("cd apps/api && npx jest --maxWorkers=2");
      expect(out).toContain("WARNING: CAMPAIGN_CHECK_TURBO_DRY_RUN");
      expect(out).not.toContain("REG-B2");
      expect(out).not.toContain("no test titled");
      expect(res.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T7 (R4): --freshness-only treats a predicted cache MISS as safe to continue", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 600, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      writeReport(runsDir, "api", { generatedAt: iso(T0 + 300), tokens: ["REG-B2 passes"] });
      const dryRunFile = writeTurboDryRunFile(dir, "MISS");

      const res = runCampaignCheck({
        fixtureDir: dir,
        runsDir,
        args: ["--freshness-only"],
        env: { CAMPAIGN_CHECK_TURBO_DRY_RUN: dryRunFile, JEST_WORKER_ID: "1" },
      });
      const out = combined(res);

      expect(out).toContain("cache miss");
      expect(out).toContain("continuing");
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T8 (R4): --freshness-only fails open when the turbo dry-run override is unparsable", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 600, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      writeReport(runsDir, "api", { generatedAt: iso(T0 + 300), tokens: ["REG-B2 passes"] });
      const dryRunFile = path.join(dir, "turbo-dry-run.json");
      fs.writeFileSync(dryRunFile, "not json");

      const res = runCampaignCheck({
        fixtureDir: dir,
        runsDir,
        args: ["--freshness-only"],
        env: { CAMPAIGN_CHECK_TURBO_DRY_RUN: dryRunFile, JEST_WORKER_ID: "1" },
      });
      const out = combined(res);

      expect(out).toContain("fail open");
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T9 (R6): CAMPAIGN_CHECK_TURBO_DRY_RUN is ignored outside a Jest worker", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 600, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      writeReport(runsDir, "api", { generatedAt: iso(T0 + 300), tokens: ["REG-B2 passes"] });
      const dryRunFile = writeTurboDryRunFile(dir, "HIT");

      const res = runCampaignCheck({
        fixtureDir: dir,
        runsDir,
        args: ["--freshness-only"],
        env: { CAMPAIGN_CHECK_TURBO_DRY_RUN: dryRunFile },
        deleteJestWorkerId: true,
      });
      const out = combined(res);

      expect(out).toContain("ignored outside a Jest worker");
      expect(out).toContain("fail open");
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T10 (R0): the real jest-campaign-reporter stamps generatedAt and gitHead without disturbing the four existing fields", () => {
    const dir = mkFixtureDir();
    try {
      // jest-campaign-reporter.cjs resolves its output dir as
      // path.resolve(process.cwd(), "..", ".."), matching how apps/api's own cwd (two levels
      // below the repo root) resolves back to the repo root. The reporter takes no artifact-dir
      // override, so this mirrors that same two-levels-deep layout under the fixture instead.
      const wsDir = path.join(dir, "apps", "api");
      fs.mkdirSync(wsDir, { recursive: true });

      const nodeScript = [
        `const Reporter = require(${JSON.stringify(REPORTER)});`,
        `const reporter = new Reporter(null, { artifact: "api" });`,
        `reporter.onRunComplete(null, {`,
        `  numTotalTests: 1,`,
        `  numPassedTests: 1,`,
        `  numFailedTests: 0,`,
        `  testResults: [],`,
        `});`,
      ].join("\n");

      const res = spawnSync(process.execPath, ["-e", nodeScript], {
        cwd: wsDir,
        encoding: "utf8",
        timeout: 60_000,
        env: scrubGitEnv(),
        shell: false,
      });
      expect(res.status).toBe(0);

      const writtenPath = path.join(dir, ".campaign", "runs", "api.json");
      expect(fs.existsSync(writtenPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(writtenPath, "utf8"));

      expect(written.numTotalTests).toBe(1);
      expect(written.numPassedTests).toBe(1);
      expect(written.numFailedTests).toBe(0);
      expect(Array.isArray(written.testResults)).toBe(true);
      expect(typeof written.generatedAt).toBe("string");
      expect(new Date(written.generatedAt).toString()).not.toBe("Invalid Date");
      expect(Object.prototype.hasOwnProperty.call(written, "gitHead")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T11 (R5): root package.json's verify script runs the freshness pre-step before the main gate", () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG_PATH, "utf8"));
    const verify: string = pkg.scripts?.verify ?? "";

    expect(verify.startsWith("node scripts/campaign-check.mjs --freshness-only && ")).toBe(true);
    expect(verify.endsWith("node scripts/campaign-check.mjs")).toBe(true);
  });

  // R9 (addendum): a scoped jest run can leave a report that is FRESH by time but is not real
  // full-suite evidence (the implementer's own Gate 1 run overwrote api.json this way — see
  // wp-report.md §Gate 4a/4c, L-063's twin). T12 pins the reporter's own `partial` stamp; T13/T14
  // pin campaign-check's refusal of a `partial: true` report in full mode and --freshness-only.

  it("T12 (R9): the reporter stamps partial:true (with patterns) for a scoped run, partial:false for a full run", () => {
    // Case A: a scoped run — globalConfig.testPathPatterns is "set", mirroring Jest 30's
    // @jest/pattern TestPathPatterns shape (`.isSet()` / `.patterns`).
    const dirA = mkFixtureDir();
    try {
      const wsDirA = path.join(dirA, "apps", "api");
      fs.mkdirSync(wsDirA, { recursive: true });
      const nodeScriptA = [
        `const Reporter = require(${JSON.stringify(REPORTER)});`,
        `const globalConfig = {`,
        `  testPathPatterns: {`,
        `    patterns: ["campaign-check-freshness"],`,
        `    isSet() { return this.patterns.length > 0; },`,
        `  },`,
        `};`,
        `const reporter = new Reporter(globalConfig, { artifact: "api" });`,
        `reporter.onRunComplete(null, {`,
        `  numTotalTests: 11,`,
        `  numPassedTests: 11,`,
        `  numFailedTests: 0,`,
        `  testResults: [],`,
        `});`,
      ].join("\n");

      const resA = spawnSync(process.execPath, ["-e", nodeScriptA], {
        cwd: wsDirA,
        encoding: "utf8",
        timeout: 60_000,
        env: scrubGitEnv(),
        shell: false,
      });
      expect(resA.status).toBe(0);

      const writtenA = JSON.parse(
        fs.readFileSync(path.join(dirA, ".campaign", "runs", "api.json"), "utf8"),
      );
      expect(writtenA.partial).toBe(true);
      expect(Array.isArray(writtenA.partialPatterns)).toBe(true);
      expect(writtenA.partialPatterns).toContain("campaign-check-freshness");
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
    }

    // Case B: a full run — no path or name pattern set (globalConfig with no patterns, same as
    // an ordinary un-scoped `npx jest` invocation).
    const dirB = mkFixtureDir();
    try {
      const wsDirB = path.join(dirB, "apps", "api");
      fs.mkdirSync(wsDirB, { recursive: true });
      const nodeScriptB = [
        `const Reporter = require(${JSON.stringify(REPORTER)});`,
        `const globalConfig = {`,
        `  testPathPatterns: { patterns: [], isSet() { return this.patterns.length > 0; } },`,
        `};`,
        `const reporter = new Reporter(globalConfig, { artifact: "api" });`,
        `reporter.onRunComplete(null, {`,
        `  numTotalTests: 1398,`,
        `  numPassedTests: 1398,`,
        `  numFailedTests: 0,`,
        `  testResults: [],`,
        `});`,
      ].join("\n");

      const resB = spawnSync(process.execPath, ["-e", nodeScriptB], {
        cwd: wsDirB,
        encoding: "utf8",
        timeout: 60_000,
        env: scrubGitEnv(),
        shell: false,
      });
      expect(resB.status).toBe(0);

      const writtenB = JSON.parse(
        fs.readFileSync(path.join(dirB, ".campaign", "runs", "api.json"), "utf8"),
      );
      expect(writtenB.partial).toBe(false);
    } finally {
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("T13 (R9): full mode refuses a PARTIAL report even when it is fresh by time and its token is present", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeApiSpecCommit(dir, T0);
      writeLedgerCommit(dir, T0 + 10, [B1_DONE_ROW]);
      const runsDir = path.join(dir, ".campaign", "runs");
      fs.mkdirSync(runsDir, { recursive: true });
      // Fresh by time (after both commits) AND the claimed REG-B1 token is present — R9 must
      // still refuse, because `partial: true` means this report only covers a scoped jest run,
      // not the full apps/api suite (a time rule alone would let this "launder" as evidence).
      fs.writeFileSync(
        path.join(runsDir, "api.json"),
        JSON.stringify({
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          generatedAt: iso(T0 + 1000),
          partial: true,
          partialPatterns: ["campaign-check-freshness"],
          testResults: [{ assertionResults: [{ fullName: "REG-B1 passes", status: "passed" }] }],
        }),
      );
      writeReport(runsDir, "mobile", { generatedAt: iso(T0 + 1000), tokens: [] });
      writeReport(runsDir, "pricing", { generatedAt: iso(T0 + 1000), tokens: [] });

      const res = runCampaignCheck({ fixtureDir: dir, runsDir });
      const out = combined(res);

      expect(out).toContain("PARTIAL");
      expect(out).toContain("full suite");
      expect(out).toContain("cd apps/api && npx jest --maxWorkers=2");
      expect(out).not.toContain("no test titled");
      expect(res.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T14 (R9): --freshness-only treats a PARTIAL report like a stale one — HIT refuses, MISS continues", () => {
    // HIT: turbo predicts a cache hit for the scoped-run workspace's #test task — refuse,
    // same as a stale report would (T6's HIT case).
    const dirHit = mkFixtureDir();
    try {
      initFixtureRepo(dirHit);
      writeApiSpecCommit(dirHit, T0);
      writeLedgerCommit(dirHit, T0 + 10, [B1_DONE_ROW]);
      const runsDirHit = path.join(dirHit, ".campaign", "runs");
      fs.mkdirSync(runsDirHit, { recursive: true });
      fs.writeFileSync(
        path.join(runsDirHit, "api.json"),
        JSON.stringify({
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          generatedAt: iso(T0 + 1000),
          partial: true,
          partialPatterns: ["campaign-check-freshness"],
          testResults: [{ assertionResults: [{ fullName: "REG-B1 passes", status: "passed" }] }],
        }),
      );
      const dryRunFileHit = writeTurboDryRunFile(dirHit, "HIT");

      const resHit = runCampaignCheck({
        fixtureDir: dirHit,
        runsDir: runsDirHit,
        args: ["--freshness-only"],
        env: { CAMPAIGN_CHECK_TURBO_DRY_RUN: dryRunFileHit, JEST_WORKER_ID: "1" },
      });
      const outHit = combined(resHit);

      expect(outHit).toContain("would replay");
      expect(resHit.status).toBe(1);
    } finally {
      fs.rmSync(dirHit, { recursive: true, force: true });
    }

    // MISS: turbo predicts a cache miss for the same workspace — continue, since a full
    // re-run (which the reporter will stamp partial:false) is expected next (T7's MISS case).
    const dirMiss = mkFixtureDir();
    try {
      initFixtureRepo(dirMiss);
      writeApiSpecCommit(dirMiss, T0);
      writeLedgerCommit(dirMiss, T0 + 10, [B1_DONE_ROW]);
      const runsDirMiss = path.join(dirMiss, ".campaign", "runs");
      fs.mkdirSync(runsDirMiss, { recursive: true });
      fs.writeFileSync(
        path.join(runsDirMiss, "api.json"),
        JSON.stringify({
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          generatedAt: iso(T0 + 1000),
          partial: true,
          partialPatterns: ["campaign-check-freshness"],
          testResults: [{ assertionResults: [{ fullName: "REG-B1 passes", status: "passed" }] }],
        }),
      );
      const dryRunFileMiss = writeTurboDryRunFile(dirMiss, "MISS");

      const resMiss = runCampaignCheck({
        fixtureDir: dirMiss,
        runsDir: runsDirMiss,
        args: ["--freshness-only"],
        env: { CAMPAIGN_CHECK_TURBO_DRY_RUN: dryRunFileMiss, JEST_WORKER_ID: "1" },
      });
      const outMiss = combined(resMiss);

      expect(outMiss).toContain("continuing");
      expect(resMiss.status).toBe(0);
    } finally {
      fs.rmSync(dirMiss, { recursive: true, force: true });
    }
  });
});
