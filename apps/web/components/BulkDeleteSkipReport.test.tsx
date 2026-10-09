import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BulkDeleteSkipReport } from "./BulkDeleteSkipReport";

/**
 * #3323 fold (b): a bulk delete that refuses some products (a family with active variants, an
 * item with active order items) lists exactly which and why in a dialog the operator can read,
 * instead of burying them in a toast that disappears.
 */
const RAW = "RAW SERVER TEXT must never show";
const skipped = [
  { id: "f1", code: "FAMILY_HAS_ACTIVE_VARIANTS", reason: RAW },
  { id: "p2", code: "PRODUCT_HAS_ACTIVE_ORDER_ITEMS", reason: RAW },
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
    expect(items[0]).toHaveTextContent(
      "This product still has active variants. Delete or archive its variants first.",
    );
    expect(items[1]).toHaveTextContent(
      "This product has active order items and cannot be deleted.",
    );
    expect(dialog).not.toHaveTextContent("RAW SERVER TEXT");
    expect(
      within(dialog).getByText(/Everything else in your selection was processed/),
    ).toBeInTheDocument();
  });

  it("an unknown or missing code gets one neutral fixed line, never the server text", () => {
    render(
      <BulkDeleteSkipReport
        skipped={[
          { id: "a", code: "SOMETHING_NEW", reason: RAW },
          { id: "b", reason: RAW },
        ]}
        onClose={jest.fn()}
      />,
    );
    const items = within(screen.getByRole("dialog")).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("This product could not be deleted.");
    expect(items[1]).toHaveTextContent("This product could not be deleted.");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("RAW SERVER TEXT");
  });

  it("uses the singular for one product and closes with Done", () => {
    const onClose = jest.fn();
    render(<BulkDeleteSkipReport skipped={[skipped[0]]} onClose={onClose} />);
    expect(screen.getByText("1 product was not deleted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
