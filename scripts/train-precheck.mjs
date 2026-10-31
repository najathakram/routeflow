#!/usr/bin/env node
// One command for a train coordinator's pre-check, so nobody picks specs by hand (W31 lost 40 minutes to a hand-picked
// list that left out api-error-codes-parity). Run it on the assembled train head BEFORE the full verify:
//
//   npm run train:precheck            run every step, exit with the first non-zero status
//   npm run train:precheck -- --dry-run   print the commands only
//
// Steps (all run, none short-circuits, so one push reports every red):
//   1. tsc          turbo check-types, every workspace
//   2. repo-truth   turbo test:repo-truth, every workspace that defines it: the DERIVED cross-workspace spec list
//                   (scripts/lib/cross-workspace-specs.cjs) plus the size ratchet and the other repo pins
//   3. named gates  enum parity and permission-coverage (and the two cheap registries), api's own Jest, by name;
//                   a gate whose spec is not on this tree yet is skipped by --passWithNoTests, never by a hand list
// Takes the machine-wide heavy slot like verify does. Contract pinned by train-precheck-script.spec.ts.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withHeavySlot } from "./lib/heavy-slot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Specs run by name in apps/api (main config). Pure data; the spec pins that the lead's four are all here. */
export const NAMED_GATES = [
  "enum-parity",
  "permission-coverage",
  "addon-gate-registry",
  "no-bare-cron",
];

/** The ordered steps. `cwd` is relative to the repo root. */
export function planPrecheck() {
  const turbo = ["turbo", "run"];
  const flags = ["--concurrency=2", "--continue=dependencies-successful"];
  return [
    { name: "tsc", cwd: ".", cmd: "npx", args: [...turbo, "check-types", ...flags] },
    { name: "repo-truth", cwd: ".", cmd: "npx", args: [...turbo, "test:repo-truth", ...flags] },
    {
      name: "named gates",
      cwd: "apps/api",
      cmd: "npx",
      args: ["jest", "--passWithNoTests", "--maxWorkers=2", ...NAMED_GATES],
    },
  ];
}

export function main(argv = process.argv.slice(2)) {
  const steps = planPrecheck();
  const dry = argv.includes("--dry-run");
  const run = () => {
    let code = 0;
    for (const s of steps) {
      console.log(
        `\n== train pre-check: ${s.name} ==\n> ${s.cmd} ${s.args.join(" ")}  (cwd ${s.cwd})`,
      );
      if (dry) continue;
      const r = spawnSync(s.cmd, s.args, {
        cwd: path.join(ROOT, s.cwd),
        stdio: "inherit",
        env: process.env,
        shell: process.platform === "win32",
      });
      const status = r.status ?? 1;
      console.log(`== ${s.name}: ${status === 0 ? "ok" : `FAILED (exit ${status})`}`);
      if (status !== 0 && code === 0) code = status;
    }
    console.log(
      code === 0 ? "\ntrain pre-check: all green" : `\ntrain pre-check: RED (exit ${code})`,
    );
    return code;
  };
  return dry
    ? Promise.resolve(run())
    : withHeavySlot({ label: "train-precheck" }, async () => run());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(e?.name === "HeavySlotTimeout" ? 75 : 1);
    },
  );
}
