/**
 * Web ↔ mobile parity for the order-detail line-card display helpers (order-ui T8).
 *
 * React Native cannot import the web row component, so `apps/mobile/lib/order-line-display.ts`
 * carries small pure mirrors of `splitProductName`, `orderLineName`, `displayLineStatus` and
 * `linePriceTag`. Nothing else ties the two implementations together, so this runs BOTH over the
 * same fixtures (the apps share `@routeflow/pricing`, and these helpers are pure) — a change to one
 * that is not made to the other fails here. The mobile module is loaded by relative path, the same
 * way `apps/api/src/common/enum-parity.spec.ts` pins the mobile `@routeflow/types` stub.
 */
import {
  displayLineStatus as mobileStatus,
  linePriceTag as mobileTag,
  orderLineName as mobileName,
  splitProductName as mobileSplit,
} from "../../mobile/lib/order-line-display";
import { linePriceTag as webTag } from "@/components/line-price-tag";
import { orderLineName as webName, splitProductName as webSplit } from "@/lib/product-display";
import { displayLineStatus as webStatus } from "@/app/(dashboard)/orders/[id]/_components/line-status";

const NAMES = [
  "Sample Pod - Strawberry Banana - 5ct",
  "Sample Chips 1oz",
  "Cola-12pk",
  " - Leading",
  "Trailing - ",
  "A - B",
  "A - B - C - D",
  "",
  "SAMPLE DIAMOND INFUSED PREROLL 1.25GM - Berry Blast Sativa - 20CT",
];

describe("splitProductName — web and mobile agree", () => {
  it.each(NAMES)("%j", (name) => {
    expect(mobileSplit(name)).toEqual(webSplit(name));
  });
});

const LINES: Array<Parameters<typeof webName>[0]> = [
  { product: { name: "Sample Chips" } },
  {
    product: { name: "Berry", variantName: "Berry", parentProductId: "p", parent: { name: "Pod" } },
  },
  { product: { name: "Berry", variantName: "Berry", parentProductId: "p" } },
  {
    product: {
      name: "x",
      variantName: "Pod - Berry",
      parentProductId: "p",
      parent: { name: "Pod" },
    },
  },
  { product: { name: "Solo", parent: { name: "Pod" } } },
  { product: null, name: "Delivery surcharge" },
  { product: undefined, name: null },
  {},
];

describe("orderLineName — web and mobile agree", () => {
  it.each(LINES.map((l, i) => [i, l] as const))("fixture %i", (_i, line) => {
    expect(mobileName(line)).toEqual(webName(line));
  });
});

describe("displayLineStatus — web and mobile agree", () => {
  const STATUSES = ["PENDING", "CONFIRMED", "CANCELLED", "DELIVERED", "PARTIAL"];
  const ORDER_STATUSES = ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"];
  const DELIVERED = [0, 3, 8, 8.0000001, 0.1 + 0.2];
  const QTY = [8, 0.3];
  for (const status of STATUSES) {
    for (const orderStatus of ORDER_STATUSES) {
      for (const deliveredQty of DELIVERED) {
        for (const qty of QTY) {
          it(`${status} / order ${orderStatus} / delivered ${deliveredQty} of ${qty}`, () => {
            const li = { status, deliveredQty, qty };
            expect(mobileStatus(li, orderStatus)).toBe(webStatus(li, orderStatus));
          });
        }
      }
    }
  }
});

describe("linePriceTag — web and mobile agree (label + strike; tone maps emerald↔green, amber↔orange)", () => {
  const TYPES = ["SPECIAL", "MANUAL", "DISCOUNTED", "PROMO", "STANDARD", undefined, null];
  const ORIGINALS: Array<number | string | null> = [null, 50, 80, "50.00"];
  const TONE = { emerald: "green", amber: "orange" } as const;
  for (const priceType of TYPES) {
    for (const originalPrice of ORIGINALS) {
      it(`${String(priceType)} / original ${String(originalPrice)}`, () => {
        const input = { priceType, originalPrice, unitPrice: 65 };
        const w = webTag(input);
        const m = mobileTag(input);
        if (w === null) {
          expect(m).toBeNull();
        } else {
          expect(m).toEqual({
            label: w.label,
            tone: TONE[w.tone],
            strikeOriginal: w.strikeOriginal,
          });
        }
      });
    }
  }
});
