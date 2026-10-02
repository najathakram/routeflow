/**
 * CI wiring pin (lead ruling 2026-10-01): control is verified by its OWN workflow, not by the shared
 * `Verify` job in ci.yml.
 *
 *  - `.github/workflows/control.yml` has the triggers, the runner, the timeout, the control-only
 *    install and the three scripts the ruling asks for, and the same `if:` as ci.yml's Verify job;
 *  - ci.yml's Verify step sets `VERIFY_EXCLUDE` to include `@routeflow/control`, so product PRs
 *    neither run nor wait on control (scripts/verify-turbo.mjs honours it);
 *  - COVERAGE: every repo path control's specs (or its running server) read outside apps/control is
 *    matched by a `paths:` glob in control.yml. Otherwise a PR that edits such a file would break a
 *    control spec while the workflow that runs it never starts, and Verify no longer runs control.
 *
 * Text and regex based on purpose (no YAML dependency: control's runtime dependency list is empty and
 * its CI install is scoped). The workflow files are small and regular; the parsers below fail loudly
 * (an empty parse is an assertion failure, never a silent pass).
 */
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTROL_DIR = path.join(REPO_ROOT, "apps", "control");
const TEST_DIR = path.join(CONTROL_DIR, "test");
const SRC_DIR = path.join(CONTROL_DIR, "src");

const read = (...p: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...p), "utf8");
const CONTROL_YML = read(".github", "workflows", "control.yml");
const CI_YML = read(".github", "workflows", "ci.yml");

/** Lines of a workflow with full-line comments removed (a comment may legitimately name a command). */
const code = (text: string): string[] => text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));

/** The text of the top-level-indented block starting at `key:` (2-space steps), without comments. */
function block(text: string, header: RegExp, indent: number): string[] {
  const lines = code(text);
  const start = lines.findIndex((l) => header.test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  const out: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      out.push(l);
      continue;
    }
    const lead = l.length - l.trimStart().length;
    if (lead <= indent) break;
    out.push(l);
  }
  return out;
}

/** `if: >` folded scalar of a job, whitespace-normalised. */
function jobIf(text: string, job: string): string {
  const jobLines = block(text, new RegExp(`^  ${job}:\\s*$`), 2);
  const i = jobLines.findIndex((l) => /^ {4}if:\s*>\s*$/.test(l));
  expect(i).toBeGreaterThanOrEqual(0);
  const parts: string[] = [];
  for (let k = i + 1; k < jobLines.length; k++) {
    if (!/^ {6}\S/.test(jobLines[k])) break;
    parts.push(jobLines[k].trim());
  }
  expect(parts.length).toBeGreaterThan(0);
  return parts.join(" ").replace(/\s+/g, " ");
}

/** `on.pull_request.paths` globs of control.yml. */
function pullRequestPaths(text: string): string[] {
  const on = block(text, /^on:\s*$/, 0);
  const pr = on.findIndex((l) => /^ {2}pull_request:\s*$/.test(l));
  expect(pr).toBeGreaterThanOrEqual(0);
  const paths = on.findIndex((l, i) => i > pr && /^ {4}paths:\s*$/.test(l));
  expect(paths).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = paths + 1; i < on.length; i++) {
    const m = /^ {6}- +"?([^"\s]+)"?\s*$/.exec(on[i]);
    if (m) out.push(m[1]);
    else if (on[i].trim() !== "") break;
  }
  return out;
}

/**
 * GitHub's `paths:` glob semantics, enough for this repo: `**` crosses directories (`**\/` also
 * matches zero of them), `*` stays inside one path segment, `?` is one non-slash character.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A file, or a directory (covered when any child path is matched), against a glob list. */
function covered(candidate: string, globs: string[]): boolean {
  const res = globs.map(globToRegExp);
  return res.some((r) => r.test(candidate) || r.test(`${candidate}/x`));
}

// ─── repo paths control's specs read ────────────────────────────────────────────────────────────
const PREFIX =
  /^(?:\.claude\/|\.github\/|\.husky\/|scripts\/|apps\/|packages\/|docs\/|package\.json|package-lock\.json|\.gitignore|\.npmrc|turbo\.json|prettier)/;
