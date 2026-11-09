/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * B178 guard: every `en` message key must be READ by some web source file. A key nobody reads is dead
 * copy that still ships to the translators and drifts silently. New dead keys fail here; the 12 that
 * already existed are baselined below and can only leave the list (shrink-only).
 *
 * "Read" means the key appears quoted ("key", 'key' or `key`) in non-test web source, or a template
 * literal such as `common.${x}` builds it dynamically (every key under that dotted prefix counts).
 * A test file that mentions a key does not make it live, so *.test.* / *.spec.* are not scanned.
 */

const WEB = join(__dirname, "..", "..");
const MESSAGES_FILE = join(__dirname, "messages.ts");

/**
 * Owner: the Spanish / i18n program (owner ruling: Spanish later). The sidebar wiring there will
 * read the nav.* keys; do not delete them and do not add to this list. B178.
 */
const SHRINK_ONLY_UNREAD: readonly string[] = [
  "nav.dashboard",
  "nav.orders",
  "nav.customers",
  "nav.settings",
  "common.save",
  "common.cancel",
  "common.close",
  "common.undo",
  "common.restored",
  "common.search",
  "common.delete",
  "common.loading",
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".jest-cache", "coverage"]);
const SOURCE_FILE = /\.(ts|tsx|js|jsx)$/;
const TEST_FILE = /\.(test|spec)\./;
const KEY_LINE = /^\s*"([a-zA-Z0-9_.]+)":/gm;

/** Every `"dotted.key":` line in `block`, in order. */
export function parseKeys(block: string): string[] {
  const keys: string[] = [];
  for (const m of block.matchAll(KEY_LINE)) keys.push(m[1]);
  return keys;
}

/** Splits messages.ts text at the `es` object: everything before it is `en`, the rest is `es`. */
export function splitCatalogues(text: string): { en: string; es: string } {
  const enStart = text.indexOf("const en = {");
  const esStart = text.indexOf("const es: Messages = {");
  if (enStart < 0 || esStart < 0 || esStart < enStart) {
    throw new Error(
      "messages.ts no longer has `const en = {` followed by `const es: Messages = {`",
    );
  }
  return { en: text.slice(enStart, esStart), es: text.slice(esStart) };
}

/** Dotted prefixes from template literals like `common.${x}` (prefix keeps its trailing dot). */
export function templatePrefixes(source: string): string[] {
  const prefixes: string[] = [];
  for (const m of source.matchAll(/`([A-Za-z0-9_.]+\.)\$\{/g)) prefixes.push(m[1]);
  return prefixes;
}

/** Keys of `enKeys` that no entry of `sources` reads (see the file header for what "read" means). */
export function unreadKeys(enKeys: readonly string[], sources: readonly string[]): string[] {
  const all = sources.join("\n");
  const prefixes = templatePrefixes(all);
  return enKeys.filter((key) => {
    const quoted = [`"${key}"`, `'${key}'`, `\`${key}\``].some((q) => all.includes(q));
    if (quoted) return false;
    return !prefixes.some((p) => key.startsWith(p));
  });
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (
      SOURCE_FILE.test(entry.name) &&
      !TEST_FILE.test(entry.name) &&
      full !== MESSAGES_FILE
    ) {
      out.push(full);
    }
  }
}

function readWebSources(): string[] {
  const files: string[] = [];
  walk(WEB, files);
  return files.map((f) => readFileSync(f, "utf8"));
}

const catalogues = splitCatalogues(readFileSync(MESSAGES_FILE, "utf8"));
const enKeys = parseKeys(catalogues.en);
const esKeys = parseKeys(catalogues.es);

describe("i18n message keys are read (B178)", () => {
  const sources = readWebSources();
  const unread = unreadKeys(enKeys, sources);

  it("parses a plausible en catalogue and found web sources to scan", () => {
    expect(enKeys.length).toBeGreaterThan(20);
    expect(new Set(enKeys).size).toBe(enKeys.length);
    expect(sources.length).toBeGreaterThan(50);
  });

  it("every unread en key is in the baseline: no NEW dead keys", () => {
    const fresh = unread.filter((k) => !SHRINK_ONLY_UNREAD.includes(k));
    if (fresh.length > 0) {
      throw new Error(
        `New unread i18n key(s) in messages.ts: ${fresh.join(", ")}. Read them from web code ` +
          `(t("key")) or do not add them. Do not add to SHRINK_ONLY_UNREAD (B178).`,
      );
    }
  });

  it("baseline is shrink-only: each entry still exists in en and is still unread", () => {
    const stale: string[] = [];
    for (const key of SHRINK_ONLY_UNREAD) {
      if (!enKeys.includes(key)) stale.push(`${key} (no longer in en)`);
      else if (!unread.includes(key)) stale.push(`${key} (is now read)`);
    }
    if (stale.length > 0) {
      throw new Error(
        `SHRINK_ONLY_UNREAD has entries that no longer apply: ${stale.join(", ")}. ` +
          `Remove them from the list in messages.unread-keys.test.ts.`,
      );
    }
  });

  it("baseline has no duplicate entries", () => {
    expect(new Set(SHRINK_ONLY_UNREAD).size).toBe(SHRINK_ONLY_UNREAD.length);
  });

  it("es covers exactly the en key set", () => {
    const en = new Set(enKeys);
    const es = new Set(esKeys);
    const onlyEn = enKeys.filter((k) => !es.has(k));
    const onlyEs = esKeys.filter((k) => !en.has(k));
    expect({ onlyEn, onlyEs }).toEqual({ onlyEn: [], onlyEs: [] });
    expect(esKeys.length).toBe(enKeys.length);
  });
});

describe("unreadKeys helper (pins the scanner itself)", () => {
  it("a quoted read in non-test source makes a key live; a key never quoted is unread", () => {
    const keys = ["a.live", "a.dead", "b.only"];
    expect(unreadKeys(keys, [`t("a.live")`, `t('b.only')`])).toEqual(["a.dead"]);
    // a key that only a test file mentions never reaches `sources` (the walker drops test files)
    expect(unreadKeys(["a.dead"], [])).toEqual(["a.dead"]);
  });

  it("a `common.${x}` template literal reads every common.* key but no other namespace", () => {
    const keys = ["common.save", "common.cancel", "nav.orders"];
    expect(unreadKeys(keys, ["const k = `common.${name}`;"])).toEqual(["nav.orders"]);
  });

  it("splits catalogues at the es object and parses only dotted quoted keys", () => {
    const text = [
      "const en = {",
      '  "x.one": "One",',
      '  "x.two": "Two",',
      "} as const;",
      "const es: Messages = {",
      '  "x.one": "Uno",',
      "};",
    ].join("\n");
    const { en, es } = splitCatalogues(text);
    expect(parseKeys(en)).toEqual(["x.one", "x.two"]);
    expect(parseKeys(es)).toEqual(["x.one"]);
  });
});
