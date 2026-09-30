#!/usr/bin/env node
// review-pack.mjs -- ESM, zero deps, Node >= 18, Windows-safe (execFileSync array-form only).
// Assembles a review pack: Spec excerpt, Diff, Call sites, Radius?, Test-plan excerpt?, Lessons cited?
// CLI: --plan <p> [--test-plan <p>] --files a,b --base <ref|worktree> [--lessons <p>] [--radius a,b]
//      --out <p> [--cap 40960] [--cwd <dir>]
// Exit: 0 ok / 2 usage / 3 content. Last stdout line: JSON {out,bytes,truncated,sections}.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CAP = 40960;
const CALL_SITES_CAP = 8192;
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

// ---- markdown heading slicing (fence-aware, ## level) ----
export function sliceH2Section(md, name) {
  const lines = md.split("\n");
  const re = new RegExp("^##\\s+" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$");
  let inFence = false,
    start = -1,
    end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (start === -1 && re.test(line)) {
      start = i;
      continue;
    }
    if (start !== -1 && /^#{1,2}\s/.test(line)) {
      end = i;
      break;
    }
  }
  return start === -1 ? null : lines.slice(start, end).join("\n");
}

export function buildSpecExcerpt(planMd) {
  const preamble = sliceH2Section(planMd, "Preamble");
  const objective = preamble === null ? sliceH2Section(planMd, "Objective") : null;
  const acceptance = sliceH2Section(planMd, "Acceptance criteria");
  const parts = [];
  if (preamble !== null) parts.push(preamble);
  else if (objective !== null) parts.push(objective);
  if (acceptance !== null) parts.push(acceptance);
  return parts.length ? parts.join("\n\n") : null;
}

const EXPORT_RE =
  /^\+\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s+|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][A-Za-z0-9_$]*)/;

export function parseDiffForExports(diffText) {
  const lines = diffText.split("\n");
  const results = [];
  const seen = new Set();
  let currentFile = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      continue;
    }
    const plusPlusPlus = line.match(/^\+\+\+ (?:b\/(.+)|(\/dev\/null))$/);
    if (plusPlusPlus) {
      currentFile = plusPlusPlus[1] || null;
      continue;
    }
    if (line.startsWith("+++")) continue;
    if (!currentFile) continue;
    const m = line.match(EXPORT_RE);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      results.push({ symbol: m[1], file: currentFile });
    }
  }
  return results;
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

function readFileOrThrow(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new ContentError("cannot read file: " + p + " (" + e.message + ")");
  }
}

function resolvePath(cwd, p) {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function parseArgs(argv) {
  const o = { cwd: process.cwd(), cap: DEFAULT_CAP };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") o.plan = argv[++i];
    else if (a === "--test-plan") o.testPlan = argv[++i];
    else if (a === "--files") o.files = argv[++i];
    else if (a === "--base") o.base = argv[++i];
    else if (a === "--lessons") o.lessons = argv[++i];
    else if (a === "--radius") o.radius = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--cap") o.cap = Number(argv[++i]);
    else if (a === "--cwd") o.cwd = argv[++i];
    else if (a === "--selftest") {
      /* handled by caller */
    } else throw new UsageError("unknown argument: " + a);
  }
  if (!o.plan) throw new UsageError("--plan is required");
  if (!o.files) throw new UsageError("--files is required");
  if (!o.base) throw new UsageError("--base is required");
  if (!o.out) throw new UsageError("--out is required");
  if (!Number.isFinite(o.cap) || o.cap <= 0)
    throw new UsageError("--cap must be a positive number");
  o.fileList = o.files
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // --radius <before,after>: the flag's own two comma-separated tokens ARE the two
  // context sizes (lines before/after) to render around each call-site hit -- NOT a
  // second list of file paths. The files searched are wherever the changed symbols are
  // actually used, i.e. the same hits already found for the Call sites section.
  if (o.radius !== undefined) {
    const parts = o.radius.split(",").map((s) => s.trim());
    if (parts.length !== 2 || !parts.every((p) => /^\d+$/.test(p))) {
      throw new UsageError(
        '--radius must be two comma-separated non-negative integers "before,after", e.g. --radius 5,10',
      );
    }
    o.radiusRange = [Number(parts[0]), Number(parts[1])];
  }
  return o;
}

export function buildHeaderLine(opts) {
  return (
    "# Review pack — " +
    path.basename(opts.plan) +
    " — files: " +
    opts.fileList.join(", ") +
    " — base: " +
    opts.base
  );
}

