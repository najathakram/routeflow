/**
 * Tripwire — a script/spec that builds a THROWAWAY git repo must scrub git's repo-scoped env.
 *
 * WHY: git EXPORTS GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE … into every hook it runs (the pre-push
 * gate runs `npm run verify`), and every child inherits them. A fixture that runs `git init` /
 * `git config` in a temp dir with that env inherited does NOT touch the temp dir — it re-points at
 * the REAL repository: `git init` re-initialises it and `git config user.*` rewrites the shared
 * `.git/config` (core.bare=true, a fixture identity). That took the whole PC's git down once
 * (`.claude/hooks/stop.gates.spec.mjs`). `scripts/campaign/bugs.mjs`'s self-test already scrubs.
 *
 * Two guards:
 *  1. static — every source file that runs a fixture `git init` must CALL the shared helper
 *     (`scrubbedGitEnv()` from scripts/lib/check-git-hooks.mjs, or `gitEnv()`); merely mentioning
 *     GIT_DIR, or carrying a private copy of the filter, does not count;
 *  2. behavioral — `stop.gates.spec.mjs` run with GIT_DIR/GIT_WORK_TREE pointed at a throwaway
 *     "poison" repo must leave that repo untouched (never the real one).
 *
 * The helper has ONE definition, scripts/lib/scrubbed-git-env.cjs (re-exported by
 * scripts/lib/check-git-hooks.mjs for .mjs callers; required here because ts-jest compiles CJS).
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SELF = path.basename(__filename);
const SCAN_DIRS = [
  ".claude",
  "scripts",
  "apps/api/scripts",
  "apps/api/src",
  "apps/web",
  "apps/mobile",
  "packages",
];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "worktrees",
  ".git",
  ".turbo",
  ".expo",
  "coverage",
]);

// ---------------------------------------------------------------------------------------------
// The scanner. Exported-in-spirit: the mutant pins below run in-memory source through the SAME
// function the repo walk uses.
// ---------------------------------------------------------------------------------------------

/** Blank out `//` and block comments (keeping strings, templates and regex literals intact). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let lastSig = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = c;
      continue;
    }
    if (c === "/" && (lastSig === "" || "(,=:[!&|?{};".includes(lastSig))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

/** Text between the paren at `open` and its match (strings/templates/regex skipped). */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Same length as `code`, every string/template literal body blanked (quotes kept). */
function blankStrings(code: string): string {
  let out = "";
  let lastSig = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        j++;
      }
      out += c + " ".repeat(Math.max(0, j - i - 1)) + (j < code.length ? c : "");
      i = j;
      lastSig = c;
    } else if (c === "/" && (lastSig === "" || "(,=:[!&|?{};".includes(lastSig))) {
      // regex literal: copy verbatim (its quotes are not string delimiters)
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== "\n") {
        if (code[j] === "\\") j++;
        else if (code[j] === "[") inClass = true;
        else if (code[j] === "]") inClass = false;
        else if (code[j] === "/" && !inClass) break;
        j++;
      }
      out += code.slice(i, j + 1);
      i = j;
      lastSig = "/";
    } else {
      out += c;
      if (!/\s/.test(c)) lastSig = c;
    }
  }
  return out.slice(0, code.length);
}

