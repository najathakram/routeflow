import fs from "node:fs";
import path from "node:path";

/**
 * Wave E / imp-10a, T2 — no code/config/workflow file outside the allow-list
 * below still references the retired single-file path `prisma/schema.prisma`
 * (or the bare filename `schema.prisma`) AS A PATH — an `import`, a Docker
 * `COPY`, a `--schema`/`--to-schema` flag, an `fs.readFileSync`/`path.join`
 * argument. A prose mention (a `//`/`#`/`/* *\/` comment, or a markdown
 * `<!-- -->` comment) is not a path reference, so comment bodies are
 * stripped before scanning — that is what lets the historical prose in
 * spec-file comments (`schema.prisma` mentioned as documentation, e.g.
 * `apps/api/src/products/products.service.spec.ts`) survive as clean.
 *
 * Allow-list (three names, each excluded from the offender scan for a stated
 * reason):
 *   - `apps/api/scripts/split-prisma-schema.mjs` — by design it names that
 *     retired path (`--from`/`--from-ref` resolve `apps/api/prisma/schema.prisma`
 *     at a git ref via `git show <ref>:...`). `--check` enforces the structural
 *     invariants on every run; the block-identity proof against the original
 *     single file was recorded at split time (`e39bf9db`, 207 blocks) and can be
 *     re-derived with `--check --from-ref e39bf9db` when git history is
 *     available; the permanent lossless guard is the drift gate (`npm run
 *     local:drift` / CI replay: folder datamodel == migration history).
 *   - `apps/api/src/common/schema-folder.spec.ts` (T1, sibling spec) — its own
 *     case (b) asserts the retired single file no longer exists on disk, which
 *     requires literally naming that path in a `path.join(...)`/`fs.existsSync`
 *     negative-existence check. That is a regression oracle, not a live path
 *     used for real I/O against an app schema, so it is exempted here rather
 *     than obscured in T1 just to dodge this scanner.
 *   - `apps/api/prisma/migrations/**` — never scanned. Migration SQL/history is
 *     not one of the directories this check walks in the first place, but the
 *     exclusion is named explicitly so a future root-widening does not silently
 *     start flagging historical migration metadata.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const ALLOW_LIST = new Set<string>(
  ["apps/api/scripts/split-prisma-schema.mjs", "apps/api/src/common/schema-folder.spec.ts"].map(
    (p) => path.join(REPO_ROOT, p),
  ),
);

const SCAN_DIR_ROOTS = ["apps/api/src", "apps/api/scripts", "scripts", ".github/workflows"];

const SCAN_SINGLE_FILES = [
  "apps/api/Dockerfile",
  "apps/api/prisma.config.ts",
  "apps/api/package.json",
  "package.json",
  "docker-compose.yml",
];

function isExcludedDir(fullPath: string): boolean {
  const norm = fullPath.replace(/\\/g, "/");
  return (
    norm.includes("/node_modules/") ||
    norm.endsWith("/node_modules") ||
    // Defensive — not one of SCAN_DIR_ROOTS today, but named per the brief so a
    // future root-widening can't silently start scanning migration history.
    norm.includes("/apps/api/prisma/migrations")
  );
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir) || isExcludedDir(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/** Every directory literally named `scripts` anywhere under `.claude/skills/`. */
function walkSkillScriptsDirs(out: string[]): void {
  const skillsRoot = path.join(REPO_ROOT, ".claude/skills");
  if (!fs.existsSync(skillsRoot)) return;
  const stack = [skillsRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "scripts") walk(full, out);
      else stack.push(full);
    }
  }
}

function candidateFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_DIR_ROOTS) walk(path.join(REPO_ROOT, root), files);
  for (const rel of SCAN_SINGLE_FILES) {
    const full = path.join(REPO_ROOT, rel);
    if (fs.existsSync(full)) files.push(full);
  }
  walkSkillScriptsDirs(files);
  return [...new Set(files)].filter((f) => !ALLOW_LIST.has(f));
}

