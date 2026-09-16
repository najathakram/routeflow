#!/usr/bin/env node
// task-brief.mjs -- ESM, zero deps, Node >= 18, Windows-safe (execFileSync array-form only).
// Slices one `### <id>` heading section out of a plan markdown file, fence-aware.
// CLI: --plan <path> --task <id> --out <path> [--cwd <dir>] [--cap 16384]
// Exit: 0 ok / 2 usage / 3 content. Last stdout line on success: JSON {out,bytes,truncated,sections}.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CAP = 16384;
const MARKER_TEXT = (cap) => "[truncated at " + cap + " bytes -- packager must tighten]";

export function sliceTaskSection(md, id) {
  const lines = md.split("\n");
  const re = new RegExp("^###\\s+" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
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
    if (start !== -1 && /^#{1,3}\s/.test(line)) {
      end = i;
      break;
    }
  }
  return start === -1 ? null : lines.slice(start, end).join("\n");
}

export function hardTruncateWithMarker(text, cap) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return { text, truncated: false };
  const marker = "\n" + MARKER_TEXT(cap);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, cap - markerBytes);
  const cut = buf.subarray(0, budget).toString("utf8");
  return { text: cut + marker, truncated: true };
}

class UsageError extends Error {}
class ContentError extends Error {}

function parseArgs(argv) {
  const o = { cwd: process.cwd(), cap: DEFAULT_CAP };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") o.plan = argv[++i];
    else if (a === "--task") o.task = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--cwd") o.cwd = argv[++i];
    else if (a === "--cap") o.cap = Number(argv[++i]);
    else if (a === "--selftest") {
      /* handled by caller */
    } else throw new UsageError("unknown argument: " + a);
  }
  if (!o.plan) throw new UsageError("--plan is required");
  if (!o.task) throw new UsageError("--task is required");
  if (!o.out) throw new UsageError("--out is required");
  if (!Number.isFinite(o.cap) || o.cap <= 0)
    throw new UsageError("--cap must be a positive number");
  return o;
}

