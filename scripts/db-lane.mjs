#!/usr/bin/env node
// db-lane.mjs — which `*.db.spec.ts` can reach the changed files?
//
// The scoped pre-push runs no DB spec (jest's base config ignores them), and lanes picked the relevant ones by
// hand and missed some (#2301 rolled on import-invoice-reimport.db.spec, #2707 on specs that reach a change only
// transitively). This names them from the diff, two ways:
//   1. a REVERSE IMPORT GRAPH over apps/api/{src,prisma,scripts,test}, scripts/lib and packages/* (its `src/`, or
//      the whole package when it has none, like packages/types):
//      relative import / export-from / import() / require(), `@routeflow/<pkg>[/sub]` → the package's `src/`,
//      its package.json entry (exports "source", main, types) or `index.ts`, and the
//      `scripts|prisma/...(mjs|cjs|ts)` path literals specs spawn or read (F3).
//   2. a PRISMA-MODEL channel for specs that hand-mock their providers and so have no import path to the service
//      (#2301): `model X` blocks added/removed and `prisma.x.` / `tx.x.` accessors on changed lines match a spec
//      containing `x.` or `X`.
// A hub change (ratio of specs above --max-ratio) or a change to the lane's own harness switches to FULL.
//
// usage: node scripts/db-lane.mjs [--base origin/master] [--files a,b] [--diff file] [--json]
//                                 [--max-ratio 0.6] [--explain] [--root <dir>]
// exit 0 list printed · 2 usage / git error (never an empty list on error) · 3 a changed file has an unresolvable
// relative import.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFilesSince, cleanGitEnv } from "./lib/verify-scope.mjs";

const HARNESS = [
  "apps/api/prisma/schema/_base.prisma",
  "apps/api/jest.db.config.js",
  "apps/api/test/db-lane-serial.cjs",
  "apps/api/src/common/testing/db-spec.ts",
];
const GRAPH_ROOTS = [
  "apps/api/src",
  "apps/api/prisma",
  "apps/api/scripts",
  "apps/api/test",
  "scripts/lib",
];
const EXTS = [".ts", ".tsx", ".js", ".cjs", ".mjs"];

function parseArgs(argv) {
  const a = {
    base: "origin/master",
    files: null,
    diff: null,
    json: false,
    maxRatio: 0.6,
    explain: false,
    root: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === "--base") a.base = v();
    else if (k === "--files")
      a.files = v()
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    else if (k === "--diff") a.diff = v();
    else if (k === "--max-ratio") {
      a.maxRatio = Number(v());
      if (!Number.isFinite(a.maxRatio) || a.maxRatio < 0)
        throw new Error("--max-ratio must be a number ≥ 0");
    } else if (k === "--root") a.root = path.resolve(v());
    else if (k === "--json") a.json = true;
    else if (k === "--explain") a.explain = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");

function gitOut(root, args) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: cleanGitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.error || r.status !== 0 ? null : r.stdout;
}

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const r = `${rel}/${name}`;
    const st = statSync(path.join(root, r));
    if (st.isDirectory()) walk(root, r, out);
    else if (EXTS.includes(path.extname(name))) out.push(r);
  }
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;
const TOKEN_RE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const SPEC_POS_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)$/;

/** Comments blanked; a string survives only in import position (`from "x"`, `import("x")`, `require("x")`). */
function importText(text) {
  return text.replace(TOKEN_RE, (m, off) => {
    if (m[0] === "/") return " ";
    return SPEC_POS_RE.test(text.slice(Math.max(0, off - 24), off)) ? m : '""';
  });
}
const LITERAL_RE = /["'`]((?:apps\/api\/)?(?:scripts|prisma)\/[\w./-]+\.(?:mjs|cjs|ts))["'`]/g;

/** `base` itself, then base+ext, then base/index+ext, then (a `./x.js` import of an `x.ts` source) base→.ts. */
function tryPaths(base, known) {
  const tries = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)];
  if (/\.(js|mjs|cjs)$/.test(base)) tries.push(base.replace(/\.(js|mjs|cjs)$/, ".ts"));
  return tries.find((t) => known.has(t)) ?? null;
}

/** Flatten a package.json `exports` / `main` target into candidate file strings, TS source conditions first. */
function targets(t) {
  if (typeof t === "string") return [t];
  if (!t || typeof t !== "object") return [];
  const order = ["source", "types", "import", "default", "require"];
  return [
    ...order.flatMap((k) => targets(t[k])),
    ...Object.keys(t)
      .filter((k) => !order.includes(k))
      .flatMap((k) => targets(t[k])),
  ];
}