/** A spec reaches the repo root by climbing three levels out of apps/control/test (any spelling). */
const CLIMB = /(?:\.\.\/){2}\.\.(?!\.)|"\.\."\s*,\s*"\.\."\s*,\s*"\.\."/;

function walk(dir: string, exts: string[], skip: (p: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    if (fs.statSync(p).isDirectory()) out.push(...walk(p, exts, skip));
    else if (exts.includes(path.extname(p))) out.push(p);
  }
  return out;
}

/**
 * Repo-relative paths read by the specs that reach the REAL repo root (a spec that only writes
 * `.claude/...` into a temp repo it created is a fixture, not a read, and is not required here).
 * Two forms are collected: a whole-path string literal (`".claude/hooks/stop.mjs"`), and a segment
 * join from the root constant (`path.join(REPO_ROOT, "scripts", "campaign", "x.json")`).
 */
function repoReadsOf(text: string): string[] {
  if (!CLIMB.test(text)) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(/"([^"\s]+)"/g)) {
    if (PREFIX.test(m[1])) found.add(m[1]);
  }
  const roots = [
    ...text.matchAll(
      /\bconst\s+(\w+)\s*=\s*path\.(?:resolve|join)\(\s*__dirname\s*,\s*(?:"(?:\.\.\/?)+"|"\.\."(?:\s*,\s*"\.\.")+)\s*\)/g,
    ),
  ].map((m) => m[1]);
  for (const root of roots) {
    const join = new RegExp(`\\b${root}\\s*,\\s*((?:"[^"\\n]*"\\s*,?\\s*)+)\\)`, "g");
    for (const m of text.matchAll(join)) {
      const segs = [...m[1].matchAll(/"([^"\n]*)"/g)].map((s) => s[1]);
      if (segs.length) found.add(segs.join("/"));
    }
  }
  expect(roots.length).toBeGreaterThan(0); // CLIMB without a recognised root const = a parser gap: fail loudly
  return [...found]
    .map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((p) => p !== "" && p !== "apps/control" && !p.startsWith("apps/control/"));
}

/**
 * Repo reads made by control's RUNNING code (src/**), which the specs exercise end to end. They use
 * variables (`apps/${svc}/railway.toml`) or climb out of `dist/`, so they are listed here and each is
 * proven to still exist in src, so this list cannot rot into a lie.
 */
