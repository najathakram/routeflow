import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-184/186/189 — the operator invoice EDIT screen sends each stored line's `id`, hydrates an
 * unrecoverable legacy box line LOCKED, and only ever sends an operator-attested `unitsPerBox`.
 * RN screens aren't renderable in this lane, so the wiring is source-pinned.
 */
describe("SA-186/189: invoice edit sends line ids, locks unrecoverable lines, attests packs", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id]/edit.tsx"),
    "utf8",
  );

  it("hydration carries the stored row id", () => {
    const at = src.search(/const hydratedLines = \(invoice\.items \?\? \[\]\)\.map/);
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(/id:\s*it\.id/);
  });

  it("an unrecoverable box line hydrates locked with its stored figures", () => {
    expect(src).toMatch(/locked:\s*true,\s*storedBoxes:\s*Number\(it\.boxes\)/);
  });

  it("the save payload sends the id, the stored split for a locked line, and only an attested pack", () => {
    const at = src.indexOf("items: lines.map((l) => ({");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 900);
    expect(block).toMatch(/l\.id \? \{ id: l\.id \}/);
    expect(block).toMatch(/l\.locked \? \{ boxes: l\.storedBoxes/);
    expect(block).toMatch(/l\.attestedPack \? \{ unitsPerBox: l\.attestedPack \}/);
  });

  it("unlocking requires an integer pack >= 2", () => {
    expect(src).toMatch(/Number\.isInteger\(n\) && n >= 2/);
  });
});
