import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/components/OrderStatusBadge", () => ({ useOrderStatusLabel: () => (s: string) => s }));

import { PosProgress } from "./PosOrderActions";
import { POS_COPY } from "@/lib/pos-copy";

/**
 * SA-1066 F01: the grey Invoice step used to answer a tap with nothing. While no invoice exists it takes
 * you to the Invoice card's Generate Invoice button (scrolled into view, focused). With an invoice the step
 * is a plain label again, and no other step is a control.
 */
const scrollIntoView = jest.fn();
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

const withCard = (ui: React.ReactElement) =>
  render(
    <>
      {ui}
      <button type="button" id="generate-invoice-button">
        Generate Invoice (full order)
      </button>
    </>,
  );

describe("F01: tapping the Invoice step lands on Generate Invoice", () => {
  it("scrolls the card's button into view and focuses it, while no invoice exists", () => {
    withCard(<PosProgress order={{ invoices: [] } as never} status="CONFIRMED" />);
    fireEvent.click(screen.getByRole("button", { name: POS_COPY.stepInvoice }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Generate Invoice/ })).toHaveFocus();
  });

  it("is a plain label once an invoice exists", () => {
    withCard(
      <PosProgress
        order={{ invoices: [{ id: "i1", status: "SENT" }] } as never}
        status="CONFIRMED"
      />,
    );
    expect(screen.queryByRole("button", { name: POS_COPY.stepInvoice })).toBeNull();
  });

  it("makes no other step a control", () => {
    withCard(<PosProgress order={{ invoices: [] } as never} status="CONFIRMED" />);
    expect(
      screen.getAllByRole("button").filter((b) => b.id !== "generate-invoice-button"),
    ).toHaveLength(1);
  });
});