/**
 * Strip `/* *\/` block comments and `//` line comments from C-like source WITHOUT letting a
 * `//` inside a string literal (a URL is the common case: `"https://..."`) swallow the rest
 * of the line as if it were a comment — that would delete a real, later same-line reference
 * this scanner exists to catch (e.g. `const u = "https://x.dev"; const p = "schema.prisma";`
 * must still flag "schema.prisma"). A single combined regex with string-literal alternatives
 * tried first was the first attempt here, and it is unsound: prose inside a `//` comment
 * routinely contains an unescaped apostrophe ("it's", "doesn't", "repair-integrity.mjs's
 * default-read-only stance" — real text from apps/api/src/scripts/repair-f03.spec.ts), and a
 * flat regex has no notion of "already inside a comment" — it reads that apostrophe as an
 * opening `'…'` string literal and greedily consumes everything up to the NEXT raw `'`
 * anywhere later in the file (its `[^'\\]*` matches newlines too), silently un-stripping
 * real comments in between. A hand-rolled scanner fixes this the direct way: once it enters
 * a `//`/`/* *\/` comment it skips straight to the terminator character-by-character, so an
 * apostrophe or quote INSIDE that comment is simply consumed as comment text and never
 * re-enters "am I opening a string?" logic — that question only gets asked outside a comment.
 *
 * One construct is still not lexed: a REGEX literal. `/["']/g` and
 * `/<strong>Verifier's note:<\/strong>/` carry an unpaired quote, and telling a regex from a
 * division needs the previous significant token. Rather than guess, the scanner uses a fact
 * that costs nothing: a `'`/`"` literal may not contain a raw newline (only a `\`-continuation
 * crosses one, and that is an escape pair the look-ahead already consumes). So a quote whose
 * partner does not arrive before the end of its line was never a string opener — it is emitted
 * as ordinary text and scanning continues on the same line. Without that rule an apostrophe in
 * a regex swallowed everything up to the next stray quote anywhere later in the file, leaving
 * the `//` comments in between un-stripped: that is exactly how the prose in
 * `scripts/campaign/bugs.mjs` ("…routes.service.ts 29, <the retired name> 28.", a `//` comment)
 * reached the offender list.
 */
function stripCLikeComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const two = ch + (text[i + 1] ?? "");
    if (two === "//") {
      while (i < n && text[i] !== "\n") i++; // skip to (not including) the newline
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < n && text[i] + (text[i + 1] ?? "") !== "*/") i++;
      i = Math.min(i + 2, n); // consume the closing */ (or run to EOF if unterminated)
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      // Look ahead for the closing quote BEFORE committing to "this opens a string". A
      // `'`/`"` literal may not contain a raw newline in JS (a `\`-line-continuation is an
      // escape pair, so it keeps scanning), which makes an unterminated one proof that this
      // quote never opened a string at all — it is a quote inside a REGEX literal, the one
      // construct left that this scanner cannot lex (`/<strong>Verifier's note:<\/strong>/`,
      // `/["']/g`). Emitting it as ordinary text and carrying on is the conservative move:
      // the alternative — the pre-fix behaviour — swallowed every line up to the next stray
      // quote anywhere later in the file, un-stripping the real `//` comments in between.
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text[j] === "\\" && j + 1 < n) {
          j += 2; // escape pair, including a `\`-newline line continuation
          continue;
        }
        if (text[j] === ch) {
          closed = true;
          break;
        }
        if (ch !== "`" && text[j] === "\n") break; // template literals span lines; strings don't
        j++;
      }
      if (closed) {
        out += text.slice(i, j + 1); // the literal verbatim — a `//` INSIDE it is not a comment
        i = j + 1;
        continue;
      }
      out += ch; // not a string opener after all
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Strip comment bodies so only executable/config text remains. Extension-aware:
 * C-like block/line comments for TS/JS variants (string-literal-safe, see
 * stripCLikeComments above), `#` comments for yaml/shell/powershell/Dockerfile/markdown,
 * `<# #>` for PowerShell, and `<!-- -->` everywhere (harmless no-op where it never occurs).
 */
function stripComments(text: string, filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let out = text.replace(/<!--[\s\S]*?-->/g, "");

  const cLike = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"].includes(ext);
  if (cLike) {
    out = stripCLikeComments(out);
  }

  const hashLike = [".yml", ".yaml", ".sh", ".ps1", ".md"].includes(ext) || base === "Dockerfile";
  if (hashLike) {
    if (ext === ".ps1") out = out.replace(/<#[\s\S]*?#>/g, "");
    out = out.replace(/#.*$/gm, "");
  }

  return out;
}

const SINGLE_SCHEMA_PATH_RE = /\bschema\.prisma\b/;

function findOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of candidateFiles()) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // unreadable/binary — not a path reference
    }
    const stripped = stripComments(text, file);
    if (SINGLE_SCHEMA_PATH_RE.test(stripped)) {
      offenders.push(path.relative(REPO_ROOT, file).replace(/\\/g, "/"));
    }
  }
  return offenders.sort();
}

