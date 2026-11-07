import * as fs from "fs";
import * as path from "path";

/**
 * AI limits PR-1, SA-1106 A-2 (c): bill scanning is included on every plan (owner ruling 2026-11-07), so the cost guard
 * is the AI cap. Every `@RequireAddon("ocr")` scan route must REACH the cap check: the route's handler calls its
 * service method, and the chain ends in a method that calls `this.platformConfig.prepareAiCall(` (which runs
 * `assertAiBudget`, the one cap check). Taking the cap call out of any one route's chain, or cutting the link between a
 * route and the method that makes it, goes red. The set of gated routes is pinned both ways: a fifth `ocr` scan route
 * fails until it is listed here with its chain.
 *
 * The census beside this file (`ai-call-sites.census.spec.ts`) pins that each Anthropic call site calls
 * `prepareAiCall` first; this spec adds what that one cannot see: which routes lead to those sites. It reads source
 * text because the chain crosses controller, service and module boundaries; the gates themselves stay as they are.
 */
const SRC = path.join(__dirname, "..");

type Hop = { file: string; method: string };

/** controller file#handler -> the chain of methods from the handler to the one that calls prepareAiCall. */
const ROUTES: Record<string, Hop[]> = {
  "bookkeeping/bookkeeping.controller.ts#extractItems": [
    { file: "bookkeeping/bookkeeping.controller.ts", method: "extractItems" },
    { file: "bookkeeping/bookkeeping.service.ts", method: "extractExpenseItems" },
  ],
  "import/batch.controller.ts#scan": [
    { file: "import/batch.controller.ts", method: "scan" },
    { file: "import/batch-import.service.ts", method: "scanAndRecord" },
    { file: "vendor-bills/vendor-bills.service.ts", method: "scanInvoice" },
  ],
  "supplier-statements/supplier-statements.controller.ts#scanStatement": [
    { file: "supplier-statements/supplier-statements.controller.ts", method: "scanStatement" },
    { file: "supplier-statements/supplier-statements.service.ts", method: "scanStatement" },
  ],
  "vendor-bills/vendor-bills.controller.ts#scanInvoice": [
    { file: "vendor-bills/vendor-bills.controller.ts", method: "scanInvoice" },
    { file: "vendor-bills/vendor-bills.service.ts", method: "scanInvoice" },
  ],
};

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (file: string) => strip(fs.readFileSync(path.join(SRC, file), "utf8"));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The balanced text from `open` (an opening bracket) to its closing bracket, exclusive. */
function balanced(text: string, open: number, o: string, c: string): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error("unbalanced");
}

/** The body of a class method (two-space member indent), async or not, parameter decorators and all. */
function methodBody(text: string, name: string): string {
  const at = text.search(new RegExp(String.raw`^ {2}(?:async\s+)?${name}\s*\(`, "m"));
  expect([name, at > -1]).toEqual([name, true]);
  const params = text.indexOf("(", at);
  const afterParams = params + balanced(text, params, "(", ")").length + 2;
  const brace = text.indexOf("{", afterParams);
  return balanced(text, brace, "{", "}");
}

describe('every @RequireAddon("ocr") scan route reaches the AI cap (SA-1106 A-2 (c))', () => {
  it("the gated routes are exactly the four listed (both ways)", () => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel.endsWith(".spec.ts") || rel.includes("/testing/")) continue;
      const text = strip(fs.readFileSync(file, "utf8"));
      for (const m of text.matchAll(/@RequireAddon\(\s*["']ocr["']\s*\)/g)) {
        const next = /^ {2}(?:async\s+)?(\w+)\s*\(/m.exec(text.slice((m.index ?? 0) + m[0].length));
        found.push(`${rel}#${next?.[1]}`);
      }
    }
    expect(found.sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(Object.entries(ROUTES))(
    "%s: each hop calls the next, the last calls prepareAiCall",
    (_route, hops) => {
      hops.forEach((hop, i) => {
        const body = methodBody(read(hop.file), hop.method);
        const next = hops[i + 1];
        if (next) {
          expect([
            hop.file,
            hop.method,
            new RegExp(String.raw`\.${next.method}\s*\(`).test(body),
          ]).toEqual([hop.file, hop.method, true]);
        } else {
          expect([
            hop.file,
            hop.method,
            /\bthis\.platformConfig\.prepareAiCall\s*\(/.test(body),
          ]).toEqual([hop.file, hop.method, true]);
        }
      });
    },
  );

  it("the cap check hangs off prepareAiCall: it calls assertAiBudget (one check, one home)", () => {
    // prepareAiCall's return type is an object type, so read the member's whole text up to the next class member.
    const text = read("platform-admin/platform-config.service.ts");
    const from = text.search(/^ {2}async prepareAiCall\s*\(/m);
    expect(from).toBeGreaterThan(-1);
    const rest = text.slice(from + 1);
    const to = rest.search(/^ {2}(?:async\s+|private\s+|public\s+)?\w+\s*\(/m);
    expect(rest.slice(0, to > -1 ? to : undefined)).toMatch(/\bthis\.assertAiBudget\s*\(/);
  });
});
