import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { EditTaxLabel } from "./EditTaxLabel";

/** Row 329a: the edit panel's Tax label reads the tenant's configured rate from GET /settings and the order's invoice line rates. */
const get = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const order = (over: Record<string, unknown> = {}) => ({
  subtotal: 100,
  tax: 8.25,
  invoices: [{ status: "SENT", items: [{ taxRate: "0.0825" }] }],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: { taxRate: 8.25 } });
});

describe("EditTaxLabel", () => {
  it("names the exact stored rate once the configured rate corroborates it: Tax (8.25%), not Tax (8%)", async () => {
    renderWithProviders(<EditTaxLabel order={order() as never} />);
    await waitFor(() =>
      expect(screen.getByTestId("edit-tax-label")).toHaveTextContent("Tax (8.25%)"),
    );
    expect(screen.getByTestId("edit-tax-label")).not.toHaveTextContent("(8%)");
  });

  it("reads plain Tax while the settings are still loading, even with a stored rate on file", async () => {
    get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<EditTaxLabel order={order() as never} />);
    expect(screen.getByTestId("edit-tax-label")).toHaveTextContent(/^Tax$/);
  });

  it("an order with no stored rate is plain Tax even though its tax divides out to 8.25%", async () => {
    renderWithProviders(<EditTaxLabel order={order({ invoices: [] }) as never} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByTestId("edit-tax-label")).toHaveTextContent(/^Tax$/);
  });

  it("an order read that carries no invoices at all (a buyer or an older server) is plain Tax", async () => {
    const { invoices: _omitted, ...bare } = order() as Record<string, unknown>;
    renderWithProviders(<EditTaxLabel order={bare as never} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByTestId("edit-tax-label")).toHaveTextContent(/^Tax$/);
  });
});
