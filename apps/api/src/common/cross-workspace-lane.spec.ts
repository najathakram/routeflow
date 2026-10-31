import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A spec that reads ANOTHER workspace's source (an API spec walking apps/web, a web test reading packages/ui) cannot
 * be found by Jest's related-tests mode (`--changedSince` follows imports, not fs reads) and is not run by an
 * affected-scope push when only the OTHER workspace changed. api-error-codes-parity read web source, missed both,
 * and a bare error-code literal reached a train that way (W31, 40 minutes of CI lost).
 *
 * The cure is one DERIVED list: `scripts/lib/cross-workspace-specs.cjs` scans every workspace's specs, and each
 * workspace's `test:repo-truth` lane runs what it finds on every fast and affected push. This spec pins:
 *   1. the detector (a fixture monorepo, plus canaries it must find in the real repo);
 *   2. the api lane's testRegex matches every spec the detector finds, so a new cross-workspace spec is on the lane
 *      the day it is written, with no hand-kept list to forget;
 *   3. every other workspace that has such a spec runs it (a `test:repo-truth` script) or names where it runs;
 *   4. the lane's turbo cache key hashes the directories those specs read, so a cached green is never replayed.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const detector = require(path.join(REPO_ROOT, "scripts", "lib", "cross-workspace-specs.cjs"));

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xw-"));
  files["package.json"] = JSON.stringify({ workspaces: ["apps/*", "packages/*"] });
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

describe("cross-workspace spec detector (fixture repo)", () => {
  const root = makeRepo({
    "apps/api/package.json": "{}",
    "apps/web/package.json": "{}",
    "packages/ui/package.json": "{}",
    "apps/api/src/reads-web.spec.ts":
      'import * as fs from "fs"; fs.readFileSync(path.join(ROOT, "apps/web/app/x.ts"), "utf8");',
    "apps/api/src/reads-web-joined.spec.ts":
      'import fs from "fs"; fs.readdirSync(path.join(ROOT, "apps", "web", "lib"));',
    "apps/api/src/reads-own.spec.ts":
      'import * as fs from "fs"; fs.readFileSync(path.join(__dirname, "own.ts"), "utf8");',
    "apps/api/src/names-web-in-prose.spec.ts":
      '// reads apps/web/app in a comment only\nit("x", () => expect(1).toBe(1));',
    "apps/api/src/no-fs-but-path.spec.ts": 'const p = "apps/web/app"; it("x", () => p);',
    "apps/web/lib/reads-ui.test.ts":
      'import fs from "node:fs"; fs.readFileSync(path.join(ROOT, "packages/ui/src/a.ts"));',
    "apps/web/lib/reads-self.test.ts":
      'import fs from "node:fs"; fs.readFileSync(path.join(ROOT, "apps/web/lib/a.ts"));',
    "apps/web/e2e/playwright.spec.ts":
      'import fs from "fs"; fs.readFileSync("packages/ui/src/a.ts");',
    "apps/api/node_modules/dep/x.spec.ts":
      'import fs from "fs"; fs.readFileSync("apps/web/app/x.ts");',
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds the specs that read another workspace, keyed by workspace", () => {
    const found = detector.findCrossWorkspaceSpecs(root);
    expect(found["apps/api"].map((s: { spec: string }) => s.spec).sort()).toEqual([
      "src/reads-web-joined.spec.ts",
      "src/reads-web.spec.ts",
    ]);
    expect(found["apps/web"].map((s: { spec: string }) => s.spec)).toEqual([
      "lib/reads-ui.test.ts",
    ]);
    expect(found["apps/web"][0].reads).toEqual(["packages/ui"]);
  });

  it("skips node_modules, e2e (Playwright) and a workspace's own tree", () => {
    const all = JSON.stringify(detector.findCrossWorkspaceSpecs(root));
    expect(all).not.toContain("node_modules");
    expect(all).not.toContain("playwright.spec");
    expect(all).not.toContain("reads-self");
    expect(all).not.toContain("reads-own");
    expect(all).not.toContain("names-web-in-prose");
    expect(all).not.toContain("no-fs-but-path");
  });
});

describe("the real repo", () => {
  const found = detector.findCrossWorkspaceSpecs(REPO_ROOT);
  // `-script.spec.ts` specs run in the serial script lane instead (script-spec-lane.spec.ts: one lane each).
  const apiSpecs: string[] = (found["apps/api"] ?? [])
    .map((s: { spec: string }) => s.spec)
    .filter((spec: string) => !spec.endsWith("-script.spec.ts"));

  it("finds the canaries that already read another workspace", () => {
    for (const canary of [
      "src/common/api-error-codes-parity.spec.ts",
      "src/common/enum-parity.spec.ts",
      "src/common/shared-dto-inventory.spec.ts",
      "src/regulated/report-warning-codes-parity.spec.ts",
      "src/common/size-ratchet.spec.ts",
    ]) {
      expect(apiSpecs).toContain(canary);
    }
  });

  it("api's test:repo-truth lane matches every spec the detector finds", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lane = require(path.join(REPO_ROOT, "apps", "api", "jest.repo-truth.config.js"));
    expect(typeof lane.testRegex).toBe("string");
    const re = new RegExp(lane.testRegex);
    const missing = apiSpecs.filter((s) => !re.test(`/repo/apps/api/${s}`));
    expect(missing).toEqual([]);
  });

  it("this spec is itself on the lane", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lane = require(path.join(REPO_ROOT, "apps", "api", "jest.repo-truth.config.js"));
    expect(
      new RegExp(lane.testRegex).test("/repo/apps/api/src/common/cross-workspace-lane.spec.ts"),
    ).toBe(true);
  });

  it("every other workspace with such a spec runs it through test:repo-truth, or says where it runs", () => {
    const COVERED_ELSEWHERE: Record<string, string> = {
      "packages/pricing": "its whole suite is a FULL always-run tripwire in the fast plan",
      "apps/control": "its own CI job (.github/workflows/control.yml)",
    };
    const uncovered: string[] = [];
    for (const ws of Object.keys(found)) {
      if (ws === "apps/api") continue;
      if (COVERED_ELSEWHERE[ws]) continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ws, "package.json"), "utf8"));
      if (!pkg.scripts?.["test:repo-truth"]) uncovered.push(ws);
    }
    expect(uncovered).toEqual([]);
  });

  it("the lane's turbo cache key hashes every directory the lane's api specs read", () => {
    const turbo = fs.readFileSync(path.join(REPO_ROOT, "turbo.json"), "utf8");
    const inputs = turbo.slice(turbo.indexOf('"test:repo-truth"'));
    const block = inputs.slice(0, inputs.indexOf('"outputs"'));
    const read = new Set<string>();
    for (const s of found["apps/api"] ?? []) for (const r of s.reads) read.add(r);
    const unhashed = [...read].filter((dir) => !block.includes(`$TURBO_ROOT$/${dir}/**`));
    expect(unhashed).toEqual([]);
  });
});
