import {
  displayProductName,
  PRODUCT_NAME_SEPARATOR as SHARED_SEPARATOR,
} from "../../../../packages/types/api/product-name";
import { productDisplayName, PRODUCT_NAME_SEPARATOR } from "./product-display-name";

/**
 * SA-1216 parity: the api twin `productDisplayName` and the shared `displayProductName`
 * (`@routeflow/types`, used by web and mobile) are one rule. The api cannot runtime-import the
 * package (its dist runs plain node), so it keeps a twin; this spec runs one case table through both
 * and fails the moment they disagree (SA-1211 A4).
 */
const CASES: ReadonlyArray<{
  label: string;
  product: { name: string; variantName?: string | null; parentProductId?: string | null };
  parentName: string | null;
  expected: string;
}> = [
  { label: "standalone", product: { name: "Acme Cola" }, parentName: null, expected: "Acme Cola" },
  {
    label: "variant with its parent",
    product: { name: "Blueberry", variantName: "Blueberry", parentProductId: "fam-1" },
    parentName: "Acme Vape",
    expected: "Acme Vape - Blueberry",
  },
  {
    label: "variant with no parent name",
    product: { name: "Blueberry", variantName: "Blueberry", parentProductId: "fam-1" },
    parentName: null,
    expected: "Blueberry",
  },
  {
    label: "legacy row already prefixed",
    product: { name: "Acme Vape - Blueberry", parentProductId: "fam-1" },
    parentName: "Acme Vape",
    expected: "Acme Vape - Blueberry",
  },
  {
    label: "empty variant name falls back to the stored name",
    product: { name: "Blueberry", variantName: "  ", parentProductId: "fam-1" },
    parentName: "Acme Vape",
    expected: "Blueberry",
  },
  {
    label: "prefix match is case-insensitive",
    product: { name: "acme vape - Blueberry", parentProductId: "fam-1" },
    parentName: "Acme Vape",
    expected: "acme vape - Blueberry",
  },
];

describe("product display name parity (api twin vs @routeflow/types)", () => {
  it("shares one separator", () => {
    expect(PRODUCT_NAME_SEPARATOR).toBe(SHARED_SEPARATOR);
  });

  it.each(CASES)("$label", ({ product, parentName, expected }) => {
    const shared = displayProductName({
      ...product,
      parent: parentName ? { name: parentName } : null,
    });
    expect(shared).toBe(expected);
    expect(productDisplayName(product, parentName)).toBe(shared);
  });
});
