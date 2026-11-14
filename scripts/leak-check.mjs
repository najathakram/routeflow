#!/usr/bin/env node
// Push leak guard: refuses a not-yet-public private name reaching the public repo.
//
// Brand-neutral by design: the secret patterns are NOT in git. They live in the untracked file
// <git-common-dir>/info/leak-patterns (one case-insensitive regex per line, `#` comments allowed;
// every worktree of a clone shares it). See docs/runbooks/push-leak-guards.md.
//
// Modes (exactly one):
//   --range <a..b> [--ref <name>]...   diff added lines (incl. new + renamed files, --text), file
//                                      names, commit messages + author/committer identity of the
//                                      range, plus ref names
//   --text-file <path> | --stdin       a PR title/body/squash message
//   --tree                             always-checked tracked paths in the working tree
//   --hook                             .husky/pre-push: reads git's pre-push stdin, enforces the
//                                      rebrand/* refusal (RF_REBRAND_PUSH=launch lifts it) and
//                                      scans each pushed ref's outgoing range
//
// Every scanned text is matched as UTF-8 AND, when it carries a UTF-16 BOM or NULs, as UTF-16 (see
// lib/leak-patterns.mjs matchesBuf).
//
// Exit: 0 clean, 1 hit, 2 usage / patterns file missing, empty or invalid / any failed git call
// (fail closed on a dev machine; under CI the missing file is a skip, exit 0, and the content scan is
// skipped but the rebrand/* refusal is not). Output carries commit shas, line counts and file paths
// ONLY, never matched text; a path that itself matches is withheld.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countMatchingLines,
  isCI,
  loadPatterns,
  matches,
  matchesBuf,
  splitLines,
} from "./lib/leak-patterns.mjs";

const ZERO = /^0+$/;
const ORIGIN_MASTER = "refs/remotes/origin/master";
const MAX_BUFFER = 256 * 1024 * 1024; // exceeding it is a spawn error: the scan exits 2, never passes
const TREE_RE = [
  /^\.claude\/pipeline\/(cost-ledger|agent-log)\.jsonl$/,
  /^\.claude\/skills\/[^/]+\/references\/RUN-LOG\.md$/,
  /^\.claude\/(lessons|code-map|campaign)\//,
];

function gitOut(cwd, args) {
  const r = spawnSync("git", args, { cwd, maxBuffer: MAX_BUFFER });
  const buf = r.stdout ?? Buffer.alloc(0);
  return { ok: r.status === 0 && !r.error, buf, out: buf.toString("utf8") };
}
/** Bytes of a git result (injected test runners may only provide `out`). */
const bytesOf = (r) => r.buf ?? Buffer.from(r.out ?? "", "utf8");

/**
 * Scan an array of rev-list arguments. Pushes identifier-only hit lines into `hits`.
 * Returns false when ANY git call fails (the caller must then fail closed, never pass).
 * Merge commits are scanned against their FIRST parent (so an evil merge cannot hide content).
 */