const SRC_RUNTIME_READS: Array<{ path: string; evidence: RegExp }> = [
  { path: "scripts/campaign/plane-denylist.json", evidence: /plane-denylist\.json/ },
  { path: "apps/api/railway.toml", evidence: /apps",\s*svc,\s*"railway\.toml"/ },
  { path: "apps/web/railway.toml", evidence: /apps",\s*svc,\s*"railway\.toml"/ },
];

describe("control.yml — its own CI job (lead ruling 2026-10-01)", () => {
  const lines = code(CONTROL_YML);
  const joined = lines.join("\n");

  it("starts on pull_request (path-filtered, ready_for_review included) and workflow_dispatch, never on push", () => {
    const on = block(CONTROL_YML, /^on:\s*$/, 0).join("\n");
    expect(on).toMatch(/^ {2}pull_request:\s*$/m);
    expect(on).toMatch(/^ {4}types: \[opened, synchronize, reopened, ready_for_review\]\s*$/m);
    expect(on).toMatch(/^ {4}paths:\s*$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:\s*$/m);
    expect(on).not.toMatch(/^ {2}push:/m);
    expect(on).not.toMatch(
      /^ {2}(schedule|deployment_status|repository_dispatch|pull_request_target):/m,
    );
  });

  it("groups per ref and cancels the stale run", () => {
    const c = block(CONTROL_YML, /^concurrency:\s*$/, 0).join("\n");
    expect(c).toMatch(/group:\s*control-\$\{\{\s*github\.ref\s*\}\}/);
    expect(c).toMatch(/cancel-in-progress:\s*true/);
  });

  it("has exactly one job `control`, named `Control (apps/control)`, on ubuntu-latest only, <= 15 min", () => {
    const jobs = block(CONTROL_YML, /^jobs:\s*$/, 0);
    expect(jobs.filter((l) => /^ {2}[\w-]+:\s*$/.test(l)).map((l) => l.trim())).toEqual([
      "control:",
    ]);
    const job = block(CONTROL_YML, /^ {2}control:\s*$/, 2).join("\n");
    expect(job).toMatch(/^ {4}name:\s*Control \(apps\/control\)\s*$/m);
    const runsOn = [...job.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    expect(runsOn).toEqual(["ubuntu-latest"]);
    expect(joined).not.toMatch(/windows|macos|self-hosted/i);
    const t = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(job);
    expect(t).not.toBeNull();
    expect(Number((t as RegExpExecArray)[1])).toBeLessThanOrEqual(15);
    expect(Number((t as RegExpExecArray)[1])).toBeGreaterThan(0);
  });

  it("is read-only, uses no secret and no cache of build output", () => {
    expect(block(CONTROL_YML, /^permissions:\s*$/, 0).join("\n")).toMatch(/contents:\s*read\s*$/m);
    expect(joined).not.toMatch(/secrets\./);
    expect(joined).not.toMatch(/actions\/cache|TURBO_(TOKEN|TEAM)/);
    expect(joined).toMatch(/^\s+cache:\s*npm\s*$/m);
  });

  it("the checkout step does not persist the token into .git/config (persist-credentials: false)", () => {
    const step = block(CONTROL_YML, /^ {6}- uses: actions\/checkout@v\d+\s*$/, 6);
    expect(step.join("\n")).toMatch(/^ {10}persist-credentials:\s*false\s*$/m);
  });

  it("uses ci.yml's checkout/setup-node versions and the same NODE_VERSION", () => {
    for (const action of ["actions/checkout", "actions/setup-node"]) {
      const re = new RegExp(`uses:\\s*(${action}@v\\d+)\\b`);
      const mine = re.exec(joined);
      const theirs = re.exec(code(CI_YML).join("\n"));
      expect(mine).not.toBeNull();
      expect(theirs).not.toBeNull();
      expect((mine as RegExpExecArray)[1]).toBe((theirs as RegExpExecArray)[1]);
    }
    const nodeVersion = (t: string): string | undefined =>
      /^ {2}NODE_VERSION:\s*"(\d+)"\s*$/m.exec(t)?.[1];
    expect(nodeVersion(joined)).toBeDefined();
    expect(nodeVersion(joined)).toBe(nodeVersion(code(CI_YML).join("\n")));
    expect(joined).toMatch(/node-version:\s*\$\{\{\s*env\.NODE_VERSION\s*\}\}/);
  });

  it("installs ONLY control's tree: every `npm ci` is the scoped, script-less form (never a bare one)", () => {
    const installs = lines.filter((l) => /\bnpm\s+(ci|install|i)\b/.test(l));
    expect(installs.length).toBe(1);
    for (const l of installs) {
      expect(l).toMatch(/\bnpm ci\b/);
      expect(l).toContain("-w @routeflow/control");
      expect(l).toContain("--include-workspace-root=false");
      expect(l).toContain("--ignore-scripts");
      expect(l).toContain("--engine-strict=false");
    }
    expect(joined).not.toMatch(/npm ci(?![^\n]*-w @routeflow\/control)/);
    expect(joined).not.toMatch(/npx prisma|prisma generate/);
  });

  it("runs check-types, lint and the CI=1 test, scoped to apps/control, after the install", () => {
    const runs = lines
      .filter((l) => /^\s+run:\s/.test(l))
      .map((l) => l.replace(/^\s+run:\s*/, "").trim());
    expect(runs.slice(1)).toEqual([
      "npm run check-types -w apps/control",
      "npm run lint -w apps/control",
      "CI=1 npm test -w apps/control",
    ]);
    expect(runs[0]).toMatch(/^npm ci /);
  });

  it("carries the SAME `if:` as ci.yml's Verify job (drafts and dependabot[bot] skipped, dispatch allowed)", () => {
    const mine = jobIf(CONTROL_YML, "control");
    const theirs = jobIf(CI_YML, "verify");
    expect(mine).toBe(theirs);
    expect(mine).toContain("github.event_name == 'workflow_dispatch'");
    expect(mine).toContain("github.event.pull_request.draft != true");
    expect(mine).toContain("github.actor != 'dependabot[bot]'");
  });
});

describe("ci.yml — Verify no longer runs control", () => {
  it("the Verify step sets VERIFY_EXCLUDE to include @routeflow/control", () => {
    const step = block(
      CI_YML,
      /^ {6}- name: Verify \(lockfile, bug-signature scan, types, lint, tests\)\s*$/,
      6,
    );
    expect(step.join("\n")).toMatch(/^ {8}run:\s*npm run verify\s*$/m);
    const m = /^ {10}VERIFY_EXCLUDE:\s*"([^"]*)"\s*$/m.exec(step.join("\n"));
    expect(m).not.toBeNull();
    // EXACTLY the one allow-listed name: scripts/verify-turbo.mjs refuses anything else loudly, and a
    // ci.yml edit that adds another workspace must fail here, not only at the first CI run
    expect(
      (m as RegExpExecArray)[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ).toEqual(["@routeflow/control"]);
  });

  it("VERIFY_EXCLUDE is set nowhere else in ci.yml (it must not leak into the e2e job)", () => {
    expect(code(CI_YML).filter((l) => /VERIFY_EXCLUDE:/.test(l)).length).toBe(1);
  });
});

describe("control.yml `paths:` cover every repo path control's specs read (coverage)", () => {
  const globs = pullRequestPaths(CONTROL_YML);

  it("parses a non-empty glob list that includes control itself and the workflow files", () => {
    expect(globs.length).toBeGreaterThan(3);
    for (const must of [
      "apps/control/**",
      ".github/workflows/control.yml",
      ".github/workflows/ci.yml",
      "package.json",
      "package-lock.json",
      ".gitattributes", // governs the golden fixture bytes (`* text=auto eol=lf`)
    ]) {
      expect(covered(must, globs)).toBe(true);
    }
  });

  it("the glob matcher means what GitHub means", () => {
    expect(globToRegExp("apps/control/**").test("apps/control/src/a/b.ts")).toBe(true);
    expect(globToRegExp("apps/control/**").test("apps/controller/x.ts")).toBe(false);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("docs/a/README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("package.json").test("apps/x/package.json")).toBe(false);
    expect(covered(".github/workflows", [".github/workflows/**"])).toBe(true);
    expect(covered(".github/workflows", [".github/workflows/ci.yml"])).toBe(false);
  });

  // This file is skipped by name: it names paths to ASSERT on them (and holds the regexes that find
  // them), and its own reads are the two workflow files, covered by `.github/workflows/**` above.
  const specFiles = walk(
    TEST_DIR,
    [".ts", ".js", ".mjs"],
    (p) => path.relative(TEST_DIR, p).split(path.sep)[0] === "fixtures" || p === __filename,
  );

  it("the scan finds the reads this PR is known to make (so an empty scan cannot pass)", () => {
    const all = new Set(specFiles.flatMap((f) => repoReadsOf(fs.readFileSync(f, "utf8"))));
    for (const known of [
      "scripts/campaign/plane-denylist.json",
      ".claude/hooks/stop.mjs",
      ".claude/control/README.md",
      ".gitignore",
      "package.json",
      ".github/workflows",
    ]) {
      expect(all).toContain(known);
    }
  });

  it("every repo path a spec reads outside apps/control is matched by a paths glob", () => {
    const uncovered: Array<{ read: string; spec: string }> = [];
    for (const f of specFiles) {
      for (const read of repoReadsOf(fs.readFileSync(f, "utf8"))) {
        if (!covered(read, globs)) uncovered.push({ read, spec: path.relative(REPO_ROOT, f) });
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("the running server's own repo reads (src/**) are listed here, still real, and covered", () => {
    const srcText = walk(SRC_DIR, [".ts"])
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const r of SRC_RUNTIME_READS) {
      expect(srcText).toMatch(r.evidence);
      expect(covered(r.path, globs)).toBe(true);
    }
  });
});
