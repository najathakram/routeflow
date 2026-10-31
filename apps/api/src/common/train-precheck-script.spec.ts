import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * `npm run train:precheck` is the ONE command a train coordinator runs before the full verify, so no pre-check is
 * ever a hand-picked spec list again (W31: api-error-codes-parity was left out of one and cost 40 minutes). This pins
 * what the command runs. It reads only its own plan (`--dry-run`), so it never starts tsc or jest.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "train-precheck.mjs");

function dryRun(): string {
  const r = spawnSync(process.execPath, [SCRIPT, "--dry-run"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe("train-precheck.mjs", () => {
  it("is wired as `npm run train:precheck`", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["train:precheck"]).toBe("node scripts/train-precheck.mjs");
  });

  it("runs tsc, then the derived repo-truth lane of every workspace, then the named gates", () => {
    const out = dryRun();
    const tsc = out.indexOf("check-types");
    const lane = out.indexOf("test:repo-truth");
    const gates = out.indexOf("== train pre-check: named gates");
    expect(tsc).toBeGreaterThan(-1);
    expect(lane).toBeGreaterThan(tsc);
    expect(gates).toBeGreaterThan(lane);
  });

  it("names enum parity, permission-coverage and the size ratchet's lane, with no hand-picked spec list", () => {
    const out = dryRun();
    expect(out).toContain("enum-parity");
    expect(out).toContain("permission-coverage");
    // the size ratchet rides the repo-truth lane (jest.repo-truth.config.js), which the lane step runs whole
    expect(out).toContain("turbo run test:repo-truth");
    // the cross-workspace specs are NOT listed here: they come from the derivation, in that same lane
    expect(out).not.toContain("api-error-codes-parity");
  });

  it("every workspace that defines test:repo-truth is reached by `turbo run test:repo-truth` (no --filter)", () => {
    const out = dryRun();
    const line = out.split("\n").find((l) => l.includes("turbo run test:repo-truth")) ?? "";
    expect(line).not.toContain("--filter");
  });
});
