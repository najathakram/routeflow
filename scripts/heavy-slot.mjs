#!/usr/bin/env node
// Machine-wide heavy-job slot CLI (see scripts/lib/heavy-slot.mjs and
// docs/runbooks/shared-host-heavy-slot.md).
//
//   node scripts/heavy-slot.mjs run --label <x> [--branch <b>] -- <cmd...>   wait for the slot, run, release
//   node scripts/heavy-slot.mjs status                                        holder, queue, last runs
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  HeavySlotTimeout,
  TIMEOUT_EXIT_CODE,
  formatStatus,
  resolveDir,
  spawnAsync,
  withHeavySlot,
} from "./lib/heavy-slot.mjs";

const USAGE = `heavy-slot.mjs — one heavy local job at a time per host

Usage:
  node scripts/heavy-slot.mjs run --label <x> [--branch <b>] -- <command> [args...]
  node scripts/heavy-slot.mjs status

Env: RF_HEAVY_SLOT_DIR, RF_HEAVY_SLOTS (default 1), RF_HEAVY_SLOT_MAX_WAIT_MIN (default 720),
     RF_HEAVY_SLOT_MAX_HOLD_MIN (default 180), RF_HEAVY_SLOT=off (run unguarded, loud warning), CI (no slot).
`;

/** { help } | { status } | { label, branch, cmd, args }; throws on bad usage. */
export function parseCli(argv) {
  const [verb, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "-h") return { help: true };
  if (verb === "status") return { status: true };
  if (verb !== "run") throw new Error(`unknown command ${JSON.stringify(verb)}`);
  const sep = rest.indexOf("--");
  if (sep === -1 || rest.length <= sep + 1) throw new Error("run needs `-- <command...>`");
  const opts = { label: "manual", branch: undefined };
  const flags = rest.slice(0, sep);
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--label" && flags[i + 1]) opts.label = flags[++i];
    else if (flags[i] === "--branch" && flags[i + 1] !== undefined) opts.branch = flags[++i];
    else throw new Error(`unknown or incomplete flag ${JSON.stringify(flags[i])}`);
  }
  const [cmd, ...args] = rest.slice(sep + 1);
  return { ...opts, cmd, args };
}

export async function main(argv = process.argv.slice(2)) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    console.error(`heavy-slot: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }
  if (cli.status) {
    console.log(formatStatus(resolveDir()));
    return 0;
  }
  try {
    return await withHeavySlot({ label: cli.label, branch: cli.branch }, async () => {
      let r = await spawnAsync(cli.cmd, cli.args);
      // Windows .cmd shims (npm, npx) need a shell; retry once that way on a plain ENOENT.
      if (r.error?.code === "ENOENT" && process.platform === "win32") {
        r = await spawnAsync(cli.cmd, cli.args, { shell: true });
      }
      if (r.error) console.error(`heavy-slot: ${r.error.message}`);
      return r.status ?? 1;
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return e instanceof HeavySlotTimeout ? TIMEOUT_EXIT_CODE : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
