// B806: the pure rules behind `check-types` for apps/api (scripts/check-types-ratchet.mjs).
//
// apps/api/tsconfig.json excludes **/*.spec.ts, and ts-jest reads `isolatedModules: true` from that
// same tsconfig and so transpiles every spec WITHOUT type-checking it: a spec could drift from the
// code it tests and still compile and run green (#1286's stale fixture). check-types now compiles
// src AND specs in ONE program and judges the result here:
//   - a SOURCE file (anything not *.spec.ts, including a diagnostic with no file) is zero-tolerance,
//     exactly as before, and can never be allow-listed;
//   - a SPEC file may carry at most its count in check-types.spec-baseline.json, and the baseline
//     only ever moves DOWN: a new or rising count fails, and so does a fixed error whose baseline
//     entry was not lowered in the same diff.
// Pinned in both directions by src/common/check-types-ratchet-script.spec.ts.

const SPEC_FILE = /\.spec\.ts$/;
// 6144, not 4096: the api program (src + specs, ~1715 files) peaked at 4394 MB RSS under the old
// 4096 cap and now OOMs on the Mac mini (#2717 M3; CI runners have the headroom). Raise again only
// with the same evidence.
export const HEAP_MB = 6144;
const OOM_HINT =
  `the type-check ran out of memory at the ${HEAP_MB} MB heap this script already sets ` +
  `(--max-old-space-size=${HEAP_MB}, also exported in NODE_OPTIONS to the compile worker). ` +
  `Free memory first (on an 8 GB machine: no other verify, push or Jest run at the same time); ` +
  `if the program has genuinely outgrown it, raise HEAP_MB in scripts/lib/check-types-ratchet-core.mjs`;
// `// @ts-nocheck`, `/// @ts-nocheck`, any case — the text fallback for isNoCheckFile().
const NOCHECK = /^\s*\/{2,3}\s*@ts-nocheck\b/im;

/**
 * A source file the compiler will skip entirely. TypeScript records the pragma itself as
 * `checkJsDirective.enabled === false`; the text match is the fallback. Takes a ts.SourceFile or
 * any `{ checkJsDirective?, text }`, so the self-test exercises the exact function the worker runs.
 */
export function isNoCheckFile(sf) {
  return sf?.checkJsDirective?.enabled === false || NOCHECK.test(sf?.text ?? "");
}

const fileOf = (d) => d.file ?? "<no file>";

/** Per-file diagnostic counts. A diagnostic with no file is keyed "<no file>" (a source error). */
export function countByFile(diagnostics) {
  const counts = new Map();
  for (const d of diagnostics) counts.set(fileOf(d), (counts.get(fileOf(d)) ?? 0) + 1);
  return counts;
}

/**
 * @param {{file: string|null, code: number, line: number, message: string}[]} diagnostics
 * @param {Record<string, number>} baseline spec file -> allowed error count
 */
export function evaluate(diagnostics, baseline, nocheckFiles = []) {
  const counts = countByFile(diagnostics);
  const failures = [];
  // A `// @ts-nocheck` file reports no diagnostics at all, so it would silently lower its own count.
  for (const file of [...nocheckFiles].sort()) failures.push({ kind: "ts-nocheck", file });
  for (const file of Object.keys(baseline).sort()) {
    if (!SPEC_FILE.test(file)) failures.push({ kind: "baseline-non-spec", file });
  }
  for (const [file, actual] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (!SPEC_FILE.test(file)) {
      failures.push({ kind: "source-error", file, actual });
      continue;
    }
    const allowed = baseline[file] ?? 0;
    if (actual > allowed) failures.push({ kind: "spec-regression", file, allowed, actual });
  }
  for (const file of Object.keys(baseline).sort()) {
    if (!SPEC_FILE.test(file)) continue;
    const actual = counts.get(file) ?? 0;
    if (actual < baseline[file]) {
      failures.push({ kind: "stale-baseline", file, allowed: baseline[file], actual });
    }
  }
  return { ok: failures.length === 0, failures, counts, total: diagnostics.length };
}

/** The baseline lowered to what is left: never raised, entries at 0 dropped, keys sorted. */
export function lowerBaseline(baseline, counts) {
  const out = {};
  for (const file of Object.keys(baseline).sort()) {
    const lowered = Math.min(baseline[file], counts.get(file) ?? 0);
    if (lowered > 0) out[file] = lowered;
  }
  return out;
}

/** An out-of-memory worker exit, turned into an actionable message instead of a raw V8 FATAL. */
export function classifyWorkerExit({ status, signal, stderr }) {
  const oom =
    /heap out of memory|Allocation failed/i.test(stderr ?? "") ||
    status === 134 ||
    signal === "SIGABRT";
  return oom ? { kind: "oom", message: OOM_HINT } : null;
}

export function describeFailure(f) {
  switch (f.kind) {
    case "source-error":
      return `${f.file}: ${f.actual} type error(s) in a SOURCE file. Source files are zero-tolerance; fix them.`;
    case "spec-regression":
      return `${f.file}: ${f.actual} type error(s), the baseline allows ${f.allowed}. Fix the new error(s); the baseline never goes up.`;
    case "stale-baseline":
      return `${f.file}: only ${f.actual} type error(s) left but the baseline still allows ${f.allowed}. Lower it: node scripts/check-types-ratchet.mjs --lower-baseline`;
    case "ts-nocheck":
      return `${f.file}: \`// @ts-nocheck\` switches the type-check off for the whole file, which would hide its errors from this gate. Remove it and fix (or baseline) the errors.`;
    case "baseline-non-spec":
      return `${f.file}: the baseline lists a non-spec file. Only *.spec.ts files can be allow-listed; remove the entry.`;
    default:
      return `${f.file}: ${f.kind}`;
  }
}
