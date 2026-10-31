"use strict";
// Derives, from the specs themselves, which Jest specs read ANOTHER workspace's source (an api spec walking apps/web,
// a web test reading packages/ui). Such a spec is invisible to `jest --changedSince` (it follows imports, not fs
// reads) and to an affected-scope push when only the OTHER workspace changed, so each workspace's `test:repo-truth`
// lane runs the specs found here on every fast and affected push. One derived list, no hand-kept one: a new
// cross-workspace spec is on the lane the day it is written. CommonJS so a Jest config can `require` it.
//
// A spec counts when (comments stripped) it calls an fs read AND names another workspace's directory, as one string
// ("apps/web", "packages/ui") or as joined segments ("apps", "web"). Heuristic by design: a false positive costs a
// few seconds on the lane, a miss is what cross-workspace-lane.spec.ts's canaries and fixture pin.
const fs = require("fs");
const path = require("path");

const SPEC_FILE = /\.(spec|test)\.[cm]?[tj]sx?$/;
// e2e = Playwright, not Jest; the rest are build output or dependencies.
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".expo", "coverage", "e2e"]);
const FS_READ = /\b(readFileSync|readdirSync|existsSync|statSync|readFile|readdir|globSync|glob)\b/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Workspace directories ("apps/api", "packages/ui") from the root package.json `workspaces` globs. */
function workspaceDirs(root) {
  const globs = (readJson(path.join(root, "package.json")) || {}).workspaces || [];
  const dirs = [];
  for (const g of globs) {
    if (!g.endsWith("/*")) continue; // only the `<parent>/*` shape this repo uses
    const parent = g.slice(0, -2);
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && fs.existsSync(path.join(root, parent, e.name, "package.json"))) {
        dirs.push(`${parent}/${e.name}`);
      }
    }
  }
  return dirs.sort();
}

/** Workspace dirs whose package.json defines `scripts[script]`, with their package names. */
function workspacesWithScript(root, script) {
  return workspaceDirs(root)
    .map((dir) => ({ dir, pkg: readJson(path.join(root, dir, "package.json")) || {} }))
    .filter((w) => w.pkg.scripts && w.pkg.scripts[script])
    .map((w) => ({ dir: w.dir, name: w.pkg.name }));
}

function walkSpecs(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkSpecs(path.join(dir, e.name), out);
    } else if (SPEC_FILE.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function namesDir(src, dir) {
  const [parent, name] = dir.split("/");
  const joined = `["'\`/\\\\]${parent}[/\\\\]${name}\\b`;
  const segments = `["']${parent}["'],\\s*["']${name}["']`;
  return new RegExp(`${joined}|${segments}`).test(src);
}

/**
 * { "apps/api": [{ spec: "src/common/x.spec.ts", reads: ["apps/web"] }], ... } — spec paths are relative to
 * the workspace and use "/". A workspace with none is absent.
 */
function findCrossWorkspaceSpecs(root) {
  const dirs = workspaceDirs(root);
  const result = {};
  for (const ws of dirs) {
    const files = [];
    walkSpecs(path.join(root, ws), files);
    const others = dirs.filter((d) => d !== ws);
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, "utf8"));
      if (!FS_READ.test(src)) continue;
      const reads = others.filter((d) => namesDir(src, d));
      if (!reads.length) continue;
      const spec = path.relative(path.join(root, ws), file).split(path.sep).join("/");
      (result[ws] = result[ws] || []).push({ spec, reads });
    }
    if (result[ws]) result[ws].sort((a, b) => a.spec.localeCompare(b.spec));
  }
  return result;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Jest testRegex alternation matching exactly these workspace-relative spec paths (either slash). */
function specPathsRegex(specs) {
  return specs.map((s) => escapeRegex(s).replace(/\//g, "[/\\\\]") + "$").join("|");
}

module.exports = {
  workspaceDirs,
  workspacesWithScript,
  findCrossWorkspaceSpecs,
  specPathsRegex,
};
