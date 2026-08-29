#!/usr/bin/env node
// ─── package-lock.json edge validator ───────────────────────────────────────────
//
// npm's arborist accepts lockfile trees with UNRESOLVABLE dependency edges:
// `npm ci` will happily install a tree where a package's deps are simply absent,
// and the failure only surfaces at runtime. Discovered on PR #488 (npm-ci
// migration), where @jest/reporters' istanbul deps and jest-changed-files'
// execa were missing from the tree — jest ran, `jest --coverage` crashed.
//
// This script re-walks every dependency edge in the lockfile and resolves it the
// way Node would (node_modules walk-up among the lock's `packages` keys):
//
//   • HARD-MISSING  — a regular/dev dependency that resolves to nothing. FAILS
//                     (exit 1) unless the edge is listed in the baseline file
//                     (lock-validate.baseline.txt, next to this script), which
//                     exists to consciously tolerate a known hole while its
//                     lockfile fix is in flight (it held #488's 12 edges until
//                     that lock regeneration landed; it is empty since).
//                     Baselined edges are reported as warnings; baseline entries
//                     that no longer fail are flagged as stale so the file
//                     shrinks back to empty. `--write-baseline` regenerates it.
//   • MISMATCH      — the edge resolves, but the found version does not satisfy
//                     the declared range. WARNING only: the tree has a known
//                     baseline of benign skews (react-is 16 vs pretty-format's
//                     optional ^18/^19 aliases, nested @jest 30.5-vs-30.2 exact
//                     pins from the root jest overrides, react peer skews) that
//                     4300+ passing tests tolerate today. `--strict` promotes
//                     mismatches to failures.
//   • OPT-MISSING / PEER-MISSING — informational; optional deps and peers are
//                     allowed to be absent.
//
// Zero dependencies on purpose (hand-rolled semver subset below): CI runs this
// on a bare checkout with only Node — no install step.
//
// Usage: node scripts/lock-validate.mjs [path/to/package-lock.json] [--strict] [--write-baseline]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── minimal semver (node-semver `satisfies` with includePrerelease: true) ──────

const VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

