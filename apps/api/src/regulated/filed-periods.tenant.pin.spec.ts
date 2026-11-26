import * as fs from "fs";
import * as path from "path";

/**
 * Read-scope hardening for the filed-period reads: every `regulatedFiling.find*(` and every raw
 * `FROM "RegulatedFiling"` in `filed-periods.ts` carries `tenantId` in its where. The by-id writers are the only
 * exceptions and are count-pinned (shrink-only): each one's id was read through `forTenant()` by its caller.
 *
 * The scan reads the file from disk. `scan` is pure so the probes below can run it on planted text (L-377).
 */
const SOURCE = fs.readFileSync(path.join(__dirname, "filed-periods.ts"), "utf8");
const BY_ID_WRITER_EXCEPTIONS = 2;

const stripComments = (text: string): string =>
  text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

/** The text of the call that opens at `open` (the index of its "("), to the matching ")". */
function callBody(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

export function scan(raw: string) {
  const text = stripComments(raw);
  const finds = [...text.matchAll(/regulatedFiling\??\s*\.find\w*\s*\(/g)].map((m) => ({
    site: m[0],
    scoped: /\btenantId\b/.test(callBody(text, m.index! + m[0].length - 1)),
  }));
  const rawReads = [...text.matchAll(/FROM\s+"RegulatedFiling"/g)].map((m) => {
    const end = text.indexOf("`", m.index!);
    return { site: m[0], scoped: /"tenantId"/.test(text.slice(m.index!, end)) };
  });
  const writers = [
    ...text.matchAll(/regulatedFiling\??\s*\.(update|updateMany|upsert|delete|deleteMany)\s*\(/g),
  ];
  return { finds, rawReads, writers: writers.length };
}

describe("filed-periods.ts: every filing read names its tenant", () => {
  const found = scan(SOURCE);

  it("scans at least one read of each kind (the pin cannot go vacuous)", () => {
    expect(found.finds.length).toBeGreaterThanOrEqual(5);
    expect(found.rawReads.length).toBeGreaterThanOrEqual(1);
  });

  it("each regulatedFiling.find*( has tenantId in its where", () => {
    expect(found.finds.filter((f) => !f.scoped)).toEqual([]);
  });

  it('each raw FROM "RegulatedFiling" filters on "tenantId"', () => {
    expect(found.rawReads.filter((f) => !f.scoped)).toEqual([]);
  });

  it("the by-id writers are the only unscoped filing calls (2, shrink-only)", () => {
    expect(found.writers).toBeLessThanOrEqual(BY_ID_WRITER_EXCEPTIONS);
  });

  it("probe: an unscoped find, an unscoped raw read and a third writer are all caught", () => {
    const planted = scan(`
      await db.regulatedFiling.findFirst({ where: { periodKey: "x" } });
      await db.regulatedFiling.findMany({ where: { tenantId, periodKey: "x" } });
      Prisma.sql\`SELECT 1 FROM "RegulatedFiling" f WHERE f."id" = 1\`;
      Prisma.sql\`SELECT 1 FROM "RegulatedFiling" f WHERE f."tenantId" = 1\`;
      await db.regulatedFiling.update({ where: { id } });
    `);
    expect(planted.finds.map((f) => f.scoped)).toEqual([false, true]);
    expect(planted.rawReads.map((f) => f.scoped)).toEqual([false, true]);
    expect(planted.writers).toBe(1);
  });
});
