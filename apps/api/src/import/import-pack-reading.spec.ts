import { IMPORT_PACK_READING, withImportPackReading } from "./import-pack-reading";

describe("import pack reading (SA-946 MUST 3, SA-961 R1)", () => {
  it("defaults to the piece reading: the import converts nothing (SA-961 R1)", () => {
    expect(IMPORT_PACK_READING).toBe("piece");
  });

  it("adds the reading only to a row that writes a pack size", () => {
    expect(withImportPackReading({ unitsPerBox: 12 })).toEqual({
      unitsPerBox: 12,
      packReading: "piece",
    });
    const noPack = { standardCost: 2 };
    expect(withImportPackReading(noPack)).toBe(noPack);
  });
});
