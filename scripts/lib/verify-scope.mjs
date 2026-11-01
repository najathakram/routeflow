// Affected-scope selection for the pre-push verify (owner ruling 2026-09-19).
//
// A push from a feature branch used to run check-types/lint/Jest for EVERY workspace. That is
// the right gate for master and for the coordinator's landing (FULL_VERIFY=1), and pure waste for
// a branch that touched one app. This module decides which workspaces a diff actually reaches:
// the changed workspaces plus everything that depends on them (a change under packages/pricing
// selects api + web + mobile, exactly as turbo's `...[origin/master]` filter would), and falls
// back to FULL whenever the diff touches a file that feeds every workspace (manifests, lockfile,
// turbo config, CI, hooks, the campaign ledger) or the scope cannot be computed.
//
// Two tripwires ALWAYS run in a scoped verify, whatever the diff — both are specs that reach
// outside their own workspace (see turbo.json): `@routeflow/pricing#test` (no-mirrors walks
// apps/*, package-shape reads the Dockerfiles) and apps/api's `test:repo-truth`.
//
// Pure functions + one git wrapper; scripts/verify-turbo.mjs is the consumer (it also asks
// scripts/campaign-check.mjs --print-stale which reports are refused, and adds those workspaces),
// scripts/verify-turbo.self-test.mjs is the proof.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { scrubbedGitEnv } from "./check-git-hooks.mjs";

// Files whose change can move every workspace's result — a scoped run would be a false green.
const FULL_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^turbo\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^prettier\.config\.[cm]?js$/,
  /^\.prettierrc/,
  /^eslint\.config\./,
  /^docker-compose[^/]*\.ya?ml$/,
  /^\.husky\//,
  /^\.github\//,
  /^\.claude\/campaign\//, // the ledger shards feed campaign-check's freshness for every workspace
  /^apps\/[^/]+\/package\.json$/,
  /^packages\/[^/]+\/package\.json$/,
];

