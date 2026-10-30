import { readFileSync } from "node:fs";
import { join } from "node:path";
import { genericToastCopy } from "./generic-toast-copy";
import { PRICE_RIGHTS_COPY, isPriceEditRefusal, priceRightsRefusalCopy } from "./price-rights-copy";

const refusal = (code: string, status = 403) => ({ response: { status, data: { code } } });

describe("price rights copy (SA-1034 rule 10)", () => {
  it("is the one fixed sentence", () => {
    expect(PRICE_RIGHTS_COPY).toBe("Needs price rights. Ask your admin.");
  });

  it("a 403 PRICE_EDIT_NOT_PERMITTED maps to it, in the helper and in the app-wide toast", () => {
    const err = refusal("PRICE_EDIT_NOT_PERMITTED");
    expect(isPriceEditRefusal(err)).toBe(true);
    expect(priceRightsRefusalCopy(err)).toBe(PRICE_RIGHTS_COPY);
    expect(genericToastCopy(err)).toBe(PRICE_RIGHTS_COPY);
  });

  it("any other error is not a price refusal", () => {
    expect(priceRightsRefusalCopy(refusal("PERMISSION_DENIED"))).toBeNull();
    expect(priceRightsRefusalCopy(refusal("PRICE_EDIT_NOT_PERMITTED", 409))).toBeNull();
    expect(priceRightsRefusalCopy(new Error("x"))).toBeNull();
    expect(priceRightsRefusalCopy(null)).toBeNull();
  });
});

/** The three "Add custom item" controls are each disabled by the one hook's answer, with the hint beside them. */
describe("the three Add custom item controls read the server's answer", () => {
  const files: [string, number][] = [
    ["app/(dashboard)/orders/[id]/_components/order-line-edit.tsx", 1],
    ["app/(dashboard)/invoices/new/page.tsx", 1],
    ["app/(dashboard)/orders/_components/CreateOrderModal.tsx", 1],
  ];
  it.each(files)("%s", (file) => {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    expect([...src.matchAll(/Add custom item/g)]).toHaveLength(1);
    expect([...src.matchAll(/usePriceEditAllowed\(\)/g)]).toHaveLength(1);
    expect(src).toMatch(/disabled=\{!priceEditAllowed\}/);
    expect(src).toContain("PRICE_RIGHTS_COPY");
  });
});
