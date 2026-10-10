import { findScanMatches } from "./scan-match";
import { scanReadInclude, toScanProductView } from "./scan-product-view";
import { tenantSafeParent } from "./product-parent";

/**
 * SA-747r: a quick key's `product` is the scan lookup's product (minus `scanMatch`). The scan reads
 * through findScanMatches and maps with the same tenant-safe parent; this pins the two shapes together on
 * the SAME mock row, so a field added to one reader cannot drift from the other.
 */
const T = "tenant-a";
const row = (over: Record<string, unknown> = {}) => ({
  id: "p-1",
  tenantId: T,
  name: "Acme Cola 12pk",
  barcode: "012345678905",
  sku: "ACME-1",
  unitSku: null,
  unitsPerBox: 12,
  pricePerUnit: "24.00",
  isActive: true,
  imageKeys: ["products/p-1/a.jpg"],
  variants: [{ id: "v-1", tenantId: T, isActive: true }],
  parent: { id: "par-1", tenantId: T, name: "Acme Cola" },
  barcodes: [
    {
      code: "012345678905",
      level: "BOX",
      symbology: "UPC_A",
      origin: "MANUAL",
      copiedFromLevel: null,
      primaryFor: "BOX",
      id: "bc-1",
    },
  ],
  ...over,
});

const fakeDb = (r: ReturnType<typeof row>) => ({
  productBarcode: { findMany: jest.fn().mockResolvedValue([]) },
  product: { findMany: jest.fn().mockResolvedValue([r]) },
});

async function scanProduct(r: ReturnType<typeof row>) {
  const hit = await findScanMatches(fakeDb(r), ["012345678905"], {}, scanReadInclude(T));
  // exactly what ProductsService.findByBarcode returns, minus scanMatch
  return { ...hit!.product, parent: tenantSafeParent(hit!.product.parent, T) };
}

describe("scanReadInclude", () => {
  it("follows only this tenant's ACTIVE variants and the parent", () => {
    expect(scanReadInclude(T)).toEqual({
      variants: { where: { isActive: true, tenantId: T } },
      parent: true,
    });
  });
  it("with no tenant it adds no tenant key (the caller is unscoped, not widened)", () => {
    expect(scanReadInclude(null).variants.where).toEqual({ isActive: true });
  });
});

describe("toScanProductView === the scan lookup's product", () => {
  it("has the same keys and values as findScanMatches' product on the same row", async () => {
    const r = row();
    const view = toScanProductView(r, T);
    const scan = await scanProduct(r);
    expect(Object.keys(view).sort()).toEqual(Object.keys(scan).sort());
    expect(view).toEqual(scan);
    expect(view).not.toHaveProperty("scanMatch");
  });

  it("synthesises the legacy barcode view the same way when the row has no barcode rows", async () => {
    const r = row({ barcodes: [] });
    expect(toScanProductView(r, T)).toEqual(await scanProduct(r));
    expect(toScanProductView(r, T).barcodes[0]).toMatchObject({ origin: "LEGACY" });
  });

  it("drops a cross-tenant parent link (B1211) and a missing parent is null", async () => {
    const foreign = row({ parent: { id: "par-x", tenantId: "tenant-b", name: "Other" } });
    expect(toScanProductView(foreign, T).parent).toBeNull();
    expect(toScanProductView(foreign, T)).toEqual(await scanProduct(foreign));
    expect(toScanProductView(row({ parent: null }), T).parent).toBeNull();
  });

  it("with no tenant the parent fails closed", () => {
    expect(toScanProductView(row(), null).parent).toBeNull();
  });
});