export function scanRevs(cwd, regexes, revArgs, hits, git = gitOut) {
  const list = git(cwd, ["rev-list", "--reverse", ...revArgs]);
  if (!list.ok) return false;
  for (const sha of list.out.split("\n").filter(Boolean)) {
    const short = sha.slice(0, 10);
    const msgR = git(cwd, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%B", sha]);
    if (!msgR.ok) return false;
    if (matchesBuf(regexes, bytesOf(msgR))) hits.push(`commit ${short}: message or identity`);
    const parR = git(cwd, ["log", "-1", "--format=%P", sha]);
    if (!parR.ok) return false;
    const parent = parR.out.trim().split(/\s+/)[0];
    const nsR = parent
      ? git(cwd, ["diff-tree", "-r", "-M", "--name-status", "-z", parent, sha])
      : git(cwd, ["diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "-z", sha]);
    if (!nsR.ok) return false;
    const ns = nsR.out.split("\0");
    const seen = new Set();
    for (let i = 0; i < ns.length;) {
      const st = ns[i++];
      if (!st) break;
      const paths = /^[RC]/.test(st) ? [ns[i++], ns[i++]] : [ns[i++]];
      for (const p of paths) {
        if (p && matchesBuf(regexes, p) && !seen.has(p)) {
          seen.add(p);
          hits.push(`commit ${short}: file name (withheld)`);
        }
      }
    }
    const diffR = parent
      ? git(cwd, ["diff", "--text", "-M", "-U0", "--no-color", "--no-ext-diff", parent, sha])
      : git(cwd, ["show", "--text", "--format=", "-U0", "--no-color", "--no-ext-diff", sha]);
    if (!diffR.ok) return false;
    let file = "";
    let count = 0;
    let inHeader = false;
    const flush = () => {
      if (count) {
        const shown = matches(regexes, file) ? "(path withheld)" : file;
        hits.push(`commit ${short}: ${count} added line(s) in ${shown}`);
      }
      count = 0;
    };
    for (const raw of splitLines(bytesOf(diffR))) {
      if (raw.toString("latin1", 0, 11) === "diff --git ") {
        flush();
        inHeader = true;
        file = "";
      } else if (inHeader) {
        const s = raw.toString("utf8");
        if (s.startsWith("+++ ")) file = s.slice(4).replace(/^b\//, "");
        else if (s.startsWith("@@")) inHeader = false;
      } else if (raw[0] === 0x2b && matchesBuf(regexes, raw.subarray(1))) {
        count++;
      }
    }
    flush();
  }
  return true;
}

function scanText(regexes, input, label, hits) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  const count = countMatchingLines(regexes, buf);
  if (count) hits.push(`${label}: ${count} line(s)`);
}

function scanTree(cwd, regexes, hits) {
  const ls = gitOut(cwd, ["ls-files", "-z"]);
  if (!ls.ok) return false;
  const files = ls.out.split("\0").filter(Boolean);
  for (const f of files) {
    if (!TREE_RE.some((re) => re.test(f))) continue;
    let buf;
    try {
      buf = fs.readFileSync(path.join(cwd, f));
    } catch {
      continue;
    }
    const count = countMatchingLines(regexes, buf);
    if (count) hits.push(`${matches(regexes, f) ? "(path withheld)" : f}: ${count} line(s)`);
  }
  return true;
}

/**
 * Append `--not refs/remotes/origin/master` when that ref exists, so a rebase or merge of master
 * never rescans master's commits. Without it the whole range is scanned (notice added).
 */
function withBase(cwd, revs, notices) {
  if (gitOut(cwd, ["rev-parse", "--verify", "-q", ORIGIN_MASTER]).ok) {
    return [...revs, "--not", ORIGIN_MASTER];
  }
  const n = "no origin/master ref: scanning the whole history, this may be slow";
  if (!notices.includes(n)) notices.push(n);
  return revs;
}

function rangeForRef(cwd, lsha, rsha, notices) {
  if (!ZERO.test(rsha) && gitOut(cwd, ["cat-file", "-e", `${rsha}^{commit}`]).ok) {
    return withBase(cwd, [`${rsha}..${lsha}`], notices);
  }
  return withBase(cwd, [lsha], notices);
}

function parseArgs(argv) {
  const o = { refs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--range") o.range = argv[++i];
    else if (a === "--ref") o.refs.push(argv[++i]);
    else if (a === "--text-file") o.textFile = argv[++i];
    else if (a === "--stdin") o.stdin = true;
    else if (a === "--tree") o.tree = true;
    else if (a === "--hook") o.hook = true;
    else return { error: "unknown argument" };
  }
  const modes = [o.range, o.textFile, o.stdin, o.tree, o.hook].filter(Boolean).length;
  if (modes !== 1) return { error: "choose exactly one mode" };
  return o;
}

/** Library entry: returns { code, lines }. `input` is stdin (string or bytes) for --stdin / --hook. */
export function run(argv, { cwd = process.cwd(), env = process.env, input = "" } = {}) {
  const lines = [];
  const notices = [];
  const o = parseArgs(argv);
  if (o.error) {
    return {
      code: 2,
      lines: [
        `leak-check: ${o.error}. Usage: --range a..b [--ref name] | --text-file p | --stdin | --tree | --hook`,
      ],
    };
  }

  // rebrand/* refusal needs no patterns file and applies under CI too, so it runs first.
  let pushed = [];
  if (o.hook) {
    const inText = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    for (const l of inText.split("\n")) {
      const [lref, lsha, rref, rsha] = l.trim().split(/\s+/);
      if (!lref || !lsha || ZERO.test(lsha)) continue; // blank or a delete: nothing is pushed
      pushed.push({ lref, lsha, rref: rref ?? "", rsha: rsha ?? "0" });
    }
    const isRebrand = (p) => /(^|\/)rebrand\//i.test(p.lref) || /(^|\/)rebrand\//i.test(p.rref);
    const rebrand = pushed.some(isRebrand);
    if (rebrand && env.RF_REBRAND_PUSH === "launch") {
      // Launch day: the refusal AND the content scan are lifted for the rebrand refs themselves.
      // Any other ref in the same push is still scanned (and still needs the patterns file).
      pushed = pushed.filter((p) => !isRebrand(p));
      if (pushed.length === 0) {
        return {
          code: 0,
          lines: ["leak-check: RF_REBRAND_PUSH=launch - rebrand refs not scanned."],
        };
      }
    } else if (rebrand) {
      return {
        code: 1,
        lines: [
          "leak-check: a rebrand/* ref is being pushed. Refused: these branches stay local until launch.",
          "leak-check: launch day only: RF_REBRAND_PUSH=launch git push ...",
        ],
      };
    }
    if (isCI(env)) return { code: 0, lines: ["leak-check: CI - content scan skipped."] };
  }

  const loaded = loadPatterns(cwd);
  if (!loaded.ok) {
    if (isCI(env) && loaded.reason === "missing") {
      return { code: 0, lines: ["leak-check: no patterns file under CI - skipped."] };
    }
    return { code: 2, lines: [loaded.message] };
  }
  const { regexes } = loaded;
  const hits = [];

  if (o.range) {
    o.refs.forEach(
      (r, i) => matchesBuf(regexes, r) && hits.push(`ref #${i + 1}: name matches (withheld)`),
    );
    if (!scanRevs(cwd, regexes, withBase(cwd, [o.range], notices), hits)) {
      return { code: 2, lines: [`leak-check: cannot resolve range ${o.range}`] };
    }
  } else if (o.textFile || o.stdin) {
    let text = input;
    if (o.textFile) {
      try {
        text = fs.readFileSync(path.resolve(cwd, o.textFile));
      } catch {
        return { code: 2, lines: [`leak-check: cannot read ${o.textFile}`] };
      }
    }
    scanText(regexes, text, "text", hits);
  } else if (o.tree) {
    if (!scanTree(cwd, regexes, hits)) {
      return { code: 2, lines: ["leak-check: git ls-files failed. Fail-closed."] };
    }
  } else {
    for (const p of pushed) {
      for (const r of [p.lref, p.rref]) {
        if (r && matches(regexes, r)) hits.push("ref name matches (withheld)");
      }
      // Follow an annotated-tag chain (scanning every tag message) to the commit it ends at; a ref
      // that ends at a blob/tree is refused (fail closed) because there is nothing we can scan.
      let cur = p.lsha;
      let tip = "";
      for (let depth = 0; ; depth++) {
        if (depth > 50) {
          hits.push(`ref ${p.lsha.slice(0, 10)}: tag chain too deep (refused)`);
          break;
        }
        const kind = gitOut(cwd, ["cat-file", "-t", cur]);
        if (!kind.ok) {
          return { code: 2, lines: [`leak-check: cannot read pushed object ${cur.slice(0, 10)}`] };
        }
        const k = kind.out.trim();
        if (k === "commit") {
          tip = cur;
          break;
        }
        if (k === "tag") {
          const body = gitOut(cwd, ["cat-file", "tag", cur]);
          if (!body.ok) return { code: 2, lines: ["leak-check: cannot read tag object."] };
          if (matchesBuf(regexes, body.buf)) hits.push(`tag object ${cur.slice(0, 10)}: message`);
          const m = /^object ([0-9a-f]{40,64})$/m.exec(body.out);
          if (!m) return { code: 2, lines: ["leak-check: malformed tag object."] };
          cur = m[1];
          continue;
        }
        hits.push(`pushed ref points at a ${k} object ${cur.slice(0, 10)} (refused)`);
        break;
      }
      if (!tip) continue;
      if (!scanRevs(cwd, regexes, rangeForRef(cwd, tip, p.rsha, notices), hits)) {
        return {
          code: 2,
          lines: [`leak-check: cannot resolve outgoing range for ${p.lsha.slice(0, 10)}`],
        };
      }
    }
  }

  lines.push(...notices.map((n) => `leak-check: notice: ${n}`));
  if (hits.length) {
    lines.push(...hits.map((h) => `leak-check: HIT ${h}`));
    lines.push(
      "leak-check: refused. Matched text is never printed; inspect the identifiers above.",
    );
    return { code: 1, lines };
  }
  lines.push("leak-check: clean.");
  return { code: 0, lines };
}

/** True when this file is the process entry point, comparing REAL paths (junctions/symlinks). */
export function isMainScript(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return fs.realpathSync.native(fileURLToPath(metaUrl)) === fs.realpathSync.native(argv1);
  } catch {
    return false;
  }
}

if (isMainScript(import.meta.url, process.argv[1])) {
  const argv = process.argv.slice(2);
  let input = Buffer.alloc(0);
  if (argv.includes("--stdin") || argv.includes("--hook")) {
    try {
      input = fs.readFileSync(0);
    } catch (e) {
      // EOF on a closed stdin is an empty input; any other read error is unreadable: fail closed.
      if (!e || e.code !== "EOF") {
        console.error("leak-check: cannot read stdin. Fail-closed.");
        process.exit(2);
      }
    }
  }
  const { code, lines } = run(argv, { input });
  for (const l of lines) (code === 0 ? console.log : console.error)(l);
  process.exit(code);
}
