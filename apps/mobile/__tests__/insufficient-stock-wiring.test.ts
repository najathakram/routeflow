import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is source-pinned:
// every buyer order-CREATE/edit path must route its failure through orderErrorMessage (which turns an
// INSUFFICIENT_STOCK 409 into a sentence) and never read `data.message` straight into a toast. The
// helper's own behaviour is covered in order-error-message.test.ts.
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("mobile buyer order paths use orderErrorMessage (gap 05)", () => {
  it.each([
    "app/(customer)/shelf.tsx",
    "app/(customer)/orders/cart.tsx",
    "app/(customer)/orders/[id].tsx", // Reorder
    "app/(customer)/orders/[id]/edit-items.tsx", // edit path
    "app/(customer)/standing-orders.tsx", // template Reorder
    "components/NewOrderScreen.tsx",
  ])("%s imports and calls orderErrorMessage", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/from "\.\.?(\/\.\.)*\/lib\/order-error-message"/);
    expect(src).toMatch(/orderErrorMessage\(/);
  });

  it("the reorder mutations no longer toast the raw server message", () => {
    expect(read("app/(customer)/orders/[id].tsx")).not.toMatch(
      /Reorder[\s\S]{0,400}showToast\(e\?\.response\?\.data\?\.message/,
    );
    const standing = read("app/(customer)/standing-orders.tsx");
    expect(standing).toMatch(/reorderMut\.mutate\(id, \{[\s\S]*?orderErrorMessage\(e,/);
  });
});
