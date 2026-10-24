import { readFileSync } from "fs";
import { join } from "path";
import { buyerEditPayloadItems } from "./buyer-edit-payload";

const ids = (items: Array<{ orderItemId?: string }>) =>
  items.map((i) => i.orderItemId).filter((v): v is string => !!v);

describe("buyerEditPayloadItems never emits a repeated line id (F3)", () => {
  it("two stored lines of ONE product keep their own distinct ids, edited rows included", () => {
    const out = buyerEditPayloadItems([
      { productId: "p1", qty: 3, orderItemId: "L1" },
      { productId: "p1", qty: 9, orderItemId: "L2" },
    ]);
    expect(ids(out)).toEqual(["L1", "L2"]);
  });

  it("rows added this session carry no id, so several adds are not duplicates of each other or of a stored line", () => {
    const out = buyerEditPayloadItems([
      { productId: "p1", qty: 1, orderItemId: "L1" },
      { productId: "p2", qty: 1 },
      { productId: "p3", qty: 2, orderItemId: null },
    ]);
    expect(ids(out)).toEqual(["L1"]);
    expect(out).toHaveLength(3);
  });

  it("a removed row is simply absent (a removal is never sent as a second entry for its id)", () => {
    const rows = [
      { productId: "p1", qty: 1, orderItemId: "L1" },
      { productId: "p2", qty: 1, orderItemId: "L2" },
    ].filter((r) => r.orderItemId !== "L1");
    expect(ids(buyerEditPayloadItems(rows))).toEqual(["L2"]);
  });

  it("the buyer portal order page builds its edit payload through this builder (no inline copy)", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/buyer/portal/[seller]/orders/[id]/page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/items:\s*buyerEditPayloadItems\(editItems\)/);
  });
});
