/**
 * #2764 (Opus review): the mobile invoice EDIT screen's scan handler must hand addCatalogLine the level the
 * scanned code carries (shared resolver over `levelsForScan`), never the line's mode or a hard-coded level.
 * Source-wiring pin (the screen is an RN component; mobile jest is pure-logic only).
 */
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(
  path.join(__dirname, "../app/(operator)/(tabs)/invoices/[id]/edit.tsx"),
  "utf8",
);

describe("invoices/[id]/edit — scan level wiring", () => {
  it("imports levelsForScan from the shared wedge-scan helper", () => {
    expect(src).toMatch(/import \{ levelsForScan \} from "[./]+\/lib\/wedge-scan"/);
  });

  it("the scan handler resolves the level from the scanned code and passes it to addCatalogLine", () => {
    expect(src).toMatch(
      /addCatalogLine\(p, resolveScanSellLevel\(p, levelsForScan\(trimmed, p\)\)\)/,
    );
  });

  it("no scan path in the screen adds a catalog line with a hard-coded level", () => {
    expect(src).not.toMatch(/addCatalogLine\([^)]*"(BOX|UNIT)"\)/);
  });
});