// Files outside every workspace whose specs live in a workspace: root scripts and the hook/skill
// scripts are executed by apps/api's plain `test` lane (campaign-check-freshness.spec.ts,
// skip-verify-audit-script.spec.ts, rls-preflight.spec.ts ...), so a change there must select api.
const PULLS_IN = [
  { re: /^scripts\//, workspace: "@routeflow/api" },
  { re: /^\.claude\/(hooks|skills)\//, workspace: "@routeflow/api" },
];

/** Read the npm-workspaces graph (name, dir, in-repo dependencies) from the package.json files. */
export function loadWorkspaces(root) {
  const workspaces = [];
  for (const parent of ["apps", "packages"]) {
    const base = join(root, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      workspaces.push({
        name: pkg.name,
        dir: `${parent}/${entry.name}`,
        deps: Object.keys({
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
        }),
      });
    }
  }
  const names = new Set(workspaces.map((w) => w.name));
  return workspaces.map((w) => ({ ...w, deps: w.deps.filter((d) => names.has(d)) }));
}

/**
 * changedFiles: repo-relative POSIX paths. Returns
 *   { mode: "full", reason }                       — run the whole chain, or
 *   { mode: "scoped", workspaces: [names], changed: [names] }
 * `workspaces` = changed ∪ transitive dependents ∪ the always-run pricing tripwire.
 */
export function computeScope(changedFiles, workspaces) {
  const files = changedFiles.map((f) => f.replace(/\\/g, "/")).filter(Boolean);
  const fullHit = files.find((f) => FULL_PATTERNS.some((re) => re.test(f)));
  if (fullHit) return { mode: "full", reason: `${fullHit} feeds every workspace` };

  const changed = new Set();
  for (const f of files) {
    const ws = workspaces.find((w) => f === w.dir || f.startsWith(`${w.dir}/`));
    if (ws) changed.add(ws.name);
  }

  const selected = new Set(changed);
  for (const f of files) {
    for (const { re, workspace } of PULLS_IN) {
      if (re.test(f) && workspaces.some((w) => w.name === workspace)) selected.add(workspace);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of workspaces) {
      if (!selected.has(w.name) && w.deps.some((d) => selected.has(d))) {
        selected.add(w.name);
        grew = true;
      }
    }
  }
  const pricing = workspaces.find((w) => w.name === "@routeflow/pricing");
  if (pricing) selected.add(pricing.name);

  return {
    mode: "scoped",
    changed: [...changed].sort(),
    workspaces: [...selected].sort(),
  };
}

/** Short campaign-check workspace key ("api" | "web" | "mobile" | "pricing") for a package name. */
export const shortName = (pkgName) => pkgName.replace(/^@routeflow\//, "");

/**
 * process.env minus every GIT_* variable (the B420 hijack guard). Not a copy: the ONE definition is
 * scripts/lib/scrubbed-git-env.cjs, reached here through check-git-hooks.mjs.
 */
export const cleanGitEnv = scrubbedGitEnv;

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: cleanGitEnv() });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/**
 * FAST VERIFY (owner ruling 2026-10-10, "Fast local check, full in CI").
 *
 * A feature-branch push runs check-types + lint for the affected workspaces and ONLY the Jest tests
 * related to the changed files (`--changedSince=<merge-base with origin/master>`); the full suite runs
 * in CI on every train/PR, which is the authority. Three pure pieces, one policy:
 *  - `wantsFastVerify`  the POLICY (not CI, not FULL_VERIFY=1, not master/main/detached) — the pre-push
 *                       hook asks it through `scripts/verify-mode.mjs` and, on "fast", exports
 *                       RF_VERIFY_MODE=fast.
 *  - `isFastMode`       the explicit SWITCH every consumer reads (verify-turbo, decideScope,
 *                       campaign-check): RF_VERIFY_MODE is exactly "fast" AND the run is neither CI nor
 *                       FULL_VERIFY=1 — so a stray exported value can never narrow CI or a landing run.
 *  - `mergeBaseSha`     the one sha the related-only filter hangs off; null = uncomputable, and every
 *                       caller then falls back to the FULL plan (loudly).
 */
export const FAST_VERIFY_BANNER =
  "FAST VERIFY (owner 2026-10-10): types + lint for affected workspaces, related tests only; the full suite runs in CI. FULL_VERIFY=1 runs everything.";

const TRUNK = new Set(["master", "main", "HEAD"]);

export function wantsFastVerify({ env = process.env, branch } = {}) {
  if (env.CI) return false;
  if (env.FULL_VERIFY === "1") return false;
  if (!branch || TRUNK.has(branch)) return false;
  return true;
}

export function isFastMode(env = process.env) {
  return env.RF_VERIFY_MODE === "fast" && !env.CI && env.FULL_VERIFY !== "1";
}

/**
 * "A fast push is not proof" (lead ruling 2026-10-28). Three PRs passed a fast push while red on a
 * full verify: the related-only lane never runs the repo-wide pins, and the api unit config ignores
 * every `-script.spec.ts`. So (1) every fast run ends with this exact line, here, in verify-turbo and
 * in .husky/pre-push (its skip line too), and (2) a diff that can break a pin also runs them.
 */
export const FAST_NOT_PROOF_LINE =
  "fast: not proof (related tests only; run FULL_VERIFY=1 or CI before a merge-ready claim)";

/** The final line of a run: the stamp for a fast run, null (print nothing new) otherwise. */
export function fastStampLine(fast) {
  return fast ? FAST_NOT_PROOF_LINE : null;
}

/**
 * Specs under apps/api/src that read the WHOLE repo (scripts/, hooks, manifests) rather than one
 * module, so `--changedSince` never relates them to a scripts/hooks/manifest edit. Run on a fast
 * push whose diff `repoPinsNeeded`. Keep each entry's reason honest; the self-test pins existence.
 */
export const REPO_WIDE_PINS = [
  {
    file: "apps/api/src/common/scripts-live-target-guard.spec.ts",
    why: "walks every scripts/*.mjs for live-DB targeting",
  },
  {
    file: "apps/api/src/common/fixture-git-env-scrub.spec.ts",
    why: "walks scripts/.claude/.husky for unscrubbed git spawns",
  },
  {
    file: "apps/api/src/common/scripts-product-mirror-tripwire.spec.ts",
    why: "scans scripts/ and apps/api/scripts for product mirrors",
  },
  {
    file: "apps/api/src/common/script-money-writers.spec.ts",
    why: "scans scripts/ for unrounded money writes",
  },
  {
    file: "apps/api/src/common/script-spec-lane.spec.ts",
    why: "reads apps/api/package.json jest lanes against the spec tree",
  },
  {
    file: "apps/api/src/common/local-scripts-forwarding.spec.ts",
    why: "reads the root package.json local:* contract",
  },
  {
    file: "apps/api/src/common/local-db-specs.spec.ts",
    why: "reads the root package.json and scripts/local-db-specs.mjs",
  },
  {
    file: "apps/api/src/common/turbo-inputs.spec.ts",
    why: "reads the root package.json and turbo.json inputs",
  },
  {
    file: "apps/api/src/common/scan-signatures-selftest.spec.ts",
    why: "walks .claude/skills/*/scripts and scripts/",
  },
  {
    file: "apps/api/src/common/no-runtime-ddl.spec.ts",
    why: "greps apps/api/scripts and src for runtime DDL",
  },
  {
    file: "apps/api/src/common/scripts-unscoped-delete.spec.ts",
    why: "walks apps/api/scripts and scripts/ for unscoped deleteMany/updateMany",
  },
  {
    file: "apps/api/src/common/owner-report-db-url.spec.ts",
    why: "walks apps/api/scripts for report scripts that read a DB url unsafely",
  },
  {
    file: "apps/api/src/common/no-ui-package-import.spec.ts",
    why: "scans apps/api/scripts (and src, prisma) for imports of the ui package",
  },
  {
    file: "apps/api/src/common/wipe-order-fk-pin.spec.ts",
    why: "reads apps/api/scripts/wipe-tenant-fresh-start.js and reset-and-seed.ts",
  },
  {
    file: "apps/api/src/common/schema-folder.spec.ts",
    why: "runs apps/api/scripts/split-prisma-schema.mjs --check against the schema folder",
  },
  {
    file: "apps/api/src/common/no-single-schema-path.spec.ts",
    why: "scans for single-file schema paths; exempts apps/api/scripts/split-prisma-schema.mjs",
  },
  {
    file: "apps/api/src/common/husky-hooks-tracked.spec.ts",
    why: "reads the git index for .husky and .husky/_ (a hook edit must keep the tracked stubs)",
  },
];

/** Paths whose edit can break a repo-wide pin or a `-script` spec. */
const PIN_TRIGGERS = [
  /^scripts\//,
  /^\.husky\//,
  /^\.claude\/hooks\//,
  /^\.claude\/skills\/[^/]+\/scripts\//,
  /(^|\/)package\.json$/,
  /^apps\/api\/src\/common\//,
  // The api jest rootDir is src, so --changedSince never relates a file here to the specs that walk it.
  /^apps\/api\/scripts\//,
  // A changed `-script` spec outside src/common must run itself too.
  /-script\.spec\.ts$/,
];

/**
 * `crossScript` = the `-script` specs that read ANOTHER workspace ([{ file, reads }], from the derived list in
 * scripts/lib/cross-workspace-specs.cjs). An edit under a directory such a spec reads needs it too, though no
 * PIN_TRIGGER matches: `--changedSince` follows imports, not fs reads, so nothing else would run it.
 */
export function repoPinsNeeded(files, crossScript = []) {
  const norm = (files ?? []).map((f) => f.replaceAll("\\", "/"));
  return (
    norm.some((f) => PIN_TRIGGERS.some((re) => re.test(f))) ||
    norm.some((f) => readByCrossScript(f, crossScript).length > 0)
  );
}

/** The cross-workspace `-script` specs whose read directories contain `file` (a "/"-separated repo path). */
function readByCrossScript(file, crossScript) {
  return crossScript.filter((s) => s.reads.some((dir) => file.startsWith(`${dir}/`)));
}

/**
 * Every `-script.spec.ts` (the api unit config ignores them). A full or fail-closed run uses this pattern
 * to select all of them. Literal-dot classes keep cmd.exe quoting trivial.
 */
export const SCRIPT_SPEC_PATTERN = "-script[.]spec[.]ts$";

/**
 * Serial, the whole set measured ~568 s (66 specs), too slow for a fast push, so a fast run picks the
 * RELATED `-script` specs instead (`selectScriptSpecs`). This one always runs: it guards the escape hatch.
 */
export const ALWAYS_SCRIPT_SPEC = "skip-verify-audit-script.spec.ts";

// Basenames too common to relate a spec by name: the pins already cover manifests.
const GENERIC_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "turbo.json",
  "index.ts",
  "index.js",
  "index.mjs",
  "README.md",
]);

