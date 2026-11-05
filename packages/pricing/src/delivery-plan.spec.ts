import * as fs from "fs";
import * as path from "path";
import { buildStopDeliveries, deliveryTypeForQty, fallbackShortPickLines } from "./delivery-plan";

/**
 * SA-1098 PR-2a: the driver's `deliveries` builder lives here once (mobile and the web driver screen both import it). The
 * full behaviour is pinned by apps/mobile/__tests__/short-pick*.test.ts through the mobile re-export; this spec pins the
 * move itself — one copy — and the multi-order coverage rule the web screen relies on.
 */
const line = (id: string, qty: number, remaining?: number) => ({
  id,
  productId: `p-${id}`,
  status: "PENDING",
  qty,
  subtotal: qty * 2,
  ...(remaining === undefined ? {} : { remaining }),
});

describe("delivery-plan (moved from apps/mobile/lib/short-pick.ts)", () => {
  it("types a delivery by qty: REFUSED at 0, DELIVERED at the full qty, PARTIAL between", () => {
    expect(deliveryTypeForQty(0, 10)).toBe("REFUSED");
    expect(deliveryTypeForQty(7, 10)).toBe("PARTIAL");
    expect(deliveryTypeForQty(10, 10)).toBe("DELIVERED");
  });

  it("a multi-order stop emits one explicit entry per line of EVERY order, never an omission", () => {
    const a = fallbackShortPickLines({ lineItems: [line("a1", 10, 10), line("a2", 4, 4)] });
    const b = fallbackShortPickLines({ lineItems: [line("b1", 6, 6)] });
    const out = buildStopDeliveries([
      { orderId: "A", lines: a, deliveredQtyById: { a1: 7 } },
      { orderId: "B", lines: b, deliveredQtyById: {} },
    ]);
    expect(out.map((d) => [d.orderItemId, d.type, d.quantityDelivered])).toEqual([
      ["a1", "PARTIAL", 7],
      ["a2", "DELIVERED", 4],
      ["b1", "DELIVERED", 6],
    ]);
  });

  it("fails closed on a line the server served no remaining for (no honest default)", () => {
    const a = fallbackShortPickLines({ lineItems: [line("a1", 10)] });
    expect(() => buildStopDeliveries([{ orderId: "A", lines: a, deliveredQtyById: {} }])).toThrow(
      /Enter the delivered quantity/,
    );
  });

  it("is a MOVE: the mobile file holds only re-exports, no function bodies", () => {
    for (const rel of ["short-pick.ts", "stop-completion-key.ts"]) {
      const src = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/lib", rel), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
      if (rel === "short-pick.ts") {
        expect(code).not.toMatch(/\bfunction\b|=>/);
        expect(code).toContain('from "@routeflow/pricing"');
      } else {
        expect(code).toContain('from "@routeflow/types/stop-completion-key"');
        expect(code).not.toMatch(/keepsStopCompletionKey\s*\(|retryOnLockUnavailable\s*</);
      }
    }
  });
});
