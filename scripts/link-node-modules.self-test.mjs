#!/usr/bin/env node
// Self-test for scripts/link-node-modules.mjs (temp dirs and a temp git repo only). Junctions are removed with
// unlinkSync, never recursively.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkOne, main } from "./link-node-modules.mjs";

let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e.message).replace(/ [^ ]*(tree|host|out)[^ ]*/g, " <p>");
  }
};
const git = (cwd, ...args) => {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-nm-"));
const host = path.join(root, "host");
fs.mkdirSync(host);
git(host, "init", "-q", "-b", "main");
git(host, "config", "core.autocrlf", "false");
fs.writeFileSync(path.join(host, "package-lock.json"), '{"lock":1}\n');
for (const d of ["apps/api", "apps/web", "apps/mobile", "packages/ui"]) {
  fs.mkdirSync(path.join(host, d), { recursive: true });
  fs.writeFileSync(path.join(host, d, "keep.txt"), "x\n");
}
git(host, "add", ".");
git(host, "commit", "-q", "-m", "base");
for (const d of ["node_modules", "apps/api/node_modules", "apps/web/node_modules"])
  fs.mkdirSync(path.join(host, d), { recursive: true });
const worktree = (name) => {
  const dir = path.join(root, name);
  git(host, "worktree", "add", "-q", "-b", name, dir);
  return dir;
};
const links = (t) =>
  ["", "apps/api", "apps/web", "apps/mobile", "packages/ui"].filter((d) =>
    isLink(path.join(t, d, "node_modules")),
  );
const unlinkAll = (t) => links(t).forEach((d) => fs.unlinkSync(path.join(t, d, "node_modules")));

const tree = worktree("tree");
const lines = [];
const code = main([tree, host], (m) => lines.push(m));
if (code) console.log(lines.join(" | "));
check(
  "N1 links the root and each workspace the host has, none the host lacks; prints each pair",
  [code, links(tree), lines.length],
  [0, ["", "apps/api", "apps/web"], 3],
);
check(
  "N2 a second run overwrites nothing",
  [main([tree, host], (m) => lines.push(m)), lines.at(-1).endsWith("exists")],
  [0, true],
);
check(
  "N3 a link path outside the tree is refused and nothing is created",
  [
    throws(() => linkOne(tree, path.join(root, "out", "node_modules"), host)),
    fs.existsSync(path.join(root, "out")),
  ],
  ["refusing: link <p> is not inside <p> (real paths compared)", false],
);
check(
  "N4 a missing target is refused",
  throws(() => linkOne(tree, path.join(tree, "packages/ui/node_modules"), path.join(host, "nope"))),
  "refusing: target <p> does not exist",
);
check(
  "N5 the host's own node_modules is untouched (no apps or packages folder inside)",
  fs.readdirSync(path.join(host, "node_modules")),
  [],
);
unlinkAll(tree);

// N6: a different lockfile is a different install: refuse, create nothing, say why.
{
  const t = worktree("lock");
  fs.writeFileSync(path.join(t, "package-lock.json"), '{"lock":2}\n');
  const out = [];
  check(
    "N6 a package-lock.json that differs from the host's is refused, no link made, reason printed",
    [
      main([t, host], (m) => out.push(m)),
      links(t),
      /package-lock\.json differs/.test(out.join("\n")),
    ],
    [2, [], true],
  );
}

// N7: packages/* changed in the tree (committed, or only edited) is refused; a change outside packages/ is fine.
{
  const t = worktree("pkgs");
  fs.writeFileSync(path.join(t, "packages/ui/keep.txt"), "changed\n");
  const edited = [];
  const c1 = main([t, host], (m) => edited.push(m));
  git(t, "add", "packages/ui/keep.txt");
  git(t, "commit", "-q", "-m", "change a package");
  const committed = [];
  const c2 = main([t, host], (m) => committed.push(m));
  check(
    "N7a packages/* edited or committed in the tree: refused, no link, reason names packages/*",
    [c1, c2, links(t), /packages\/\* differs/.test(edited.join("\n") + committed.join("\n"))],
    [2, 2, [], true],
  );
  const u = worktree("appsonly");
  fs.writeFileSync(path.join(u, "apps/api/keep.txt"), "changed\n");
  git(u, "add", "apps/api/keep.txt");
  git(u, "commit", "-q", "-m", "change an app");
  check(
    "N7b a change outside packages/ does not block the link",
    [main([u, host], () => {}), links(u)],
    [0, ["", "apps/api", "apps/web"]],
  );
  unlinkAll(u);
}

// N8: the inside-tree check uses realpaths: a tree whose `apps` is a link to elsewhere cannot write outside it.
{
  const t = path.join(root, "linked-apps-tree");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "api"), { recursive: true });
  fs.mkdirSync(t);
  fs.symlinkSync(elsewhere, path.join(t, "apps"), "junction");
  const msg = throws(() =>
    linkOne(
      t,
      path.join(t, "apps", "api", "node_modules"),
      path.join(host, "apps/api/node_modules"),
    ),
  );
  check(
    "N8 a link written through a linked `apps` folder is refused and nothing lands outside the tree",
    [msg, fs.existsSync(path.join(elsewhere, "api", "node_modules"))],
    ["refusing: link <p> is not inside <p> (real paths compared)", false],
  );
  fs.unlinkSync(path.join(t, "apps"));
}

// N9: a dangling link at a later workspace stops the run before any link is made.
{
  const t = worktree("dangling");
  fs.symlinkSync(path.join(root, "nowhere"), path.join(t, "apps/web/node_modules"), "junction");
  const out = [];
  const c = main([t, host], (m) => out.push(m));
  check(
    "N9 a dangling link in the tree: refused up front, nothing linked, the dangling link left alone",
    [c, links(t), /dangling/.test(out.join("\n"))],
    [2, ["apps/web"], true],
  );
  fs.unlinkSync(path.join(t, "apps/web/node_modules"));
}

// N10: a link that fails mid-run undoes the links this run already made.
{
  const t = worktree("rollback");
  let n = 0;
  const flaky = (target, link, type) => {
    if (++n === 3) throw new Error("EPERM: simulated");
    fs.symlinkSync(target, link, type);
  };
  const out = [];
  const c = main([t, host], (m) => out.push(m), { symlink: flaky });
  check(
    "N10 a failure on the 3rd link removes the 2 made, leaves none, says it rolled back",
    [c, links(t), /rolled back 2 link/.test(out.join("\n"))],
    [2, [], true],
  );
}

unlinkAll(tree);
for (const d of fs.readdirSync(root)) {
  const p = path.join(root, d);
  if (d !== "host") for (const sub of links(p)) fs.unlinkSync(path.join(p, sub, "node_modules"));
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`link-node-modules self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
