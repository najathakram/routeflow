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

describe("train-precheck.mjs: pins found by rule, gates that cannot vanish", () => {
  const os = require("os") as typeof import("os");
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  /** A tiny monorepo: api (with the named gates, optionally minus some) plus web and mobile. */
  function fixture(opts: { skipGates?: string[]; files?: Record<string, string> } = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-"));
    dirs.push(root);
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    for (const ws of ["apps/api", "apps/web", "apps/mobile"]) put(`${ws}/package.json`, "{}");
    for (const gate of ["enum-parity", "addon-gate-registry", "no-bare-cron"]) {
      if (!(opts.skipGates ?? []).includes(gate)) put(`apps/api/src/common/${gate}.spec.ts`, "");
    }
    for (const [rel, text] of Object.entries(opts.files ?? {})) put(rel, text);
    return root;
  }

  function precheck(root: string): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--root", root], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    return { status: r.status, out: r.stdout };
  }

  it("runs every *.pin.spec.ts / *.pin.test.ts of EVERY workspace, with that workspace's own jest", () => {
    const out = dryRun();
    expect(out).toContain("== train pre-check: repo pins apps/api ==");
    expect(out).toContain("== train pre-check: repo pins apps/web ==");
    expect(out).toContain("== train pre-check: repo pins apps/mobile ==");
    // the known repo-wide pins ride in the api step beside the rule-found ones
    expect(out).toContain("src/common/turbo-inputs.spec.ts");
    expect(out).toContain("src/billing/plan-key-writers.pin.spec.ts");
  });

  it("a pin a train member adds is run with no list edit (the W32 shape)", () => {
    const root = fixture({
      files: {
        "apps/api/src/money/new-money.pin.spec.ts": "",
        "apps/web/lib/new-copy.pin.test.ts": "",
        "apps/mobile/__tests__/new-mobile.pin.test.ts": "",
        "apps/web/lib/plain.test.ts": "",
      },
    });
    const { status, out } = precheck(root);
    expect(status).toBe(0);
    expect(out).toContain("src/money/new-money.pin.spec.ts");
    expect(out).toContain("lib/new-copy.pin.test.ts");
    expect(out).toContain("__tests__/new-mobile.pin.test.ts");
    expect(out).not.toContain("plain.test.ts");
  });

  it("a named gate that matches no spec FAILS the run instead of being skipped silently", () => {
    const { status, out } = precheck(fixture({ skipGates: ["no-bare-cron"] }));
    expect(status).toBe(1);
    expect(out).toContain("named gate no-bare-cron: matches NO spec");
    // the other gates still run: one run reports every red
    expect(out).toContain("enum-parity");
  });

  it("only a gate that is listed as arriving is skipped, loudly, with its PR", () => {
    const { status, out } = precheck(fixture());
    expect(status).toBe(0);
    expect(out).toContain(
      "named gate permission-coverage: no spec on this tree yet, skipped until #3799 lands",
    );
  });

  it("no longer passes --passWithNoTests to the named gates", () => {
    expect(fs.readFileSync(SCRIPT, "utf8")).not.toMatch(/"--passWithNoTests"/);
  });
});
