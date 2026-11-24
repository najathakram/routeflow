#!/usr/bin/env node
// List EXISTING test assertions a diff removed or changed (why: #4404 went green by rewriting the
// fixtures of a named eligibility test). Usage: node scripts/review-test-edits.mjs --base <sha> --head <sha> [--json]
// Exit 1 when any are found, 2 on a crash or bad usage. Added tests are ignored: only lines removed from the base side count.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TEST_FILE = /\.(spec\.ts|test\.tsx?|test\.mjs)$/;
const RANGE_TITLE = /\b(it|test)(\.(only|skip|each|todo))?\s*\(/;
const TITLE = /\b(it|test|describe)(\.(only|skip|each|todo))?\s*\(/;
const SKIP_ONLY = /\.(skip|only)\(|\b[xf](it|describe|test)\(/;
const TRIVIAL = /^[\s});,\]]*$/;
const ASSERT =
  /\bexpect\s*\(|\.(toBe|toEqual|toStrictEqual|toThrow|toHaveBeenCalled(With|Times)?|toMatch|toContain)\w*\s*\(|\bassert(\.\w+)?\s*\(/;

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Line ranges (1-based, inclusive) of it()/test() calls: paren depth from the title line to its close. */
export function testRanges(source) {
  const lines = source.split("\n");
  const ranges = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, "");
    if (!start && RANGE_TITLE.test(code)) start = i + 1;
    if (!start) continue;
    for (const ch of code) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth <= 0) {
      ranges.push([start, i + 1]);
      start = 0;
      depth = 0;
    }
  }
  return ranges;
}

export function classify(text, inTest) {
  if (TITLE.test(text)) return "title";
  if (ASSERT.test(text)) return "assertion";
  if (inTest) return "fixture";
  return TRIVIAL.test(text) ? null : "setup";
}

export function findEdits(base, head) {
  const diff = git(["diff", "--no-renames", "--unified=0", "--no-color", base, head]);
  const findings = [];
  let file = null;
  let headFile = null;
  let ranges = [];
  let inHeader = false;
  let line = 0;
  let headLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      headFile = null;
      ranges = [];
    } else if (inHeader && raw.startsWith("--- ")) {
      const p = raw.slice(4).replace(/^a\//, "");
      file = p !== "/dev/null" && TEST_FILE.test(p) ? p : null;
      ranges = file ? testRanges(git(["show", `${base}:${file}`])) : [];
    } else if (inHeader && raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "");
      headFile = p !== "/dev/null" && TEST_FILE.test(p) ? p : null;
    } else if (raw.startsWith("@@")) {
      inHeader = false;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      line = Number(m[1]);
      headLine = Number(m[2]);
    } else if (inHeader) {
      continue;
    } else if (raw.startsWith("+")) {
      const text = raw.slice(1);
      if (headFile && SKIP_ONLY.test(text)) {
        findings.push({ file: headFile, line: headLine, kind: "skip", text: text.trim() });
      }
      headLine++;
    } else if (file && raw.startsWith("-")) {
      const text = raw.slice(1);
      const inTest = ranges.some(([s, e]) => line >= s && line <= e);
      const kind = text.trim() ? classify(text, inTest) : null;
      if (kind) findings.push({ file, line, kind, text: text.trim() });
      line++;
    }
  }
  return findings;
}

function main(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const [base, head] = [opt("--base"), opt("--head")];
  if (!base || !head) {
    console.error("usage: review-test-edits.mjs --base <sha> --head <sha> [--json]");
    return 2;
  }
  let findings;
  try {
    findings = findEdits(base, head);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  if (argv.includes("--json")) console.log(JSON.stringify({ base, head, findings }, null, 2));
  else {
    for (const f of findings) console.log(`${f.file}:${f.line} [${f.kind}] ${f.text}`);
    console.log(`${findings.length} existing test line(s) removed or changed (base side).`);
  }
  return findings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
