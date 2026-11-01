// The local files a script pulls in (static `import`, dynamic `import()`, `require()`, `createRequire(...)("./x")`),
// followed transitively. A self-test that runs a script from a scratch copy builds the copy list from this, never from
// a hand-kept list: a hand-kept list silently goes stale the day the script imports one more file, and the fixture then
// fails (or, worse, passes against the wrong file) for a reason nobody sees. A file the script imports that does not
// exist is reported by name, so the failure says what to fix.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// A relative specifier directly after `from`, `import(`, `require(`, or the `)(` of createRequire(...)("./x").
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\)\s*\(\s*)["'](\.{1,2}\/[^"'\n]+)["']/g;

// Comments name files that are not imported (a note about `from "./calendar-date"`). Line by line, never a regex over
// the whole text: a `/*` inside a string or a glob ("apps/*") would otherwise open a "block comment" that swallows
// real imports up to the next `*/` (it did: check-git-hooks.mjs fell out of the closure). A line that starts a
// comment is dropped; a trailing `//` comment is cut where it is not inside a quoted string ("https://" survives).
function codeOf(line) {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}
const stripComments = (src) => src.split(/\r?\n/).map(codeOf).join("\n");

/** Relative specifiers ("./lib/a.mjs", "../b.cjs") in a source text, in order, no duplicates. */
export function relativeImports(src) {
  return [...new Set([...stripComments(src).matchAll(SPECIFIER)].map((m) => m[1]))];
}

/**
 * { files, missing }: `files` are repo-relative ("/") paths of every local file reachable from `entryRel` (the entry
 * itself excluded), sorted; `missing` are { from, spec } for each relative import that resolves to no file.
 * `exists` / `read` are seams for the self-test; the defaults read the disk under `root`.
 */
export function importClosure(
  root,
  entryRel,
  {
    exists = (rel) => existsSync(path.join(root, rel)),
    read = (rel) => readFileSync(path.join(root, rel), "utf8"),
  } = {},
) {
  const seen = new Set([entryRel]);
  const missing = [];
  const queue = [entryRel];
  while (queue.length) {
    const from = queue.shift();
    for (const spec of relativeImports(read(from))) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      if (!exists(rel)) {
        missing.push({ from, spec });
        continue;
      }
      if (!seen.has(rel)) {
        seen.add(rel);
        queue.push(rel);
      }
    }
  }
  seen.delete(entryRel);
  return { files: [...seen].sort(), missing };
}

/** One line per missing import, naming the importer, the specifier and what to do. */
export function describeMissing(missing) {
  return missing
    .map(
      (m) =>
        `fixture copy list: ${m.from} imports ${m.spec}, which does not exist; fix the import or restore the file`,
    )
    .join("\n");
}