/** The entry files a `@routeflow/<pkg>` import can mean, best first (cached in `pkgs`). */
function pkgEntries(root, pkg, sub, pkgs) {
  if (!pkgs.has(pkg)) {
    let json = {};
    try {
      json = JSON.parse(readFileSync(path.join(root, "packages", pkg, "package.json"), "utf8"));
    } catch {
      /* no/invalid manifest: fall back to the directory layout below */
    }
    pkgs.set(pkg, json);
  }
  const json = pkgs.get(pkg);
  const dir = `packages/${pkg}`;
  const exp = json.exports;
  const out = [];
  const clean = (t) => path.posix.normalize(path.posix.join(dir, t));
  if (!sub) {
    out.push(`${dir}/src`);
    if (exp && typeof exp === "object" && !Array.isArray(exp))
      out.push(...targets("." in exp ? exp["."] : exp).map(clean));
    else if (typeof exp === "string") out.push(clean(exp));
    for (const f of [json.main, json.types]) if (typeof f === "string") out.push(clean(f));
    out.push(`${dir}/index`);
  } else {
    if (exp && typeof exp === "object" && !Array.isArray(exp)) {
      for (const [k, v] of Object.entries(exp)) {
        // "./web" (exact) or "./*" (one `*`: prefix + capture + suffix)
        const [pre, post] =
          k.startsWith("./") && k.includes("*") ? k.slice(2).split("*") : [null, null];
        const mid =
          pre === null
            ? k === `./${sub}`
              ? ""
              : null
            : sub.length >= pre.length + post.length && sub.startsWith(pre) && sub.endsWith(post)
              ? sub.slice(pre.length, sub.length - post.length)
              : null;
        if (mid !== null) out.push(...targets(v).map((t) => clean(t.replace("*", mid))));
      }
    }
    out.push(`${dir}/src/${sub}`, `${dir}/${sub}`);
  }
  return out;
}

/** Resolve `spec` (relative or @routeflow/x) from file `from` to a repo-relative path in `known`, or null. */
function resolveImport(from, spec, known, root, pkgs) {
  if (spec.startsWith("."))
    return tryPaths(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)), known);
  if (!spec.startsWith("@routeflow/")) return null;
  const [pkg, ...rest] = spec.slice(11).split("/");
  for (const base of pkgEntries(root, pkg, rest.join("/"), pkgs)) {
    const hit = tryPaths(base, known);
    if (hit) return hit;
  }
  return null;
}

function buildGraph(root, changed) {
  const files = [];
  for (const r of GRAPH_ROOTS) walk(root, r, files);
  // packages/<n>: its src/ when it has one, else the whole package (packages/types keeps index.ts + api/ at its root)
  const pk = path.join(root, "packages");
  if (existsSync(pk))
    for (const n of readdirSync(pk)) {
      const dir = `packages/${n}`;
      if (!statSync(path.join(root, dir)).isDirectory()) continue;
      walk(root, existsSync(path.join(root, dir, "src")) ? `${dir}/src` : dir, files);
    }
  const known = new Set(files);
  const pkgs = new Map();
  const fwd = new Map();
  const unresolved = [];
  const changedSet = new Set(changed);
  for (const f of files) {
    const text = readFileSync(path.join(root, f), "utf8");
    const deps = new Set();
    for (const m of importText(text).matchAll(IMPORT_RE)) {
      const spec = m[2];
      if (!spec.startsWith(".") && !spec.startsWith("@routeflow/")) continue;
      const hit = resolveImport(f, spec, known, root, pkgs);
      if (hit) deps.add(hit);
      else if (spec.startsWith(".") && changedSet.has(f)) unresolved.push(`${f} → ${spec}`);
    }
    for (const m of text.matchAll(LITERAL_RE)) {
      const lit = m[1];
      const hit = [lit, `apps/api/${lit}`].find((c) => known.has(c));
      if (hit) deps.add(hit);
    }
    deps.delete(f);
    fwd.set(f, deps);
  }
  const rev = new Map();
  for (const [f, deps] of fwd)
    for (const d of deps) (rev.get(d) ?? rev.set(d, new Set()).get(d)).add(f);
  return { known, fwd, rev, unresolved };
}

