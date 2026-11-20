/**
 * @jest-environment node
 */
// SA-1192: parity rows carry brand tokens, never a name. normaliseBrand turns the name into
// {{brand:name}} and, only when it differs, the previous name into {{brand:formerly}}. All names
// here are synthetic.
import { normaliseBrand, normaliseRow } from "../../e2e/helpers/site-parity";

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
