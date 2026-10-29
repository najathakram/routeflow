import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1026 A: the order detail page renders its staff header flags through OrderStaffFlags (the page sits at its size cap, so
 * the To collect chip rides in the same slot as the B1116 badge), reading the server's field and never re-deriving it.
 */
describe("orders/[id]/page.tsx header flags", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("renders OrderStaffFlags with the order", () => {
    expect(src).toMatch(/<OrderStaffFlags order=\{order\} \/>/);
  });

  it("does not compute To collect itself", () => {
    expect(src).not.toMatch(/expectedPaymentMethod/);
  });
});
