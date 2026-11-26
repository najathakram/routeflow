#!/usr/bin/env node
// Junctions a worktree's node_modules to a host tree's, so a builder never runs `npm ci` or hand-writes link scripts.
//   node scripts/link-node-modules.mjs <tree> <host>
// Links <tree>/node_modules and <tree>/<apps|packages>/<x>/node_modules to the host's where BOTH the tree's folder and
// the host's node_modules exist.
// The link is only sound when the host's installed packages are the ones the tree would install, so it REFUSES unless
//   1. the tree's package-lock.json is byte-identical to the host's (sha256), and
//   2. packages/* has no diff between the host's HEAD and the tree (its HEAD and working files): `@routeflow/*` and their
//      `dist` resolve through the link, so a changed package would be tested against the host's copy.
// Link paths are compared by realpath (a tree whose `apps/` is itself a link cannot write outside the tree). The run is
// all-or-nothing: every check happens before the first link, and if a link still fails the links this run made are
// removed again (unlink only, never recursive). Never overwrites anything. Exit 0 ok, 2 refused / usage.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Realpath of `p`, or of its nearest existing ancestor with the remainder re-appended. */
function realish(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const up = path.dirname(abs);
    return up === abs ? abs : path.join(realish(up), path.basename(abs));
  }
}

/** Validates one junction `link` -> `target` without creating it; returns "link" or "exists", else throws. */
export function checkLink(tree, link, target) {
  if (!inside(realish(tree), path.join(realish(path.dirname(link)), path.basename(link))))
    throw new Error(`refusing: link ${link} is not inside ${tree} (real paths compared)`);
  if (!fs.existsSync(target)) throw new Error(`refusing: target ${target} does not exist`);
  let st = null;
  try {
    st = fs.lstatSync(link);
  } catch {
    /* absent */
  }
  if (!st) return "link";
  if (st.isSymbolicLink() && !fs.existsSync(link))
    throw new Error(`refusing: ${link} is a dangling link; remove it first`);
  return "exists";
}

/** Creates one junction `link` -> `target`; throws (and creates nothing) on a failed check. */
export function linkOne(tree, link, target, symlink = fs.symlinkSync) {
  const what = checkLink(tree, link, target);
  if (what === "exists") return "exists";
  symlink(path.resolve(target), path.resolve(link), "junction");
  return "linked";
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function gitOut(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: scrubbedGitEnv(),
  });
  return {
    status: r.status,
    out: String(r.stdout ?? "").trim(),
    err: String(r.stderr ?? "").trim(),
  };
}

/** Why `tree` must not borrow `host`'s node_modules, or null. */
export function mismatchReason(tree, host, git = gitOut) {
  const [tl, hl] = [tree, host].map((d) => path.join(d, "package-lock.json"));
  if (!fs.existsSync(tl) || !fs.existsSync(hl))
    return `package-lock.json is missing in ${fs.existsSync(tl) ? host : tree}; cannot prove the installs match`;
  if (sha256(tl) !== sha256(hl))
    return "package-lock.json differs between the tree and the host (a different install); run its own `npm ci --ignore-scripts` through the heavy slot";
  const head = git(host, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.out)
    return `cannot read the host's HEAD (${head.err || "git failed"})`;
  const d = git(tree, ["diff", "--quiet", head.out, "--", "packages"]);
  if (d.status === 1)
    return "packages/* differs between the host's HEAD and the tree; the linked dist would be the host's, so a change here would pass unseen. Build its own node_modules";
  if (d.status !== 0) return `cannot compare packages/* (${d.err || "git failed"})`;
  return null;
}

export function main(
  argv = process.argv.slice(2),
  log = console.log,
  { symlink = fs.symlinkSync, git = gitOut } = {},
) {
  const [tree, host] = argv;
  if (!tree || !host) {
    log("usage: node scripts/link-node-modules.mjs <tree> <host>");
    return 2;
  }
  const made = [];
  try {
    const why = mismatchReason(tree, host, git);
    if (why) throw new Error(`refusing: ${why}`);
    const dirs = [""];
    for (const top of ["apps", "packages"])
      for (const d of fs.existsSync(path.join(tree, top))
        ? fs.readdirSync(path.join(tree, top))
        : [])
        dirs.push(path.join(top, d));
    const plan = [];
    for (const d of dirs) {
      const target = path.join(host, d, "node_modules");
      if (d && !fs.existsSync(target)) continue; // the host has none for this workspace
      const link = path.join(tree, d, "node_modules");
      plan.push({ link, target, what: checkLink(tree, link, target) });
    }
    const lines = [];
    for (const { link, target, what } of plan) {
      if (what === "link") {
        symlink(path.resolve(target), path.resolve(link), "junction");
        made.push(link);
      }
      lines.push(`${link} -> ${target}: ${what === "link" ? "linked" : "exists"}`);
    }
    lines.forEach((l) => log(l));
    for (const stray of ["apps", "packages"])
      if (fs.existsSync(path.join(host, "node_modules", stray)))
        log(
          `WARNING: ${path.join(host, "node_modules", stray)} exists (a link written into the host tree)`,
        );
    return 0;
  } catch (e) {
    for (const l of made.reverse()) {
      try {
        fs.unlinkSync(l); // only a link this run made; unlink never recurses into the target
      } catch {
        /* already gone */
      }
    }
    log(e instanceof Error ? e.message : String(e));
    if (made.length) log(`rolled back ${made.length} link(s) made by this run`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main());
