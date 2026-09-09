import { spawnSync, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pins that scripts/campaign-check.mjs treats apps/web's jest report
// (.campaign/runs/web.json, wired via apps/web/jest.config.js's
// jest-campaign-reporter.cjs { artifact: "web" }) as a T1 proof source on par with
// api/mobile/pricing — see .campaign/runs/web.json in scripts/campaign-check.mjs and
// apps/web/jest.config.js's reporters block. Without this, REG-B### specs living in
// apps/web (e.g. lib/api/routes.stop-pod.test.tsx REG-B35) were invisible to the gate:
// "no test titled with REG-B## found in the jest report" on every PR (#683).

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/campaign-check.mjs");
const WEB_JEST_CONFIG = path.join(REPO_ROOT, "apps/web/jest.config.js");

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

function writeReport(
  runsDir: string,
  name: string,
  opts: { generatedAt?: string; tokens?: string[] } = {},
): void {
  fs.mkdirSync(runsDir, { recursive: true });
  const tokens = opts.tokens ?? [];
  const report: Record<string, unknown> = {
    numTotalTests: tokens.length,
    numPassedTests: tokens.length,
    numFailedTests: 0,
    testResults: [{ assertionResults: tokens.map((t) => ({ fullName: t, status: "passed" })) }],
  };
  if (opts.generatedAt !== undefined) report.generatedAt = opts.generatedAt;
  fs.writeFileSync(path.join(runsDir, `${name}.json`), JSON.stringify(report));
}

function combined(res: SpawnSyncReturns<string>): string {
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

function runCampaignCheck(fixtureDir: string, runsDir: string): SpawnSyncReturns<string> {
  const env = scrubGitEnv();
  delete env.CAMPAIGN_CHECK_TURBO_DRY_RUN;
  env.CAMPAIGN_CHECK_STATUS_DIR = path.join(fixtureDir, ".claude", "campaign", "status");
  return spawnSync(process.execPath, [SCRIPT, "--runs-dir", runsDir], {
    cwd: fixtureDir,
    env,
    encoding: "utf8",
    timeout: 60_000,
    shell: false,
  });
}

function mkFixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "campaign-check-web-report-"));
}

const T0 = Math.floor(Date.now() / 1000) - 24 * 3600;

describe("campaign-check reads apps/web's jest report", () => {
  it("declares apps/web as a T1 proof workspace, writing to web.json (not web-e2e.json)", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toContain('ws: "web"');
    expect(source).toContain('dir: "apps/web"');
    expect(source).toContain("webJsonPath");
    expect(source).toContain('path.join(runsDir, "web.json")');
    // Must stay distinct from the Playwright e2e artifact.
    expect(source).toContain('path.join(runsDir, "web-e2e.json")');
  });

  it('apps/web/jest.config.js wires jest-campaign-reporter.cjs with { artifact: "web" }', () => {
    const config = fs.readFileSync(WEB_JEST_CONFIG, "utf8");
    expect(config).toContain("jest-campaign-reporter.cjs");
    expect(config).toContain('artifact: "web"');
  });

  it("discharges a T1 claim proven only by a REG-B### test in .campaign/runs/web.json", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeLedgerCommit(dir, T0, [
        { id: "B35", batch: "F01", tier: "T1", state: "proven", proof: "REG-B35 …" },
      ]);
      const runsDir = path.join(dir, ".campaign", "runs");
      // api/mobile/pricing exist but say nothing about B35 — only web.json proves it.
      writeReport(runsDir, "api", { generatedAt: new Date().toISOString(), tokens: [] });
      writeReport(runsDir, "mobile", { generatedAt: new Date().toISOString(), tokens: [] });
      writeReport(runsDir, "pricing", { generatedAt: new Date().toISOString(), tokens: [] });
      writeReport(runsDir, "web", {
        generatedAt: new Date().toISOString(),
        tokens: ["REG-B35 stop-pod route returns signed url"],
      });

      const res = runCampaignCheck(dir, runsDir);
      const out = combined(res);

      expect(out).not.toContain("no test titled with REG-B35");
      expect(out).toContain(
        "every affirmative claim in scope is backed by a real proof (1 checked)",
      );
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still fails a T1 claim with no matching test anywhere, web.json included", () => {
    const dir = mkFixtureDir();
    try {
      initFixtureRepo(dir);
      writeLedgerCommit(dir, T0, [
        { id: "B999", batch: "F01", tier: "T1", state: "proven", proof: "REG-B999 …" },
      ]);
      const runsDir = path.join(dir, ".campaign", "runs");
      writeReport(runsDir, "api", { generatedAt: new Date().toISOString(), tokens: [] });
      writeReport(runsDir, "mobile", { generatedAt: new Date().toISOString(), tokens: [] });
      writeReport(runsDir, "pricing", { generatedAt: new Date().toISOString(), tokens: [] });
      writeReport(runsDir, "web", { generatedAt: new Date().toISOString(), tokens: [] });

      const res = runCampaignCheck(dir, runsDir);
      const out = combined(res);

      expect(out).toContain("B999: no test titled with REG-B999 found in the jest report");
      expect(res.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
