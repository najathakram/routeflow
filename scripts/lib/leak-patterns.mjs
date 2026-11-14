// Shared pattern loading + matching for the push leak guard (scripts/leak-check.mjs and the
// leak-guard block of .husky/pre-push). Brand-neutral: the secret patterns live ONLY in the
// untracked file <git-common-dir>/info/leak-patterns (one case-insensitive regex per line, `#`
// comments and blank lines ignored), shared by every worktree of the clone.
//
// Nothing here ever returns or prints the text a pattern matched: callers get booleans.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HOWTO =
  "create it with one case-insensitive regex per line (# comments allowed), e.g.: " +
  'printf "%s\\n" "your-regex" > "$(git rev-parse --git-common-dir)/info/leak-patterns"';

/** CI (or any GitHub Actions runner) does not run the guard: the patterns file never exists there. */
export function isCI(env = process.env) {
  return env.CI === "true" || Boolean(env.GITHUB_ACTIONS);
}

/** Absolute path of the shared patterns file, resolved from the git common dir (worktree-safe). */
export function patternsPath(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  return path.resolve(cwd, r.stdout.trim(), "info", "leak-patterns");
}

/**
 * Load the patterns. Returns { ok: true, regexes } or { ok: false, reason, message }.
 * Fail closed: missing file, no usable lines, or an invalid regex are all `ok: false`.
 * Error messages carry line numbers only, never pattern text.
 */
class BadEncoding extends Error {}

export function loadPatterns(cwd = process.cwd()) {
  const file = patternsPath(cwd);
  if (!file)
    return { ok: false, reason: "no-git", message: "leak-check: not inside a git repository." };
  let text;
  try {
    const buf = fs.readFileSync(file);
    // Fail closed on anything that is not plain UTF-8 (a UTF-16 file saved by a Windows editor would
    // otherwise decode to garbage that matches nothing, silently disabling the guard).
    const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
    if (utf16 || buf.includes(0)) throw new BadEncoding();
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch (e) {
    if (e instanceof BadEncoding || e instanceof TypeError) {
      return {
        ok: false,
        reason: "encoding",
        message: `leak-check: ${file} is not plain UTF-8 text (UTF-16, NUL bytes or invalid encoding). Fail-closed: re-create it as UTF-8, e.g. with the printf command: ${HOWTO}`,
      };
    }
    return {
      ok: false,
      reason: "missing",
      message: `leak-check: patterns file not found at ${file}. Fail-closed: ${HOWTO}`,
    };
  }
  const regexes = [];
  const sentinels = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const sm = /^commit:([0-9a-f]{40,64})$/i.exec(line);
    if (sm) {
      sentinels.push(sm[1].toLowerCase());
      continue;
    }
    try {
      regexes.push(new RegExp(line, "i"));
    } catch {
      return {
        ok: false,
        reason: "invalid",
        message: `leak-check: ${file} line ${i + 1} is not a valid regex. Fail-closed.`,
      };
    }
  }
  if (regexes.length === 0 && sentinels.length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: `leak-check: ${file} has no patterns. Fail-closed: ${HOWTO}`,
    };
  }
  return { ok: true, regexes, sentinels };
}

/**
 * True when any pattern matches `text`, as written OR after dropping Unicode format characters
 * (zero-width joiners and spaces, soft hyphen, BOM...) and NFKC normalisation (full-width forms).
 */
export function matches(regexes, text) {
  const s = String(text);
  if (regexes.some((re) => re.test(s))) return true;
  if (!/[^\x00-\x7f]/.test(s)) return false;
  const folded = s
    .replace(/\p{Cf}/gu, "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "");
  return folded !== s && regexes.some((re) => re.test(folded));
}

/**
 * True when any pattern matches the bytes `buf` in ANY plausible text form: UTF-8, and, when the
 * bytes carry a UTF-16 BOM or NULs (PowerShell 5.1 `echo x > f` writes FF FE + NULs), the NUL-stripped
 * form and UTF-16 decodes at both byte alignments (LE and BE, and a line cut at a 0x0A byte).
 */
export function matchesBuf(regexes, input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (matches(regexes, buf.toString("utf8"))) return true;
  const bom = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  if (!bom && !buf.includes(0)) return false;
  return (
    matches(regexes, buf.toString("utf8").replace(/\0/g, "")) ||
    matches(regexes, buf.toString("utf16le")) ||
    matches(regexes, buf.subarray(1).toString("utf16le"))
  );
}

/** Split bytes on 0x0A (as git does) into line buffers. */
export function splitLines(buf) {
  const out = [];
  let start = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
    out.push(buf.subarray(start, i));
    start = i + 1;
  }
  out.push(buf.subarray(start));
  return out;
}

/** Number of lines of `buf` that match in any text form. */
export function countMatchingLines(regexes, buf) {
  return splitLines(buf).filter((l) => matchesBuf(regexes, l)).length;
}
