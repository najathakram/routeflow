#!/usr/bin/env node
// Pre-push size-ratchet gate (#2865). Runs ONLY apps/api/src/common/size-ratchet.spec.ts — the same
// spec, through the same jest.repo-truth.config.js, that CI's Verify runs inside `test:repo-truth` —
// in a few seconds instead of the whole repo-truth lane.
//
// .husky/pre-push runs it BEFORE the SKIP_VERIFY hatch and the verified-tree fast path, so a push
// that skips `npm run verify` still cannot carry a file over its ratchet into a public CI window
// (#2865 spent one on exactly that: NewOrderScreen.tsx at 2637 lines against a cap of 2585).
//
// No arguments and no environment switch, by design: there is no way to skip or narrow it. A red
// here means "extract the slice you added into its own module", never "raise the baseline".
// It always checks the tree it lives in (this file's ../); scripts/size-ratchet-gate.self-test.mjs
// relies on that to run a verbatim copy against a planted tree.
//
// Exit: jest's status (0 = every tracked file within baseline + headroom); 1 if the spec is missing
// or jest cannot start. jest is spawned with node directly (no npx, no shell), so it behaves the
// same from Git Bash on Windows as on the Mac.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = path.join(ROOT, "apps", "api");
const SPEC = path.join(API, "src", "common", "size-ratchet.spec.ts");

if (!existsSync(SPEC)) {
  console.error(`size-ratchet gate: ${path.relative(ROOT, SPEC)} is missing — refusing the push.`);
  process.exit(1);
}

let jestBin;
try {
  jestBin = createRequire(path.join(API, "package.json")).resolve("jest/bin/jest");
} catch (e) {
  console.error(
    `size-ratchet gate: cannot resolve jest from apps/api (${e instanceof Error ? e.message : e}). ` +
      `Run \`npm ci\` in this checkout.`,
  );
  process.exit(1);
}

console.log("size-ratchet gate: apps/api size-ratchet.spec.ts (repo-truth lane)");
const r = spawnSync(
  process.execPath,
  [jestBin, "-c", "jest.repo-truth.config.js", "--ci", "size-ratchet\\.spec\\.ts$"],
  { cwd: API, stdio: "inherit" },
);
if (r.error) console.error(`size-ratchet gate: could not start jest: ${r.error.message}`);
process.exit(r.status ?? 1);
