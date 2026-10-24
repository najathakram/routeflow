import * as fs from "fs";
import * as path from "path";

/**
 * Structural pin (SA-763r / SA-749): the API has exactly ONE name-based UUID implementation,
 * common/uuidv5.ts. A second one (a hand-rolled sha1 UUID, or a `uuid` v5 import) would derive different
 * ids for the same name, and a stored paymentGroupId would stop matching its reader.
 */
const SRC = path.resolve(__dirname, "..");
const ALLOWED = new Set([path.join(SRC, "common", "uuidv5.ts")]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(abs);
    return e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") ? [abs] : [];
  });
}

describe("no second v5 implementation", () => {
  const files = sourceFiles(SRC);
  const VERSION_BITS = /\|\s*0x50\b/;
  const SHA1 = /createHash\(\s*["'](?:sha1|sha-1)["']\s*\)/;
  const UUID_PKG_V5 = /from\s+["']uuid["']|require\(\s*["']uuid["']\s*\)|uuid\/v5/;

  it("scans a non-trivial source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect([...ALLOWED].every((f) => fs.existsSync(f))).toBe(true);
  });

  it("only common/uuidv5.ts sets the version-5 bits or hashes with sha1 for an id", () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => {
        const text = fs.readFileSync(f, "utf8");
        return VERSION_BITS.test(text) || SHA1.test(text) || UUID_PKG_V5.test(text);
      })
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
