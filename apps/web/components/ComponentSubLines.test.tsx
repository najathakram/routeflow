import * as React from "react";
import { render, screen } from "@testing-library/react";
import { componentSubLineText } from "@routeflow/pricing";
import { ComponentSubLines } from "./ComponentSubLines";

/**
 * #2717 M3 (case 33, L-212, L-225): the sub-lines of a composed (mixed-pack) invoice or order line.
 * Selected by data-testid; the text is the ONE shared componentSubLineText, so web, mobile and the
 * PDF read identically. A legacy line (no components) renders nothing at all.
 */
const comps = [
  {
    componentProductId: "o",
    name: "Oat",
    qty: 24,
    unitSku: null,
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: null,
    position: 1,
  },
  {
    componentProductId: "a",
    name: "Almond",
    qty: 24,
    unitSku: "ALM-1",
    unitBarcode: "036000291452",
    barcodeSymbology: "UPC_A",
    // Prisma sends a Decimal as a STRING today; the component coerces.
    displayUnitPrice4: "0.6250" as unknown as number,
    position: 0,
  },
];

describe("ComponentSubLines", () => {
  it("renders one sub-line per component, in position order, with the shared text", () => {
    render(<ComponentSubLines components={comps} />);
    const rows = screen.getAllByTestId("line-component-sub-line");
    expect(rows.map((r) => r.textContent)).toEqual([
      componentSubLineText({
        name: "Almond",
        qty: 24,
        unitSku: "ALM-1",
        unitBarcode: "036000291452",
        displayUnitPrice4: 0.625,
      }),
      componentSubLineText({
        name: "Oat",
        qty: 24,
        unitSku: null,
        unitBarcode: null,
        displayUnitPrice4: null,
      }),
    ]);
    expect(rows[0].textContent).toContain("$0.63 (included)");
  });

  it("a legacy line (none, empty or missing components) renders nothing", () => {
    for (const c of [undefined, null, []]) {
      const { container, unmount } = render(<ComponentSubLines components={c} />);
      expect(container.innerHTML).toBe("");
      unmount();
    }
    expect(screen.queryByTestId("line-component-sub-line")).toBeNull();
  });
});
