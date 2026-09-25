import { readFileSync } from "fs";
import { join } from "path";

/** SA-184/186/189 — web invoice edit: line ids in the payload, LOCKED unrecoverable lines,
 *  only an operator-attested `unitsPerBox` on the wire. Source-pinned like pack-hydration.pins. */
describe("SA-186/189: web invoice edit line ids, locked lines, attested pack", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("hydration keeps the stored id and locks an unrecoverable box line", () => {
    expect(src).toMatch(/id:\s*it\.id,/);
    expect(src).toMatch(/const locked = isBoxSplit && !\(upb > 1\);/);
    expect(src).toMatch(/storedBoxes:\s*locked \? Number\(it\.boxes \?\? 0\)/);
  });

  it("the payload sends the id, the stored split when locked, and only an attested pack", () => {
    expect(src).toMatch(/\.\.\.\(it\.id \? \{ id: it\.id \} : \{\}\)/);
    expect(src).toMatch(
      /it\.locked\s*\? \{ boxes: it\.storedBoxes \?\? 0, pieces: it\.storedPieces \?\? 0 \}/,
    );
    expect(src).toMatch(/it\.attestedPack \? \{ unitsPerBox: it\.attestedPack \}/);
  });

  it("unlocking requires an integer pack >= 2", () => {
    expect(src).toMatch(/Number\.isInteger\(v\) && v >= 2/);
  });

  it("swapping a line's product drops its stored id (a NEW line); re-picking the SAME product keeps the row's pack", () => {
    expect(src).toMatch(/const swapped = productId !== item\.productId;/);
    expect(src).toMatch(
      /swapped\s*\? \{ id: undefined, locked: undefined, attestedPack: undefined \}/,
    );
    expect(src).toMatch(/: item\.unitsPerBox,/);
  });
});
