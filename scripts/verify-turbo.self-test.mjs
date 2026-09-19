#!/usr/bin/env node
/**
 * Self-test for the affected-scope pre-push (scripts/lib/verify-scope.mjs + verify-turbo.mjs).
 * Runs against the REAL workspace graph of this repo — not a hand-typed fixture — so a new
 * dependency edge or a renamed package is caught here, not by a false-green push.
 *
 * S1: a change under packages/pricing selects api + web + mobile (its dependents) + itself.
 * S2: a change confined to apps/api selects only api + the always-run pricing tripwire.
 * S3: a change under packages/ui selects web (its dependent) and not api/mobile.
 * S4: a docs-only / code-map-only diff selects only the pricing tripwire (repo-truth always runs).
 * S5: files that feed every workspace force FULL — root manifest, lockfile, turbo.json, a
 *     workspace manifest, the hooks, the CI workflows, the campaign ledger.
 * S6: decideScope stays FULL unless the hook opted in, and under FULL_VERIFY=1 / CI / master.
 * S7: the hook wiring — pre-push sets VERIFY_SCOPE=affected off FULL_VERIFY, keeps separate
 *     verified-tree markers, and package.json's verify chain goes through verify-turbo.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeScope, decideScope, loadWorkspaces, shortName } from "./lib/verify-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = loadWorkspaces(ROOT);

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const scopedNames = (files) => {
  const s = computeScope(files, workspaces);
  return s.mode === "scoped" ? s.workspaces.map(shortName) : `FULL (${s.reason})`;
};

check(
  "S0 the real graph has the five workspaces the chain depends on",
  ["api", "mobile", "pricing", "web"].every((n) => workspaces.some((w) => shortName(w.name) === n)),
  true,
);

check(
  "S1 packages/pricing change selects api + mobile + pricing + web",
  scopedNames(["packages/pricing/src/index.ts"]),
  ["api", "mobile", "pricing", "web"],
);
check(
  "S2 apps/api-only change selects api + the pricing tripwire",
  scopedNames(["apps/api/src/orders/orders.service.ts"]),
  ["api", "pricing"],
);
check(
  "S3 packages/ui change selects web (+ pricing tripwire)",
  scopedNames(["packages/ui/src/web/Button.tsx"]),
  ["pricing", "ui", "web"],
);
check(
  "S4 docs-only diff selects only the pricing tripwire",
  scopedNames(["CLAUDE.md", ".claude/code-map/INDEX.md"]),
  ["pricing"],
);
check(
  "S4b two apps changed selects both",
  scopedNames(["apps/web/lib/a.ts", "apps/mobile/lib/b.ts"]),
  ["mobile", "pricing", "web"],
);

for (const f of [
  "package.json",
  "package-lock.json",
  "turbo.json",
  "apps/web/package.json",
  "packages/types/package.json",
  ".husky/pre-push",
  ".github/workflows/ci.yml",
  ".claude/campaign/status/F01.jsonl",
]) {
  check(`S5 ${f} forces FULL`, computeScope([f, "apps/api/src/x.ts"], workspaces).mode, "full");
}

const gitRoot = ROOT;
check("S6a VERIFY_SCOPE unset -> full", decideScope(gitRoot, {}).mode, "full");
check(
  "S6b FULL_VERIFY=1 -> full",
  decideScope(gitRoot, { VERIFY_SCOPE: "affected", FULL_VERIFY: "1" }).reason,
  "FULL_VERIFY=1",
);
check(
  "S6c CI -> full",
  decideScope(gitRoot, { VERIFY_SCOPE: "affected", CI: "true" }).reason,
  "CI",
);

const hook = readFileSync(join(ROOT, ".husky", "pre-push"), "utf8");
check(
  "S7a pre-push opts in to VERIFY_SCOPE=affected unless FULL_VERIFY=1",
  /FULL_VERIFY" != "1" \]; then\s+export VERIFY_SCOPE=affected/.test(hook),
  true,
);
check(
  "S7b pre-push keeps a distinct verified-tree marker for scoped passes",
  hook.includes('tree_key="$tree:affected"'),
  true,
);
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
check(
  "S7c verify runs the turbo step through verify-turbo.mjs",
  pkg.scripts.verify.includes("node scripts/verify-turbo.mjs"),
  true,
);
check(
  "S7d verify no longer calls turbo directly for the test step",
  pkg.scripts.verify.includes("turbo run check-types lint test"),
  false,
);

process.exit(failures ? 1 : 0);
