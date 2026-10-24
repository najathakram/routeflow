#!/usr/bin/env node
// B806: `npm run check-types -w @routeflow/api`. Type-checks src AND specs (see
// scripts/lib/check-types-ratchet-core.mjs for why and for the rules). The heap is set HERE, for
// every caller (verify, CI, turbo).
//
// W-756: two programs, run one after the other, each in its own worker process (so the peak is the
// larger of the two, never the sum): `unit` (tsconfig.spec-unit.json) and `db`
// (tsconfig.spec-db.json, the *.db.spec.ts lane and the source it imports). Each has its own baseline.
//
//   node scripts/check-types-ratchet.mjs                  check (exit 0 = pass)
//   node scripts/check-types-ratchet.mjs --lower-baseline  lower each baseline to what is left
//   node scripts/check-types-ratchet.mjs --init-baseline   write a program's first baseline (refused if one exists)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEAP_MB,
  PROGRAMS,
  classifyWorkerExit,
  countByFile,
  describeFailure,
  evaluate,
  lowerBaseline,
} from "./lib/check-types-ratchet-core.mjs";

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(API_DIR, "scripts/lib/check-types-worker.mjs");
const mode = process.argv[2] ?? "check";
if (!["check", "--lower-baseline", "--init-baseline"].includes(mode)) {
  console.error(
    `check-types (api): unknown argument "${mode}" (expected --lower-baseline or --init-baseline).`,
  );
  process.exit(2);
}

const heapFlag = `--max-old-space-size=${HEAP_MB}`;
const nodeOptions = [process.env.NODE_OPTIONS ?? "", heapFlag].join(" ").trim();

/** One program's compile, in its own worker. Exits the whole check on a crash or an out-of-memory. */
function compile(program) {
  const label = `check-types (api, ${program.name})`;
  const res = spawnSync(process.execPath, [heapFlag, WORKER, path.join(API_DIR, program.config)], {
    cwd: API_DIR,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });
  const oom = classifyWorkerExit(res);
  if (oom) {
    console.error(`${label}: FAILED: ${oom.message}.`);
    if (res.stderr) console.error(res.stderr.trim().split("\n").slice(-12).join("\n"));
    process.exit(1);
  }
  if (res.status !== 0 || !res.stdout.trim()) {
    console.error(
      `${label}: the compile worker failed (status ${res.status}, signal ${res.signal}).`,
    );
    if (res.stderr) console.error(res.stderr.trim().split("\n").slice(-20).join("\n"));
    process.exit(1);
  }
  const out = JSON.parse(res.stdout.trim().split("\n").pop());
  console.log(
    `${label}: ${out.files} files, ${out.diagnostics.length} diagnostic(s) · ` +
      `wall ${(out.wallMs / 1000).toFixed(1)}s · peak RSS ${out.peakRssMb} MB (heap cap ${HEAP_MB} MB)`,
  );
  return out;
}

let failed = false;
for (const program of PROGRAMS) {
  const label = `check-types (api, ${program.name})`;
  const baselinePath = path.join(API_DIR, program.baseline);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  const writeBaseline = (obj) => writeFileSync(baselinePath, JSON.stringify(obj, null, 2) + "\n");

  if (mode === "--init-baseline" && baseline) {
    console.log(`${label}: a baseline already exists; it can only be lowered (--lower-baseline).`);
    continue;
  }

  const { diagnostics, nocheck } = compile(program);

  if (mode === "--init-baseline") {
    const counts = countByFile(diagnostics);
    const source = [...counts.keys()].filter((f) => !/\.spec\.ts$/.test(f));
    if (source.length) {
      console.error(`${label}: refusing to baseline SOURCE errors: ${source.join(", ")}`);
      failed = true;
      continue;
    }
    writeBaseline(Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))));
    console.log(
      `${label}: wrote the first baseline, ${diagnostics.length} error(s) in ${counts.size} spec file(s).`,
    );
    continue;
  }

  const result = evaluate(diagnostics, baseline ?? {}, nocheck, program.name);

  if (mode === "--lower-baseline") {
    const blocking = result.failures.filter((f) => f.kind !== "stale-baseline");
    if (blocking.length) {
      console.error(`${label}: not lowering: fix these first.`);
      for (const f of blocking) console.error(`  - ${describeFailure(f)}`);
      failed = true;
      continue;
    }
    writeBaseline(lowerBaseline(baseline ?? {}, result.counts));
    console.log(`${label}: baseline lowered to what is left.`);
    continue;
  }

  if (result.ok) {
    const allowed = Object.values(baseline ?? {}).reduce((a, b) => a + b, 0);
    console.log(
      `${label}: ok. 0 source errors; spec errors ${result.total} (baseline allows ${allowed}).`,
    );
    continue;
  }

  failed = true;
  console.error(`${label}: FAILED, ${result.failures.length} problem(s):`);
  for (const f of result.failures) console.error(`  - ${describeFailure(f)}`);
  const flagged = new Set(
    result.failures
      .filter((f) => f.kind === "source-error" || f.kind === "spec-regression")
      .map((f) => f.file),
  );
  const shown = diagnostics.filter((d) => flagged.has(d.file ?? "<no file>")).slice(0, 60);
  if (shown.length) {
    console.error("\nThe errors in those files:");
    for (const d of shown)
      console.error(
        `  ${d.file ?? "<no file>"}(${d.line}): TS${d.code}: ${d.message.split("\n")[0]}`,
      );
  }
}
process.exit(failed ? 1 : 0);