export function buildSections(opts) {
  const sections = [];

  // 1. Spec excerpt
  const planMd = readFileOrThrow(resolvePath(opts.cwd, opts.plan));
  const specText = buildSpecExcerpt(planMd);
  sections.push({
    name: "Spec excerpt",
    text:
      specText !== null ? specText : "(no Preamble/Objective section found in " + opts.plan + ")",
  });

  // 2. Diff
  const diffArgs = ["diff", "-U10"];
  diffArgs.push(opts.base === "worktree" ? "HEAD" : opts.base);
  diffArgs.push("--", ...opts.fileList);
  const diffText = git(diffArgs, opts.cwd);
  const diffBody =
    diffText.trim().length === 0
      ? "(no changes in the named files against " + opts.base + ")"
      : "```diff\n" + diffText + "```";
  sections.push({ name: "Diff", text: diffBody });

  const exportsList = parseDiffForExports(diffText);

  // 3. Call sites -- also the source of "radius files" for section 4 (files where the
  // changed symbols are actually used), so the hits are captured here once and reused.
  let callSitesBody;
  const callSiteHits = []; // { symbol, file, line }
  if (exportsList.length === 0) {
    callSitesBody = "(no new exported symbols in the diff)";
  } else {
    const parts = [];
    for (const { symbol, file } of exportsList) {
      // git() already turns "no matches" (exit 1, allowExit1:true) into '' without
      // throwing. Do NOT wrap this in a try/catch here -- a genuine git failure
      // (corrupted repo, git unavailable, bad pathspec) must propagate as the caller's
      // exit-3 content failure, not be silently reinterpreted as "no references found".
      const hits = git(["grep", "-n", "-w", symbol, "--", ".", ":!" + file], opts.cwd, {
        allowExit1: true,
      });
      const hitLines = hits.split("\n").filter(Boolean).slice(0, 20);
      for (const hl of hitLines) {
        const m = hl.match(/^([^:]+):(\d+):/);
        if (m) callSiteHits.push({ symbol, file: m[1], line: Number(m[2]) });
      }
      parts.push(
        "**" +
          symbol +
          "** (defined in " +
          file +
          "):\n" +
          (hitLines.length ? hitLines.join("\n") : "(no other references found)"),
      );
    }
    callSitesBody = parts.join("\n\n");
  }
  const cappedCallSites = hardTruncateWithMarker(callSitesBody, CALL_SITES_CAP);
  sections.push({ name: "Call sites", text: cappedCallSites.text });

  // 4. Radius (only when --radius given; header always emitted). --radius <before,after>
  // are the two context-line counts; the files searched are exactly the call-site hits
  // above (files where the changed symbols are used), not a separate file list.
  if (opts.radiusRange) {
    const [before, after] = opts.radiusRange;
    let radiusBody;
    if (callSiteHits.length === 0) {
      radiusBody = "(no usages found in call sites)";
    } else {
      const fileCache = new Map();
      const parts = [];
      for (const hit of callSiteHits) {
        let flines = fileCache.get(hit.file);
        if (flines === undefined) {
          const rfPath = resolvePath(opts.cwd, hit.file);
          try {
            flines = fs.readFileSync(rfPath, "utf8").split("\n");
          } catch (e) {
            flines = null;
            parts.push("(" + hit.file + ": cannot read -- " + e.message + ")");
          }
          fileCache.set(hit.file, flines);
        }
        if (!flines) continue;
        const from = Math.max(1, hit.line - before);
        const to = Math.min(flines.length, hit.line + after);
        const excerpt = flines
          .slice(from - 1, to)
          .map((l, idx) => from + idx + ": " + l)
          .join("\n");
        parts.push(
          "**" +
            hit.symbol +
            "** in " +
            hit.file +
            " around line " +
            hit.line +
            ":\n```\n" +
            excerpt +
            "\n```",
        );
      }
      radiusBody = parts.length ? parts.join("\n\n") : "(no usages found in call sites)";
    }
    sections.push({ name: "Radius", text: radiusBody });
  }

  // 5. Test-plan excerpt (only with --test-plan)
  if (opts.testPlan) {
    const tpMd = readFileOrThrow(resolvePath(opts.cwd, opts.testPlan));
    const table = sliceH2Section(tpMd, "2. Test table");
    const text = table !== null ? table : tpMd.split("\n").slice(0, 60).join("\n");
    sections.push({ name: "Test-plan excerpt", text });
  }

  // 6. Lessons cited (only with --lessons)
  if (opts.lessons) {
    const cited = new Set(planMd.match(/L-\d{3}/g) || []);
    const digest = readFileOrThrow(resolvePath(opts.cwd, opts.lessons));
    const lines = digest.split("\n").filter((line) => {
      const m = line.match(/L-\d{3}/g);
      if (!m) return false;
      return m.some((id) => cited.has(id));
    });
    sections.push({
      name: "Lessons cited",
      text: lines.length ? lines.join("\n") : "(the plan cites no lesson ids)",
    });
  }

  return sections;
}

