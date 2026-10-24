import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { PriceEditRow } from "./price-edit-row";

/**
 * Order edit: the price-history button sits beside the "Unit price" input and "Use this price" goes
 * through the SAME path as typing (commitPrice -> onPriceChange), so a SPECIAL line still asks for
 * its reason and the margin-floor hint still keys off the resulting price.
 */

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const history = {
  customerId: "cust-1",
  customerName: "Acme Foods",
  productId: "prod-1",
  productName: "Sample Cola 24pk",
  unitHint: "case",
};

function Harness({
  isSpecial = true,
  withHistory = true,
}: {
  isSpecial?: boolean;
  withHistory?: boolean;
}) {
  const [price, setPrice] = React.useState(10);
  return (
    <PriceEditRow
      basePrice={12}
      unitPrice={price}
      originalUnitPrice={10}
      onPriceChange={setPrice}
      onReasonChange={() => {}}
      isSpecial={isSpecial}
      history={withHistory ? history : undefined}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({
    data: {
      customerId: "cust-1",
      customerName: "Acme Foods",
      productId: "prod-1",
      productName: "Sample Cola 24pk",
      costVisible: false,
      rows: [
        {
          date: "2026-09-20T00:00:00.000Z",
          source: "INVOICE",
          unitPrice: 13.5,
          unitLabel: "case",
          unitsPerBox: 24,
          qty: 2,
          boxes: 2,
          pieces: 0,
          avgCostAtSale: null,
          invoiceId: "inv-1",
          invoiceNumber: "INV-0001",
          orderId: "ord-1",
          orderNumber: "ORD-0001",
          priceType: null,
        },
      ],
      summaries: [
        { unitLabel: "case", last: 13.5, low: 13.5, high: 13.5, qtySold: 2, currentAvgCost: null },
      ],
    },
  });
});

describe("PriceEditRow price history (order edit)", () => {
  it("has the button beside Unit price, and none when there is no history prop", () => {
    const { unmount } = renderWithProviders(<Harness />);
    expect(screen.getByRole("button", { name: "Price history" })).toBeEnabled();
    unmount();
    renderWithProviders(<Harness withHistory={false} />);
    expect(screen.queryByRole("button", { name: "Price history" })).not.toBeInTheDocument();
  });

  it("opening and closing leaves the price alone; Use this price changes it through the normal path (reason now required)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const input = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    expect(input.value).toBe("10.00");

    await user.click(screen.getByRole("button", { name: "Price history" }));
    await screen.findByRole("dialog", { name: "Price history" });
    await user.keyboard("{Escape}");
    expect(input.value).toBe("10.00");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Price history" })).toHaveFocus(),
    );
    expect(screen.queryByPlaceholderText("reason (required)")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    await user.click(within(dialog).getByRole("button", { name: "Use this price ($13.50)" }));
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("13.50");
    // the SPECIAL line's existing rule: a changed price needs a documented reason
    expect(screen.getByPlaceholderText("reason (required)")).toBeRequired();
  });
});
