#!/usr/bin/env node
// fix-brief.mjs -- ESM, zero deps, Node >= 18, Windows-safe (execFileSync array-form only).
// Renders one packet per review finding: detail, scenario, source excerpt, enclosing symbol, callers.
// CLI: --findings <json> --out <path> [--cap 8192] [--cwd <dir>] [--context 20]
// Exit: 0 ok / 2 usage / 3 content. Last stdout line: JSON {out,bytes,truncated,sections}.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CAP = 8192;
const DEFAULT_CONTEXT = 20;
const DETAIL_CAP = 1200;
const MAX_CALLERS = 10;
const MARKER_TEXT = (cap) => "[truncated at " + cap + " bytes -- packager must tighten]";

class UsageError extends Error {}
class ContentError extends Error {}

export function hardTruncateWithMarker(text, cap) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return { text, truncated: false };
  const marker = "\n" + MARKER_TEXT(cap);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, cap - markerBytes);
  const cut = buf.subarray(0, budget).toString("utf8");
  return { text: cut + marker, truncated: true };
}

export const DECL_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s+\w+|class\s+\w+|(const|let|var)\s+\w+\s*=|interface\s+\w+|type\s+\w+\s*=|\w+\s*\([^)]*\)\s*\{|def\s+\w+)/;

export function findEnclosingSymbol(lines, idx) {
  const floor = Math.max(0, idx - 80);
  for (let i = idx; i >= floor; i--)
    if (DECL_RE.test(lines[i])) return { line: i + 1, text: lines[i].trim() };
  return null;
}

function git(args, cwd, opts) {
  const o = opts || {};
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  } catch (e) {
    if (o.allowExit1 && e.status === 1) return e.stdout || "";
    throw new ContentError(
      "git " + args.join(" ") + " failed: " + (e.stderr || e.message || String(e)),
    );
  }
}

function resolvePath(cwd, p) {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function parseArgs(argv) {
  const o = { cwd: process.cwd(), cap: DEFAULT_CAP, context: DEFAULT_CONTEXT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--findings") o.findings = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--cap") o.cap = Number(argv[++i]);
    else if (a === "--cwd") o.cwd = argv[++i];
    else if (a === "--context") o.context = Number(argv[++i]);
    else if (a === "--selftest") {
      /* handled by caller */
    } else throw new UsageError("unknown argument: " + a);
  }
  if (!o.findings) throw new UsageError("--findings is required");
  if (!o.out) throw new UsageError("--out is required");
  if (!Number.isFinite(o.cap) || o.cap <= 0)
    throw new UsageError("--cap must be a positive number");
  if (!Number.isFinite(o.context) || o.context < 0)
    throw new UsageError("--context must be a non-negative number");
  return o;
}

function loadFindings(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ContentError("unparsable findings JSON: " + e.message);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.findings)) return parsed.findings;
  throw new ContentError("findings JSON must be an array or {findings:[]}");
}

const SYNTHETIC_KEY_RE = /^\((.+)\)$/;

function renderExcerpt(finding, cwd, context) {
  const file = finding.file;
  const line = finding.line;
  if (!file || typeof file !== "string")
    return { excerpt: "(no source excerpt: no file given)", lines: null };
  const m = file.match(SYNTHETIC_KEY_RE);
  if (m) return { excerpt: "(no source excerpt: synthetic key " + file + ")", lines: null };
  if (line === undefined || line === null || line === "?" || line === "") {
    return { excerpt: "(no source excerpt: no line number given)", lines: null };
  }
  const lineNum = Number(line);
  if (!Number.isFinite(lineNum) || lineNum < 1)
    return { excerpt: "(no source excerpt: invalid line number)", lines: null };
  const filePath = resolvePath(cwd, file);
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return {
      excerpt: "(no source excerpt: cannot read " + file + " -- " + e.message + ")",
      lines: null,
    };
  }
  const lines = content.split("\n");
  const from = Math.max(1, lineNum - context);
  const to = Math.min(lines.length, lineNum + context);
  const excerptBody = lines
    .slice(from - 1, to)
    .map((l, idx) => from + idx + ": " + l)
    .join("\n");
  const header = "**Excerpt (" + file + " L" + from + "–" + to + "):**";
  return { excerpt: header + "\n```\n" + excerptBody + "\n```", lines, lineIdx: lineNum - 1 };
}

