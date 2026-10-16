import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * scripts/db-lane.mjs + scripts/verify-scoped.mjs — the scoped pre-push's DB-lane picker.
 *
 * The scoped verify ran no `*.db.spec.ts` (the base jest config ignores them), and lanes picked the
 * relevant ones by hand and missed some (#2301, #2707). `db-lane.mjs` names, from the changed files,
 * every DB spec that can reach them: a reverse import graph (relative imports, script/prisma path
 * literals, `@routeflow/*`) PLUS a Prisma-model channel for the specs that reach a service only
 * through hand-mocked providers (#2301's import-invoice-reimport.db.spec). Cases 1-14, 18, 19 run
 * the CLI on a throwaway git repo that mirrors the layout; 15, 16, 20 run it on this repo.
 */

const REPO = path.resolve(__dirname, "../../../..");
const LANE = path.join(REPO, "scripts", "db-lane.mjs");
const SCOPED = path.join(REPO, "scripts", "verify-scoped.mjs");

// The ONE GIT_* scrub (scripts/lib/scrubbed-git-env.cjs); fixture-git-env-scrub.spec.ts pins that every
// git spawn in a fixture-repo spec passes it (a private copy of the filter does not count).
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: () => NodeJS.ProcessEnv;
};
function git(cwd: string, args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A throwaway git repo holding `files` + five unrelated DB specs (so a single hit stays under the FULL ratio). */
function fixture(files: Record<string, string>, fillers = 5): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "db-lane-"));
  const all: Record<string, string> = { ...files };
  for (let i = 1; i <= fillers; i++) all[`apps/api/src/filler/f${i}.db.spec.ts`] = "export {};\n";
  for (const [rel, body] of Object.entries(all)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function lane(root: string, args: string[]) {
  const r = spawnSync(process.execPath, [LANE, "--root", root, ...args], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
    // The lane walks ~2.9k files; on a loaded runner a run can pass 60 s, and a killed child leaves the spec list
    // without its FINAL summary line ("DB-LANE FULL ..."). 180 s keeps case 16 a pin on the picker, not on CI load.
    timeout: 180_000,
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const specLines = (out: string) => out.split("\n").filter((l) => /\.db\.spec\.ts/.test(l));
const listed = (out: string, spec: string) => specLines(out).some((l) => l.includes(spec));

describe("db-lane.mjs — the import graph", () => {
  it("1. a spec importing a changed module is listed with its hop count", () => {
    const root = fixture({
      "apps/api/src/a/x.service.ts": "export const x = 1;\n",
      "apps/api/src/a/x.db.spec.ts": 'import { x } from "./x.service";\nvoid x;\n',
    });
    const r = lane(root, ["--files", "apps/api/src/a/x.service.ts"]);
    expect(r.status).toBe(0);
    const l = specLines(r.out).find((s) => s.includes("a/x.db.spec.ts"));
    expect(l).toContain("<= import:apps/api/src/a/x.service.ts via 1 hops");
    expect(r.out).toContain("DB-LANE 1/6");
  });

  it("2. spec → module → service → helper: the helper's change reaches the spec; --explain prints the chain", () => {
    const root = fixture({
      "apps/api/src/a/helper.ts": "export const h = 1;\n",
      "apps/api/src/a/svc.ts": 'import { h } from "./helper";\nexport const s = h;\n',
      "apps/api/src/a/mod.ts": 'import { s } from "./svc";\nexport const m = s;\n',
      "apps/api/src/a/m.db.spec.ts": 'import { m } from "./mod";\nvoid m;\n',
    });
    const r = lane(root, ["--files", "apps/api/src/a/helper.ts", "--explain"]);
    expect(specLines(r.out).find((s) => s.includes("a/m.db.spec.ts"))).toContain("via 3 hops");
    expect(r.out).toMatch(/helper\.ts.*svc\.ts.*mod\.ts.*m\.db\.spec\.ts/s);
  });

  it("3. a re-export barrel (`export *`) and index.ts resolution are followed", () => {
    const root = fixture({
      "apps/api/src/b/impl.ts": "export const i = 1;\n",
      "apps/api/src/b/index.ts": 'export * from "./impl";\n',
      "apps/api/src/b/b.db.spec.ts": 'import { i } from "./index";\nvoid i;\n',
      "apps/api/src/c/c.db.spec.ts": 'import { i } from "../b";\nvoid i;\n',
    });
    const r = lane(root, ["--files", "apps/api/src/b/impl.ts"]);
    expect(listed(r.out, "b/b.db.spec.ts")).toBe(true);
    expect(listed(r.out, "c/c.db.spec.ts")).toBe(true);
  });

  it("4. dynamic import() and require() of a root scripts/lib file are followed", () => {
    const root = fixture({
      "apps/api/src/d/late.ts": "export const l = 1;\n",
      "scripts/lib/t.cjs": "module.exports = {};\n",
      "apps/api/src/d/d1.db.spec.ts": 'void import("./late");\n',
      "apps/api/src/d/d2.db.spec.ts":
        'const t = require("../../../../scripts/lib/t.cjs");\nvoid t;\n',
    });
    expect(listed(lane(root, ["--files", "apps/api/src/d/late.ts"]).out, "d/d1.db.spec.ts")).toBe(
      true,
    );
    expect(listed(lane(root, ["--files", "scripts/lib/t.cjs"]).out, "d/d2.db.spec.ts")).toBe(true);
  });

  it('5. a script path literal (F3) is an edge: path.resolve(API_DIR, "scripts/run.mjs")', () => {
    const root = fixture({
      "apps/api/scripts/run.mjs": "export {};\n",
      "apps/api/src/e/e.db.spec.ts":
        'const p = path.resolve(API_DIR, "scripts/run.mjs");\nvoid p;\n',
    });
    const l = specLines(lane(root, ["--files", "apps/api/scripts/run.mjs"]).out).find((s) =>
      s.includes("e/e.db.spec.ts"),
    );
    expect(l).toContain("import:apps/api/scripts/run.mjs");
  });

  it("6. a spec importing ../../prisma/pub-v9 is reached when a definitions file that file imports changes", () => {
    const root = fixture({
      "apps/api/prisma/defs.ts": "export const d = 1;\n",
      "apps/api/prisma/pub-v9.ts": 'import { d } from "./defs";\nexport const p = d;\n',
      "apps/api/src/f/f.db.spec.ts": 'import { p } from "../../prisma/pub-v9";\nvoid p;\n',
    });
    expect(listed(lane(root, ["--files", "apps/api/prisma/defs.ts"]).out, "f/f.db.spec.ts")).toBe(
      true,
    );
  });

  it("7. an import cycle terminates and the spec is listed once", () => {
    const root = fixture({
      "apps/api/src/g/a.ts": 'import "./b";\nexport const a = 1;\n',
      "apps/api/src/g/b.ts": 'import "./a";\nexport const b = 1;\n',
      "apps/api/src/g/g.db.spec.ts": 'import "./a";\n',
    });
    const r = lane(root, ["--files", "apps/api/src/g/b.ts"]);
    expect(r.status).toBe(0);
    expect(specLines(r.out).filter((s) => s.includes("g/g.db.spec.ts"))).toHaveLength(1);
  });

  it("8. only apps/web changed ⇒ DB-LANE 0/N, exit 0", () => {
    const root = fixture({ "apps/web/x.tsx": "export {};\n" });
    const r = lane(root, ["--files", "apps/web/x.tsx"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("DB-LANE 0/5");
    expect(specLines(r.out)).toHaveLength(0);
  });

  it("9. a changed DB spec is listed as self", () => {
    const root = fixture({ "apps/api/src/h/h.db.spec.ts": "export {};\n" });
    const l = specLines(lane(root, ["--files", "apps/api/src/h/h.db.spec.ts"]).out).find((s) =>
      s.includes("h/h.db.spec.ts"),
    );
    expect(l).toContain("<= self");
  });
});

describe("db-lane.mjs — the Prisma-model channel", () => {
  const diffOf = (body: string) => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "db-lane-diff-")), "d.diff");
    writeFileSync(f, body);
    return f;
  };

  it("10. a diff adding `model Widget` lists a spec using prisma.widget.", () => {
    const root = fixture({
      "apps/api/prisma/schema/sales.prisma": "model Old {\n}\n",
      "apps/api/src/w/w.db.spec.ts": "await prisma.widget.create({});\n",
    });
    const diff = diffOf(
      "diff --git a/apps/api/prisma/schema/sales.prisma b/apps/api/prisma/schema/sales.prisma\n--- a/apps/api/prisma/schema/sales.prisma\n+++ b/apps/api/prisma/schema/sales.prisma\n@@ -1 +1,3 @@\n+model Widget {\n+}\n",
    );
    const r = lane(root, ["--files", "apps/api/prisma/schema/sales.prisma", "--diff", diff]);
    expect(specLines(r.out).find((s) => s.includes("w/w.db.spec.ts"))).toContain("model:Widget");
  });

  it("11. a `tx.invoice.` accessor on a changed line lists a spec seeding invoices; a comment/string mention does not", () => {
    const root = fixture({
      "apps/api/src/i/svc.ts": "export {};\n",
      "apps/api/src/i/i.db.spec.ts": "await prisma.invoice.create({});\n",
    });
    const real = diffOf(
      "diff --git a/apps/api/src/i/svc.ts b/apps/api/src/i/svc.ts\n--- a/apps/api/src/i/svc.ts\n+++ b/apps/api/src/i/svc.ts\n@@ -1 +1 @@\n- await tx.invoice.update({});\n",
    );
    expect(
      specLines(lane(root, ["--files", "apps/api/src/i/svc.ts", "--diff", real]).out).find((s) =>
        s.includes("i/i.db.spec.ts"),
      ),
    ).toContain("model:Invoice");
    const noise = diffOf(
      'diff --git a/apps/api/src/i/svc.ts b/apps/api/src/i/svc.ts\n--- a/apps/api/src/i/svc.ts\n+++ b/apps/api/src/i/svc.ts\n@@ -1 +1,2 @@\n+  // tx.invoice.update was removed\n+  const s = "prisma.invoice.count(";\n',
    );
    expect(
      listed(
        lane(root, ["--files", "apps/api/src/i/svc.ts", "--diff", noise]).out,
        "i/i.db.spec.ts",
      ),
    ).toBe(false);
  });
});

describe("db-lane.mjs — FULL mode, flags and exits", () => {
  it("12. 7 of 10 specs reached with --max-ratio 0.6 ⇒ FULL (ratio 0.70) listing all; db-spec.ts changed ⇒ FULL", () => {
    const files: Record<string, string> = { "apps/api/src/j/core.ts": "export {};\n" };
    for (let i = 1; i <= 7; i++) files[`apps/api/src/j/s${i}.db.spec.ts`] = 'import "./core";\n';
    const root = fixture(files, 3);
    const r = lane(root, ["--files", "apps/api/src/j/core.ts", "--max-ratio", "0.6"]);
    expect(r.out).toContain("DB-LANE FULL (ratio 0.70)");
    expect(specLines(r.out)).toHaveLength(10);
    const root2 = fixture({ "apps/api/src/common/testing/db-spec.ts": "export {};\n" });
    const r2 = lane(root2, ["--files", "apps/api/src/common/testing/db-spec.ts"]);
    expect(r2.out).toMatch(/DB-LANE FULL \(.*db-spec\.ts.*\)/);
    expect(specLines(r2.out)).toHaveLength(5);
  });

  it("13. a bad --base ⇒ exit 2 with no list; a changed file importing ./missing ⇒ exit 3 naming it", () => {
    const root = fixture({ "apps/api/src/k/bad.ts": 'import "./missing";\n' });
    const r = lane(root, ["--base", "no-such-ref"]);
    expect(r.status).toBe(2);
    expect(specLines(r.out)).toHaveLength(0);
    expect(r.out).not.toMatch(/DB-LANE \d/);
    const r3 = lane(root, ["--files", "apps/api/src/k/bad.ts"]);
    expect(r3.status).toBe(3);
    expect(r3.err + r3.out).toContain("apps/api/src/k/bad.ts");
    expect(r3.err + r3.out).toContain("./missing");
  });

  it("13b. an import-shaped string or comment in a changed file is not an import (exit 0); a real one still is", () => {
    const body = [
      "const fixture = 'import \"./nope\";';",
      "const other = `from './also-nope'`;",
      '// import "./commented-out";',
      '/* require("./block-commented") */',
      "export { fixture, other };",
      "",
    ].join("\n");
    const root = fixture({ "apps/api/src/k/strings.ts": body });
    const r = lane(root, ["--files", "apps/api/src/k/strings.ts"]);
    expect(r.status).toBe(0);
    expect(r.err).not.toContain("unresolvable");
  });

  it("14. Windows separators are normalised and --json equals the text set", () => {
    const root = fixture({
      "apps/api/src/a/x.service.ts": "export const x = 1;\n",
      "apps/api/src/a/x.db.spec.ts": 'import "./x.service";\n',
    });
    const text = lane(root, ["--files", "apps\\api\\src\\a\\x.service.ts"]);
    const js = lane(root, ["--files", "apps/api/src/a/x.service.ts", "--json"]);
    const parsed = JSON.parse(js.out);
    expect(parsed.total).toBe(6);
    expect(parsed.mode).toBe("scoped");
    expect(parsed.specs).toEqual(["apps/api/src/a/x.db.spec.ts"]);
    expect(listed(text.out, "a/x.db.spec.ts")).toBe(true);
  });
});

describe("db-lane.mjs — this repo", () => {
  it("15. #2301: invoices.service.ts + a prisma.invoice diff lists recompute-order-partial AND import-invoice-reimport (model:Invoice)", () => {
    const diff = path.join(mkdtempSync(path.join(os.tmpdir(), "db-lane-2301-")), "d.diff");
    writeFileSync(
      diff,
      "diff --git a/apps/api/src/invoices/invoices.service.ts b/apps/api/src/invoices/invoices.service.ts\n--- a/apps/api/src/invoices/invoices.service.ts\n+++ b/apps/api/src/invoices/invoices.service.ts\n@@ -1 +1 @@\n+ await this.prisma.invoice.update({});\n",
    );
    const r = lane(REPO, [
      "--files",
      "apps/api/src/invoices/invoices.service.ts",
      "--diff",
      diff,
      "--max-ratio",
      "1",
    ]);
    expect(r.status).toBe(0);
    expect(listed(r.out, "invoices/recompute-order-partial.db.spec.ts")).toBe(true);
    expect(
      specLines(r.out).find((s) => s.includes("import/import-invoice-reimport.db.spec.ts")),
    ).toContain("model:Invoice");
  });

  it("16. #2707: the #2700 file list reaches the catalog/entitlement/repin specs and trips FULL above its own ratio", () => {
    const files = [
      "apps/api/prisma/publish-plan-catalog-v13.ts",
      "apps/api/src/billing/entitlements.service.ts",
      "apps/api/src/billing/plan-catalog.constants.ts",
      "apps/api/scripts/publish-and-repin.mjs",
    ];
    // The scoped set first: its share of all db specs is this list's ratio. A fixed cutoff made the test a repo-size
    // assertion (every new db spec lowers the ratio), so the FULL trip is checked just under the list's own ratio.
    const scoped = lane(REPO, ["--files", files.join(","), "--max-ratio", "1", "--json"]);
    const parsed = JSON.parse(scoped.out);
    expect(parsed.mode).toBe("scoped");
    const ratio = parsed.specs.length / parsed.total;
    expect(ratio).toBeGreaterThan(0.4); // still a hub change
    const cutoff = Math.max(0, ratio - 0.05).toFixed(2);
    const r = lane(REPO, ["--files", files.join(","), "--max-ratio", cutoff]);
    expect(r.out).toMatch(/DB-LANE FULL \(ratio 0\.\d\d\)/);
    for (const s of [
      "billing/publish-plan-catalog-v12.db.spec.ts",
      "billing/publish-plan-catalog-v13.db.spec.ts",
      "common/publish-and-repin.db.spec.ts",
      "billing/addon-default-grant.db.spec.ts",
    ])
      expect(listed(r.out, s)).toBe(true);
    // the scoped set (without the FULL fold) is a strict subset of the full run
    const full = JSON.parse(
      lane(REPO, ["--files", files.join(","), "--max-ratio", cutoff, "--json"]).out,
    );
    expect(full.mode).toBe("full");
    expect(parsed.specs.length).toBeLessThan(full.specs.length);
    for (const sp of parsed.specs) expect(full.specs).toContain(sp);
    expect(parsed.specs).toEqual(
      expect.arrayContaining([
        "apps/api/src/billing/publish-plan-catalog-v12.db.spec.ts",
        "apps/api/src/common/publish-and-repin.db.spec.ts",
      ]),
    );
  });

  it("20. the repo graph builds in under 10 s of CPU time from the working tree", () => {
    // CPU time of the lane process itself, not wall clock: a loaded host (pre-push verify runs the whole workspace in
    // parallel) stretches wall time by the scheduler's whim but not the work the graph build does, so the bound stays at the
    // same 10 s and no longer flakes. The probe runs the real lane in-process and prints its own cpuUsage at exit.
    const probe =
      'process.on("exit",()=>{const u=process.cpuUsage();process.stderr.write("CPU_MS="+Math.round((u.user+u.system)/1000)+"\\n")});' +
      "process.argv=[process.argv[0],process.env.LANE_PATH,...JSON.parse(process.env.LANE_ARGS)];" +
      "import(require('url').pathToFileURL(process.env.LANE_PATH).href);";
    const r = spawnSync(process.execPath, ["-e", probe], {
      encoding: "utf8",
      env: {
        ...scrubbedGitEnv(),
        LANE_PATH: LANE,
        LANE_ARGS: JSON.stringify(["--root", REPO, "--files", "apps/web/x.tsx"]),
      },
      timeout: 120_000,
    });
    expect(r.status).toBe(0);
    const cpuMs = Number(/CPU_MS=(\d+)/.exec(r.stderr ?? "")?.[1]);
    expect(Number.isFinite(cpuMs)).toBe(true);
    expect(cpuMs).toBeLessThan(10_000);
  });
});

describe("verify-scoped.mjs", () => {
  /** A fixture whose local-db-specs runner and jest are fakes that log their argv. */
  function scopedFixture(dbExit: number) {
    const root = fixture({
      "apps/api/src/a/x.service.ts": "export const x = 1;\n",
      "apps/api/src/a/x.db.spec.ts": 'import "./x.service";\n',
      "scripts/local-db-specs.mjs": `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.LOG, "DBRUN " + process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(${dbExit});\n`,
      "fake-jest.mjs":
        'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.LOG, "JEST " + process.argv.slice(2).join(" ") + "\\n");\n',
      "apps/web/x.tsx": "export {};\n",
    });
    const log = path.join(root, "run.log");
    return { root, log };
  }
  function scoped(root: string, args: string[], log?: string) {
    const r = spawnSync(
      process.execPath,
      [SCOPED, "--root", root, "--jest", path.join(root, "fake-jest.mjs"), ...args],
      {
        encoding: "utf8",
        env: { ...scrubbedGitEnv(), LOG: log ?? path.join(root, "run.log") },
        timeout: 60_000,
      },
    );
    return { status: r.status, out: r.stdout ?? "" };
  }

  it("17. --dry-run with only apps/web changed still prints size-ratchet and the three guard specs", () => {
    const { root } = scopedFixture(0);
    const r = scoped(root, ["--dry-run", "--files", "apps/web/x.tsx"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("size-ratchet");
    expect(r.out).toContain("enum-parity");
    expect(r.out).toContain("no-bare-cron");
    expect(r.out).toContain("addon-gate-registry");
  });

  it("17b. a flag with no value (or another flag as its value) ⇒ exit 2", () => {
    const root = fixture({ "apps/api/src/k/a.ts": "export {};\n" });
    expect(scoped(root, ["--dry-run", "--files"]).status).toBe(2);
    expect(scoped(root, ["--files", "--dry-run"]).status).toBe(2);
    expect(scoped(root, ["--dry-run", "--base"]).status).toBe(2);
  });

  it("18. --dry-run with 0 DB specs prints no test:db line", () => {
    const { root } = scopedFixture(0);
    const r = scoped(root, ["--dry-run", "--files", "apps/web/x.tsx"]);
    expect(r.out).not.toContain("test:db");
    expect(r.status).toBe(0);
  });

  it("19. a failing DB spec ⇒ non-zero exit, and the guard specs still ran", () => {
    const { root, log } = scopedFixture(1);
    const r = scoped(root, ["--files", "apps/api/src/a/x.service.ts"], log);
    expect(r.status).not.toBe(0);
    const ran = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(ran).toContain("DBRUN");
    expect(ran).toContain("size-ratchet");
    expect(ran).toContain("enum-parity");
  });
});
