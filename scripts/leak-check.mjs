#!/usr/bin/env node
// Push leak guard: refuses a not-yet-public private name reaching the public repo.
//
// Brand-neutral by design: the secret patterns are NOT in git. They live in the untracked file
// <git-common-dir>/info/leak-patterns (one case-insensitive regex per line, `#` comments allowed;
// every worktree of a clone shares it). See docs/runbooks/push-leak-guards.md.
//
// Besides regexes, the patterns file may hold lines of the form `commit:<full sha, 40+ hex>`: sentinel
// commits (the first commit(s) unique to a private line of work). Under --hook a push is refused when any
// sentinel is an ancestor of (or equal to) a pushed commit, whatever the branch is called; a sentinel unknown
// to the local repository is ignored with a notice. RF_REBRAND_PUSH=launch lifts it like the other private checks.
//
// Lines of the form `path:<prefix>` (repo-relative, forward slashes, case-insensitive) list private path
// prefixes: under --hook a push is refused when any outgoing commit adds or modifies a file under one (binary
// files included; deletes are fine). Output names the commit and the rule number, never the path. Lifted by
// RF_REBRAND_PUSH=launch. A `commit:` or `path:` line that does not parse refuses to load, and the file must
// hold at least one regex (the content scan is never off).
//
// Modes (exactly one):
//   --range <a..b> [--ref <name>]...   diff added lines (incl. new + renamed files, --text), file
//                                      names, commit messages + author/committer identity of the
//                                      range, plus ref names
//   --text-file <path> | --stdin       a PR title/body/squash message
//   --tree                             always-checked tracked paths in the working tree
//   --hook                             .husky/pre-push: reads git's pre-push stdin, allows a
//                                      rebrand/* branch pushed to its OWN ref only (owner ruling
//                                      2026-11-19), refuses it on any other ref (RF_REBRAND_PUSH=launch
//                                      lifts that) and scans each other pushed ref's outgoing range
//
// Every scanned text is matched as UTF-8 AND, when it carries a UTF-16 BOM or NULs, as UTF-16 (see
// lib/leak-patterns.mjs matchesBuf).
//
// Exit: 0 clean, 1 hit, 2 usage / patterns file missing, empty or invalid / any failed git call
// (fail closed on a dev machine; only the non-hook modes treat a missing file under CI as a skip, exit 0;
// --hook never skips: CI does not push through it). Pushing nothing (deletes only) is exit 0. Output carries
// commit shas, line counts and file paths ONLY, never matched text; a path that itself matches, or that git quotes, is withheld.
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

const ESC = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, ["\\"]: 92, '"': 34 };
/**
 * The path of a `+++ ` diff header line (bytes after the marker). git C-quotes a name with unusual bytes
 * ("..." with \ooo octal bytes and \t \n \" \\ escapes), then the `b/` prefix sits INSIDE the quotes. Returns
 * { name, quoted }: the decoded name (UTF-8) without the prefix, and whether git quoted it.
 */
export function parseHeaderPath(buf) {
  let name;
  const quoted = buf[0] === 0x22;
  if (quoted) {
    const bytes = [];
    for (let i = 1; i < buf.length; i++) {
      const c = buf[i];
      if (c === 0x22) break;
      if (c !== 92) {
        bytes.push(c);
        continue;
      }
      const d = buf.toString("latin1", i + 1, i + 4);
      if (/^[0-7]{3}$/.test(d)) {
        bytes.push(parseInt(d, 8) & 0xff);
        i += 3;
      } else {
        const e = ESC[String.fromCharCode(buf[++i])];
        if (e !== undefined) bytes.push(e);
      }
    }
    name = Buffer.from(bytes).toString("utf8");
  } else {
    name = buf.toString("utf8").replace(/\t$/, "");
  }
  return { name: name.replace(/^b\//, ""), quoted };
}

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
      ? git(cwd, [
          "diff",
          "--text",
          "-M",
          "-U0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          parent,
          sha,
        ])
      : git(cwd, [
          "show",
          "--text",
          "--format=",
          "-U0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          sha,
        ]);
    if (!diffR.ok) return false;
    let file = "";
    let fileQuoted = false;
    let count = 0;
    let inHeader = false;
    const flush = () => {
      if (count) {
        // A quoted name (unusual bytes) is never printed, whatever it decodes to.
        const shown = fileQuoted || matches(regexes, file) ? "(path withheld)" : file;
        hits.push(`commit ${short}: ${count} added line(s) in ${shown}`);
      }
      count = 0;
    };
    for (const raw of splitLines(bytesOf(diffR))) {
      if (raw.toString("latin1", 0, 11) === "diff --git ") {
        flush();
        inHeader = true;
        file = "";
        fileQuoted = false;
      } else if (inHeader) {
        if (raw.toString("latin1", 0, 4) === "+++ ") {
          ({ name: file, quoted: fileQuoted } = parseHeaderPath(raw.subarray(4)));
        } else if (raw[0] === 0x40 && raw[1] === 0x40) inHeader = false;
      } else if (raw[0] === 0x2b && matchesBuf(regexes, raw.subarray(1))) {
        count++;
      }
    }
    flush();
  }
  return true;
}

