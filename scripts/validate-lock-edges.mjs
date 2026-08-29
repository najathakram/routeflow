#!/usr/bin/env node
// Package-lock edge validator — the check `npm ci` does NOT do.
//
// WHY THIS EXISTS
// npm's arborist validates that every lock entry's *own* resolved tarball is
// present and integrity-matched, but it never re-walks the tree to confirm that
// each entry's declared `dependencies` are actually *reachable* from where that
// entry sits. A lock can therefore describe a tree with holes in it, and
// `npm ci` will install that tree, exit 0, and look perfectly healthy — until
// something lazily `require()`s the missing module at runtime.
//
// That is not hypothetical. During the npm-ci migration (#488) this exact class
// of hole cost two full CI rounds: `@jest/reporters@30.2.0` declares
// istanbul-lib-report, istanbul-reports, istanbul-lib-source-maps, v8-to-istanbul
// and @bcoe/v8-coverage, and `jest-changed-files` declares execa — none of which
// were in the lock at all. `jest --coverage` (a CI-only flag) crashed at report
// time on whichever one it reached first, one per round. Deleting a lock entry
// by hand has the same effect on a larger scale: arborist silently drops the
// whole subtree beneath it and `npm ci` accepts the hole.
//
// WHAT IT DOES
// For every entry in package-lock.json, resolve each declared dependency by the
// same node_modules walk-up Node itself uses (own node_modules, then each
// ancestor's), applying root `overrides`. Three findings fail the build:
//
//   MISSING       — a prod/dev edge that resolves to nothing. The tree has a
//                   hole. Fix by declaring the package (root devDependency is
//                   the established hoist-shim pattern here) and regenerating.
//   WORKSPACE
//   OVERRIDE BREAK— a workspace declares a range that the root `overrides` pin
//                   falls outside. npm 11 resolves this silently; npm 10 — what
//                   CI and every node:20-alpine image run — does NOT apply
//                   overrides in its `ci` validator, floats the declared range
//                   to a phantom subtree and reports ~100 cascading errors that
//                   name everything except the actual cause. This is exactly
//                   what blocked #488 (mobile jest ^30.3.0 vs the 30.2.0 pin),
//                   so it is caught by name here and can never recur silently.
//   SKEW          — the edge resolves, but outside the declared range, and is
//                   not in TOLERATED_SKEWS below. New drift has to be looked at
//                   and either fixed or justified with a written reason.
//
// Override-forced, optional and peer findings are reported for information and
// never fail — unmet peers are endemic in the React Native / React 18-vs-19 tree
// here, and unmet optionals are usually just foreign-platform binaries.
//
// USAGE
//   npm run validate-lock                 # root package-lock.json
//   npm run validate-lock -- --verbose    # also list the informational classes
//   node scripts/validate-lock-edges.mjs <path-to-lock>
//
// Triage of the current baseline: docs/testing/lockfile-edges.md
//
// After ANY manifest edit, regenerate the lock with the npm that CI and Docker
// run (10.x — `npx -y npm@10.8.2 install --package-lock-only --no-audit`), then
// run this. `npm ci --dry-run` catches a different, narrower set of problems;
// run both.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// ─── Baselined version skews ────────────────────────────────────────────────
// Every entry here is a real mismatch between a declared range and the version
// the tree actually resolves. They are tolerated deliberately; each needs a
// reason that says why it is safe, not just that it is old. Match is on the
// (name, found, wanted) triple — deliberately NOT on location, so a dedupe that
// moves a package around does not invalidate the baseline.
//
// To retire one: fix the range or the pin, regenerate the lock, delete the entry.
// To add one: prove the suites pass and write down why the skew is harmless.
// Full write-up, including how to retire the baseline: docs/testing/lockfile-edges.md
const TOLERATED_SKEWS = [
  {
    name: "jest-mock",
    found: "30.5.0",
    wanted: "30.2.0",
    reason:
      "Root-hoisted jest-mock is 30.5.0 even though root `overrides` pin jest-mock to 30.2.0 — npm applies an " +
      "override when it RESOLVES an edge, and a --package-lock-only regeneration keeps pre-existing subtrees " +
      "that predate the pin. Dev-only, and the runner never reaches it: jest@30.2.0 and jest-cli each carry " +
      "their own nested jest-mock@30.2.0, so the 30.5.0 copy is an unused hoist. Retiring it needs a " +
      "from-scratch lock regeneration (see the doc), not a spot edit.",
  },
  {
    name: "jest-mock",
    found: "29.7.0",
    wanted: "30.2.0",
    reason:
      "Same override-doesn't-reach-it mechanism, on the jest-29 island that jest-expo pulls in for mobile. " +
      "@jest/globals@29.7.0 nests its own jest-mock@29.7.0; the island is internally consistent at 29.7.0 " +
      "and dev-only. Mixing it up to 30.2.0 would be the riskier change.",
  },
  {
    name: "@jest/types",
    found: "30.5.0",
    wanted: "30.2.0",
    reason:
      "The 30.5.x jest-util / jest-mock / jest-message-util hoists nest a matching @jest/types@30.5.0. " +
      "Dev-only and self-consistent within that island; every non-dev consumer of @jest/types (metro and " +
      "react-native pull jest packages as production deps) resolves the root 30.2.0 copy, which is the pin.",
  },
  {
    name: "babel-plugin-jest-hoist",
    found: "30.4.0",
    wanted: "30.2.0",
    reason:
      "The only skew here NOT caused by an override: babel-preset-jest@30.2.0 declares an exact sibling pin " +
      "of 30.2.0, and mobile's tree hoisted 30.4.0 over it. Two patch releases apart on a dev-only Babel " +
      "plugin whose whole job is hoisting jest.mock() calls above imports; both mobile and api suites pass on " +
      "it. Pinning it would mean adding a 9th jest entry to `overrides` for no behavioural gain.",
  },
];

