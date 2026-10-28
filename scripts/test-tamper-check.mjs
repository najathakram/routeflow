#!/usr/bin/env node
// Flags a diff that WEAKENS a test (R4, dark). Read-only: scans the unified diff of test files only.
//
//   node scripts/test-tamper-check.mjs [--base <ref>]
//
// Hits (file:line, before/after), judged per FILE across its hunks (an assertion moved to another hunk
// is no hit; removed import lines are not assertions): an assertion removed with no replacement; a
// matcher loosened, also through .resolves/.not and when the subject changes (toEqual -> toBeDefined, a
// number -> expect.any(Number), a wider toBeCloseTo); .skip/.only/xit/it.todo added; @ts-ignore/
// eslint-disable added; a test file deleted.
// Allowed edits: a `// tamper-ok: <reason>` comment on the added line itself (for a removal: on an added
// line of the same hunk), or a `Test-Change: <reason>` trailer in a branch commit (whole-file delete).
// Allowed edits are listed with their reason.
// --base defaults to origin/master, master or main (first that exists).
// Exit: TAMPER_MODE "dark" always 0 (even on an internal error); "enforced" would exit 1 on any hit.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

export const TAMPER_MODE = "dark";

const TEST_FILE = /(\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$)|(^|\/)__tests__\/|\.self-test\.mjs$/;
export const isTestFile = (p) => TEST_FILE.test(p);

