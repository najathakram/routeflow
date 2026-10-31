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
 *   3. every other workspace that has such a spec runs it (a `test:repo-truth` script that lists it) or names where
 *      it runs, so a spec found is never on no lane;
 *   4. the lane's turbo cache key hashes the directories EVERY lane's specs read (api, web, mobile, scanning), minus
 *      generated trees, so a cached green is never replayed and the key does not move when the lane merely runs;
 *   5. `main()` plans the lane for the DERIVED workspace list, not a hand-named one; and a `-script` spec that
 *      reads another workspace is selected on a fast push by what it reads.
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
    // the climbing shape: the spec sits three levels deep, so "../../../web" is apps/web; named by no string
    "apps/api/src/a/b/climbs.spec.ts":
      'import fs from "fs"; fs.readFileSync(require("path").join(__dirname, "../../../../web/lib/x.ts"));',
    "apps/api/src/a/b/climbs-import.spec.ts":
      'import { thing } from "../../../../web/lib/thing"; it("x", () => thing);',
    "apps/api/src/a/b/climbs-literal.spec.ts":
      'const ui = require("path").resolve(__dirname, "../../../../../packages/ui"); it("x", () => ui);',
    "apps/api/src/a/climbs-to-own-tree.spec.ts":
      'import fs from "fs"; fs.readFileSync(require("path").join(__dirname, "../../package.json"));',
    "apps/api/src/a/climbs-to-root.spec.ts":
      'import fs from "fs"; fs.readFileSync(require("path").join(__dirname, "../../../../scripts/x.mjs"));',
    "apps/api/src/cwd-root.spec.ts":
      'import fs from "fs"; fs.readdirSync(require("path").join(process.cwd(), "..", "web", "app"));',
    "apps/api/src/variable-root.spec.ts":
      'import fs from "fs"; const APPS = path.join(ROOT, "apps"); fs.readdirSync(path.join(APPS, "web", "lib"));',
    "apps/api/src/variable-root-no-fs.spec.ts":
      'const APPS = path.join(ROOT, "apps"); it("x", () => path.join(APPS, "web", "lib"));',
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
      "src/a/b/climbs-import.spec.ts",
      "src/a/b/climbs-literal.spec.ts",
      "src/a/b/climbs.spec.ts",
      "src/cwd-root.spec.ts",
      "src/reads-web-joined.spec.ts",
      "src/reads-web.spec.ts",
      "src/variable-root.spec.ts",
    ]);
    expect(found["apps/web"].map((s: { spec: string }) => s.spec)).toEqual([
      "lib/reads-ui.test.ts",
    ]);
    expect(found["apps/web"][0].reads).toEqual(["packages/ui"]);
  });

  it("resolves a relative path against the spec's own directory, whatever its depth", () => {
    const found = detector.findCrossWorkspaceSpecs(root);
    const reads = (spec: string) =>
      found["apps/api"].find((s: { spec: string }) => s.spec === spec)?.reads;
    expect(reads("src/a/b/climbs.spec.ts")).toEqual(["apps/web"]);
    expect(reads("src/a/b/climbs-import.spec.ts")).toEqual(["apps/web"]);
    expect(reads("src/a/b/climbs-literal.spec.ts")).toEqual(["packages/ui"]);
    expect(reads("src/cwd-root.spec.ts")).toEqual(["apps/web"]);
    // ../../ from src/a lands in apps/api itself; ../../../../ lands on the repo root, no workspace
    expect(JSON.stringify(found)).not.toContain("climbs-to-own-tree");
    expect(JSON.stringify(found)).not.toContain("climbs-to-root");
  });

  it("a literal folder name joined to a variable root counts only when the spec reads the filesystem", () => {
    const found = JSON.stringify(detector.findCrossWorkspaceSpecs(root));
    expect(found).toContain("variable-root.spec.ts");
    expect(found).not.toContain("variable-root-no-fs");
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

  // A workspace whose specs reach another workspace but whose lane is not a test:repo-truth script says where they run.
  const COVERED_ELSEWHERE: Record<string, string> = {
    "packages/pricing": "its whole suite is a FULL always-run tripwire in the fast plan",
    "apps/control": "its own CI job (.github/workflows/control.yml)",
  };
  const laneWorkspaces: string[] = detector
    .workspacesWithScript(REPO_ROOT, "test:repo-truth")
    .map((w: { dir: string }) => w.dir);

  it("every workspace with such a spec has a lane that runs the derived list", () => {
    const onNone: string[] = [];
    for (const ws of Object.keys(found)) {
      if (COVERED_ELSEWHERE[ws]) continue;
      if (ws === "apps/api") continue; // its lane is the testRegex test above
      if (!laneWorkspaces.includes(ws)) {
        onNone.push(`${ws}: has cross-workspace specs but no test:repo-truth script`);
        continue;
      }
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ws, "package.json"), "utf8"));
      // the runner derives its list from the same detector, so a script that runs it lists every spec found
      if (!String(pkg.scripts["test:repo-truth"]).includes("run-cross-workspace-specs.mjs")) {
        onNone.push(`${ws}: test:repo-truth does not run the derived list`);
      }
    }
    expect(onNone).toEqual([]);
  });

  it("every spec a COVERED_ELSEWHERE workspace relies on is still covered there", () => {
    expect(
      fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "control.yml"), "utf8"),
    ).toContain("apps/control");
    expect(laneWorkspaces).not.toContain("packages/pricing"); // it runs whole, not through the lane
  });

  it("the lane's turbo cache key hashes every directory ANY lane's specs read, and no generated tree", () => {
    const turbo = fs.readFileSync(path.join(REPO_ROOT, "turbo.json"), "utf8");
    const inputs = turbo.slice(turbo.indexOf('"test:repo-truth"'));
    const block = inputs.slice(0, inputs.indexOf('"outputs"'));
    const unhashed: string[] = [];
    for (const ws of ["apps/api", ...laneWorkspaces.filter((w) => w !== "apps/api")]) {
      const read = new Set<string>();
      for (const s of found[ws] ?? []) for (const r of s.reads) read.add(r);
      for (const dir of read) {
        if (!block.includes(`$TURBO_ROOT$/${dir}/**`)) unhashed.push(`${ws} reads ${dir}`);
      }
    }
    expect(unhashed).toEqual([]);
    // Without these the key would also hash installs, Next builds, compiled packages and the Jest cache the lane writes.
    for (const generated of ["node_modules", ".next", "dist", ".turbo", ".jest-cache"]) {
      expect(block).toContain(`"!**/${generated}/**"`);
    }
  });

  it("main() plans the lane for every workspace that defines test:repo-truth, not a hand-named one", () => {
    const vt = fs.readFileSync(path.join(REPO_ROOT, "scripts", "verify-turbo.mjs"), "utf8");
    const main = vt.slice(vt.indexOf("export async function main"));
    expect(main).toMatch(/repoTruth:\s*workspacesWithScript\(ROOT,\s*"test:repo-truth"\)/);
    expect(main).not.toMatch(/repoTruth:\s*\[\s*API_NAME\s*\]/);
  });

  it("every -script spec that reads another workspace is an api -script spec the pins call can select", () => {
    const scriptSpecs: string[] = (found["apps/api"] ?? [])
      .map((s: { spec: string }) => s.spec)
      .filter((spec: string) => spec.endsWith("-script.spec.ts"));
    // script-spec-lane.spec.ts pins that each -script spec is on the serial script lane; this pins that the
    // fast path reaches it from what it reads (verify-turbo.self-test.mjs R3C-l rows pin the selection itself).
    expect(scriptSpecs.length).toBeGreaterThan(0);
    expect(scriptSpecs).toContain("src/common/inferred-goods-rate-parity-script.spec.ts");
  });
});
