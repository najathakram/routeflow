import * as fs from "fs";
import * as path from "path";

/**
 * SA-1154 O11: the web never works out where an embedded checkout returns. The path is the server's
 * (`CheckoutStart.returnPath`), checked in `assertCheckoutStartable` and read only inside `followCheckout`.
 * Structural, so a new opener cannot slip a path of its own in.
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "coverage", "e2e", "playwright-report"]);
const CORE = "lib/checkout-embedded.ts";
const HOST = "components/billing/EmbeddedCheckoutHost.tsx";

type Source = { file: string; text: string };

function sourceFiles(dir: string, acc: Source[] = []): Source[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) {
      acc.push({
        file: path.relative(WEB_ROOT, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return acc;
}

/** The number of top-level arguments of the call whose `(` is at `open` (strings and nested brackets skipped). */
function argumentCount(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  let count = 0;
  let sawToken = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      sawToken = true;
    } else if (c === "(" || c === "{" || c === "[") {
      if (depth > 0) sawToken = true;
      depth++;
    } else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return sawToken ? count + 1 : 0;
    } else if (c === "," && depth === 1) {
      count++;
      sawToken = false;
    } else if (depth >= 1 && !/\s/.test(c)) sawToken = true;
  }
  return -1;
}

/** Calls of `name(` in `text`, as their argument counts (the declaration `function name(` is not a call). */
function callArgumentCounts(text: string, name: string): number[] {
  const re = new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, "g");
  return [...text.matchAll(re)].map((m) => argumentCount(text, (m.index ?? 0) + m[0].length - 1));
}

const files = sourceFiles(WEB_ROOT);

describe("SA-1154 O11: the return path is the server's, never a caller's", () => {
  it("scans the real tree (guards against an empty walk)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((f) => f.file)).toContain(CORE);
  });

  it("every followCheckout call passes (start, leave) and no path", () => {
    const calls = files.flatMap((f) =>
      callArgumentCounts(f.text, "followCheckout").map((n) => ({ file: f.file, args: n })),
    );
    // the two tenant mutations (plan checkout, payment-due pay) and nothing else
    expect(calls).toEqual([
      { file: "lib/api/billing.ts", args: 2 },
      { file: "lib/api/payment-due.ts", args: 2 },
    ]);
  });

  it("only the checkout module opens the embedded checkout, so only followCheckout chooses its path", () => {
    const callers = files
      .filter((f) => callArgumentCounts(f.text, "openEmbeddedCheckout").length > 0)
      .map((f) => f.file);
    expect(callers).toEqual([CORE]);
  });

  it("returnPath appears only in the checkout module (follow, assert, store) and the host that pushes it", () => {
    const readers = files.filter((f) => /\breturnPath\b/.test(f.text)).map((f) => f.file);
    expect(readers.sort()).toEqual([CORE, HOST].sort());
  });

  it("no web file builds an embedded start of its own", () => {
    const builders = files.filter((f) => /\buiMode\s*:\s*["']embedded["']/.test(f.text));
    expect(builders.map((f) => f.file)).toEqual([]);
  });

  it("self-controls: the counter sees a third argument, a nested comma and a declaration", () => {
    expect(callArgumentCounts("followCheckout(r, (u) => go(u, 1))", "followCheckout")).toEqual([2]);
    expect(callArgumentCounts("followCheckout(r, leave, PATH)", "followCheckout")).toEqual([3]);
    expect(
      callArgumentCounts("followCheckout(r, (u) => { a(u, 2); }, p)", "followCheckout"),
    ).toEqual([3]);
    expect(callArgumentCounts("export function followCheckout(a, b) {}", "followCheckout")).toEqual(
      [],
    );
  });
});