function parseVersion(str) {
  const m = VERSION_RE.exec(String(str).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

function cmpIdent(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(+a - +b);
  if (an) return -1; // numeric identifiers sort before alphanumeric
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpVersion(a, b) {
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch);
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1; // release > prerelease
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const c = cmpIdent(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return Math.sign(a.pre.length - b.pre.length);
}

const PARTIAL_RE =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

function parsePartial(str) {
  const m = PARTIAL_RE.exec(str);
  if (!m) return null;
  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? undefined : +s);
  return { major: num(m[1]), minor: num(m[2]), patch: num(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

const ver = (major, minor, patch, pre = []) => ({ major, minor, patch, pre });
const ZERO_PRE = ["0"]; // "-0": lowest possible prerelease, used for open upper bounds

// Expand one range token into primitive comparators [{op, v}]. Returns null on
// an unparsable token; [] means "matches everything".
function expandToken(token) {
  if (token === "" || token === "*" || /^[xX]$/.test(token)) return [];
  const opMatch = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
  const op = opMatch[1] || "";
  const p = parsePartial(opMatch[2]);
  if (!p) return null;
  const { major: M, minor: m, patch: pt, pre } = p;
  if (M === undefined) return op === "<" ? null : []; // ">*" et al. — treat as any
  const lower = ver(M, m ?? 0, pt ?? 0, pre);

  if (op === "^") {
    let upper;
    if (M > 0 || m === undefined) upper = ver(M + 1, 0, 0, ZERO_PRE);
    else if (m > 0 || pt === undefined) upper = ver(0, m + 1, 0, ZERO_PRE);
    else upper = ver(0, m, pt + 1, ZERO_PRE);
    return [
      { op: ">=", v: lower },
      { op: "<", v: upper },
    ];
  }
  if (op === "~") {
    const upper = m === undefined ? ver(M + 1, 0, 0, ZERO_PRE) : ver(M, m + 1, 0, ZERO_PRE);
    return [
      { op: ">=", v: lower },
      { op: "<", v: upper },
    ];
  }
  if (op === ">") {
    // ">1.2" means ">=1.3.0", ">1" means ">=2.0.0" (node-semver x-range rules)
    if (pt === undefined)
      return [{ op: ">=", v: m === undefined ? ver(M + 1, 0, 0) : ver(M, m + 1, 0) }];
    return [{ op: ">", v: lower }];
  }
  if (op === "<") return [{ op: "<", v: pt === undefined ? ver(M, m ?? 0, 0, ZERO_PRE) : lower }];
  if (op === ">=") return [{ op: ">=", v: lower }];
  if (op === "<=") {
    // "<=1.2" means "<1.3.0-0", "<=1" means "<2.0.0-0"
    if (pt === undefined)
      return [
        { op: "<", v: m === undefined ? ver(M + 1, 0, 0, ZERO_PRE) : ver(M, m + 1, 0, ZERO_PRE) },
      ];
    return [{ op: "<=", v: lower }];
  }
  // bare or "=": exact when full, x-range when partial
  if (pt !== undefined) return [{ op: "=", v: lower }];
  const upper = m === undefined ? ver(M + 1, 0, 0, ZERO_PRE) : ver(M, m + 1, 0, ZERO_PRE);
  return [
    { op: ">=", v: lower },
    { op: "<", v: upper },
  ];
}

function matches(v, { op, v: c }) {
  const d = cmpVersion(v, c);
  if (op === "=") return d === 0;
  if (op === ">") return d > 0;
  if (op === ">=") return d >= 0;
  if (op === "<") return d < 0;
  return d <= 0; // <=
}

// Returns true/false, or null when nothing matched AND part of the range was
// unparsable (e.g. a dist-tag alternative like ">=3.0.0 || insiders") — a
// parsable alternative that matches still wins over an unparsable sibling.
function satisfies(versionStr, rangeStr) {
  const v = parseVersion(versionStr);
  if (!v) return null;
  const range = String(rangeStr).trim();
  if (range === "" || range === "*" || range === "latest") return true;
  let sawUnparsable = false;
  for (const alt of range.split("||")) {
    const set = alt.trim().replace(/([<>=~^])\s+/g, "$1"); // ">= 1.2" → ">=1.2"
    const comps = [];
    let bad = false;
    // hyphen ranges: "1.2.3 - 2.x" → >=1.2.3 <3.0.0-0
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hyphen) {
      const lo = expandToken(">=" + hyphen[1]);
      const hi = expandToken("<=" + hyphen[2]);
      if (!lo || !hi) bad = true;
      else comps.push(...lo, ...hi);
    } else {
      for (const t of set.split(/\s+/)) {
        const c = expandToken(t);
        if (!c) {
          bad = true;
          break;
        }
        comps.push(...c);
      }
    }
    if (bad) {
      sawUnparsable = true;
      continue;
    }
    if (comps.every((c) => matches(v, c))) return true;
  }
  return sawUnparsable ? null : false;
}

// ─── lockfile walk ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const writeBaseline = args.includes("--write-baseline");
const lockPath = resolve(args.find((a) => !a.startsWith("--")) || "./package-lock.json");
const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "lock-validate.baseline.txt");
const baseline = new Set(
  existsSync(baselinePath)
    ? readFileSync(baselinePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [],
);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const pkgs = lock.packages;
if (!pkgs) {
  console.error(
    `No "packages" map in ${lockPath} (lockfileVersion ${lock.lockfileVersion}) — need v2/v3.`,
  );
  process.exit(2);
}
// Root overrides replace ranges tree-wide (this lock does not carry them in
// packages[""], so read the manifest). Only the simple string form is handled —
// the only form this repo uses.
const manifest = JSON.parse(readFileSync(join(dirname(lockPath), "package.json"), "utf8"));
const overrides = pkgs[""]?.overrides ?? manifest.overrides ?? {};

// Node's resolution order: ./node_modules/<name>, then each ancestor's.
function resolveFrom(fromLoc, name) {
  const bases = [];
  let cur = fromLoc;
  for (;;) {
    bases.push(cur);
    if (cur === "") break;
    const i = cur.lastIndexOf("node_modules/");
    if (i < 0) {
      bases.push(""); // workspace dir (apps/x) → fall through to the root
      break;
    }
    cur = cur.slice(0, i).replace(/\/+$/, "");
  }
  for (const b of bases) {
    const cand = (b ? b + "/" : "") + "node_modules/" + name;
    if (pkgs[cand]) return cand;
  }
  return null;
}

let hard = 0,
  mism = 0,
  optMiss = 0,
  peerMiss = 0,
  exotic = 0,
  unparsed = 0;
const hardEdges = []; // every hard-missing edge key, baselined or not
const baselineHits = new Set();

for (const [loc, meta] of Object.entries(pkgs)) {
  if (meta.link) continue; // workspace symlink stub — the target entry is walked itself
  const isWorkspace = loc === "" || !loc.includes("node_modules/");
  const groups = [
    ["dep", meta.dependencies || {}],
    ["opt", meta.optionalDependencies || {}],
    ["peer", meta.peerDependencies || {}],
  ];
  // devDependencies are only installed for the root + workspaces, not for
  // packages inside node_modules — only check them where npm installs them.
  if (isWorkspace) groups.push(["dev", meta.devDependencies || {}]);
  const peerMeta = meta.peerDependenciesMeta || {};

  for (const [kind, deps] of groups) {
    for (const [name, declared] of Object.entries(deps)) {
      if (kind === "opt" && (meta.dependencies || {})[name]) continue; // duplicated edge
      const optionalPeer = kind === "peer" && peerMeta[name]?.optional;

      // Overrides replace the declared spec wholesale (string form).
      let spec = typeof overrides[name] === "string" ? overrides[name] : declared;

      // npm: alias — the package is installed under the ALIAS name (the key),
      // so resolve by the key; only the range after the last "@" applies.
      // (Resolving by the aliased TARGET name finds the wrong entry — e.g.
      // @isaacs/cliui's string-width-cjs → npm:string-width@^4.2.0 must check
      // node_modules/string-width-cjs, not the hoisted string-width.)
      if (spec.startsWith("npm:")) {
        const at = spec.lastIndexOf("@");
        if (at <= 4) {
          exotic++;
          continue; // "npm:name" with no range — nothing to check
        }
        spec = spec.slice(at + 1);
      }
      if (/^(file:|link:|git|http|workspace:)/.test(spec)) {
        exotic++;
        continue;
      }

      const hit = resolveFrom(loc, name);
      const at = loc || "(root)";
      if (!hit) {
        if (kind === "opt") {
          optMiss++;
          console.log(`OPT-MISSING  ${name}@${declared}  needed by ${at}`);
        } else if (kind === "peer") {
          if (!optionalPeer) {
            peerMiss++;
            console.log(`PEER-MISSING ${name}@${declared}  needed by ${at}`);
          }
        } else {
          const key = `${loc} :: ${name}@${declared}`;
          hardEdges.push(key);
          if (baseline.has(key)) {
            baselineHits.add(key);
            console.log(`MISSING      ${name}@${declared}  needed by ${at} [${kind}] (baselined)`);
          } else {
            hard++;
            console.log(`MISSING      ${name}@${declared}  needed by ${at} [${kind}]`);
          }
        }
        continue;
      }

      const got = pkgs[hit];
      if (got.link || !got.version) continue; // workspace / versionless — no range check
      const ok = satisfies(got.version, spec);
      if (ok === null) {
        unparsed++;
        console.log(
          `UNPARSED     ${name}: cannot evaluate "${spec}" against ${got.version} (by ${at})`,
        );
      } else if (!ok) {
        mism++;
        console.log(
          `MISMATCH     ${name}: found ${got.version} at ${hit}, wanted ${spec}  (by ${at}) [${kind}]`,
        );
      }
    }
  }
}

if (writeBaseline) {
  const header =
    "# Known-unresolvable dependency edges in package-lock.json, tolerated by\n" +
    "# scripts/lock-validate.mjs (new hard-missing edges still fail). These are the\n" +
    "# arborist-accepted holes discovered on PR #488 — its lock regeneration removes\n" +
    "# them, after which the validator flags each line here as stale: delete them.\n" +
    "# Regenerate with: node scripts/lock-validate.mjs --write-baseline\n";
  writeFileSync(
    baselinePath,
    header + hardEdges.sort().join("\n") + (hardEdges.length ? "\n" : ""),
  );
  console.log(`\n✔ wrote ${hardEdges.length} baseline entr(ies) to ${baselinePath}`);
  process.exit(0);
}

const stale = [...baseline].filter((k) => !baselineHits.has(k));
for (const k of stale)
  console.log(`STALE-BASELINE ${k} — no longer fails; remove it from ${baselinePath}`);

console.log(
  `\n== lock-validate: HARD-MISSING=${hard} (+${baselineHits.size} baselined) MISMATCH=${mism} ` +
    `OPT-MISSING=${optMiss} PEER-MISSING=${peerMiss} skipped-exotic=${exotic} unparsed=${unparsed} ` +
    `stale-baseline=${stale.length}`,
);
if (hard > 0) {
  console.error(
    `\n✖ ${hard} unresolvable dependency edge(s) — npm ci would install a broken tree. ` +
      `Regenerate the affected subtree (npm install <pkg> or a scoped npm install) and re-run.`,
  );
  process.exit(1);
}
if (strict && mism > 0) {
  console.error(`\n✖ --strict: ${mism} version-range mismatch(es).`);
  process.exit(1);
}
console.log(
  baselineHits.size
    ? `✔ no NEW unresolvable edges in ${lockPath} (${baselineHits.size} baselined hole(s) remain)`
    : `✔ every dependency edge in ${lockPath} resolves`,
);
