import { readFileSync } from "fs";
import { join } from "path";
import { getTierPrice } from "@routeflow/pricing";
import { buildSubstituteLine } from "../lib/substitute-line";
import { pickRowPrice } from "../lib/picker-price";

/**
 * B1007 (money): the order editor's product picker (Add product / "Substitute with…") advertised the product's LIST price
 * while the line it creates is billed at the CUSTOMER's tier price. The picker must show the number the line will bill
 * with, by construction: the same `tierPriceFor` the editor prices the substitute/add line with.
 */
const product = {
  id: "p1",
  name: "Cola",
  pricePerUnit: "10.00",
  priceTier2: "8.00",
  priceTier3: "7.00",
  unitsPerBox: 12,
} as const;
const tierPriceFor = (tier: number) => (p: typeof product) => getTierPrice(p, tier);

describe("pickRowPrice: the picker shows what the line will bill", () => {
  it("a tier-2 customer: the picker shows the TIER price (8.00), never the list price (10.00)", () => {
    expect(pickRowPrice(product, tierPriceFor(2))).toBe(8);
    expect(pickRowPrice(product, tierPriceFor(2))).not.toBe(10);
  });

  it("a tier-1 customer (list tier) shows the list price", () => {
    expect(pickRowPrice(product, tierPriceFor(1))).toBe(10);
  });

  it("with no priceFor (every other picker caller) it is the list price, unchanged", () => {
    expect(pickRowPrice(product)).toBe(10);
  });

  it("PARITY: the number shown equals the unit price the substitute line is built with", () => {
    for (const tier of [1, 2, 3]) {
      const priceFor = tierPriceFor(tier);
      const line = buildSubstituteLine({
        product: { id: "p1", name: "Cola", unitsPerBox: 12 },
        tierPrice: priceFor(product),
        listPrice: 10,
      });
      expect(pickRowPrice(product, priceFor)).toBe(line.unitPrice);
    }
  });
});

describe("wiring: the order editor gives the picker its tier pricing", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("edit-items passes priceFor={tierPriceFor} and the picker row reads pickRowPrice, not pricePerUnit", () => {
    expect(read("app/(operator)/(tabs)/orders/[id]/edit-items.tsx")).toMatch(
      /priceFor=\{tierPriceFor\}/,
    );
    const picker = read("components/edit-items/ProductPicker.tsx");
    expect(picker).toMatch(/pickRowPrice\(p, priceFor\)/);
    expect(picker).not.toMatch(/\$\{toNumber\(p\.pricePerUnit\)\.toFixed\(2\)\}/);
  });
});
