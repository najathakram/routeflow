/**
 * T1 (item 11, PR-14): static docs-truth tripwire.
 *
 * README.md and CLAUDE.md are read by humans and by the coding agent every session — a stale
 * claim in either one (a dead branch name, a deleted workflow, a wrong remote) survives
 * silently because nothing else in the repo checks prose against reality. This pins the
 * specific claims item 11 fixed so a future edit can't quietly reintroduce them.
 *
 * Lives in the API project because the repo has no root test runner (CLAUDE.md "DO NOT
 * introduce ... a root-level test runner").
 */
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const claudeMd = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");

describe("README.md truth (T1)", () => {
  it("points at the real origin, not the stale najathakram1 remote", () => {
    expect(readme).toContain("najathakram/routeflow");
    expect(readme).not.toMatch(/\bnajathakram1\b/);
  });

  it("does not reference the deleted deploy-staging.yml workflow", () => {
    expect(readme).not.toContain("deploy-staging.yml");
  });

  it("does not claim a develop branch exists", () => {
    expect(readme).not.toMatch(/\bdevelop\b/);
  });

  it('does not claim "main is production-ready" (trunk is master)', () => {
    expect(readme).not.toContain("main is production-ready");
  });

  it("documents the deployment_status-triggered E2E flow", () => {
    expect(readme).toContain("deployment_status");
  });

  it("names web in the `npm run test` row (Jest now covers api, web, mobile)", () => {
    const testRow = readme.split("\n").find((line) => line.includes("`npm run test`"));
    expect(testRow).toBeDefined();
    expect(testRow).toMatch(/\bweb\b/);
  });
});

describe("CLAUDE.md truth (T1)", () => {
  it("no longer lists Zustand in the web stack (removed, item 11)", () => {
    expect(claudeMd).not.toMatch(/zustand/i);
  });

  it("states the lessons-register byte cap enforced by validate-lessons.mjs", () => {
    expect(claudeMd.includes("65,536") || claudeMd.includes("65536")).toBe(true);
  });

  it("documents Jest for web in the web stack line (web has Jest + RTL, not Playwright-only)", () => {
    const webLine = claudeMd.split("\n").find((line) => line.includes("**Web** (`apps/web`)"));
    expect(webLine).toBeDefined();
    expect(webLine).toContain("Jest");
  });
});