export function buildBrief(opts) {
  const planPath = path.isAbsolute(opts.plan) ? opts.plan : path.join(opts.cwd, opts.plan);
  let md;
  try {
    md = fs.readFileSync(planPath, "utf8");
  } catch (e) {
    throw new ContentError("cannot read plan file: " + planPath + " (" + e.message + ")");
  }
  const slice = sliceTaskSection(md, opts.task);
  if (slice === null) throw new ContentError("task id not found: " + opts.task);
  const { text, truncated } = hardTruncateWithMarker(slice, opts.cap);
  return { text, truncated, bytes: Buffer.byteLength(text, "utf8"), sections: ["task-brief"] };
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
    result = buildBrief(opts);
  } catch (e) {
    if (e instanceof ContentError)
      return { code: 3, stdout: [], stderr: ["content error: " + e.message] };
    return { code: 3, stdout: [], stderr: ["error: " + (e && e.message ? e.message : String(e))] };
  }
  const outPath = path.isAbsolute(opts.out) ? opts.out : path.join(opts.cwd, opts.out);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.text);
  } catch (e) {
    return { code: 3, stdout: [], stderr: ["cannot write out file: " + e.message] };
  }
  const line = JSON.stringify({
    out: outPath,
    bytes: result.bytes,
    truncated: result.truncated,
    sections: result.sections,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-brief-selftest-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, encoding: "utf8" });
    const planMd = [
      "# Build plan",
      "",
      "### T1 -- First task",
      "",
      "Body line 1.",
      "",
      "```text",
      "### T9 -- inside fence, must not match",
      "```",
      "",
      "Body line 2.",
      "",
      "### T2 -- Second task",
      "",
      "Body of T2.",
      "",
    ].join("\n");
    const planPath = path.join(tmp, "build-plan.md");
    fs.writeFileSync(planPath, planMd);
    execFileSync("git", ["add", "-A"], { cwd: tmp, encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], {
      cwd: tmp,
      encoding: "utf8",
    });

    try {
      assertEq(sliceTaskSection(planMd, "T9"), null, "fenced ### T9 decoy does not match", state);
    } catch (e) {
      state.failed = true;
      state.failures.push("fenced ### T9 decoy does not match");
      console.error("FAIL: fenced ### T9 decoy does not match -- threw " + e.message);
    }

    let t1 = null;
    try {
      t1 = sliceTaskSection(planMd, "T1");
      assertTrue(t1 !== null, "T1 slice is found", state);
      assertTrue(
        t1 !== null && t1.includes("Body line 1."),
        "T1 slice includes its own body",
        state,
      );
      assertTrue(
        t1 !== null && t1.includes("### T9 -- inside fence"),
        "T1 slice includes fenced decoy content verbatim",
        state,
      );
      assertTrue(
        t1 !== null && t1.includes("Body line 2."),
        "T1 slice includes body after the fence",
        state,
      );
      assertTrue(
        t1 !== null && !t1.includes("### T2"),
        "T1 slice excludes the following ### T2 heading",
        state,
      );
      assertTrue(t1 !== null && !t1.includes("Body of T2."), "T1 slice excludes T2 body", state);
    } catch (e) {
      state.failed = true;
      state.failures.push("T1 slicing");
      console.error("FAIL: T1 slicing -- threw " + e.message);
    }

    const outMissing = path.join(tmp, "out-missing.md");
    try {
      const rMissing = main([
        "--plan",
        planPath,
        "--task",
        "T99",
        "--out",
        outMissing,
        "--cwd",
        tmp,
      ]);
      assertEq(rMissing.code, 3, "missing task id exits 3", state);
    } catch (e) {
      state.failed = true;
      state.failures.push("missing task id exits 3");
      console.error("FAIL: missing task id exits 3 -- threw " + e.message);
    }

    const outT1 = path.join(tmp, "out-t1.md");
    try {
      const rT1 = main(["--plan", planPath, "--task", "T1", "--out", outT1, "--cwd", tmp]);
      assertEq(rT1.code, 0, "T1 brief exits 0", state);
      assertTrue(rT1.stdout.length > 0, "T1 brief prints a stdout line", state);
      let parsed = null;
      try {
        parsed = JSON.parse(rT1.stdout[rT1.stdout.length - 1]);
      } catch (e) {
        /* leave null */
      }
      assertTrue(parsed !== null, "last stdout line is valid JSON", state);
      assertTrue(
        parsed !== null && Array.isArray(parsed.sections) && parsed.sections[0] === "task-brief",
        'sections === ["task-brief"]',
        state,
      );
      assertTrue(fs.existsSync(outT1), "out file was written", state);
    } catch (e) {
      state.failed = true;
      state.failures.push("T1 happy path");
      console.error("FAIL: T1 happy path -- threw " + e.message);
    }

    try {
      const rUsage = main(["--plan", planPath, "--out", outT1, "--cwd", tmp]);
      assertEq(rUsage.code, 2, "missing --task exits 2 (usage)", state);
    } catch (e) {
      state.failed = true;
      state.failures.push("missing --task exits 2");
      console.error("FAIL: missing --task exits 2 -- threw " + e.message);
    }

    const outTrunc = path.join(tmp, "out-trunc.md");
    try {
      const rTrunc = main([
        "--plan",
        planPath,
        "--task",
        "T1",
        "--out",
        outTrunc,
        "--cwd",
        tmp,
        "--cap",
        "40",
      ]);
      assertEq(rTrunc.code, 0, "tiny-cap run still exits 0", state);
      const truncText = fs.readFileSync(outTrunc, "utf8");
      assertTrue(
        truncText.includes("truncated at 40 bytes -- packager must tighten"),
        "tiny cap output carries the ASCII truncation marker",
        state,
      );
    } catch (e) {
      state.failed = true;
      state.failures.push("tiny-cap truncation");
      console.error("FAIL: tiny-cap truncation -- threw " + e.message);
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