/** Every apps/api `-script.spec.ts` as { file (relative to apps/api), text }. */
export function loadScriptSpecs(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules") continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}/${e.name}`);
      else if (e.name.endsWith("-script.spec.ts")) {
        out.push({ file: `${rel}/${e.name}`, text: readFileSync(join(dir, e.name), "utf8") });
      }
    }
  };
  walk(join(root, "apps", "api", "src"), "src");
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Which `-script` specs a fast run executes: the always-on audit spec plus every spec whose file name
 * or source text mentions a changed file's path or basename (plain substring reads, no import parsing).
 * `files` null (diff not computable) selects ALL ("all"): fail closed. Returns
 * { files: string[] | "all", line }, one line with the count and why.
 */
export function selectScriptSpecs({ files, specs, crossScript = [] }) {
  if (files === null) {
    return {
      files: "all",
      line: `+ SCRIPT SPECS: all ${specs.length} (cannot diff, fail closed).`,
    };
  }
  if (specs.length === 0) {
    return {
      files: "all",
      line: "+ SCRIPT SPECS: all (no -script specs found on disk, fail closed).",
    };
  }
  const changed = files.map((f) => f.replaceAll("\\", "/"));
  const needles = changed.flatMap((f) => {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (GENERIC_BASENAMES.has(base)) return [];
    const bare = base.replace(/\.[^.]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [{ path: f, base, importRe: new RegExp(`/${bare}["'\`]`) }];
  });
  const always = specs.filter((s) => s.file.endsWith(ALWAYS_SCRIPT_SPEC));
  const why = [];
  const related = [];
  for (const s of specs) {
    if (always.includes(s)) continue;
    const name = s.file.slice(s.file.lastIndexOf("/") + 1);
    const hit = needles.find(
      (n) =>
        name === n.base ||
        // TypeScript imports drop the extension: `from "./calendar-date"`.
        n.importRe.test(s.text) ||
        name === `${n.base.replace(/\.[^.]+$/, "")}-script.spec.ts` ||
        s.text.includes(n.path) ||
        s.text.includes(n.base),
    );
    if (hit) {
      related.push(s.file);
      why.push(`${name} (${hit.base})`);
      continue;
    }
    // Reads another workspace: an edit anywhere under what it reads selects it, named or not.
    const reader = crossScript.find((c) => s.file === c.file);
    const touched = reader && changed.find((f) => readByCrossScript(f, [reader]).length > 0);
    if (touched) {
      related.push(s.file);
      why.push(`${name} (reads ${reader.reads.find((d) => touched.startsWith(`${d}/`))})`);
    }
  }
  const picked = [...always.map((s) => s.file), ...related];
  return {
    files: picked,
    line:
      `+ SCRIPT SPECS: ${picked.length} of ${specs.length} (always ${ALWAYS_SCRIPT_SPEC}` +
      (why.length ? `; related: ${why.join(", ")}` : "; none related") +
      ").",
  };
}

/** The checked-out branch name ("HEAD" when detached), or null when git cannot say. */
export function currentBranch(root) {
  const out = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out === null ? null : out.trim() || null;
}

/** 40-hex merge-base of `base` and HEAD, or null when it cannot be computed. */
export function mergeBaseSha(root, base = "origin/master") {
  const out = git(root, ["merge-base", base, "HEAD"]);
  const sha = out === null ? "" : out.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Every file that differs from the merge-base with `base` (committed, staged, unstaged, untracked). */
export function changedFilesSince(root, base = "origin/master") {
  const mergeBase = git(root, ["merge-base", base, "HEAD"]);
  if (mergeBase === null) return null;
  // --no-renames: a move across workspaces must report BOTH paths, or the workspace that lost
  // the file (whose importers now dangle) would never be checked.
  const diff = git(root, ["diff", "--name-only", "--no-renames", mergeBase.trim()]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  if (diff === null || untracked === null) return null;
  return [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))];
}

/**
 * The scope decision for an actual verify run. Affected scope is the DEFAULT on any non-master
 * branch (owner ruling 2026-09-19); the ONLY override is FULL_VERIFY=1 (the coordinator's landing
 * run). CI, master/main and a detached HEAD are always full, and so is any diff that cannot be
 * computed. `probe` ({ branch, files }) is a test seam for those two git reads — plain
 * parameters, never environment, so there is no ambient switch that can quietly narrow a run.
 */
export function decideScope(root, env = process.env, probe = {}) {
  if (env.FULL_VERIFY === "1") return { mode: "full", reason: "FULL_VERIFY=1" };
  if (env.CI) return { mode: "full", reason: "CI" };
  // `in`, not `??`: an explicit probe value of null/undefined MEANS "uncomputable" (the S6e case) —
  // `??` treated it as "not supplied" and fell through to the real repo's diff.
  const branch =
    "branch" in probe ? probe.branch : git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  if (!branch || branch === "master" || branch === "main" || branch === "HEAD") {
    return { mode: "full", reason: `branch ${branch || "unknown"}` };
  }
  const files = "files" in probe ? probe.files : changedFilesSince(root);
  if (files === null) return { mode: "full", reason: "cannot diff against origin/master" };
  const workspaces = loadWorkspaces(root);
  const scope = computeScope(files, workspaces);
  // Only a scoped decision can use the answer (a full run already covers every workspace), so a
  // diff that tripped a FULL pattern never pays the spawn. `probe.stale` is the same kind of test
  // seam as branch/files: the workspaces whose campaign report is refused (see staleWorkspaces).
  if (scope.mode !== "scoped") return scope;
  // FAST VERIFY (isFastMode): local runs execute related tests only, and campaign-check defers report
  // coverage to CI, so a stale report is no reason to widen the run — and the --print-stale spawn is
  // skipped outright. Outside fast mode this is exactly the previous behaviour.
  if (isFastMode(env)) return withStale(scope, []);
  const stale = "stale" in probe ? probe.stale : staleWorkspaces(root, workspaces);
  return withStale(scope, stale);
}

/**
 * Workspaces whose campaign report (.campaign/runs/<ws>.json) `campaign-check` would refuse —
 * missing, partial or stale — from its read-only `--print-stale`. A scoped run that never touched
 * such a workspace would leave the report as it is and then be refused at the end of verify for
 * evidence it had no reason to regenerate; adding the workspace puts its tests in the run, and
 * turbo rewrites the report when they actually execute (a cache MISS). On a cache HIT turbo
 * replays without running jest — the `--freshness-only` pre-step earlier in `npm run verify`
 * forces a real run for exactly that case (order pinned by verify-turbo.self-test SP8). FAILS
 * OPEN ([]): an unanswerable question must never narrow or break a run — the end-of-verify check
 * still enforces freshness exactly as before. `cleanGitEnv` is an alias of the shared
 * `scrubbedGitEnv` (scripts/lib/scrubbed-git-env.cjs), the one prefix filter that drops every
 * GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG* ...).
 */
export function staleWorkspaces(root, workspaces = loadWorkspaces(root)) {
  const r = spawnSync(
    process.execPath,
    [join(root, "scripts", "campaign-check.mjs"), "--print-stale"],
    {
      cwd: root,
      encoding: "utf8",
      env: cleanGitEnv(),
    },
  );
  if (r.error || r.status !== 0) return [];
  const known = new Set(workspaces.map((w) => w.name));
  return [
    ...new Set(
      r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => known.has(l)),
    ),
  ].sort();
}

/**
 * Adds stale workspaces to a SCOPED decision (a full run already covers them). Only the workspace
 * itself is added — its report is regenerated by its own tests, not by its dependents'. `stale` on
 * the result lists the ones this pulled in beyond the diff's own reach, for the printout.
 */
export function withStale(scope, stale) {
  if (scope.mode !== "scoped") return scope;
  const wanted = (stale ?? []).filter((n) => typeof n === "string" && n);
  const pulled = wanted.filter((n) => !scope.workspaces.includes(n)).sort();
  if (!pulled.length) return { ...scope, stale: [] };
  return {
    ...scope,
    workspaces: [...new Set([...scope.workspaces, ...pulled])].sort(),
    stale: pulled,
  };
}
