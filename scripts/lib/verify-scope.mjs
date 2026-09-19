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
// Pure functions + one git wrapper; scripts/verify-turbo.mjs and scripts/campaign-check.mjs are
// the consumers, scripts/verify-turbo.self-test.mjs is the proof.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

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

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
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
 * The scope decision for an actual verify run. Scoped ONLY when the pre-push hook opted in
 * (VERIFY_SCOPE=affected) — a hand-run `npm run verify` and CI stay full — and never on master
 * or under FULL_VERIFY=1.
 */
export function decideScope(root, env = process.env) {
  if (env.VERIFY_SCOPE !== "affected") return { mode: "full", reason: "VERIFY_SCOPE not set" };
  if (env.FULL_VERIFY === "1") return { mode: "full", reason: "FULL_VERIFY=1" };
  if (env.CI) return { mode: "full", reason: "CI" };
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  if (!branch || branch === "master" || branch === "main" || branch === "HEAD") {
    return { mode: "full", reason: `branch ${branch || "unknown"}` };
  }
  const files = changedFilesSince(root);
  if (files === null) return { mode: "full", reason: "cannot diff against origin/master" };
  return computeScope(files, loadWorkspaces(root));
}