const ASSERT = /\bexpect\s*\(|\bassert\b|\bcheck\s*\(|\bok\s*\(|\.toThrow|\.rejects\b/;
const STRICT = new Set(["toBe", "toEqual", "toStrictEqual"]);
const LOOSE = new Set(["toBeDefined", "toBeTruthy", "toBeFalsy"]);
// Added-line patterns: one row per kind of tamper that needs no pairing with a removed line.
const ADDED = [
  [
    "skip-added",
    /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/,
  ],
  ["suppression-added", /@ts-ignore|@ts-nocheck|eslint-disable/],
];

/** `Test-Change: <reason>` trailers of a commit-message blob. */
export const parseTrailers = (text) =>
  [...String(text).matchAll(/^Test-Change:[ \t]*(.+)$/gim)].map((m) => m[1].trim());

/** { subject, neg, name, args } of the first `expect(<subject>).[not.]matcher(args)` on a line. */
function parseExpect(text) {
  const start = text.indexOf("expect(");
  if (start < 0) return null;
  let depth = 0;
  let i = start + "expect".length;
  for (; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) break;
  }
  const m = /^\s*\.((?:(?:not|resolves|rejects)\.)*)(\w+)\((.*)$/.exec(text.slice(i + 1));
  if (!m) return null;
  return {
    subject: text.slice(start + 7, i).trim(),
    neg: /not\./.test(m[1]),
    name: m[2],
    args: m[3],
  };
}
const digits = (a) => Number(/,\s*(\d+)\s*\)/.exec(a)?.[1] ?? 2);

/** [kind, detail] when `after` is weaker than `before` (same subject), else null. */
function weakened(before, after) {
  if (!before || !after) return null;
  if (STRICT.has(before.name) && !before.neg) {
    if (LOOSE.has(after.name) || (after.neg && /^toBe(Null|Undefined)$/.test(after.name))) {
      return ["loosened", `${before.name} -> ${after.neg ? "not." : ""}${after.name}`];
    }
    if (/expect\.(anything\(\)|any\(Number\))/.test(after.args) && !/expect\./.test(before.args)) {
      return ["loosened", "exact value -> expect.anything()/any(Number)"];
    }
  }
  if (
    before.name === "toBeCloseTo" &&
    after.name === "toBeCloseTo" &&
    digits(after.args) < digits(before.args)
  ) {
    return ["precision-loosened", `toBeCloseTo ${digits(before.args)} -> ${digits(after.args)}`];
  }
  return null;
}

/** Scans a unified diff (git diff -U0); returns { hits, allowed } of { kind, file, line, before, after }. */
export function scanDiff(diff, { trailers = [] } = {}) {
  const hits = [];
  const allowed = [];
  let file = null;
  let acc = { rem: [], add: [] }; // { rem, add } of the current file, across all its hunks
  let hunkNo = 0;
  let inHunk = false;
  let hunkLine = 0;
  let gone = false; // the file is deleted: its removed lines are one file-deleted hit, not many

  const okReason = (lines) =>
    lines.map((a) => /tamper-ok:\s*(.*?)\s*$/.exec(a.text)?.[1]).find(Boolean);
  const judge = ({ rem, add }) => {
    // via = the added lines allowed to carry tamper-ok: the hit's own added line, or for a removal its hunk
    const report = (kind, at, before, after, via = [at]) => {
      const reason = okReason(via);
      (reason ? allowed : hits).push({
        kind,
        file,
        line: at.line,
        before,
        after,
        ...(reason ? { reason } : {}),
      });
    };
    // imports/requires are not assertions even when they name `assert`
    const code = (l) => l.text.trim() && !/^\s*(\/\/|\*|\/\*|import\b)|\brequire\s*\(/.test(l.text);
    for (const a of add) {
      for (const [kind, re] of ADDED) {
        if (re.test(a.text) && !rem.some((r) => r.text.trim() === a.text.trim())) {
          report(kind, a, "", a.text.trim());
        }
      }
    }
    const unpairedAdds = add.filter((l) => code(l) && ASSERT.test(l.text));
    const unpairedRem = [];
    for (const r of rem.filter((l) => code(l) && ASSERT.test(l.text))) {
      const rp = parseExpect(r.text);
      const j = rp
        ? unpairedAdds.findIndex((a) => parseExpect(a.text)?.subject === rp.subject)
        : -1;
      if (j < 0) {
        unpairedRem.push(r);
        continue;
      }
      const [a] = unpairedAdds.splice(j, 1);
      const w = weakened(rp, parseExpect(a.text));
      if (w) report(w[0], a, r.text.trim(), a.text.trim());
    }
    for (const r of unpairedRem) {
      const a = unpairedAdds.shift(); // a changed subject still counts as the replacement
      const w = a && weakened(parseExpect(r.text), parseExpect(a.text));
      if (w) report(w[0], a, r.text.trim(), a.text.trim());
      else if (!a) {
        report(
          "assertion-removed",
          r,
          r.text.trim(),
          "",
          add.filter((x) => x.hunk === r.hunk),
        );
      }
    }
  };
  const flush = () => {
    if (acc && file && !gone && isTestFile(file)) judge(acc);
    acc = { rem: [], add: [] };
  };

  for (const raw of String(diff).split("\n")) {
    const head = /^diff --git a\/.* b\/(.*)$/.exec(raw);
    if (head) {
      flush();
      file = head[1];
      gone = false;
      inHunk = false;
    } else if (raw.startsWith("@@")) {
      inHunk = true;
      hunkNo += 1;
      hunkLine = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (inHunk && raw.startsWith("-")) {
      acc.rem.push({ text: raw.slice(1), line: hunkLine, hunk: hunkNo });
    } else if (inHunk && raw.startsWith("+")) {
      acc.add.push({ text: raw.slice(1), line: hunkLine++, hunk: hunkNo });
    } else if (!inHunk && raw.startsWith("deleted file mode") && file && isTestFile(file)) {
      gone = true;
      const e = { kind: "file-deleted", file, line: 0, before: file, after: "" };
      if (trailers.length) allowed.push({ ...e, reason: trailers[0] });
      else hits.push(e);
    }
  }
  flush();
  return { hits, allowed };
}

const git = (args) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });

export function main(argv) {
  const bi = argv.indexOf("--base");
  const refs = bi >= 0 ? [argv[bi + 1]] : ["origin/master", "master", "main"];
  const ok = (r) => r && git(["rev-parse", "--verify", "-q", `${r}^{commit}`]).status === 0;
  const base = refs.find(ok);
  if (!base) {
    console.log("test-tamper-check: no base ref found; nothing to scan.");
    return 0;
  }
  const mb = git(["merge-base", base, "HEAD"]).stdout.trim() || base;
  const d = git(["diff", "-U0", "-M", "--no-color", "--no-ext-diff", mb, "HEAD"]);
  const trailers = parseTrailers(git(["log", "--format=%B", `${mb}..HEAD`]).stdout);
  const { hits, allowed } = scanDiff(d.stdout, { trailers });
  for (const h of hits)
    console.log(`TAMPER  ${h.kind}  ${h.file}:${h.line}  ${h.before} => ${h.after}`);
  for (const a of allowed) console.log(`allowed ${a.kind}  ${a.file}:${a.line}  ${a.reason}`);
  console.log(
    `test-tamper-check (${TAMPER_MODE}): ${hits.length} hit(s), ${allowed.length} allowed.`,
  );
  return TAMPER_MODE === "enforced" && hits.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`test-tamper-check: ${e instanceof Error ? e.message : e}`);
    process.exit(TAMPER_MODE === "enforced" ? 2 : 0);
  }
}
