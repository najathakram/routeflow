/**
 * @jest-environment node
 */
// SA-1192: parity rows carry brand tokens, never a name. normaliseBrand turns the name into
// {{brand:name}} and, only when it differs, the previous name into {{brand:formerly}}. All names
// here are synthetic, except in the capture case, which builds its probes from the brand file.
import * as fs from "fs";
import * as path from "path";
import { BRAND } from "@routeflow/types/brand";
import {
  brandPatternSource,
  captureParity,
  normaliseBrand,
  normaliseRow,
  parseBrand,
} from "../../e2e/helpers/site-parity";

type Evaluate = (fn: (arg: unknown) => unknown, arg: unknown) => Promise<unknown>;

describe("the browser copy of the normaliser", () => {
  const g = globalThis as unknown as { document?: unknown };
  const saved = g.document;
  afterEach(() => {
    if (saved === undefined) delete g.document;
    else g.document = saved;
  });

  it("gives the rows normaliseRow gives (tokens first, then the cut; both names)", async () => {
    const brand = { name: BRAND.name, formerly: BRAND.formerly };
    expect(brand.formerly).not.toBe(brand.name);
    const labels = [
      `${"p".repeat(95)} ${brand.name} tail`,
      `${"p".repeat(60)} ${brand.name} tail`,
      `see ${brand.formerly} here`,
      `plain  label`,
    ];
    const node = (label: string) => ({
      getAttribute: () => null,
      textContent: label,
      querySelector: () => null,
    });
    g.document = {
      querySelectorAll: (sel: string) => (sel.startsWith("button:not") ? labels.map(node) : []),
    };
    const page = {
      evaluate: ((fn, arg) => Promise.resolve(fn(arg))) as Evaluate,
    };
    const rows = await captureParity(page as unknown as Parameters<typeof captureParity>[0]);
    const want = labels.map((s) => `button|${normaliseRow(s, brand)}`).sort();
    expect(rows).toEqual(want);
    expect(rows.some((r) => r.includes("{{brand:formerly}}"))).toBe(true);
    expect(rows.some((r) => r.includes("{{brand:name}}"))).toBe(true);
  });
});

describe("the boundary", () => {
  it("is the one site-port-tokens.cjs uses", () => {
    const cjs = fs.readFileSync(
      path.resolve(__dirname, "../../../../scripts/lib/site-port-tokens.cjs"),
      "utf8",
    );
    const src = brandPatternSource("X");
    const at = src.indexOf("X");
    // The cjs holds the pattern inside a template string, so each backslash is doubled there.
    const inFile = (s: string) => s.replace(/\\/g, "\\\\");
    expect(cjs).toContain(inFile(src.slice(0, at)));
    expect(cjs).toContain(inFile(src.slice(at + 1)));
  });
});

describe("parseBrand", () => {
  it("throws when the name is empty", () => {
    expect(() => parseBrand({ name: "", formerly: "Oldco" })).toThrow(/name/);
  });
  it("throws when the previous name is empty", () => {
    expect(() => parseBrand({ name: "Acme", formerly: "" })).toThrow(/formerly/);
  });
  it("returns both names otherwise", () => {
    expect(parseBrand({ name: "Acme", formerly: "Oldco" })).toEqual(NEW);
  });
});

const NEW = { name: "Acme", formerly: "Oldco" };
const LONG = { name: "Acmeflow Logistics", formerly: "Oldco" };

describe("normaliseBrand", () => {
  it("(1) a real text change next to the name still differs", () => {
    const a = normaliseRow("button|Open Acme dashboard", NEW);
    const b = normaliseRow("button|Open Acme workspace", NEW);
    expect(a).toBe("button|Open {{brand:name}} dashboard");
    expect(a).not.toBe(b);
  });

  it("(2) rows without either name are byte-identical", () => {
    for (const row of ["id|hero", "a|/pricing|Pricing  plans", "control|input|text|q|Search"]) {
      expect(normaliseBrand(row, NEW)).toBe(row);
    }
  });

  it("(3) the old name under the new brand does not match the name token", () => {
    const base = normaliseRow("a|/|Acme home", NEW);
    const now = normaliseRow("a|/|Oldco home", NEW);
    expect(base).toBe("a|/|{{brand:name}} home");
    expect(now).toBe("a|/|{{brand:formerly}} home");
    expect(now).not.toBe(base);
  });

  it("(3b) no second token when the two names are the same", () => {
    expect(normaliseBrand("x Acme y", { name: "Acme", formerly: "Acme" })).toBe(
      "x {{brand:name}} y",
    );
  });

  it("(4) a short and a long name cut at the same place", () => {
    const tail = " ".repeat(3) + "word ".repeat(30);
    const short = normaliseRow(`a|/|Acme${tail}`, NEW);
    const long = normaliseRow(`a|/|Acmeflow Logistics${tail}`, LONG);
    expect(short).toBe(long);
    expect(short.startsWith("a|/|{{brand:name}} word")).toBe(true);
  });

  it("(5) whole words only", () => {
    const row = "a|/x|Acmeworks and Acme.com and @Acme and Acme";
    expect(normaliseBrand(row, NEW)).toBe(
      "a|/x|Acmeworks and Acme.com and @Acme and {{brand:name}}",
    );
  });
});