// A file is in scope when it spawns git (see unscrubbedGitSpawns) AND names a repo init anywhere:
// an `"init"` string literal in ANY argument position (`sh(dir, "init")`,
// `git(path.join(t, "r"), "init")`, `["init", ...]`) or the string form `git init`. Helper names
// and first-argument shapes are irrelevant.
const INIT_RE = /["'`]init["'`]|["'`]git\s+init\b/;
// A spawner is a bare call or a child_process member call; `re.exec(text)`, `obj.spawn(...)` and other
// same-named METHODS are not process spawns.
const SPAWNERS =
  /(?:(?<![.\w$])|(?<=\b(?:child_process|cp|childProcess)\.))\b(spawnSync|execFileSync|execSync|spawn|execFile|exec)\s*\(/g;
const SCRUB_ROOT = "scrubbedGitEnv";

/** Names in this file provably derived from the shared helper (assignments, functions, imports). */
function derivedNames(code: string): Set<string> {
  const names = new Set<string>([SCRUB_ROOT]);
  // The root only counts as a CALL; a derived name counts as any mention of it.
  const mention = (text: string) =>
    [...names].some((n) =>
      new RegExp(n === SCRUB_ROOT ? String.raw`\b${n}\s*\(` : String.raw`\b${n}\b`).test(text),
    );
  for (let changed = true; changed;) {
    changed = false;
    const add = (n: string, text: string) => {
      if (!names.has(n) && mention(text)) {
        names.add(n);
        changed = true;
      }
    };
    for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]*)/g)) add(m[1], m[2]);
    for (const m of code.matchAll(/\bfunction\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g)) {
      const open = m.index! + m[0].length - 1;
      let depth = 0;
      let k = open;
      for (; k < code.length; k++) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}" && --depth === 0) break;
      }
      add(m[1], code.slice(open, k));
    }
    for (const m of code.matchAll(/\b(\w+)\s+as\s+(\w+)\b/g)) {
      if (names.has(m[1]) && !names.has(m[2])) {
        names.add(m[2]);
        changed = true;
      }
    }
  }
  return names;
}

/** Every git spawn site in `src` whose options do not pass a scrub derived from the helper. */
function unscrubbedGitSpawns(src: string): { sites: number; bad: string[] } {
  const code = stripComments(src);
  // Same length as `code`: string bodies blanked so a "scrubbedGitEnv" literal is never a use.
  const bare = blankStrings(code);
  const derived = derivedNames(bare);
  const gitAliases = new Set<string>();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*["']git["']/g))
    gitAliases.add(m[1]);
  let sites = 0;
  const bad: string[] = [];
  const initFile = INIT_RE.test(code);
  for (const m of code.matchAll(SPAWNERS)) {
    const open = m.index! + m[0].length - 1;
    const args = balanced(code, open);
    const bareArgs = balanced(bare, open);
    const first = args.trimStart();
    const literalGit =
      /^["'`]git["'`]\s*[,)]/.test(first) ||
      /^["'`]git\s/.test(first) ||
      [...gitAliases].some((a) => new RegExp(String.raw`^${a}\s*[,)]`).test(first));
    // In a file that runs a repo init, EVERY spawn is a git site (a generic runner such as
    // `const run = (cmd, a, cwd) => execFileSync(cmd, a, { cwd }); run("git", ["init"], dir)` hides the
    // command from the literal check) unless its command is provably not git: a non-git string
    // literal, or process.execPath.
    const provablyNotGit =
      /^process\.execPath\s*[,)]/.test(first) || (/^["'`]/.test(first) && !literalGit);
    const isGit = literalGit || (initFile && !provablyNotGit);
    if (!isGit) continue;
    sites++;
    const passes = [...derived].some((n) =>
      new RegExp(
        n === SCRUB_ROOT
          ? String.raw`\benv\s*:[^;]*?\b${n}\s*\(`
          : String.raw`\benv\s*:[^;]*?\b${n}\b`,
      ).test(bareArgs),
    );
    // `{ ..., env }` shorthand: accepted only when a derived name is assigned to `env` in the file.
    const shorthand =
      /\benv\s*[,}]/.test(bareArgs) &&
      [...bare.matchAll(/\b(?:const|let|var)\s+env\s*=\s*([^;]*)/g)].some((e) =>
        [...derived].some((n) =>
          new RegExp(n === SCRUB_ROOT ? String.raw`\b${n}\s*\(` : String.raw`\b${n}\b`).test(e[1]),
        ),
      );
    if (!passes && !shorthand) bad.push(args.replace(/\s+/g, " ").slice(0, 70));
  }
  return { sites, bad };
}

/** In scope = names a repo init (any arg position, any helper) AND has a git spawn site. */
function isFixtureFile(src: string): boolean {
  const code = stripComments(src);
  return INIT_RE.test(code) && unscrubbedGitSpawns(src).sites > 0;
}

/** null = not a fixture file, or clean; otherwise the reasons it is flagged. */
function fixtureOffences(src: string): string[] | null {
  const code = stripComments(src);
  if (!INIT_RE.test(code)) return null;
  const { sites, bad } = unscrubbedGitSpawns(src);
  if (sites === 0) return null;
  const out = bad.map((b) => `unscrubbed git spawn: ${b}`);
  return out.length ? out : null;
}

// Same single definition the .mjs scripts get through check-git-hooks.mjs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(mjs|cjs|js|ts)$/.test(entry.name) && entry.name !== SELF) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("fixture git repos scrub git's repo-scoped env", () => {
  it("every git spawn in every fixture-repo file passes the shared GIT_* scrub", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)));
    const offenders: string[] = [];
    let fixtureFiles = 0;
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (!isFixtureFile(text)) continue;
      fixtureFiles++;
      const found = fixtureOffences(text);
      if (found) {
        const rel = path.relative(REPO_ROOT, f).split(path.sep).join("/");
        offenders.push(...found.map((o) => `${rel}: ${o}`));
      }
    }
    // The scan must be looking at something, or an empty walk would pass vacuously.
    expect(files.length).toBeGreaterThan(0);
    expect(fixtureFiles).toBeGreaterThan(0);
    expect(offenders.sort()).toEqual([]);
  });

  describe("scanner mutant pins", () => {
    it("(a) a bare execFileSync git init is flagged even when the helper is used elsewhere", () => {
      const src = `
        const { scrubbedGitEnv } = require("./scrubbed-git-env.cjs");
        spawnSync("git", ["status"], { env: scrubbedGitEnv() });
        execFileSync("git", ["init"]);
      `;
      const found = fixtureOffences(src);
      expect(found).not.toBeNull();
      expect(found).toHaveLength(1);
    });
    it("(b) a comment-only mention of scrubbedGitEnv is flagged", () => {
      const src = `
        // TODO: use scrubbedGitEnv() here
        /* env: scrubbedGitEnv() */
        spawnSync("git", ["init"], { cwd: dir });
      `;
      expect(fixtureOffences(src)).not.toBeNull();
    });
    it("(c) a correctly scrubbed file is clean, incl. wrappers and derived helpers", () => {
      const direct = `spawnSync("git", ["init"], { cwd: d, env: scrubbedGitEnv() });`;
      expect(fixtureOffences(direct)).toBeNull();
      const wrapper = `
        const gitEnv = () => scrubbedGitEnv();
        function git(repo, ...args) { return execFileSync("git", args, { cwd: repo, env: gitEnv() }); }
        git(dir, "init", "-q");
      `;
      expect(fixtureOffences(wrapper)).toBeNull();
    });
    it("(d) helper-call form: a wrapper body that does not scrub is flagged", () => {
      const src = `
        function git(repo, ...args) { return execFileSync("git", args, { cwd: repo }); }
        git(dir, "init", "-q");
      `;
      expect(fixtureOffences(src)).not.toBeNull();
    });
    it("(e) execSync string form is checked per spawn", () => {
      expect(fixtureOffences('execSync("git init -q", { cwd: d });')).not.toBeNull();
      expect(
        fixtureOffences('execSync("git init -q", { cwd: d, env: scrubbedGitEnv() });'),
      ).toBeNull();
    });
  });

  describe("scanner mutant pins (private filter copies, real misses on master)", () => {
    it("(j) a private GIT_* filter (`cleanEnv()` / a const) instead of the shared helper is flagged", () => {
      const fn = `
        function cleanEnv() {
          return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
        }
        spawnSync("git", ["init"], { cwd: d, env: cleanEnv() });
      `;
      const konst = `
        const CLEAN_ENV = Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)),
        );
        spawnSync("git", ["init"], { cwd: d, env: CLEAN_ENV });
      `;
      expect(fixtureOffences(fn)).not.toBeNull();
      expect(fixtureOffences(konst)).not.toBeNull();
    });
    it("(k) the same spawns through the shared helper are clean", () => {
      const src = `
        const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs");
        spawnSync("git", ["init"], { cwd: d, env: scrubbedGitEnv() });
        spawnSync(process.execPath, [script], { cwd: d, env: { ...scrubbedGitEnv(), LOG: "x" } });
      `;
      expect(fixtureOffences(src)).toBeNull();
    });
  });

  describe("scanner mutant pins (generic runners, #2737 review)", () => {
    it("(l) a generic runner hiding the git command is flagged in a file that runs a repo init", () => {
      const src = `
        const run = (cmd, a, cwd) => execFileSync(cmd, a, { cwd });
        run("git", ["init"], dir);
      `;
      expect(fixtureOffences(src)).not.toBeNull();
    });
    it("(m) `execSync(cmd, ...)` with no env in an init file is flagged; with the shared scrub it is clean", () => {
      const bare = "execSync(`git init`, { cwd }); execSync(cmd, { cwd });";
      expect(fixtureOffences(bare)).not.toBeNull();
      const scrubbed =
        "execSync(`git init`, { cwd, env: scrubbedGitEnv() }); execSync(cmd, { cwd, env: scrubbedGitEnv() });";
      expect(fixtureOffences(scrubbed)).toBeNull();
    });
    it("(n) provably non-git spawns (process.execPath, a non-git literal) stay out of scope", () => {
      const src = `
        spawnSync("git", ["init"], { cwd, env: scrubbedGitEnv() });
        spawnSync(process.execPath, [script], { cwd });
        spawnSync("node", [script], { cwd });
      `;
      expect(fixtureOffences(src)).toBeNull();
    });
    it("(o) the `b(\\w+) as (\\w+)b` import-alias pass really runs: an aliased helper counts", () => {
      const src = `
        import { scrubbedGitEnv as clean } from "./scrubbed-git-env.cjs";
        spawnSync("git", ["init"], { cwd, env: clean() });
      `;
      expect(fixtureOffences(src)).toBeNull();
    });
  });

  describe("scanner mutant pins (real misses)", () => {
    const sh = (env: string) => `
      import { execFileSync } from "node:child_process";
      import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
      const sh = (cwd, ...args) =>
        execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8"${env} });
      sh(dir, "init");
    `;
    it('(f) check-git-hooks.self-test-shaped `sh(dir, "init")` without env is flagged', () => {
      expect(fixtureOffences(sh(""))).not.toBeNull();
      expect(fixtureOffences(sh(", env: scrubbedGitEnv()"))).toBeNull();
    });
    it('(g) non-identifier first arg `git(path.join(t, "r"), "init")` is flagged', () => {
      const src = (env: string) => `
        const git = (cwd, ...a) => spawnSync("git", a, { cwd${env} });
        git(path.join(tmp, "r"), "init");
      `;
      expect(fixtureOffences(src(""))).not.toBeNull();
      expect(fixtureOffences(src(", env: scrubbedGitEnv()"))).toBeNull();
    });
    it("(h) scrubbedGitEnv named only inside a string literal is flagged", () => {
      const src = `
        const note = "use scrubbedGitEnv() please";
        spawnSync("git", ["init"], { cwd: d, env: "scrubbedGitEnv()" });
        spawnSync("git", ["init"], { cwd: d, env: process.env, label: 'env: scrubbedGitEnv()' });
      `;
      expect(fixtureOffences(src)).toHaveLength(2);
    });
    it("(i) an uncalled reference `env: scrubbedGitEnv` is flagged", () => {
      expect(
        fixtureOffences('spawnSync("git", ["init"], { env: scrubbedGitEnv });'),
      ).not.toBeNull();
    });
  });

  it("stop.gates.spec.mjs never touches the repo GIT_DIR points at", () => {
    const poison = fs.mkdtempSync(path.join(os.tmpdir(), "poison-repo-"));
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: poison, encoding: "utf8", env: scrubbedGitEnv() });
    try {
      git(["init", "-q"]);
      git(["config", "user.name", "poison-sentinel"]);
      git(["config", "user.email", "poison@example.com"]);
      fs.writeFileSync(path.join(poison, "seed.txt"), "seed\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "seed"]);
      const configPath = path.join(poison, ".git", "config");
      const before = fs.readFileSync(configPath, "utf8");
      const headBefore = git(["rev-parse", "HEAD"]).stdout.trim();

      const res = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, ".claude/hooks/stop.gates.spec.mjs")],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 300_000, // the child alone takes ~100 s; a loaded machine doubled it past the old 120 s
          env: {
            ...scrubbedGitEnv(),
            GIT_DIR: path.join(poison, ".git"),
            GIT_WORK_TREE: poison,
          },
        },
      );

      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(git(["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(poison, { recursive: true, force: true });
    }
  }, 360_000);
});
