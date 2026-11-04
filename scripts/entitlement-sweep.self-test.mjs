#!/usr/bin/env node
// T11 (FG-1 WP1) — self-test for `scripts/entitlement-sweep.mjs --compare a.json b.json`.
// Plain node: `node scripts/entitlement-sweep.self-test.mjs`. Runs the compare on temp files and
// checks the exit code: same -> 0; a bit differs while inputsHash is unchanged -> 2; a bit differs
// but inputsHash changed -> 0. Also: the compare prints only hashed ids and key names; a
// non-local base URL is refused without the per-command owner flag.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "entitlement-sweep.mjs");
let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const bits = (over = {}) => ({
  old: true,
  effective: true,
  strict: true,
  clientAddon: null,
  clientFlag: true,
  ...over,
});
const file = (inputsHash, keyBits) => ({
  mode: "shadow",
  planFlagEnforcement: "off",
  tenants: [
    {
      id: "h-0001",
      class: "PRODUCTION",
      inputsHash,
      keys: { "flag.reports": keyBits, "flag.analytics": bits() },
      sets: { "order_delivery|developer_mode": { old: true, effective: true } },
    },
  ],
});

const dir = mkdtempSync(path.join(tmpdir(), "entitlement-sweep-"));
const write = (name, obj) => {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};
const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

try {
  const a = write("a.json", file("in-1", bits()));
  const same = write("same.json", file("in-1", bits()));
  const diffSameInputs = write("diff-same-inputs.json", file("in-1", bits({ effective: false })));
  const diffNewInputs = write("diff-new-inputs.json", file("in-2", bits({ effective: false })));

  check("same files -> exit 0", run(["--compare", a, same]).status, 0);
  const bad = run(["--compare", a, diffSameInputs]);
  check("bit differs, inputsHash unchanged -> exit 2", bad.status, 2);
  check(
    "the report names the hashed tenant and the key only",
    /h-0001/.test(bad.stdout) && /flag\.reports/.test(bad.stdout) && !/PRODUCTION/.test(bad.stdout),
    true,
  );
  check(
    "bit differs, inputsHash changed -> exit 0",
    run(["--compare", a, diffNewInputs]).status,
    0,
  );

  // A set row difference with unchanged inputs is a difference too.
  const setDiff = file("in-1", bits());
  setDiff.tenants[0].sets["order_delivery|developer_mode"].effective = false;
  check(
    "set row differs, inputsHash unchanged -> exit 2",
    run(["--compare", a, write("set.json", setDiff)]).status,
    2,
  );

  // Never against production by itself: a non-local base URL is refused (exit 3), no network call.
  const refused = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ENTITLEMENT_SWEEP_API_URL: "https://api.example.com/api/v1",
      ENTITLEMENT_SWEEP_TOKEN: "t",
    },
  });
  check("non-local base URL without the owner flag -> exit 3", refused.status, 3);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nentitlement-sweep self-test passed");
