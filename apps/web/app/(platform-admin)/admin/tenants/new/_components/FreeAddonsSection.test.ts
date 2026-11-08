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
        grant: { override: true, plan: true, mode: false },
      },
      { key: "legacy", label: "No grant", description: "d3" },
    ];
    expect(freeAddonsFromRegistry(rows)).toEqual([
      { addonKey: "msrp", label: "MSRP pricing", description: "d1" },
    ]);
  });

  // An older API sends no `grant`; the form must still offer master's eight add-on keys.
  it("falls back to the pre-grant key map for rows with no grant (older API)", () => {
    const row = (key: string) => ({ key, label: key, description: "d" });
    const keys = [
      "tobacco_dealer",
      "driver_payments",
      "recurring_routes",
      "order_delivery",
      "ocr",
      "developer_mode",
      "flag.msrp",
      "flag.sales_agents",
      "crm_gohighlevel",
      "limit_seats",
    ];
    expect(freeAddonsFromRegistry(keys.map(row)).map((a) => a.addonKey)).toEqual([
      "tobacco_dealer",
      "driver_payments",
      "recurring_routes",
      "order_delivery",
      "ocr",
      "developer_mode",
      "msrp",
      "sales_agents",
    ]);
  });
});