// ─── Lock loading ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const lockPath = resolve(args.find((a) => !a.startsWith("--")) ?? "package-lock.json");

/** @type {{ packages?: Record<string, any>, lockfileVersion?: number }} */
let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (err) {
  console.error(`✖ Could not read ${lockPath}: ${err.message}`);
  process.exit(1);
}

const pkgs = lock.packages;
if (!pkgs) {
  console.error(
    `✖ ${lockPath} has no "packages" map (lockfileVersion ${lock.lockfileVersion ?? "?"}). ` +
      "This validator needs lockfileVersion 2 or 3.",
  );
  process.exit(1);
}

// semver is not declared anywhere — it is read out of the installed tree, which
// npm ci has always populated by the time this runs. Without it the range
// comparison is skipped; the hard-missing gate (pure name resolution) still runs,
// and that is the part that actually blocks a broken tree.
const require = createRequire(import.meta.url);
let semver = null;
try {
  semver = require("semver");
} catch {
  console.warn(
    "⚠ semver is not resolvable from the installed tree — version-skew checking is skipped.\n" +
      "  (Run this after `npm ci`. Unresolvable-edge checking is unaffected.)",
  );
}

// ─── Overrides ──────────────────────────────────────────────────────────────
// npm applies a top-level string override to every occurrence of that name in
// the tree, so an edge's effective requirement is the override, not what the
// declarer asked for. The lock does NOT record `overrides` — they have to be
// read from the manifest beside it. Forms handled: "name": "range",
// "name": { ".": "range", … } and "name": "$other" (take root's range for
// `other`).
const rootPkg = pkgs[""] ?? {};
const rootDeclared = { ...(rootPkg.devDependencies ?? {}), ...(rootPkg.dependencies ?? {}) };

let manifestOverrides = {};
try {
  const manifestPath = lockPath.replace(/package-lock\.json$/, "package.json");
  manifestOverrides = JSON.parse(readFileSync(manifestPath, "utf8")).overrides ?? {};
} catch {
  console.warn("⚠ No package.json beside the lockfile — overrides will not be applied.");
}

/** @type {Record<string, string>} */
const overrides = {};
for (const [name, value] of Object.entries(rootPkg.overrides ?? manifestOverrides)) {
  const raw =
    typeof value === "string" ? value : typeof value?.["."] === "string" ? value["."] : null;
  if (!raw) continue; // nested-only override — no direct range for this name
  overrides[name] = raw.startsWith("$") ? (rootDeclared[raw.slice(1)] ?? raw) : raw;
}

// ─── Resolution ─────────────────────────────────────────────────────────────
/**
 * Resolve `name` from lock location `from` the way Node does: the location's own
 * node_modules first, then each ancestor's, ending at the root. Workspace
 * directories (`apps/mobile`) fall straight through to the root, which is where
 * npm actually places their hoisted deps.
 * @returns {string | null} the lock key of the resolved entry
 */
function resolveFrom(from, name) {
  let cur = from;
  for (;;) {
    const candidate = `${cur ? `${cur}/` : ""}node_modules/${name}`;
    if (pkgs[candidate]) return candidate;
    if (cur === "") return null;
    const cut = cur.lastIndexOf("node_modules/");
    cur = cut < 0 ? "" : cur.slice(0, cut).replace(/\/$/, "");
  }
}

