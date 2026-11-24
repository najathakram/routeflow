import * as fs from "fs";
import * as path from "path";
import { orderSideDrafts } from "./drafts";

// SA-1222 PR-A: a PURCHASE_ORDER draft is absent from the orders Parked window and from the orders page `hasDrafts`.
const d = (id: string, kind: string) => ({ id, kind }) as never;

describe("orderSideDrafts (SA-1222)", () => {
  it("drops a PO draft, keeps order and invoice drafts in order; a PO-only list is empty (hasDrafts false)", () => {
    expect(
      orderSideDrafts([d("a", "ORDER"), d("po", "PURCHASE_ORDER"), d("b", "INVOICE")]).map(
        (x) => x.id,
      ),
    ).toEqual(["a", "b"]);
    expect(orderSideDrafts([d("po", "PURCHASE_ORDER")])).toHaveLength(0);
  });

  it("an allowlist: a kind this build has never heard of is dropped (mobile openableDrafts parity)", () => {
    expect(orderSideDrafts([d("x", "ESTIMATE"), d("a", "ORDER")]).map((x) => x.id)).toEqual(["a"]);
  });

  it("a non-array (loading or mocked read) is no drafts", () => {
    expect(orderSideDrafts(undefined)).toEqual([]);
    expect(orderSideDrafts({})).toEqual([]);
  });

  it("both order surfaces read their drafts through it", () => {
    const root = path.resolve(__dirname, "..");
    const page = fs.readFileSync(path.join(root, "app/(dashboard)/orders/page.tsx"), "utf8");
    const parked = fs.readFileSync(
      path.join(root, "app/(dashboard)/orders/_components/ParkedSales.tsx"),
      "utf8",
    );
    // B-M3 (SA-1234): the orders page keeps master's spacer line; the dock lists every kind.
    expect(page).not.toContain("orderSideDrafts(drafts)");
    expect(page).toContain("const hasDrafts = (drafts?.length ?? 0) > 0;");
    expect(parked).toContain("orderSideDrafts(draftRows)");
  });
});
