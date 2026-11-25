#!/usr/bin/env node
// Junctions a worktree's node_modules to a host tree's, so a builder never runs `npm ci` or hand-writes link scripts.
//   node scripts/link-node-modules.mjs <tree> <host>
// Links <tree>/node_modules and <tree>/<apps|packages>/<x>/node_modules to the host's where BOTH the tree's folder and
// the host's node_modules exist. Refuses a link path that is not inside <tree>, refuses a missing target, never
// overwrites or removes anything. Prints each pair. Exit 0 ok, 2 refused / usage.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Creates one junction `link` -> `target`; throws (and creates nothing) on a link outside `tree` or a missing target. */
export function linkOne(tree, link, target) {
  const rel = path.relative(path.resolve(tree), path.resolve(link));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`refusing: link ${link} is not inside ${tree}`);
  if (!fs.existsSync(target)) throw new Error(`refusing: target ${target} does not exist`);
  if (fs.existsSync(link)) return "exists";
  fs.symlinkSync(path.resolve(target), path.resolve(link), "junction");
  return "linked";
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const [tree, host] = argv;
  if (!tree || !host) {
    log("usage: node scripts/link-node-modules.mjs <tree> <host>");
    return 2;
  }
  try {
    const dirs = [""];
    for (const top of ["apps", "packages"])
      for (const d of fs.existsSync(path.join(tree, top))
        ? fs.readdirSync(path.join(tree, top))
        : [])
        dirs.push(path.join(top, d));
    for (const d of dirs) {
      const target = path.join(host, d, "node_modules");
      if (d && !fs.existsSync(target)) continue; // the host has none for this workspace
      const link = path.join(tree, d, "node_modules");
      log(`${link} -> ${target}: ${linkOne(tree, link, target)}`);
    }
    for (const stray of ["apps", "packages"])
      if (fs.existsSync(path.join(host, "node_modules", stray)))
        log(
          `WARNING: ${path.join(host, "node_modules", stray)} exists (a link written into the host tree)`,
        );
    return 0;
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main());