/** Per-file changed-line text from a unified diff: Map<file, string[]> (added/removed lines only). */
function diffLines(diff) {
  const per = new Map();
  let cur = null;
  for (const line of diff.split("\n")) {
    const h = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (h) {
      cur = h[2];
      per.set(cur, []);
    } else if (cur && /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
      per.get(cur).push(line.slice(1));
  }
  return per;
}

const stripStrings = (s) =>
  s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const isCommentLine = (s) => /^\s*(\/\/|\/\*|\*|#)/.test(s);

function models(perFile) {
  const out = new Set();
  for (const [file, lines] of perFile) {
    if (/\.spec\.ts$/.test(file)) continue;
    const isSchema = /prisma\/schema\/.*\.prisma$/.test(file);
    for (const raw of lines) {
      if (isSchema) {
        const m = /^model\s+(\w+)\s*\{/.exec(raw.trim());
        if (m) out.add(m[1]);
        continue;
      }
      if (isCommentLine(raw)) continue;
      for (const m of stripStrings(raw).matchAll(/\b(?:prisma|tx)\.(\w+)\./g))
        out.add(m[1][0].toUpperCase() + m[1].slice(1));
    }
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`db-lane: ${e.message}`);
    return 2;
  }
  const root = args.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tracked = gitOut(root, ["ls-files", "apps/api"]);
  if (tracked === null) {
    console.error("db-lane: cannot list the repo's files (git ls-files failed)");
    return 2;
  }
  const specs = tracked
    .split("\n")
    .filter((f) => /\.db\.spec\.ts$/.test(f))
    .sort();

  let changed;
  let mergeBase = null;
  if (args.files) changed = args.files.map(norm);
  else {
    changed = changedFilesSince(root, args.base);
    if (changed === null) {
      console.error(`db-lane: cannot diff against ${args.base}`);
      return 2;
    }
    changed = changed.map(norm);
  }
  let diffText = "";
  if (args.diff) {
    try {
      diffText = readFileSync(args.diff, "utf8");
    } catch (e) {
      console.error(`db-lane: cannot read --diff ${args.diff}`);
      return 2;
    }
  } else {
    mergeBase = gitOut(root, ["merge-base", args.base, "HEAD"])?.trim() ?? null;
    if (mergeBase === null && !args.files) {
      console.error(`db-lane: cannot diff against ${args.base}`);
      return 2;
    }
    if (mergeBase) {
      // --files names the change set, so read only those paths' lines for the model channel
      const scope = args.files ? ["--", ...changed] : [];
      diffText = gitOut(root, ["diff", "--no-renames", "-U0", mergeBase, ...scope]) ?? "";
    }
  }

  const { known, rev, unresolved } = buildGraph(root, changed);
  if (unresolved.length) {
    console.error(
      `db-lane: unresolvable relative import in a changed file:\n  ${unresolved.join("\n  ")}`,
    );
    return 3;
  }

  // reverse BFS from every changed file: parent pointer gives the chain
  const parent = new Map();
  const depth = new Map();
  const queue = [];
  for (const c of changed) {
    depth.set(c, 0);
    parent.set(c, null);
    queue.push(c);
  }
  while (queue.length) {
    const f = queue.shift();
    for (const importer of rev.get(f) ?? []) {
      if (depth.has(importer)) continue;
      depth.set(importer, depth.get(f) + 1);
      parent.set(importer, f);
      queue.push(importer);
    }
  }
  const rootOf = (f) => {
    let x = f;
    while (parent.get(x) !== null && parent.get(x) !== undefined) x = parent.get(x);
    return x;
  };
  const chainOf = (f) => {
    const chain = [f];
    let x = f;
    while (parent.get(x)) {
      x = parent.get(x);
      chain.push(x);
    }
    return chain.reverse();
  };

  const reasons = new Map(); // spec → string
  for (const s of specs) {
    if (changed.includes(s)) reasons.set(s, "self");
    else if (depth.has(s)) reasons.set(s, `import:${rootOf(s)} via ${depth.get(s)} hops`);
  }
  const modelSet = models(diffLines(diffText));
  if (modelSet.size) {
    for (const s of specs) {
      const text = readFileSync(path.join(root, s), "utf8");
      for (const M of modelSet) {
        const camel = M[0].toLowerCase() + M.slice(1);
        if (new RegExp(`\\b${camel}\\.`).test(text) || new RegExp(`\\b${M}\\b`).test(text)) {
          // Listed ALONGSIDE an import/self reason (not instead of it): a spec reachable both ways keeps both
          // reasons, so a new import edge can never hide the model that selected it.
          const prior = reasons.get(s);
          reasons.set(s, prior ? `${prior}; model:${M}` : `model:${M}`);
          break;
        }
      }
    }
  }

  const total = specs.length;
  const hit = specs.filter((s) => reasons.has(s));
  const ratio = total ? hit.length / total : 0;
  const harness = changed.filter((c) => HARNESS.includes(c));
  let mode = "scoped";
  let why = "";
  if (harness.length) {
    mode = "full";
    why = `harness changed: ${harness.join(", ")}`;
  } else if (ratio > args.maxRatio) {
    mode = "full";
    why = `ratio ${ratio.toFixed(2)}`;
  }
  const chosen = mode === "full" ? specs : hit;

  if (args.json) {
    console.log(JSON.stringify({ specs: chosen, total, mode, ...(why ? { why } : {}) }));
    return 0;
  }
  for (const s of chosen) {
    const r = reasons.get(s);
    console.log(`${s}  <= ${r ?? "full"}`);
    if (args.explain && r && r.startsWith("import:"))
      console.log(`    chain: ${chainOf(s).join(" → ")}`);
  }
  console.log(mode === "full" ? `DB-LANE FULL (${why})` : `DB-LANE ${chosen.length}/${total}`);
  return 0;
}

process.exit(main());
