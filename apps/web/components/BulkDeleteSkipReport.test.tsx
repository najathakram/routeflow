import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BulkDeleteSkipReport } from "./BulkDeleteSkipReport";

/**
 * #3323 fold (b): a bulk delete that refuses some products (a family with active variants, an
 * item with active order items) lists exactly which and why in a dialog the operator can read,
 * instead of burying them in a toast that disappears.
 */
const skipped = [
  {
    id: "f1",
    reason: "Sample Pod has variants that are still active; delete or archive them first",
  },
  { id: "p2", reason: "Cola 6pk has active order items and cannot be deleted" },
];

describe("BulkDeleteSkipReport", () => {
  it("renders nothing when nothing was refused", () => {
    const { container } = render(<BulkDeleteSkipReport skipped={[]} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every refused product with its reason and a count in the title", () => {
    render(<BulkDeleteSkipReport skipped={skipped} onClose={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("2 products were not deleted")).toBeInTheDocument();
    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Sample Pod has variants that are still active");
    expect(items[1]).toHaveTextContent("Cola 6pk has active order items");
    expect(
      within(dialog).getByText(/Everything else in your selection was processed/),
    ).toBeInTheDocument();
  });

  it("uses the singular for one product and closes with Done", () => {
    const onClose = jest.fn();
    render(<BulkDeleteSkipReport skipped={[skipped[0]]} onClose={onClose} />);
    expect(screen.getByText("1 product was not deleted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
