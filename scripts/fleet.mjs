#!/usr/bin/env node
// Fleet CLI: one command per fleet mechanic that used to be a prose guard.
//   node scripts/fleet.mjs stamp [--seconds]                   0 ok
//   node scripts/fleet.mjs subject-check "<subject>"           0 ok, 1 a commitlint rule fails, 2 usage
//   node scripts/fleet.mjs post --issue <n> --body-file <path> 0 posted (else gh's code), 2 empty/usage,
//                                                              3 count unreadable, 4 leak/no patterns,
//                                                              5 board full (>= 2300 comments)
//   node scripts/fleet.mjs preflight                           0 hooks present, 1 no hooks, 2 unreadable
// Unknown subcommand: prints this table, exit 64. Not on the push path; nothing loads it.
import { pathToFileURL } from "node:url";

const TABLE = {
  stamp: () => import("./lib/fleet/stamp.mjs"),
  "subject-check": () => import("./lib/fleet/subject.mjs"),
  post: () => import("./lib/fleet/board.mjs"),
  preflight: () => import("./lib/fleet/preflight.mjs"),
};

export async function main(argv, ctx = {}) {
  const [name, ...args] = argv;
  if (!Object.hasOwn(TABLE, name))
    return {
      code: 64,
      lines: [`unknown subcommand "${name ?? ""}"; use one of: ${Object.keys(TABLE).join(", ")}`],
    };
  return (await TABLE[name]()).run(args, ctx);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, lines } = await main(process.argv.slice(2));
  for (const l of lines) console.log(l);
  process.exit(code);
}
