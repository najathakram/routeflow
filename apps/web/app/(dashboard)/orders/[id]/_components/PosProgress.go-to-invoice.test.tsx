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

/**
 * F01 tap area: jsdom has no layout, so this pins the classes. The browser row: the step's button measures 44 x 44 and its
 * pill (the `li`) stays 24 high. Height = 16 line + 2 x 14 padding, taken back by -14 margins; width = min 44, padding 2 taken
 * back by -2 margins.
 */
describe("F01: the step's button is a 44 x 44 tap area that leaves the pill height alone", () => {
  it("carries the 44 px height, the 44 px minimum width, and margins that take the padding back", () => {
    withCard(<PosProgress order={{ invoices: [] } as never} status="CONFIRMED" />);
    const cls = screen.getByRole("button", { name: POS_COPY.stepInvoice }).className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["py-[14px]", "-my-[14px]", "min-w-11"]));
    expect(cls).toEqual(expect.arrayContaining(["px-0.5", "-mx-0.5"]));
  });
});
