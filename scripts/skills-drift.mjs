#!/usr/bin/env node
/**
 * R7-b: this repo is the source of truth for every skill it holds. The global copy (`~/.claude/skills/<name>`, usually
 * a junction into the owner's `claude-skills` checkout) is a deploy target, never edited by hand.
 *
 *   --check [--warn]   compare each skill present on both sides; exit 1 on drift naming each file. --warn (the
 *                      SessionStart hook) prints one line naming the drifted skills, nothing when clean, and exits 0.
 *   --sync [--force]   copy the repo files that differ or are missing into the real global dir (through the junction),
 *                      commit nothing, and print the git commands for the owner's checkout. It refuses to overwrite a
 *                      global file git could not give back (outside a checkout, or with uncommitted changes) and
 *                      exits 1 naming it; --force overwrites anyway. New files are always written.
 *   --repo <dir> --global <dir>   override the two skills dirs (defaults: <repo>/.claude/skills, ~/.claude/skills).
 *
 * Drift = a repo file that is missing globally or differs. A file only in the global copy is an "extra": printed, not
 * drift, because it may be the owner's own addition (the 2026-10 reconcile table rules the ones that existed then).
 * IGNORE drops backups, caches and generated output on both sides. With no global skills dir (CI) it says so and
 * exits 0. Each machine runs --sync for its own home directory only.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Relative paths (forward slashes) that are never compared or copied. */
export const IGNORE = [
  /(?:^|\/)__pycache__\//,
  /(?:^|\/)node_modules\//,
  /(?:^|\/)graphify-out\//,
  /\.pyc$/,
  /\.bak(?:-[^/]*)?$/,
  /(?:^|\/)\.DS_Store$/,
];
const ignored = (rel) => IGNORE.some((re) => re.test(rel));

/** Files under dir as sorted forward-slash relative paths; statSync follows junctions and symlinks. */
function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(a);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile() && !ignored(r)) out.push(r);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out.sort();
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Skill names (dirs holding a SKILL.md) present in both skills dirs. */
export function pairedSkills(repoDir, globalDir) {
  if (!isDir(repoDir) || !isDir(globalDir)) return [];
  return readdirSync(repoDir)
    .filter((n) => existsSync(path.join(repoDir, n, "SKILL.md")) && isDir(path.join(globalDir, n)))
    .sort();
}

/** One skill: { differs, missingGlobal, globalOnly } as relative paths. Line endings count as equal. */
export function diffSkill(repoSkill, globalSkill) {
  const a = listFiles(repoSkill);
  const b = new Set(listFiles(globalSkill));
  const norm = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  return {
    differs: a.filter(
      (f) => b.has(f) && norm(path.join(repoSkill, f)) !== norm(path.join(globalSkill, f)),
    ),
    missingGlobal: a.filter((f) => !b.has(f)),
    globalOnly: [...b].filter((f) => !a.includes(f)).sort(),
  };
}

export function driftReport(repoDir, globalDir) {
  const drift = [];
  const extra = [];
  for (const skill of pairedSkills(repoDir, globalDir)) {
    const d = diffSkill(path.join(repoDir, skill), path.join(globalDir, skill));
    for (const file of d.differs) drift.push({ skill, file, kind: "differs" });
    for (const file of d.missingGlobal) drift.push({ skill, file, kind: "missing-global" });
    for (const file of d.globalOnly) extra.push({ skill, file, kind: "global-only" });
  }
  const key = (x) => `${x.skill}/${x.file}`;
  drift.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)); // code-point order, same as listFiles
  return { drift, extra };
}

const slash = (p) => p.split(path.sep).join("/");

/** Copy drifted repo files into the real global dirs. Returns { copied, commands }; runs no git write. */
export function syncSkills(repoDir, globalDir, { force = false } = {}) {
  const copied = [];
  const refused = [];
  const roots = new Map(); // git toplevel -> relative paths changed under it
  for (const { skill, file, kind } of driftReport(repoDir, globalDir).drift) {
    const real = realpathSync(path.join(globalDir, skill));
    const dest = path.join(real, ...file.split("/"));
    const top = spawnSync("git", ["-C", real, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    const root = top.status === 0 ? top.stdout.trim() : null;
    // Overwriting is only safe when git can give the old text back: tracked and clean. A new file destroys nothing.
    if (kind === "differs" && !force) {
      const why = !root
        ? "not in a git checkout, so the global text could not be recovered"
        : spawnSync("git", ["-C", real, "status", "--porcelain", "--", dest], {
              encoding: "utf8",
            }).stdout.trim()
          ? "has uncommitted changes in its checkout"
          : null;
      if (why) {
        refused.push({ file: `${skill}/${file}`, why });
        continue;
      }
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(repoDir, skill, ...file.split("/")), dest);
    copied.push(`${skill}/${file}`);
    if (root) {
      if (!roots.has(root)) roots.set(root, []);
      roots.get(root).push(slash(path.relative(realpathSync(root), dest)));
    }
  }
  const commands = [];
  for (const [root, files] of roots) {
    const r = slash(root);
    commands.push(`git -C "${r}" add ${files.map((f) => `"${f}"`).join(" ")}`);
    commands.push(
      `git -C "${r}" commit -m "sync RouteFlow skills from the repo (skills-drift --sync)"`,
    );
  }
  return { copied, refused, commands };
}

function main(argv) {
  const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : dflt;
  };
  const repoDir = opt(
    "--repo",
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude", "skills"),
  );
  const globalDir = opt("--global", path.join(os.homedir(), ".claude", "skills"));
  const mode = argv.includes("--sync") ? "sync" : argv.includes("--check") ? "check" : null;
  if (!mode) {
    console.error(
      "usage: skills-drift.mjs --check [--warn] | --sync [--force]  [--repo <dir>] [--global <dir>]",
    );
    return 2;
  }
  if (!isDir(globalDir)) {
    console.log(`skills-drift: no global skills dir at ${globalDir}, nothing to check`);
    return 0;
  }
  if (mode === "sync") {
    const { copied, refused, commands } = syncSkills(repoDir, globalDir, {
      force: argv.includes("--force"),
    });
    for (const f of copied) console.log(`copied ${f}`);
    for (const r of refused) console.log(`refused ${r.file}: ${r.why}`);
    console.log(
      `skills-drift: ${copied.length} file(s) copied, ${refused.length} refused, nothing committed` +
        (refused.length ? " — commit or copy those by hand first, or re-run with --force" : ""),
    );
    if (commands.length)
      console.log(`To record them in the owner's checkout:\n${commands.join("\n")}`);
    return refused.length ? 1 : 0;
  }
  const { drift, extra } = driftReport(repoDir, globalDir);
  if (argv.includes("--warn")) {
    // SessionStart: one line in every session's context, and none when clean.
    const skills = [...new Set(drift.map((d) => d.skill))];
    if (drift.length)
      console.log(
        `skills-drift: ${drift.length} file(s) differ from ~/.claude/skills in ${skills.join(", ")}; ` +
          "see `node scripts/skills-drift.mjs --check`; --sync makes the repo copy win",
      );
    return 0;
  }
  for (const d of drift) console.log(`drift ${d.kind}: ${d.skill}/${d.file}`);
  for (const e of extra) console.log(`extra (global only, not drift): ${e.skill}/${e.file}`);
  console.log(
    `skills-drift: ${drift.length} drifted file(s), ${extra.length} global-only` +
      (drift.length ? " — run `node scripts/skills-drift.mjs --sync`" : ""),
  );
  return drift.length ? 1 : 0;
}

const isCli = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && isCli()) process.exitCode = main(process.argv.slice(2));
