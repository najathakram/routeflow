import * as React from "react";
import { render, screen } from "@testing-library/react";
import { componentSubLineText } from "@routeflow/pricing";
import { LineItemRowReadOnly } from "./LineItemRowReadOnly";
import { lineRowProps } from "@/app/(dashboard)/orders/[id]/_components/OrderLineItemCards";
import type { OrderItem } from "@/lib/api/orders";

/**
 * #2717 M3 (case 33): the order detail's line row prints the composed line's sub-lines through the
 * ONE shared component + text helper; a legacy line prints none. Selected by data-testid (L-212).
 */
const base = {
  displayName: "Mixed Pack",
  unitPrice: 30,
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  subtotal: 60,
};
const comp = (id: string, name: string, position: number) => ({
  componentProductId: id,
  name,
  qty: 24,
  unitSku: `SKU-${id}`,
  unitBarcode: null,
  barcodeSymbology: null,
  displayUnitPrice4: 1.25,
  position,
});

describe("LineItemRowReadOnly sub-lines", () => {
  it("renders one sub-line per component with the shared text", () => {
    render(
      <ul>
        <LineItemRowReadOnly {...base} components={[comp("a", "Almond", 0), comp("o", "Oat", 1)]} />
      </ul>,
    );
    const rows = screen.getAllByTestId("line-component-sub-line");
    expect(rows[0].textContent).toBe(
      componentSubLineText({ name: "Almond", qty: 24, unitSku: "SKU-a", displayUnitPrice4: 1.25 }),
    );
    expect(rows).toHaveLength(2);
  });

  it("a legacy line renders no sub-lines", () => {
    render(
      <ul>
        <LineItemRowReadOnly {...base} />
      </ul>,
    );
    expect(screen.queryByTestId("line-component-sub-line")).toBeNull();
  });

  it("lineRowProps passes an order line's components through, and null for a plain line", () => {
    const withC = {
      id: "l1",
      productId: "p",
      status: "PENDING",
      ...base,
      components: [comp("a", "Almond", 0)],
    };
    expect(lineRowProps(withC as unknown as OrderItem, "PENDING").components).toHaveLength(1);
    const plain = { id: "l2", productId: "p", status: "PENDING", ...base };
    expect(lineRowProps(plain as unknown as OrderItem, "PENDING").components).toBeNull();
  });
});