function findCallers(symbol, file, cwd) {
  if (!symbol) return [];
  // NOTE: git() already turns "no matches" (exit 1, allowExit1:true) into '' without
  // throwing. Do NOT wrap this in a try/catch here -- a genuine git failure (corrupted
  // repo, git unavailable, bad pathspec) must propagate as the caller's exit-3 content
  // failure, not be silently reinterpreted as "no callers found".
  const hits = git(["grep", "-n", "-w", symbol, "--", ".", ":!" + file], cwd, { allowExit1: true });
  return hits.split("\n").filter(Boolean).slice(0, MAX_CALLERS);
}

function renderFinding(finding, idx, cwd, context) {
  const severity = finding.severity || "unknown";
  const file = finding.file || "?";
  const line =
    finding.line === undefined || finding.line === null || finding.line === "" ? "?" : finding.line;
  const summary = finding.summary || "";
  const header = "## [" + idx + "] " + severity + " -- " + file + ":" + line + " -- " + summary;
  const parts = [header];
  if (finding.detail) {
    const detail = String(finding.detail);
    const shown = detail.length > DETAIL_CAP ? detail.slice(0, DETAIL_CAP) + "…" : detail;
    parts.push("**Detail:**\n" + shown);
  }
  if (finding.scenario) parts.push("**Scenario:**\n" + finding.scenario);
  const { excerpt, lines, lineIdx } = renderExcerpt(finding, cwd, context);
  parts.push(excerpt);
  let enclosing = null;
  if (lines && lineIdx !== undefined) enclosing = findEnclosingSymbol(lines, lineIdx);
  if (enclosing) {
    parts.push("**Enclosing symbol:** line " + enclosing.line + ": " + enclosing.text);
    const symMatch =
      enclosing.text.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*[=(]/) ||
      enclosing.text.match(/\b(?:function|class|interface|type|def)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    const symName = symMatch ? symMatch[1] : null;
    const callers = symName ? findCallers(symName, finding.file, cwd) : [];
    parts.push(
      "**Callers of " +
        (symName || "?") +
        ":**\n" +
        (callers.length ? callers.join("\n") : "(none found)"),
    );
  } else {
    parts.push("**Enclosing symbol:** (none found)");
  }
  return parts.join("\n\n");
}

// Like hardTruncateWithMarker, but for a whole-text cut across finding BLOCKS: any block
// whose `## [<index>] ...` heading starts at or after the byte offset where the cut
// landed is "dropped" -- its index is appended after the marker, machine-parseable as a
// bracketed comma list (e.g. "... tighten] dropped: [3, 4, 5]").
export function truncateFindingsWithMarker(blocks, cap) {
  const joiner = "\n\n";
  const joined = blocks.join(joiner);
  const buf = Buffer.from(joined, "utf8");
  if (buf.length <= cap) return { text: joined, truncated: false, dropped: [] };
  const marker = "\n" + MARKER_TEXT(cap);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, cap - markerBytes);
  const cutText = buf.subarray(0, budget).toString("utf8");
  let offset = 0;
  const dropped = [];
  for (let i = 0; i < blocks.length; i++) {
    if (offset >= budget) dropped.push(i);
    offset += Buffer.byteLength(blocks[i], "utf8");
    if (i < blocks.length - 1) offset += Buffer.byteLength(joiner, "utf8");
  }
  const droppedSuffix = dropped.length ? " dropped: [" + dropped.join(", ") + "]" : "";
  return { text: cutText + marker + droppedSuffix, truncated: true, dropped };
}

export function buildFixBrief(opts) {
  const raw = fs.readFileSync(resolvePath(opts.cwd, opts.findings), "utf8");
  const findings = loadFindings(raw);
  const rendered = findings.map((f, i) => renderFinding(f, i, opts.cwd, opts.context));
  return truncateFindingsWithMarker(rendered, opts.cap);
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError)
      return { code: 2, stdout: [], stderr: ["usage error: " + e.message] };
    throw e;
  }
  let result;
  try {
    result = buildFixBrief(opts);
  } catch (e) {
    if (e instanceof ContentError)
      return { code: 3, stdout: [], stderr: ["content error: " + e.message] };
    return { code: 3, stdout: [], stderr: ["error: " + (e && e.message ? e.message : String(e))] };
  }
  const outPath = resolvePath(opts.cwd, opts.out);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.text);
  } catch (e) {
    return { code: 3, stdout: [], stderr: ["cannot write out file: " + e.message] };
  }
  const line = JSON.stringify({
    out: outPath,
    bytes: Buffer.byteLength(result.text, "utf8"),
    truncated: result.truncated,
    sections: ["fix-brief"],
  });
  return { code: 0, stdout: [line], stderr: [] };
}

