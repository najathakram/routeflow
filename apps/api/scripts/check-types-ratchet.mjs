#!/usr/bin/env node
// B806: `npm run check-types -w @routeflow/api`. Type-checks src AND specs in one program (see
// scripts/lib/check-types-ratchet-core.mjs for why and for the rules). The heap is set HERE, for
// every caller (verify, CI, turbo): src + specs peaks near 3 GB and OOMs at Node's default heap.
//
//   node scripts/check-types-ratchet.mjs                  check (exit 0 = pass)
//   node scripts/check-types-ratchet.mjs --lower-baseline  lower the spec baseline to what is left
//   node scripts/check-types-ratchet.mjs --init-baseline   write the first baseline (refused if one exists)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEAP_MB,
  classifyWorkerExit,
  countByFile,
  describeFailure,
  evaluate,
  lowerBaseline,
} from "./lib/check-types-ratchet-core.mjs";

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(API_DIR, "tsconfig.spec.json");
const WORKER = path.join(API_DIR, "scripts/lib/check-types-worker.mjs");
const BASELINE = path.join(API_DIR, "check-types.spec-baseline.json");
const mode = process.argv[2] ?? "check";
if (!["check", "--lower-baseline", "--init-baseline"].includes(mode)) {
  console.error(
    `check-types (api): unknown argument "${mode}" (expected --lower-baseline or --init-baseline).`,
  );
  process.exit(2);
}

const heapFlag = `--max-old-space-size=${HEAP_MB}`;
const nodeOptions = [process.env.NODE_OPTIONS ?? "", heapFlag].join(" ").trim();
const res = spawnSync(process.execPath, [heapFlag, WORKER, CONFIG], {
  cwd: API_DIR,
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

const oom = classifyWorkerExit(res);
if (oom) {
  console.error(`check-types (api): FAILED: ${oom.message}.`);
  if (res.stderr) console.error(res.stderr.trim().split("\n").slice(-12).join("\n"));
  process.exit(1);
}
if (res.status !== 0 || !res.stdout.trim()) {
  console.error(
    `check-types (api): the compile worker failed (status ${res.status}, signal ${res.signal}).`,
  );
  if (res.stderr) console.error(res.stderr.trim().split("\n").slice(-20).join("\n"));
  process.exit(1);
}
const { files, diagnostics, nocheck, wallMs, peakRssMb } = JSON.parse(
  res.stdout.trim().split("\n").pop(),
);
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;

console.log(
  `check-types (api, src + specs): ${files} files, ${diagnostics.length} diagnostic(s) · ` +
    `wall ${(wallMs / 1000).toFixed(1)}s · peak RSS ${peakRssMb} MB (heap cap ${HEAP_MB} MB)`,
);

const writeBaseline = (obj) => writeFileSync(BASELINE, JSON.stringify(obj, null, 2) + "\n");

if (mode === "--init-baseline") {
  if (baseline) {
    console.error(
      "check-types (api): a baseline already exists; it can only be lowered (--lower-baseline).",
    );
    process.exit(1);
  }
  const counts = countByFile(diagnostics);
  const source = [...counts.keys()].filter((f) => !/\.spec\.ts$/.test(f));
  if (source.length) {
    console.error(`check-types (api): refusing to baseline SOURCE errors: ${source.join(", ")}`);
    process.exit(1);
  }
  writeBaseline(Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))));
  console.log(
    `check-types (api): wrote the first baseline, ${diagnostics.length} error(s) in ${counts.size} spec file(s).`,
  );
  process.exit(0);
}

const result = evaluate(diagnostics, baseline ?? {}, nocheck);

if (mode === "--lower-baseline") {
  const blocking = result.failures.filter((f) => f.kind !== "stale-baseline");
  if (blocking.length) {
    console.error("check-types (api): not lowering: fix these first.");
    for (const f of blocking) console.error(`  - ${describeFailure(f)}`);
    process.exit(1);
  }
  writeBaseline(lowerBaseline(baseline ?? {}, result.counts));
  console.log("check-types (api): baseline lowered to what is left.");
  process.exit(0);
}

if (result.ok) {
  const allowed = Object.values(baseline ?? {}).reduce((a, b) => a + b, 0);
  console.log(
    `check-types (api): ok. 0 source errors; spec errors ${result.total} (baseline allows ${allowed}).`,
  );
  process.exit(0);
}

console.error(`check-types (api): FAILED, ${result.failures.length} problem(s):`);
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
process.exit(1);
