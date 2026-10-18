/**
 * Tailwind finds classes by scanning source TEXT; it never evaluates JavaScript. A variant class
 * assembled from a template literal or string concatenation therefore generates no CSS at all:
 * K11-19 shipped `has-[${ADD_PANEL}]:[&>*]:order-last` and the rule silently did nothing. Write the
 * class out whole (a const string holding the full class, or a ternary between two whole classes).
 *
 * Rule: no Tailwind VARIANT class may contain a `${...}` hole or be glued together with `+`.
 *   - an arbitrary variant   `has-[${x}]:...`, `data-[${x}]:...`, `[&${x}]:...`
 *   - a variant-prefixed utility with an interpolated suffix   `md:bg-${tone}`
 *   - the same assembled by concatenation   `"has-[" + x + "]:..."`, `"md:bg-" + tone`
 * Not flagged: a whole-class ternary (`cond ? "md:hidden" : "md:block"`) and an interpolated
 * suffix on a plain, non-variant utility (`bg-${tone}`), which this rule does not try to police.
 */
import * as fs from "fs";
import * as path from "path";

const ARBITRARY_VARIANT =
  "(?:has|group-has|peer-has|data|aria|supports|min|max|group-data|group-aria)";
const PLAIN_VARIANT =
  "(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|focus-within|motion-reduce|motion-safe|dark|print|first|last|odd|even|disabled|checked|open)";

/** Each pattern describes ONE way of building a variant class out of a runtime value. */
export const TEMPLATE_VARIANT_PATTERNS: RegExp[] = [
  // has-[${x}]:..., data-[${x}]:..., aria-[...${x}...]:...
  new RegExp(String.raw`\b${ARBITRARY_VARIANT}-\[[^\]\s]*\$\{`),
  // [&${x}]:..., [&>${x}]:...
  /\[&[^\]\s]*\$\{/,
  // md:bg-${tone}, hover:focus:ring-${size}
  new RegExp(String.raw`\b${PLAIN_VARIANT}(?::[a-z-]+)*:[a-z-]+-\$\{`),
  // "has-[" + x + "]:order-last"   (\x60 is a backtick)
  new RegExp(String.raw`\b${ARBITRARY_VARIANT}-\[[^\]\s"'\x60]*["'\x60]\s*\+`),
  // "md:bg-" + tone
  new RegExp(String.raw`\b${PLAIN_VARIANT}(?::[a-z-]+)*:[a-z-]+-["'\x60]\s*\+`),
];

export function findTemplateBuiltVariant(source: string): string[] {
  const hits: string[] = [];
  for (const re of TEMPLATE_VARIANT_PATTERNS) {
    const global = new RegExp(re.source, "g");
    for (const m of source.matchAll(global)) hits.push(m[0]);
  }
  return hits;
}

describe("template-built variant detector (the rule itself)", () => {
  it.each([
    // The exact K11-19 string that generated nothing.
    "has-[${ADD_PANEL}]:[&>*]:order-last",
    "className={`flex data-[state=${state}]:opacity-50`}",
    "group-has-[${sel}]:hidden",
    "aria-[${attr}]:font-bold",
    "[&${child}]:p-2",
    "[&>${tag}]:mt-1",
    "md:bg-${tone}",
    "sm:hover:text-${size} p-2",
    "dark:ring-${w}",
    '"has-[" + ADD_PANEL + "]:order-last"',
    '"md:grid-cols-" + n',
  ])("flags %s", (sample) => {
    expect(findTemplateBuiltVariant(sample).length).toBeGreaterThan(0);
  });

  it.each([
    'cond ? "md:hidden" : "md:block"',
    "`flex gap-${gap}`",
    "bg-${tone} p-2",
    '"has-[[data-add-panel]]:[&>*]:order-last"',
    'className="data-[state=open]:animate-in md:w-[min(860px,calc(100vw-32px))]"',
    "const url = `/orders/${id}`",
    "`${base} md:hidden`",
    "style={{ width: `${w}px` }}",
    "md:${cls}",
  ])("does not flag %s", (sample) => {
    expect(findTemplateBuiltVariant(sample)).toEqual([]);
  });
});

const WEB_ROOT = path.join(__dirname, "..");
const SCAN_DIRS = [
  path.join(WEB_ROOT, "app"),
  path.join(WEB_ROOT, "components"),
  path.join(WEB_ROOT, "..", "..", "packages", "ui", "src", "web"),
];
const SKIP_DIRS = new Set(["node_modules", ".next", ".jest-cache", "coverage"]);
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

/** Files where a hit is genuinely safe. Path (posix, relative to apps/web) -> why. Keep this tiny. */
const ALLOW_LIST: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("no template-built Tailwind variant classes in source", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d));

  it("scans a real, non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds none (Tailwind cannot generate a class it cannot read as text)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(WEB_ROOT, file).split(path.sep).join("/");
      if (rel in ALLOW_LIST) continue;
      const hits = findTemplateBuiltVariant(fs.readFileSync(file, "utf8"));
      if (hits.length) offenders.push(`${rel}: ${[...new Set(hits)].join(" | ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
