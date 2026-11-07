import { freeAddonsFromRegistry } from "./FreeAddonsSection";

describe("freeAddonsFromRegistry (SA-1106 WP7: reads grant.addonKey off the wire row)", () => {
  it("offers only rows that declare an add-on key, under that key", () => {
    const rows = [
      {
        key: "flag.msrp",
        label: "MSRP pricing",
        description: "d1",
        grant: { override: true, addonKey: "msrp", plan: false, mode: false },
      },
      {
        key: "ocr",
        label: "OCR document scanning",
        description: "d2",
        grant: { override: false, plan: true, mode: false },
      },
      { key: "legacy", label: "No grant", description: "d3" },
    ];
    expect(freeAddonsFromRegistry(rows)).toEqual([
      { addonKey: "msrp", label: "MSRP pricing", description: "d1" },
    ]);
  });
});
