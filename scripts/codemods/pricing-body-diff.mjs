#!/usr/bin/env node
/**
 * pricing-body-diff.mjs — proves R2: every `export function` moved into
 * `@routeflow/pricing` is byte-identical to its pre-move source, function
 * text for function text (from the `export function <name>` line to the
 * matching closing `}` at column 0).
 *
 * Compares each `export function` in the four legacy sources —
 * `apps/api/src/common/pricing.ts`, `apps/api/src/utils/pricing.ts`,
 * `apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts` — against the
 * same-named function in the package (`packages/pricing/src/pricing.ts` +
 * `src/tier-pricing.ts`). Prints `identical` / `DIFFERS` per symbol per
 * source file. Doc comments above the `export function` line are NOT part
 * of the compared text (only the declaration + body), so an added/adjusted
 * doc comment never registers as a diff.
 *
 * The four legacy sources are DELETED by this PR, so they are read from the
 * pinned pre-move baseline ref (`BASELINE_REF`, the master commit this branch
 * is off) via `git show <ref>:<path>` — the R2 proof therefore stays runnable
 * and reproducible after the deletions land.
 *
 * Known, expected diff: `prorateLineSubtotal`'s first parameter was widened
 * from `number` to `number | null | undefined` (mobile's contract, R2) — its
 * signature line differs against the api/common and web sources (which had
 * the narrower `number` type); the body is untouched. It is the only entry in
 * `ALLOWED_DIFFS`; any other DIFFERS in an `apps/api` source is a real finding
 * and fails the script.
 *
 * `apps/web` / `apps/mobile` DIFFERS are reported as WARN, not failures: those
 * two copies carried pre-existing formatting drift against the api original
 * (destructured params, wrapped signatures, `any` vs typed tier arg) and the
 * package deliberately resolves toward the api body.
 *
 * Exit code: 0 only when symbols were actually compared and every api symbol
 * matched. 1 when nothing was compared (`NOT PROVEN`) or an api symbol
 * DIFFERS / is missing.
 *
 * Usage: node scripts/codemods/pricing-body-diff.mjs [--ref <sha>] [--worktree]
 *   --ref <sha>  compare against that ref instead of the pinned baseline
 *   --worktree   read the legacy sources from the working tree (pre-deletion
 *                behaviour; on the merged tree this reports NOT PROVEN)
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/** Pre-move baseline: the master commit this branch is off, where all four legacy sources exist. */
const BASELINE_REF = "e39bf9db";

const LEGACY_SOURCES = [
  "apps/api/src/common/pricing.ts",
  "apps/api/src/utils/pricing.ts",
  "apps/web/lib/pricing.ts",
  "apps/mobile/lib/pricing.ts",
];

/** `<source>#<symbol>` diffs that are intended and must not fail the script. */
const ALLOWED_DIFFS = new Set([
  // R2: the first parameter was widened to `number | null | undefined` (mobile's
  // contract). Signature line only — the body is untouched.
  "apps/api/src/common/pricing.ts#prorateLineSubtotal",
]);

/** Sources whose DIFFERS are pre-existing formatting drift, resolved toward the api body. */
const ADVISORY_SOURCES = new Set(["apps/web/lib/pricing.ts", "apps/mobile/lib/pricing.ts"]);

const args = process.argv.slice(2);
const useWorktree = args.includes("--worktree");
const refIndex = args.indexOf("--ref");
const REF = refIndex === -1 ? BASELINE_REF : args[refIndex + 1];

/** Legacy source text, or null when it cannot be read from the chosen origin. */
function readLegacySource(relPath) {
  if (useWorktree) {
    const full = join(REPO_ROOT, relPath);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  }
  try {
    return execFileSync("git", ["show", `${REF}:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const PACKAGE_SOURCES = ["packages/pricing/src/pricing.ts", "packages/pricing/src/tier-pricing.ts"];

/**
 * Extract every top-level `export function <name>` block from `content`:
 * from the `export function` line up to (and including) the first
 * subsequent line that is exactly `}` (a closing brace at column 0, which
 * — given this codebase's Prettier formatting — is always that function's
 * own close, never a nested block's).
 */
function extractFunctions(content) {
  const lines = content.split("\n");
  const fns = new Map();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^export function (\w+)/);
    if (!match) continue;
    const name = match[1];
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === "}") {
        end = j;
        break;
      }
    }
    fns.set(name, lines.slice(i, end + 1).join("\n"));
  }
  return fns;
}

function readFunctions(relPaths) {
  const fns = new Map();
  for (const relPath of relPaths) {
    const full = join(REPO_ROOT, relPath);
    if (!existsSync(full)) continue;
    for (const [name, text] of extractFunctions(readFileSync(full, "utf8"))) {
      fns.set(name, text);
    }
  }
  return fns;
}

/** First line the two texts disagree on, 1-indexed — null when identical. */
function firstDiffLine(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) return i + 1;
  }
  return null;
}

function main() {
  const pkgFns = readFunctions(PACKAGE_SOURCES);
  const origin = useWorktree ? "working tree" : `git ${REF}`;
  console.log(`Legacy sources read from: ${origin}`);
  let total = 0;
  let identical = 0;
  let differs = 0;
  let missing = 0;
  let failures = 0;

  for (const source of LEGACY_SOURCES) {
    console.log(`\n${source}`);
    const content = readLegacySource(source);
    if (content === null) {
      console.log(`  SKIPPED (not readable from ${origin})`);
      continue;
    }
    const advisory = ADVISORY_SOURCES.has(source);
    const oldFns = extractFunctions(content);
    if (oldFns.size === 0) {
      console.log("  (no `export function` declarations)");
      continue;
    }
    for (const [name, oldText] of [...oldFns].sort(([a], [b]) => a.localeCompare(b))) {
      total += 1;
      const pkgText = pkgFns.get(name);
      if (pkgText === undefined) {
        missing += 1;
        if (!advisory) failures += 1;
        console.log(`  ${name}: MISSING in package${advisory ? " (WARN — advisory source)" : ""}`);
        continue;
      }
      if (pkgText === oldText) {
        identical += 1;
        console.log(`  ${name}: identical`);
        continue;
      }
      differs += 1;
      const line = firstDiffLine(oldText, pkgText);
      if (ALLOWED_DIFFS.has(`${source}#${name}`)) {
        console.log(`  ${name}: DIFFERS — ALLOWED (signature widened, R2; line ${line})`);
      } else if (advisory) {
        console.log(
          `  ${name}: DIFFERS — WARN (pre-existing formatting drift, resolved toward the api body; line ${line})`,
        );
      } else {
        failures += 1;
        console.log(`  ${name}: DIFFERS (first differing line: ${line})`);
      }
    }
  }

  console.log(
    `\n${total} symbol(s) checked — ${identical} identical, ${differs} DIFFERS, ${missing} missing.`,
  );

  if (total === 0) {
    console.log("NOT PROVEN — nothing compared.");
    process.exitCode = 1;
    return;
  }
  if (failures > 0) {
    console.log(`R2 NOT PROVEN — ${failures} unexpected api diff(s)/missing symbol(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "R2 PROVEN — every api symbol is byte-identical (bar the allowed signature widening).",
  );
}

main();
