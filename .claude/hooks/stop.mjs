#!/usr/bin/env node
/**
 * Stop gate — fast, changed-files-only checks (monorepo-safe, < 10s).
 *
 * Gate 1 — formatting: `prettier --check` on the changed/untracked TS/JS
 * source files only. Blocks turn close (exit 2) with a fix list if any are
 * unformatted.
 *
 * Gate 2 — code-map freshness: CLAUDE.md requires `.claude/code-map/` to be
 * updated surgically with every code change, in every session. Blocks when
 * (a) this session has uncommitted code changes but no code-map change, or
 * (b) commits since the map's `_meta.json.mappedSha` touched code without any
 *     of them touching the map (drift left behind by an earlier session).
 *
 * Why prettier-only (no eslint here): ESLint flat config resolves from the
 * current working directory, and this repo has NO root eslint.config — eslint
 * only runs per-workspace via `npm run lint` / Turbo. tsc is likewise excluded
 * (too slow/fragile per-file with Prisma); type-checks live in the pre-push hook.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Invoke prettier directly via node — this repo's root has no node_modules/.bin
// shim, so `npx prettier` fails on Windows. Fall back to npx where the shim exists.
function prettierCli() {
  const local = "node_modules/prettier/bin/prettier.cjs";
  return existsSync(local) ? `node "${local}"` : "npx prettier";
}

function sh(cmd) {
  try {
    return { code: 0, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let changed = [];
try {
  const tracked = execSync("git diff --name-only HEAD", { encoding: "utf8" });
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf8" });
  changed = `${tracked}\n${untracked}`
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(0); // not a git repo / git unavailable — nothing to gate
}

const SKIP = /(node_modules|\.next|[/]dist[/]|[/]build[/]|[/]coverage[/]|\.turbo)/;
const source = changed.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && !SKIP.test(f));

// ── Gate 1: formatting ────────────────────────────────────────────────────
if (source.length > 0) {
  const list = source.map((f) => `"${f}"`).join(" ");
  const res = sh(`${prettierCli()} --check ${list}`);

  if (res.code !== 0) {
    const detail = res.out.trim().split(/\r?\n/).slice(0, 25).join("\n");
    process.stderr.write(
      `Stop gate: unformatted source files. Run \`npm run format\` (or \`npx prettier --write\`):\n\n${detail}\n`,
    );
    process.exit(2); // block close; stderr is fed back to Claude to self-correct
  }
}

// ── Gate 2: code-map freshness ────────────────────────────────────────────
const norm = (f) => f.replace(/\\/g, "/");
const isCode = (f) =>
  /^(apps|packages|scripts)\/.*\.(ts|tsx|js|jsx|cjs|mjs|prisma)$/.test(norm(f)) && !SKIP.test(f);
const isMap = (f) => norm(f).startsWith(".claude/code-map/");

const HOW_TO_FIX =
  "Surgically update the touched entries (.claude/code-map/INDEX.md → the area file: " +
  "api/web/mobile/packages.md) and bump _meta.json (mappedSha + generatedAt). " +
  "If the map's content is genuinely unaffected, bump generatedAt to acknowledge the review.";

// (a) session-local: code changed in the working tree, map untouched
const uncommittedCode = changed.filter(isCode);
if (uncommittedCode.length > 0 && !changed.some(isMap)) {
  const list = uncommittedCode.slice(0, 10).join("\n  ");
  process.stderr.write(
    `Stop gate: code changed but .claude/code-map/ was not updated (CLAUDE.md code-map routine).\n` +
      `${HOW_TO_FIX}\n\nChanged code files:\n  ${list}\n`,
  );
  process.exit(2);
}

// (b) committed drift: code committed AFTER the last commit that touched the
// map (any session's leftovers, not just this one's). Self-anchoring: the
// fixing commit touches .claude/code-map/ and becomes the new anchor, and a
// commit carrying code + map together is always clean. An uncommitted
// code-map change counts as the fix in progress — don't re-block.
if (!changed.some(isMap) && existsSync(".claude/code-map/_meta.json")) {
  const lastMap = sh("git log -1 --format=%H -- .claude/code-map").out.trim();
  if (/^[0-9a-f]{40}$/i.test(lastMap)) {
    const codeDrift = sh(`git diff --name-only ${lastMap} HEAD -- apps packages scripts`)
      .out.split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f && isCode(f));
    if (codeDrift.length > 0) {
      const list = codeDrift.slice(0, 10).join("\n  ");
      process.stderr.write(
        `Stop gate: the code map is STALE — code was committed after the last ` +
          `.claude/code-map/ update (${lastMap.slice(0, 7)}) without refreshing the map ` +
          `(CLAUDE.md code-map routine).\n${HOW_TO_FIX}\n\n` +
          `Unmapped code files (first 10 of ${codeDrift.length}):\n  ${list}\n`,
      );
      process.exit(2);
    }
  }
}

process.exit(0);
