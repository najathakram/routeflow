/**
 * Row 505 — SOURCE PINS for the 44px tap-target rule (390px capture measured 43px POS buttons,
 * ~16px shipment links, 34px carrier chips). Style text is pinned because the screens cannot be
 * imported under Jest (React Native / expo-router deps).
 */
import { readFileSync } from "fs";
import { join } from "path";

const orderSrc = readFileSync(
  join(__dirname, "..", "app", "(operator)", "(tabs)", "orders", "[id].tsx"),
  "utf8",
);
const shipSrc = readFileSync(join(__dirname, "..", "components", "ShipmentSection.tsx"), "utf8");

const block = (src: string, key: string): string => {
  const m = src.match(new RegExp(`\\n\\s*${key}:\\s*\\{([\\s\\S]*?)\\n?\\s*\\},?\\n`));
  return m ? m[1] : "";
};

describe("pin (505): 44px tap targets", () => {
  it("the shared POS action button style (actionBtn) has minHeight 44", () => {
    expect(block(orderSrc, "actionBtn")).toMatch(/minHeight:\s*44\b/);
  });
  it("the Shipment card's Add tracking / Edit shipment link (editBtn) has minHeight 44", () => {
    expect(block(shipSrc, "editBtn")).toMatch(/minHeight:\s*44\b/);
  });
  it("the carrier chips (carrierChip) have minHeight 44", () => {
    expect(block(shipSrc, "carrierChip")).toMatch(/minHeight:\s*44\b/);
  });
});
