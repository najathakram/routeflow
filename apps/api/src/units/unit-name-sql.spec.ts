import { Prisma } from "@prisma/client";
import { unitNameKey } from "@routeflow/pricing";
import { sqlKeyOf } from "./unit-name-sql";

/** Every UTF-16 unit JS `trim()` strips, derived from the engine itself, not from a hand list. */
const jsTrimSet = (): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= 0xffff; i++) if (String.fromCharCode(i).trim() === "") out.push(i);
  return out;
};

const sqlText = () => sqlKeyOf(Prisma.sql`x`).sql;

describe("the SQL key's btrim set equals what JS trim() strips", () => {
  it("is exactly the code points JS trim() removes (incl. U+1680, U+2000-200A, U+2028/9, U+202F, U+205F, U+3000, U+FEFF)", () => {
    const literal = sqlText().match(/E'([^']*)'/)?.[1] ?? "";
    // every character is a 4-hex \uXXXX escape: valid in a PostgreSQL E-string, no \v, no raw bytes
    expect(literal).toMatch(/^(\\u[0-9a-fA-F]{4})+$/);
    const sqlSet = [...literal.matchAll(/\\u([0-9a-fA-F]{4})/g)].map((m) => parseInt(m[1], 16));
    expect([...sqlSet].sort((a, b) => a - b)).toEqual(jsTrimSet());
  });

  it("covers the ones the old set missed", () => {
    const literal = sqlText().match(/E'([^']*)'/)?.[1] ?? "";
    for (const cp of [0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
      expect(literal.toLowerCase()).toContain(`\\u${cp.toString(16).padStart(4, "0")}`);
    }
  });

  it("the TS key strips them too (the two sides agree on a table)", () => {
    for (const cp of [0x1680, 0x2003, 0x2028, 0x202f, 0x205f, 0x3000, 0xfeff]) {
      const ch = String.fromCharCode(cp);
      expect(unitNameKey(`${ch}Case${ch}`)).toBe("case");
    }
  });

  it("keeps the normalize and lower wrapping around the column", () => {
    expect(sqlText()).toMatch(/^lower\(btrim\(normalize\(x, NFC\), E'/);
  });
});