export function assemble(sections, cap, headerLine) {
  const render = (list) =>
    headerLine + "\n\n" + list.map((s) => "## " + s.name + "\n\n" + s.text).join("\n\n");
  let kept = sections.slice(),
    out = render(kept),
    truncated = false;
  while (Buffer.byteLength(out, "utf8") > cap && kept.length > 1) {
    kept.pop();
    truncated = true;
    out = render(kept);
  }
  if (Buffer.byteLength(out, "utf8") > cap) {
    const marker = "\n" + MARKER_TEXT(cap);
    const markerBytes = Buffer.byteLength(marker, "utf8");
    const budget = Math.max(0, cap - markerBytes);
    out = Buffer.from(out, "utf8").subarray(0, budget).toString("utf8") + marker;
    truncated = true;
  }
  return { out, truncated, kept };
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
  let sections;
  try {
    sections = buildSections(opts);
  } catch (e) {
    if (e instanceof ContentError)
      return { code: 3, stdout: [], stderr: ["content error: " + e.message] };
    return { code: 3, stdout: [], stderr: ["error: " + (e && e.message ? e.message : String(e))] };
  }
  const { out, truncated, kept } = assemble(sections, opts.cap, buildHeaderLine(opts));
  const outPath = resolvePath(opts.cwd, opts.out);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, out);
  } catch (e) {
    return { code: 3, stdout: [], stderr: ["cannot write out file: " + e.message] };
  }
  const line = JSON.stringify({
    out: outPath,
    bytes: Buffer.byteLength(out, "utf8"),
    truncated,
    sections: kept.map((s) => s.name),
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-pack-selftest-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, encoding: "utf8" });
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "a.ts"), "export function existingFn() { return 1; }\n");
    // b.ts: bakes in a call to newHelper (the symbol a.ts will newly export) at a KNOWN
    // line, padded on both sides, so the Radius before/after window can be checked exactly.
    const bLines = [];
    for (let i = 1; i <= 5; i++) bLines.push("// pad " + i);
    bLines.push("const x = newHelper();"); // line 6
    for (let i = 6; i <= 10; i++) bLines.push("// pad " + i);
    fs.writeFileSync(path.join(tmp, "src", "b.ts"), bLines.join("\n") + "\n");
    // c.ts: committed and never touched again -- the dedicated "no changes" fixture.
    fs.writeFileSync(path.join(tmp, "src", "c.ts"), "export function untouched() { return 42; }\n");
    fs.writeFileSync(
      path.join(tmp, "plan.md"),
      [
        "# Sample plan",
        "",
        "## Preamble",
        "",
        "This is the preamble. Related: L-001.",
        "",
        "## Objective",
        "",
        "Should not be used since Preamble exists.",
        "",
        "## Acceptance criteria",
        "",
        "- AC1: newHelper exists.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "plan-empty.md"),
      ["# Nothing here", "", "Some unrelated content, no lesson ids.", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "test-plan.md"),
      [
        "# Test plan",
        "",
        "## 1. Overview",
        "",
        "Not this section.",
        "",
        "## 2. Test table",
        "",
        "| id | desc |",
        "|----|------|",
        "| T1 | does the thing |",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "lessons-digest.md"),
      ["L-001: Always truncate ASCII markers.", "L-002: Unrelated lesson not cited.", ""].join(
        "\n",
      ),
    );
    execFileSync("git", ["add", "-A"], { cwd: tmp, encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], {
      cwd: tmp,
      encoding: "utf8",
    });
    fs.appendFileSync(path.join(tmp, "src", "a.ts"), "export function newHelper() { return 2; }\n");

    const outPath = path.join(tmp, "out", "pack.md");
    let r;
    try {
      r = main([
        "--plan",
        "plan.md",
        "--test-plan",
        "test-plan.md",
        "--files",
        "src/a.ts",
        "--base",
        "worktree",
        "--lessons",
        "lessons-digest.md",
        "--radius",
        "2,3",
        "--out",
        outPath,
        "--cwd",
        tmp,
      ]);
      assertEq(r.code, 0, "happy-path run exits 0", state);
    } catch (e) {
      state.failed = true;
      state.failures.push("happy-path run");
      console.error("FAIL: happy-path run -- threw " + e.message);
      r = null;
    }

    if (r && r.code === 0) {
      const parsed = JSON.parse(r.stdout[r.stdout.length - 1]);
      assertEq(
        JSON.stringify(parsed.sections),
        JSON.stringify([
          "Spec excerpt",
          "Diff",
          "Call sites",
          "Radius",
          "Test-plan excerpt",
          "Lessons cited",
        ]),
        "section ORDER is Spec excerpt, Diff, Call sites, Radius, Test-plan excerpt, Lessons cited",
        state,
      );
      const text = fs.readFileSync(outPath, "utf8");
      assertTrue(
        text.startsWith("# Review pack — plan.md — files: src/a.ts — base: worktree"),
        'output starts with the mandated "# Review pack -- <plan> -- files: <list> -- base: <base>" header line',
        state,
      );
      assertTrue(text.includes("This is the preamble"), "Spec excerpt uses Preamble", state);
      assertTrue(
        !text.includes("Should not be used since Preamble exists"),
        "Spec excerpt skips Objective when Preamble present",
        state,
      );
      assertTrue(
        text.includes("AC1: newHelper exists"),
        "Spec excerpt includes Acceptance criteria",
        state,
      );
      assertTrue(
        text.includes("+export function newHelper"),
        "Diff shows the newly added export",
        state,
      );
      // Item 1: --radius 2,3 means before=2/after=3 context lines around each call-site
      // hit, in whichever files the changed symbol is actually used (b.ts here) -- NOT a
      // second file list. Hit is b.ts line 6; window must be exactly lines 4..9.
      assertTrue(/## Radius/.test(text), "--radius emits the Radius header", state);
      assertTrue(
        text.includes("4: // pad 4") && text.includes("9: // pad 8"),
        "Radius window is exactly [hit-before, hit+after] = lines 4..9 for --radius 2,3",
        state,
      );
      assertTrue(
        !text.includes("3: // pad 3") && !text.includes("10: // pad 9"),
        "Radius window does NOT spill past the requested before/after counts (old hardcoded +-20 would have)",
        state,
      );
      assertTrue(
        text.includes("**newHelper** in src/b.ts around line 6"),
        "Radius identifies the correct symbol/file/line",
        state,
      );
      assertTrue(
        text.includes("| T1 | does the thing |"),
        "Test-plan excerpt uses the Test table section",
        state,
      );
      assertTrue(
        !text.includes("Not this section."),
        "Test-plan excerpt skips the Overview section",
        state,
      );
      assertTrue(
        text.includes("L-001: Always truncate"),
        "Lessons cited includes the cited id",
        state,
      );
      assertTrue(
        !text.includes("L-002: Unrelated"),
        "Lessons cited excludes the uncited id",
        state,
      );
    }

    // Item 1 (usage guard): --radius no longer accepts a file-path-shaped value.
    try {
      const rBadRadius = main([
        "--plan",
        "plan.md",
        "--files",
        "src/a.ts",
        "--base",
        "worktree",
        "--radius",
        "src/b.ts",
        "--out",
        path.join(tmp, "out", "bad-radius.md"),
        "--cwd",
        tmp,
      ]);
      assertEq(
        rBadRadius.code,
        2,
        "--radius with a file-path-shaped value (the old, wrong reading) is a usage error, not silently accepted",
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("--radius usage guard");
      console.error("FAIL: --radius usage guard -- threw " + e.message);
    }

    // Items 4 + 5: empty diff -> exact "(no changes ...)" text; and with no new exports,
    // Call sites uses the exact required placeholder wording.
    try {
      const outNoChange = path.join(tmp, "out", "no-change.md");
      const rNoChange = main([
        "--plan",
        "plan.md",
        "--files",
        "src/c.ts",
        "--base",
        "worktree",
        "--out",
        outNoChange,
        "--cwd",
        tmp,
      ]);
      assertEq(rNoChange.code, 0, "no-changes run exits 0", state);
      const noChangeText = fs.readFileSync(outNoChange, "utf8");
      assertTrue(
        noChangeText.includes("(no changes in the named files against worktree)"),
        'an empty diff renders the exact "(no changes in the named files against <base>)" text',
        state,
      );
      assertTrue(
        !noChangeText.includes("```diff"),
        "an empty diff does NOT render an empty ```diff fence",
        state,
      );
      assertTrue(
        noChangeText.includes("(no new exported symbols in the diff)"),
        'Call sites uses the exact "(no new exported symbols in the diff)" wording',
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("empty-diff wording");
      console.error("FAIL: empty-diff wording -- threw " + e.message);
    }

    // Item 5: exact fallback wording for Spec excerpt and Lessons cited.
    try {
      const outEmpty = path.join(tmp, "out", "empty-plan.md");
      const rEmpty = main([
        "--plan",
        "plan-empty.md",
        "--files",
        "src/c.ts",
        "--base",
        "worktree",
        "--lessons",
        "lessons-digest.md",
        "--out",
        outEmpty,
        "--cwd",
        tmp,
      ]);
      assertEq(rEmpty.code, 0, "empty-plan run exits 0", state);
      const emptyText = fs.readFileSync(outEmpty, "utf8");
      assertTrue(
        emptyText.includes("(no Preamble/Objective section found in plan-empty.md)"),
        "Spec-excerpt fallback uses the exact wording with the plan path substituted",
        state,
      );
      assertTrue(
        emptyText.includes("(the plan cites no lesson ids)"),
        'Lessons-cited fallback uses the exact "(the plan cites no lesson ids)" wording',
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("exact fallback wording");
      console.error("FAIL: exact fallback wording -- threw " + e.message);
    }

    // Item 2: git() must propagate a GENUINE failure (not "no matches") as a thrown
    // error, not swallow it -- the exact primitive Call Sites/Radius rely on now that
    // their redundant outer try/catch is gone. A malformed grep pattern is a reliable,
    // deterministic way to force git's real fatal path (exit 128), as opposed to the
    // "no matches" exit 1 that allowExit1 legitimately turns into ''.
    try {
      let threw = false;
      try {
        git(["grep", "-n", "-w", "[", "--", "."], tmp);
      } catch (e) {
        threw = true;
        assertTrue(
          /git grep/.test(e.message),
          "git() propagates a genuine failure (malformed pattern, exit 128) as a thrown error, not an empty result",
          state,
        );
      }
      if (!threw) {
        state.failed = true;
        state.failures.push("git() propagates a genuine failure");
        console.error("FAIL: git() propagates a genuine failure -- did not throw");
      }
    } catch (e) {
      state.failed = true;
      state.failures.push("git() error propagation");
      console.error("FAIL: git() error propagation -- threw " + e.message);
    }
    // Regression guard: no site should re-introduce the swallowing catch-and-reset-to-
    // empty-string pattern that used to sit around an already-safe git(...,
    // {allowExit1:true}) call. (Built via concatenation below so this very assertion's
    // own source text -- comment included -- can never contain the literal contiguous
    // pattern it is searching for.)
    try {
      const ownSource = fs.readFileSync(new URL(import.meta.url), "utf8");
      const swallowPattern = "catch (e) { hits = " + "''" + "; }";
      assertTrue(
        !ownSource.includes(swallowPattern),
        'source no longer contains the redundant catch that swallowed a genuine git failure as "no hits"',
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("source self-scan for the swallowed-catch pattern");
      console.error("FAIL: source self-scan -- threw " + e.message);
    }

    const outTiny = path.join(tmp, "out", "pack-tiny.md");
    try {
      const rTiny = main([
        "--plan",
        "plan.md",
        "--test-plan",
        "test-plan.md",
        "--files",
        "src/a.ts",
        "--base",
        "worktree",
        "--lessons",
        "lessons-digest.md",
        "--radius",
        "2,3",
        "--out",
        outTiny,
        "--cwd",
        tmp,
        "--cap",
        "300",
      ]);
      assertEq(rTiny.code, 0, "tiny-cap run exits 0", state);
      const parsedTiny = JSON.parse(rTiny.stdout[rTiny.stdout.length - 1]);
      assertEq(parsedTiny.truncated, true, "tiny --cap sets truncated:true", state);
      assertTrue(
        parsedTiny.sections.length < 6,
        "tiny --cap drops at least one tail section",
        state,
      );
      assertTrue(
        !parsedTiny.sections.includes("Lessons cited"),
        "tiny --cap drops the lowest-priority tail section first",
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("tiny-cap drop");
      console.error("FAIL: tiny-cap drop -- threw " + e.message);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