describe("no single schema path references outside the allow-list (wave E / imp-10a, T2)", () => {
  // The real walk yields ~817 candidates today; 400 is a floor with headroom, not a pin —
  // high enough that a silently-vacuous walk (an empty root, a typo'd SCAN_DIR_ROOTS entry)
  // still fails loudly, without being brittle to normal file-count churn.
  it("scans at least 400 candidate files (guards against a silently-vacuous empty walk)", () => {
    expect(candidateFiles().length).toBeGreaterThanOrEqual(400);
  });

  it("stripComments keeps a string literal verbatim — a URL's // does not swallow a later same-line string as a comment", () => {
    // Built via concatenation, not a literal "schema.prisma" in this file's own source: this
    // spec is itself a scanned candidate, and the whole point of this case is to prove the
    // matcher fires on that exact runtime string — writing it as one contiguous literal here
    // would make this file its own offender and force it onto the allow-list for no reason.
    const schemaPath = "schema" + ".prisma";
    const snippet = `const u = "https://x.dev"; const p = "${schemaPath}";`;
    const stripped = stripComments(snippet, "example.ts");
    expect(stripped).toContain('"https://x.dev"');
    expect(stripped).toContain(`"${schemaPath}"`);
    expect(SINGLE_SCHEMA_PATH_RE.test(stripped)).toBe(true);
  });

  it("stripComments treats a quote inside a regex literal as text — a following // comment is still stripped", () => {
    // The construct that broke this scanner in the wild: an apostrophe inside a regex literal
    // (`scripts/campaign/bugs.mjs`, the `Verifier's note` picker). Read as a string opener it
    // swallowed ~200 lines up to the next stray quote, un-stripping the `//` comments in
    // between — including the prose line that then showed up as a bogus offender. Built by
    // concatenation for the same reason as the case above: this spec is itself scanned.
    const schemaPath = "schema" + ".prisma";
    const snippet = [
      `const rx = /<strong>Verifier's note:<\\/strong>/;`,
      `// prose: the retired ${schemaPath} was mentioned here, in a comment`,
      `const keep = 1;`,
    ].join("\n");
    const stripped = stripComments(snippet, "example.mjs");
    expect(stripped).toContain("const keep = 1;");
    expect(SINGLE_SCHEMA_PATH_RE.test(stripped)).toBe(false);
  });

  it("stripComments still flags a REAL reference that follows an apostrophe-bearing regex literal", () => {
    // The other half of the pair: recovering from the regex must not turn into skipping code.
    const schemaPath = "schema" + ".prisma";
    const snippet = [
      `const rx = /<strong>Verifier's note:<\\/strong>/;`,
      `// prose only — no path on this line`,
      `const p = "${schemaPath}";`,
    ].join("\n");
    const stripped = stripComments(snippet, "example.mjs");
    expect(stripped).toContain(`"${schemaPath}"`);
    expect(SINGLE_SCHEMA_PATH_RE.test(stripped)).toBe(true);
  });

  it("no candidate file references the retired single schema path outside comments", () => {
    expect(findOffenders()).toEqual([]);
  });

  it("allow-list: apps/api/scripts/split-prisma-schema.mjs is excluded — it reads the original single-file schema from git history by design", () => {
    const scriptPath = path.join(REPO_ROOT, "apps/api/scripts/split-prisma-schema.mjs");
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(ALLOW_LIST.has(scriptPath)).toBe(true);
    expect(candidateFiles()).not.toContain(scriptPath);
  });

  it("allow-list: schema-folder.spec.ts (T1) is excluded — its own case (b) must name the retired path to assert it is gone", () => {
    const t1Path = path.join(REPO_ROOT, "apps/api/src/common/schema-folder.spec.ts");
    expect(fs.existsSync(t1Path)).toBe(true);
    expect(ALLOW_LIST.has(t1Path)).toBe(true);
    expect(candidateFiles()).not.toContain(t1Path);
  });

  it("allow-list: apps/api/prisma/migrations/** is never scanned", () => {
    const scanned = candidateFiles().some((f) =>
      f.replace(/\\/g, "/").includes("/apps/api/prisma/migrations/"),
    );
    expect(scanned).toBe(false);
  });
});
