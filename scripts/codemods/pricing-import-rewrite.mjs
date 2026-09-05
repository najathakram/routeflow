#!/usr/bin/env node
/**
 * Codemod: rewrite legacy pricing-mirror import specifiers to the bare
 * `@routeflow/pricing` workspace package specifier (PR-4, R5).
 *
 * Rewrites `import`/`export … from` and `require(…)` specifiers matching:
 *   - API:    "../common/pricing", "../../common/pricing", "../utils/pricing"
 *   - API scripts/tests: "../src/common/pricing", "../src/utils/pricing"
 *             (and their explicit ".ts" forms)
 *   - Web:    "@/lib/pricing"
 *   - Mobile: "../lib/pricing", "../../../lib/pricing",
 *             "../../../../lib/pricing", "../../../../../lib/pricing",
 *             and the cross-app "../../web/lib/pricing"
 * to "@routeflow/pricing", across apps/api/src, apps/api/scripts, apps/api/test,
 * apps/web and apps/mobile (skipping node_modules, .next and dist).
 *
 * If a file ends up with more than one `import { ... } from "@routeflow/pricing"`
 * statement (e.g. it previously imported from both common/pricing and
 * utils/pricing), the named imports are merged into a single statement —
 * union of named specifiers, deduplicated, sorted.
 *
 * Usage:
 *   node scripts/codemods/pricing-import-rewrite.mjs --check   # exit 1 + list offenders
 *   node scripts/codemods/pricing-import-rewrite.mjs --write   # apply rewrites
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

const SCAN_ROOTS = ["apps/api/src", "apps/api/scripts", "apps/api/test", "apps/web", "apps/mobile"];
// Bare directory names only — `packages/` is outside SCAN_ROOTS, so no entry is
// needed for `packages/pricing`; adding "pricing" here would silently skip the
// real `apps/web/app/(marketing)/pricing` route.
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);

const LEGACY_SPECIFIERS = [
  // API
  "../common/pricing",
  "../../common/pricing",
  "../utils/pricing",
  // API scripts/tests (one level above `src`; CommonJS scripts use the ".ts" form)
  "../src/common/pricing",
  "../src/utils/pricing",
  "../src/common/pricing.ts",
  "../src/utils/pricing.ts",
  // Web
  "@/lib/pricing",
  // Mobile
  "../lib/pricing",
  "../../../lib/pricing",
  "../../../../lib/pricing",
  "../../../../../lib/pricing",
  "../../web/lib/pricing",
  // Sibling-relative forms used by modules that sat NEXT TO a mirror:
  // `apps/api/src/common/*.ts`, `apps/web/lib/*.ts`, `apps/mobile/lib/*.ts`
  // resolved "./pricing", and `apps/web/lib/api/*.ts` resolved "../pricing".
  // No `pricing.ts` remains under any scan root, so these are unambiguous.
  "./pricing",
  "../pricing",
];

const TARGET_SPECIFIER = "@routeflow/pricing";

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

function collectSourceFiles(root) {
  const full = join(REPO_ROOT, root);
  try {
    statSync(full);
  } catch {
    return [];
  }
  return walk(full).filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
}

const rel = (file) => relative(REPO_ROOT, file).split(sep).join("/");

/** Matcher for a legacy specifier in either module syntax: `from "<spec>"`
 * (ESM import/export) or `require("<spec>")` (CommonJS scripts). The keyword is
 * captured so a rewrite can put it back verbatim. */
function specifierRe(legacy, flags) {
  return new RegExp(`(\\bfrom|\\brequire\\()(\\s*)(["'])${escapeRegExp(legacy)}\\3`, flags);
}

/** Rewrite legacy `from "<specifier>"` / `require("<specifier>")` occurrences to
 * the target specifier, preserving quote style and surrounding whitespace. */
function rewriteSpecifiers(text) {
  let result = text;
  let changed = false;
  for (const legacy of LEGACY_SPECIFIERS) {
    if (specifierRe(legacy, "g").test(result)) {
      changed = true;
      result = result.replace(
        specifierRe(legacy, "g"),
        (_m, kw, ws, q) => `${kw}${ws}${q}${TARGET_SPECIFIER}${q}`,
      );
    }
  }
  return { text: result, changed };
}

/** Full `import ... from "@routeflow/pricing";` statement matcher — named,
 * default, default+named, or namespace clauses. Bounded to `[^;]*?` (no
 * semicolon) so it can never cross into a preceding or following statement —
 * import clauses never contain a literal `;`. */
const IMPORT_STATEMENT_RE = /\bimport\s+(type\s+)?([^;]*?)\s+from\s+(["'])@routeflow\/pricing\3;?/g;

function extractNamedTokens(clause) {
  const braceStart = clause.indexOf("{");
  const braceEnd = clause.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1) return [];
  return clause
    .slice(braceStart + 1, braceEnd)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Merge duplicate `@routeflow/pricing` import statements in one file into a
 * single statement — union of named imports, deduplicated, sorted. */
function mergeDuplicateImports(text) {
  const matches = [...text.matchAll(IMPORT_STATEMENT_RE)];
  if (matches.length <= 1) return { text, changed: false };

  const tokens = new Set();
  for (const m of matches) {
    for (const t of extractNamedTokens(m[2])) tokens.add(t);
  }
  const sorted = [...tokens].sort((a, b) => a.localeCompare(b));
  const merged = `import { ${sorted.join(", ")} } from "${TARGET_SPECIFIER}";`;

  // Splice out matches from the end first so earlier indices stay valid;
  // replace the first (earliest) match with the merged statement.
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const start = m.index;
    const end = m.index + m[0].length;
    if (i === 0) {
      result = result.slice(0, start) + merged + result.slice(end);
    } else {
      // Also eat one trailing newline so we don't leave a blank line behind.
      let realEnd = end;
      if (result[realEnd] === "\n") realEnd += 1;
      result = result.slice(0, start) + result.slice(realEnd);
    }
  }
  return { text: result, changed: true };
}

function findOffenders() {
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    for (const file of collectSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const legacy of LEGACY_SPECIFIERS) {
        if (specifierRe(legacy, "").test(source)) {
          offenders.push(`${rel(file)} -> "${legacy}"`);
          break;
        }
      }
    }
  }
  return offenders.sort();
}

function run() {
  const mode = process.argv.includes("--write")
    ? "write"
    : process.argv.includes("--check")
      ? "check"
      : null;

  if (!mode) {
    console.error("Usage: pricing-import-rewrite.mjs --check | --write");
    process.exit(2);
  }

  if (mode === "check") {
    const offenders = findOffenders();
    if (offenders.length > 0) {
      console.error(`Found ${offenders.length} legacy pricing import specifier(s):`);
      for (const o of offenders) console.error(`  ${o}`);
      process.exit(1);
    }
    console.log("No legacy pricing import specifiers found.");
    process.exit(0);
  }

  // --write
  let filesChanged = 0;
  for (const root of SCAN_ROOTS) {
    for (const file of collectSourceFiles(root)) {
      const original = readFileSync(file, "utf8");
      const { text: rewritten, changed: rewroteAny } = rewriteSpecifiers(original);
      const { text: merged, changed: mergedAny } = mergeDuplicateImports(rewritten);
      if (rewroteAny || mergedAny) {
        writeFileSync(file, merged, "utf8");
        filesChanged += 1;
        console.log(`rewrote ${rel(file)}`);
      }
    }
  }
  console.log(`\n${filesChanged} file(s) rewritten to import from "${TARGET_SPECIFIER}".`);
}

run();