const isTolerated = (name, found, wanted) =>
  TOLERATED_SKEWS.some(
    (t) =>
      t.name === name &&
      (t.found === undefined || t.found === found) &&
      (t.wanted === undefined || t.wanted === wanted),
  );

// ─── Walk ───────────────────────────────────────────────────────────────────
const missing = [];
const newSkews = [];
const toleratedHits = [];
const peerSkews = [];
const overrideForced = [];
const overrideBreaksWorkspace = [];
const optMissing = [];
const peerMissing = [];
let exotic = 0;

for (const [loc, meta] of Object.entries(pkgs)) {
  if (meta.link) continue; // workspace symlink — the real entry is the target
  const isWorkspace = !loc.includes("node_modules/");
  // Bundled deps ship inside the parent's tarball and get no lock entry of
  // their own. `true` means "bundle everything declared".
  const bundleField = meta.bundleDependencies ?? meta.bundledDependencies;
  const bundled = Array.isArray(bundleField) ? new Set(bundleField) : null;
  const bundlesAll = bundleField === true;

  const groups = [
    ["dependencies", meta.dependencies ?? {}],
    ["optionalDependencies", meta.optionalDependencies ?? {}],
    ["peerDependencies", meta.peerDependencies ?? {}],
  ];
  // Transitive devDependencies are never installed; only workspaces' own count.
  if (isWorkspace) groups.push(["devDependencies", meta.devDependencies ?? {}]);
  const peerMeta = meta.peerDependenciesMeta ?? {};

  for (const [kind, deps] of groups) {
    for (const [name, declared] of Object.entries(deps)) {
      // `range` is what the edge is actually judged against — the override when
      // one exists, otherwise the declared spec. Both are kept: the gap between
      // them is itself a finding (see the override checks below).
      let range = declared;

      // A package listed in both dependencies and optionalDependencies is a
      // plain dependency; the optional listing only marks install failure OK.
      if (kind === "optionalDependencies" && (meta.dependencies ?? {})[name]) continue;
      if (kind === "peerDependencies" && peerMeta[name]?.optional) continue;
      if (bundlesAll || bundled?.has(name)) continue;

      if (overrides[name]) range = overrides[name];
      if (typeof range !== "string") {
        exotic++;
        continue;
      }

      // Aliases: "left-pad": "npm:pad-left@^2" installs pad-left under the alias
      // name, so resolve by the alias and range-check against the real version.
      if (range.startsWith("npm:")) {
        const m = range.match(/^npm:(@?[^@]+(?:\/[^@]+)?)@(.*)$/);
        if (!m) {
          exotic++;
          continue;
        }
        range = m[2];
      }
      // file:/link:/git/http/workspace: specs carry no comparable version.
      if (/^(file:|link:|git|https?:|workspace:)/.test(range)) {
        exotic++;
        continue;
      }

      const hit = resolveFrom(loc, name);
      if (!hit) {
        const record = { name, range, loc, kind };
        if (kind === "optionalDependencies") optMissing.push(record);
        else if (kind === "peerDependencies") peerMissing.push(record);
        else missing.push(record);
        continue;
      }

      if (!semver) continue;
      const found = pkgs[hit];
      // A resolved workspace link has no meaningful version to compare.
      if (found.link || !found.version) continue;
      if (range === "" || range === "*" || range === "latest") continue;
      // `semver.satisfies` swallows a parse error and returns false, so an
      // unparseable range would read as a mismatch. Some published manifests
      // carry them (tailwindcss-animate asks for ">=3.0.0 || insiders"). If the
      // range cannot be compared, say nothing rather than accuse.
      if (!semver.validRange(range)) {
        exotic++;
        continue;
      }
      const ok = semver.satisfies(found.version, range, { includePrerelease: true });
      const record = { name, found: found.version, at: hit, range, declared, loc, kind };

      if (!ok) {
        // A peer range the tree does not satisfy is what npm itself only warns
        // about — never a gate. Everything else means a hard requirement is unmet.
        if (kind === "peerDependencies") peerSkews.push(record);
        else if (isTolerated(name, found.version, range)) toleratedHits.push(record);
        else newSkews.push(record);
        continue;
      }

      // The edge is satisfied — but only because an override rewrote it. Worth
      // knowing, and in ONE position it is a hard error: when the declarer is a
      // workspace manifest. npm 10 (what CI and every node:20-alpine image run)
      // does not apply overrides in its `ci` tree validator, so it floats the
      // declared range to a phantom newest version and reports that entire
      // subtree — often ~100 cascading Missing/Invalid errors — while npm 11
      // resolves it silently. That is precisely the "works locally, fails in
      // CI and Docker" break that blocked the npm-ci migration (#488): mobile
      // declared jest ^30.3.0 against the root pin of 30.2.0.
      if (!overrides[name] || !semver.validRange(declared)) continue;
      if (semver.satisfies(found.version, declared, { includePrerelease: true })) continue;
      if (isWorkspace) overrideBreaksWorkspace.push(record);
      else overrideForced.push(record);
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────
const rel = lockPath.replace(`${process.cwd()}\\`, "").replace(`${process.cwd()}/`, "");
const line = (r) => `${r.name}@${r.range}  ← ${r.loc || "<root>"} [${r.kind}]`;

if (missing.length) {
  console.error(
    `\n✖ ${missing.length} unresolvable edge(s) — npm ci would install a tree with holes:\n`,
  );
  for (const r of missing) console.error(`   MISSING  ${line(r)}`);
  console.error(
    "\n   Declare each as a root devDependency (the hoist-shim pattern used for the" +
      "\n   jest coverage chain), regenerate the lock with npm@10.x --package-lock-only," +
      "\n   and re-run.",
  );
}

const skewLine = (r) =>
  `${r.name}: found ${r.found} at ${r.at}, wanted ${r.range}  ← ${r.loc || "<root>"} [${r.kind}]`;

if (newSkews.length) {
  console.error(`\n✖ ${newSkews.length} undocumented version skew(s):\n`);
  for (const r of newSkews) console.error(`   SKEW  ${skewLine(r)}`);
  console.error(
    "\n   Either align the range/pin and regenerate the lock, or — if the skew is" +
      "\n   genuinely harmless — add it to TOLERATED_SKEWS in this file WITH A REASON.",
  );
}

if (overrideBreaksWorkspace.length) {
  console.error(
    `\n✖ ${overrideBreaksWorkspace.length} workspace range(s) that a root override contradicts:\n`,
  );
  for (const r of overrideBreaksWorkspace)
    console.error(
      `   ${r.loc}/package.json declares ${r.name}@${r.declared}, but the root override pins ${r.range} (tree has ${r.found})`,
    );
  console.error(
    "\n   npm 10 — what CI and the node:20-alpine images run — does not apply" +
      "\n   overrides in its `ci` tree validator. It floats the declared range to a" +
      "\n   phantom newest version and reports that whole subtree as Missing/Invalid" +
      "\n   (~100 cascading errors), while npm 11 resolves it silently. Widen the" +
      "\n   workspace range to include the override pin, then regenerate the lock.",
  );
}

// Informational classes — real signal, but never a gate.
const info = [
  ["tolerated skew", toleratedHits, skewLine],
  [
    "override-forced edge",
    overrideForced,
    (r) => `${r.name}: ${r.declared} → ${r.range}  ← ${r.loc}`,
  ],
  ["unsatisfied peer range", peerSkews, skewLine],
  ["unmet optional", optMissing, (r) => `${r.name}@${r.range}  ← ${r.loc || "<root>"}`],
  ["unmet peer", peerMissing, (r) => `${r.name}@${r.range}  ← ${r.loc || "<root>"}`],
];

if (verbose) {
  for (const [label, list, fmt] of info) {
    if (!list.length) continue;
    console.log(`\n${list.length} ${label}(s):`);
    for (const r of list) console.log(`   ${fmt(r)}`);
  }
}

const counts =
  `${Object.keys(pkgs).length} entries · missing ${missing.length} · ` +
  `skew ${newSkews.length} new / ${toleratedHits.length} tolerated · ` +
  `override-forced ${overrideForced.length} · peer ${peerSkews.length + peerMissing.length}` +
  (optMissing.length ? ` · optional ${optMissing.length}` : "") +
  (exotic ? ` · ${exotic} non-versioned skipped` : "") +
  (semver ? "" : " · SKEW CHECK SKIPPED (no semver)");

if (missing.length || newSkews.length || overrideBreaksWorkspace.length) {
  console.error(`\n${rel}: ${counts}\n`);
  process.exit(1);
}
console.log(`✔ ${rel}: every dependency edge resolves. ${counts}`);
if (!verbose && info.some(([, list]) => list.length))
  console.log("  (--verbose lists the tolerated, override-forced and peer edges)");
