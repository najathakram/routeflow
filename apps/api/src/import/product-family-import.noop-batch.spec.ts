import { ProductFamilyImportService } from "./product-family-import.service";

type Row = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  parentProductId: string | null;
};

const fam: Row = { id: "fam", name: "Acme Cola", sku: null, barcode: null, parentProductId: null };
const variant = (i: number, over: Partial<Row> = {}): Row => ({
  id: `v${i}`,
  name: `Flavour ${i}`,
  sku: `S${i}`,
  barcode: `B${i}`,
  parentProductId: "fam",
  ...over,
});

function build(rows: Row[]) {
  const reads = { findMany: 0, findFirst: 0 };
  const has = (r: Row, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "OR") return v.some((w: any) => has(r, w));
      const val = (r as any)[k];
      if (v && typeof v === "object" && "in" in v) return v.in.includes(val);
      if (v && typeof v === "object" && "equals" in v)
        return String(val ?? "").toLowerCase() === String(v.equals).toLowerCase();
      return val === v;
    });
  const product = {
    findMany: jest.fn(async (a: any) => {
      reads.findMany += 1;
      return rows.filter((r) => has(r, a.where));
    }),
    findFirst: jest.fn(async (a: any) => {
      reads.findFirst += 1;
      return rows.find((r) => has(r, a.where)) ?? null;
    }),
  };
  const prisma = { forTenant: () => ({ product }), getTenantId: () => "t1" };
  const service = new ProductFamilyImportService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, reads };
}

describe("currentFamilyNoops reads in batches (row 700)", () => {
  it("answers 40 rows with a handful of reads, not one per row", async () => {
    const rows = [fam, ...Array.from({ length: 40 }, (_, i) => variant(i))];
    const { service, reads } = build(rows);
    const input = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      family: "Acme Cola",
      sku: `S${i}`,
    }));
    const out = await service.currentFamilyNoops(input);
    expect(out.size).toBe(40);
    expect(reads.findMany + reads.findFirst).toBeLessThanOrEqual(3);
  });

  it("keeps the match order and the per-row rules", async () => {
    const rows = [
      fam,
      variant(1),
      variant(2, { parentProductId: null }), // not in a family: not a no-op
      variant(3, { name: "Twin" }),
      variant(4, { name: "Twin", sku: "S4" }), // a name shared by two products never matches
    ];
    const { service } = build(rows);
    const out = await service.currentFamilyNoops([
      { index: 0, family: "acme cola", id: "v1" }, // id, family compared case-insensitively
      { index: 1, family: "Acme Cola", sku: "S2" }, // no parent
      { index: 2, family: "Acme Cola", sku: "NOPE", barcode: "B1" }, // sku misses, barcode hits
      { index: 3, family: "Acme Cola", nameCell: "Twin" }, // ambiguous name
      { index: 4, family: "Acme Cola", nameCell: "Acme Cola - Flavour 1" }, // prefixed name, unique
      { index: 5, family: "Acme Cola", sku: "S1", variantCell: "Zero" }, // a Variant Name cell is never a no-op
      { index: 6, family: "Other", id: "v1" }, // a different family is a real regroup
    ]);
    expect([...out].sort()).toEqual([0, 2, 4]);
  });
});
