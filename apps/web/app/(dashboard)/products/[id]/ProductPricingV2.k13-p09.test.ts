import * as fs from "fs";
import * as path from "path";

// K13 P09: while editing, the Save bar must rest directly under the grid it saves. It used to render after the
// Customer view block, which pushed Save ~220 px below the grid.
describe("K13 P09: the Save bar renders right after the grid", () => {
  const src = fs.readFileSync(path.join(__dirname, "ProductPricingV2.tsx"), "utf8");
  const section = src.slice(src.indexOf("<EditablePricesGrid"));
  it("comes before the saved line and the Customer view", () => {
    const bar = section.indexOf("<PriceEditBar");
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(section.indexOf("<PriceSaveStatus"));
    expect(bar).toBeLessThan(section.indexOf("<CustomerPriceView"));
  });
});
