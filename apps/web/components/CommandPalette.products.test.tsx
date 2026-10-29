import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

/** W-927: typing a product name or SKU lists matching products beside customers, orders and invoices. */
const mockPush = jest.fn();
const get = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
jest.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true }),
  useDeliveryAccess: () => ({ enabled: true }),
}));
jest.mock("@/lib/api/counter-sale", () => ({ useCounterSaleGate: () => ({ showButton: true }) }));

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
  get.mockReset();
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data: {
        data: url === "/products" ? [{ id: "p1", name: "Cola 12 pack", sku: "COLA-12" }] : [],
      },
    }),
  );
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe("CommandPalette product results (W-927)", () => {
  it("searches products and opens the product page on a click", async () => {
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("palette.placeholder"), {
      target: { value: "cola" },
    });
    await jest.advanceTimersByTimeAsync(400);
    expect(get).toHaveBeenCalledWith("/products", { params: { search: "cola", limit: 4 } });
    fireEvent.click(await screen.findByText("Cola 12 pack"));
    expect(mockPush).toHaveBeenCalledWith("/products/p1");
  });
});