// ---- selftest ----
function assertEq(actual, expected, msg, state) {
  const ok = actual === expected;
  if (!ok) {
    state.failed = true;
    state.failures.push(msg);
    console.error(
      "FAIL: " +
        msg +
        " -- expected " +
        JSON.stringify(expected) +
        " got " +
        JSON.stringify(actual),
    );
  } else console.log("PASS: " + msg);
  return ok;
}
function assertTrue(cond, msg, state) {
  if (!cond) {
    state.failed = true;
    state.failures.push(msg);
    console.error("FAIL: " + msg);
  } else console.log("PASS: " + msg);
  return cond;
}

export function runSelftest() {
  const state = { failed: false, failures: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fix-brief-selftest-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, encoding: "utf8" });
    const srcLines = [];
    for (let i = 1; i <= 10; i++) srcLines.push("// pad line " + i);
    srcLines.push("function target(x) {");
    srcLines.push("  return x + 1; // BUG line");
    srcLines.push("}");
    for (let i = 1; i <= 10; i++) srcLines.push("// pad line " + (10 + i));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "a.ts"), srcLines.join("\n") + "\n");
    fs.writeFileSync(
      path.join(tmp, "src", "b.ts"),
      'import { target } from "./a";\nexport function caller() { return target(1); }\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: tmp, encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], {
      cwd: tmp,
      encoding: "utf8",
    });

    const bugLineNum = 11; // 1-based: 10 pad lines then "function target(x) {"
    const longDetail = "x".repeat(1300);
    const findings = [
      {
        severity: "critical",
        file: "src/a.ts",
        line: bugLineNum + 1,
        summary: "off by one",
        detail: "adds 1 unexpectedly",
        scenario: "call target(1), expect 1 got 2",
      },
      { severity: "minor", file: "(build-plan)", summary: "plan is stale" },
      {
        severity: "important",
        file: "src/a.ts",
        line: bugLineNum + 1,
        summary: "long detail",
        detail: longDetail,
      },
    ];
    fs.writeFileSync(path.join(tmp, "findings.json"), JSON.stringify(findings));

    let enclosing;
    try {
      enclosing = findEnclosingSymbol(srcLines, bugLineNum); // 0-based idx of the BUG line
      assertTrue(enclosing !== null, "enclosing symbol is found scanning upward", state);
      assertTrue(
        enclosing !== null && /function target/.test(enclosing.text),
        "enclosing symbol is the containing function",
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("findEnclosingSymbol");
      console.error("FAIL: findEnclosingSymbol -- threw " + e.message);
    }

    const outPath = path.join(tmp, "out", "fix-brief.md");
    let r;
    try {
      r = main(["--findings", "findings.json", "--out", outPath, "--cwd", tmp]);
      assertEq(r.code, 0, "happy-path run exits 0", state);
    } catch (e) {
      state.failed = true;
      state.failures.push("happy-path run");
      console.error("FAIL: happy-path run -- threw " + e.message);
      r = null;
    }

    if (r && r.code === 0) {
      const text = fs.readFileSync(outPath, "utf8");
      assertTrue(
        /11: function target\(x\) \{/.test(text) || text.includes("function target(x) {"),
        "+-20-line excerpt is present around the enclosing function",
        state,
      );
      assertTrue(text.includes("src/b.ts"), "one caller line from git grep is present", state);
      assertTrue(
        text.includes("(no source excerpt: synthetic key (build-plan))"),
        "synthetic key finding gets a no-source-excerpt note",
        state,
      );
      assertTrue(
        text.includes("**Excerpt (src/a.ts L1–24):**"),
        'excerpt block carries the required "**Excerpt (<file> L<from>–<to>):**" header',
        state,
      );
      assertTrue(
        text.includes("x".repeat(1200) + "…"),
        "a Detail longer than the cap is truncated AND ends with an ellipsis",
        state,
      );
      assertTrue(
        !text.includes("x".repeat(1201)),
        "the truncated Detail carries no more than DETAIL_CAP source characters",
        state,
      );
    }

    // Item 9: truncateFindingsWithMarker appends the dropped finding indices after the
    // marker -- test the function directly with synthetic blocks so the byte math is
    // fully deterministic (block1 starts at offset 52, block2 at offset 104; any cap
    // whose budget lands under 52 must drop exactly [1, 2]).
    try {
      const blocks = ["A".repeat(50), "B".repeat(50), "C".repeat(50)];
      const res = truncateFindingsWithMarker(blocks, 60);
      assertEq(res.truncated, true, "synthetic 3-block truncation sets truncated:true", state);
      assertEq(
        JSON.stringify(res.dropped),
        JSON.stringify([1, 2]),
        "dropped[] lists exactly the blocks whose heading starts at/after the cut point",
        state,
      );
      assertTrue(
        res.text.includes("dropped: [1, 2]"),
        "the marker is followed by a machine-parseable bracketed list of dropped indices",
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("truncateFindingsWithMarker dropped indices");
      console.error("FAIL: truncateFindingsWithMarker dropped indices -- threw " + e.message);
    }

    const outTiny = path.join(tmp, "out", "fix-brief-tiny.md");
    try {
      const rTiny = main([
        "--findings",
        "findings.json",
        "--out",
        outTiny,
        "--cwd",
        tmp,
        "--cap",
        "200",
      ]);
      assertEq(rTiny.code, 0, "tiny-cap run exits 0", state);
      const tinyText = fs.readFileSync(outTiny, "utf8");
      assertTrue(
        tinyText.includes("[truncated at 200 bytes -- packager must tighten]"),
        "tiny --cap output carries the exact ASCII marker",
        state,
      );
      assertTrue(
        /dropped: \[\d+(, \d+)*\]\s*$/.test(tinyText),
        "tiny --cap output ends with a machine-parseable dropped-indices list",
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("tiny-cap marker");
      console.error("FAIL: tiny-cap marker -- threw " + e.message);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Item 2: a GENUINE git failure (no repository at all here, so `git grep` inside
  // findCallers exits non-1/non-0) must propagate as exit 3, not be silently
  // reinterpreted as "no callers found". Separate tmp dir, deliberately NOT git-init'd.
  const tmpNoGit = fs.mkdtempSync(path.join(os.tmpdir(), "fix-brief-selftest-nogit-"));
  try {
    fs.mkdirSync(path.join(tmpNoGit, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpNoGit, "src", "a.ts"),
      "function target(x) {\n  return x + 1;\n}\n",
    );
    fs.writeFileSync(
      path.join(tmpNoGit, "findings.json"),
      JSON.stringify([{ severity: "critical", file: "src/a.ts", line: 2, summary: "test" }]),
    );
    const outNoGit = path.join(tmpNoGit, "out.md");
    const rNoGit = main(["--findings", "findings.json", "--out", outNoGit, "--cwd", tmpNoGit]);
    assertEq(
      rNoGit.code,
      3,
      "a genuine git failure (no repository here) propagates as exit 3, not a silently empty callers list",
      state,
    );
    assertTrue(
      rNoGit.stderr.some((l) => /git/i.test(l)),
      "the exit-3 error message mentions git",
      state,
    );
  } catch (e) {
    state.failed = true;
    state.failures.push("git failure propagation");
    console.error("FAIL: git failure propagation -- threw " + e.message);
  } finally {
    fs.rmSync(tmpNoGit, { recursive: true, force: true });
  }

  if (state.failed) console.log("SELFTEST FAIL: " + state.failures.join("; "));
  else console.log("SELFTEST PASS");
  return state.failed ? 1 : 0;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    process.exitCode = runSelftest();
  } else {
    let result = null;
    try {
      result = main(argv);
    } catch (e) {
      console.error("error: " + (e && e.message ? e.message : String(e)));
      process.exitCode = 3;
    }
    if (result) {
      for (const l of result.stdout) console.log(l);
      for (const l of result.stderr) console.error(l);
      process.exitCode = result.code;
    }
  }
}
