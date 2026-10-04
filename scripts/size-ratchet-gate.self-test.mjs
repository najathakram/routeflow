#!/usr/bin/env node
// Self-test for scripts/size-ratchet-gate.mjs (the pre-push size-ratchet gate, #2865).
// Wired into `npm run verify`. Exit 0 when every check passes, 1 otherwise.
//
// The planted-file cases build a throwaway tree under .size-ratchet-selftest/ (gitignored) that holds
// verbatim copies of the gate, apps/api's jest config + tsconfig and the REAL size-ratchet.spec.ts, plus
// the 16 tracked files at planted line counts. The gate computes its root from its own location and the
// spec from its own __dirname, so the copies check the fixture tree with no seam in either file. It sits
// inside the repo (not os.tmpdir()) only so jest and ts-jest resolve from the repo's node_modules.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = "scripts/size-ratchet-gate.mjs";
const SPEC = "apps/api/src/common/size-ratchet.spec.ts";
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed += 1;
};
const read = (rel) =>
  existsSync(path.join(ROOT, rel)) ? readFileSync(path.join(ROOT, rel), "utf8") : null;

// ── S1: the hook runs the gate, unconditionally, before anything that can end the hook early ──
const hook = (read(".husky/pre-push") ?? "").split(/\r?\n/);
const at = (re) => hook.findIndex((l) => re.test(l));
const gateLine = at(/^node scripts\/size-ratchet-gate\.mjs \|\| exit 1$/);
ok(
  "S1 .husky/pre-push runs `node scripts/size-ratchet-gate.mjs || exit 1` at top level",
  gateLine >= 0,
);
for (const [label, re] of [
  ["the SKIP_VERIFY hatch", /^if \[ "\$SKIP_VERIFY" = "1" \]/],
  ["the verified-tree fast path", /already passed 'npm run verify'/],
  ["npm run verify", /^npm run verify/],
]) {
  const i = at(re);
  ok(
    `S1 ...before ${label}`,
    gateLine >= 0 && i > gateLine,
    `(gate line ${gateLine}, ${label} line ${i})`,
  );
}

// ── S2: no escape hatch — the gate reads no environment variable and takes no argument ──
const gateSrc = read(GATE);
ok(`S2 ${GATE} exists`, gateSrc !== null);
ok(
  "S2 the gate reads no process.env (no SKIP path)",
  gateSrc !== null && !/process\.env/.test(gateSrc),
);
ok(
  "S2 the gate reads no process.argv (no flag can narrow it)",
  gateSrc !== null && !/process\.argv/.test(gateSrc),
);

// ── S3-S5: planted trees ──
const spec = read(SPEC);
const headroom = Number(/const HEADROOM = (\d+);/.exec(spec)?.[1]);
const block = /const BASELINE: Record<string, number> = \{([\s\S]*?)\n\};/.exec(spec)?.[1] ?? "";
const baseline = [...block.matchAll(/^\s*"([^"]+)":\s*(\d+),/gm)].map((m) => [m[1], Number(m[2])]);
const VICTIM = "apps/mobile/components/NewOrderScreen.tsx";
ok(
  "S3 parsed HEADROOM and the 16 BASELINE rows from the spec",
  headroom > 0 && baseline.length === 16,
  `(headroom ${headroom}, rows ${baseline.length})`,
);
ok(
  `S3 ${VICTIM} is tracked by the ratchet`,
  baseline.some(([rel]) => rel === VICTIM),
);

const FIXTURES = path.join(ROOT, ".size-ratchet-selftest");
const lines = (n) => "x\n".repeat(n);
const planted = [];
function plant(name, { over = null, dropSpec = false } = {}) {
  const dir = path.join(FIXTURES, `${process.pid}-${name}`);
  planted.push(dir);
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  const copy = (rel) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  };
  for (const rel of [
    GATE,
    "apps/api/package.json",
    "apps/api/jest.repo-truth.config.js",
    "apps/api/tsconfig.json",
  ]) {
    copy(rel);
  }
  if (!dropSpec) copy(SPEC);
  for (const [rel, base] of baseline) put(rel, lines(base + headroom + (rel === over ? 1 : 0)));
  return dir;
}
function gate(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, GATE)], { cwd: dir, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}

try {
  if (gateSrc !== null && baseline.length === 16 && headroom > 0) {
    const atCap = gate(plant("at-cap"));
    ok(
      "S3 every tracked file exactly at baseline + headroom -> gate passes",
      atCap.status === 0,
      `(exit ${atCap.status})\n${atCap.out.slice(-1500)}`,
    );

    const over = gate(plant("over", { over: VICTIM }));
    ok(
      `S4 ${VICTIM} planted at cap + 1 -> gate fails`,
      over.status !== 0 && over.status !== null,
      `(exit ${over.status})`,
    );
    ok(
      "S4 ...and names the file and its line count",
      over.out.includes(`${VICTIM} grew to`),
      `\n${over.out.slice(-1500)}`,
    );

    const noSpec = gate(plant("no-spec", { dropSpec: true }));
    ok(
      "S5 spec missing -> gate fails, never a silent pass",
      noSpec.status !== 0 && noSpec.status !== null,
      `(exit ${noSpec.status})\n${noSpec.out.slice(-800)}`,
    );
  }
} finally {
  // Only this run's trees: a concurrent run in the same checkout owns its own <pid>-* dirs.
  for (const dir of planted) rmSync(dir, { recursive: true, force: true });
  try {
    rmdirSync(FIXTURES); // only when empty
  } catch {}
}
ok(
  "cleanup: this run's planted trees removed",
  planted.every((dir) => !existsSync(dir)),
);

console.log(
  failed
    ? `\nsize-ratchet-gate self-test: ${failed} FAILED`
    : "\nsize-ratchet-gate self-test: all passed",
);
process.exit(failed ? 1 : 0);