/**
 * Refuse any commit in the range that ADDS or MODIFIES a file under a `path:` prefix (binary files too).
 * Deletes are allowed. Output names the commit and the rule number, never the path. False on a git failure.
 */
function scanPaths(cwd, prefixes, revArgs, hits) {
  const list = gitOut(cwd, ["rev-list", "--reverse", ...revArgs]);
  if (!list.ok) return false;
  for (const sha of list.out.split("\n").filter(Boolean)) {
    const parR = gitOut(cwd, ["log", "-1", "--format=%P", sha]);
    if (!parR.ok) return false;
    const parent = parR.out.trim().split(/\s+/)[0];
    const nsR = parent
      ? gitOut(cwd, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", parent, sha])
      : gitOut(cwd, ["diff-tree", "-r", "--root", "--no-renames", "--name-status", "-z", sha]);
    if (!nsR.ok) return false;
    const ns = nsR.out.split("\0");
    const ruleHits = new Set();
    for (let i = 0; i < ns.length;) {
      const st = ns[i++];
      if (!st) break;
      const f = ns[i++];
      if (st === "D" || !f) continue;
      const low = f.toLowerCase();
      prefixes.forEach((pre, idx) => low.startsWith(pre) && ruleHits.add(idx + 1));
    }
    for (const r of ruleHits)
      hits.push(`commit ${sha.slice(0, 10)}: file under private path rule #${r}`);
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

/**
 * Refuse when the commits being pushed overlap the commits only rebrand/* branches hold (local
 * refs/heads/rebrand/* and remote-tracking refs/remotes/<remote>/rebrand/*: the branch now lives on the
 * remote, so a machine may hold only the remote-tracking ref), whatever the ref is called
 * (HEAD:refs/heads/x, a sha refspec, a copied branch). Returns refusal lines, or null when there is no
 * overlap. Fails closed when origin/master is missing or a git call fails.
 */
function privateOverlap(cwd, pushed) {
  const refs = gitOut(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"]);
  if (!refs.ok) return ["leak-check: cannot list rebrand/* branches. Fail-closed."];
  // Case-insensitive, like isRebrand in run(): a Rebrand/x branch holds private commits too.
  const isPrivRef = (r) =>
    /^refs\/heads\/rebrand\/./i.test(r) || /^refs\/remotes\/[^/]+\/rebrand\/./i.test(r);
  const privRefs = refs.out.split("\n").filter(isPrivRef);
  if (privRefs.length === 0) return null; // no rebrand/* branches here: nothing to overlap
  if (!gitOut(cwd, ["rev-parse", "--verify", "-q", ORIGIN_MASTER]).ok) {
    return [
      "leak-check: rebrand/* branches exist but refs/remotes/origin/master is missing, so a push cannot be",
      "leak-check: proven free of private commits. Fail-closed: run git fetch origin master, then push again.",
    ];
  }
  const priv = gitOut(cwd, ["rev-list", ...privRefs, "--not", ORIGIN_MASTER]);
  if (!priv.ok) return ["leak-check: cannot list private commits. Fail-closed."];
  const privSet = new Set(priv.out.split("\n").filter(Boolean));
  if (privSet.size === 0) return null;
  for (const p of pushed) {
    const out = gitOut(cwd, ["rev-list", p.lsha, "--not", ORIGIN_MASTER]);
    if (!out.ok)
      return [`leak-check: cannot list outgoing commits of ${p.lsha.slice(0, 10)}. Fail-closed.`];
    if (out.out.split("\n").some((c) => c && privSet.has(c))) {
      return [
        "leak-check: the push contains commits that belong to a rebrand/* branch. Refused: they may only reach their own rebrand/* ref.",
        "leak-check: launch day only: RF_REBRAND_PUSH=launch git push ...",
      ];
    }
  }
  return null;
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

  // rebrand/* handling needs no patterns file and applies under CI too, so it runs first.
  let pushed = [];
  let refLines = 0;
  if (o.hook) {
    const inText = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    for (const l of inText.split("\n")) {
      const [lref, lsha, rref, rsha] = l.trim().split(/\s+/);
      if (lref && lsha) refLines++;
      if (!lref || !lsha || ZERO.test(lsha)) continue; // blank or a delete: nothing is pushed
      pushed.push({ lref, lsha, rref: rref ?? "", rsha: rsha ?? "0" });
    }
    // Owner ruling 2026-11-19: a rebrand/* branch may be pushed to its OWN ref (same name both sides).
    const isOwnRef = (p) => p.lref === p.rref && /^refs\/heads\/rebrand\/[^/]/.test(p.rref);
    const ownCount = pushed.filter(isOwnRef).length;
    pushed = pushed.filter((p) => !isOwnRef(p));
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
          "leak-check: a rebrand/* branch may only be pushed to its own ref (git push origin rebrand/<name>). Refused.",
          "leak-check: launch day only: RF_REBRAND_PUSH=launch git push ...",
        ],
      };
    }
    if (pushed.length === 0 && ownCount > 0) {
      return { code: 0, lines: ["leak-check: rebrand/* pushed to its own ref - not scanned."] };
    }
    // CI never pushes through this hook, so CI=true on a developer machine must not skip the scan.
    if (pushed.length === 0) {
      return {
        code: 0,
        lines: [
          refLines === 0
            ? "leak-check: no refs to push, nothing to scan."
            : "leak-check: nothing is being pushed (delete only).",
        ],
      };
    }
    if (env.RF_REBRAND_PUSH !== "launch") {
      const ov = privateOverlap(cwd, pushed);
      if (ov) return { code: 1, lines: ov };
    }
  }

  const loaded = loadPatterns(cwd);
  if (!loaded.ok) {
    if (!o.hook && isCI(env) && loaded.reason === "missing") {
      return { code: 0, lines: ["leak-check: no patterns file under CI - skipped."] };
    }
    return { code: 2, lines: [loaded.message] };
  }
  const { regexes, sentinels = [], paths = [] } = loaded;
  if (o.hook && env.RF_REBRAND_PUSH !== "launch") {
    for (const s of sentinels) {
      if (!gitOut(cwd, ["cat-file", "-e", `${s}^{commit}`]).ok) {
        notices.push(`sentinel ${s.slice(0, 10)} is unknown to this repository: ignored`);
        continue;
      }
      if (gitOut(cwd, ["merge-base", "--is-ancestor", s, ORIGIN_MASTER]).ok) {
        return {
          code: 1,
          lines: [
            `leak-check: sentinel ${s.slice(0, 10)} is already on origin/master: remove this commit: line from the patterns file.`,
          ],
        };
      }
      for (const p of pushed) {
        if (gitOut(cwd, ["merge-base", "--is-ancestor", s, `${p.lsha}^{commit}`]).ok) {
          return {
            code: 1,
            lines: [
              "leak-check: the push contains a private sentinel commit. Refused: it stays local until launch.",
              "leak-check: launch day only: RF_REBRAND_PUSH=launch git push ...",
            ],
          };
        }
      }
    }
  }
  const hits = [];

  if (o.range) {
    o.refs.forEach(
      (r, i) => matchesBuf(regexes, r) && hits.push(`ref #${i + 1}: name matches (withheld)`),
    );
    if (!scanRevs(cwd, regexes, withBase(cwd, [o.range], notices), hits)) {
      return { code: 2, lines: ["leak-check: cannot resolve the --range argument."] };
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
      const revs = rangeForRef(cwd, tip, p.rsha, notices);
      if (!scanRevs(cwd, regexes, revs, hits)) {
        return {
          code: 2,
          lines: [`leak-check: cannot resolve outgoing range for ${p.lsha.slice(0, 10)}`],
        };
      }
      if (paths.length && env.RF_REBRAND_PUSH !== "launch" && !scanPaths(cwd, paths, revs, hits)) {
        return {
          code: 2,
          lines: [`leak-check: cannot list files of the outgoing range for ${p.lsha.slice(0, 10)}`],
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
