import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { LowStockDigestToggle } from "./LowStockDigestToggle";

const get = jest.fn();
const patch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("LowStockDigestToggle", () => {
  it("shows a loading state while preferences load", () => {
    get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<LowStockDigestToggle />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("is ON when the preference is absent (opt-out model)", async () => {
    get.mockResolvedValue({ data: {} });
    renderWithProviders(<LowStockDigestToggle />);
    const sw = await screen.findByRole("switch", { name: /low-stock digest/i });
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it('is OFF when the preference is "false"', async () => {
    get.mockResolvedValue({ data: { lowStockDigestEnabled: "false" } });
    renderWithProviders(<LowStockDigestToggle />);
    const sw = await screen.findByRole("switch", { name: /low-stock digest/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it('sends the exact string "false" when toggled off, then a saved toast', async () => {
    get.mockResolvedValue({ data: {} });
    patch.mockResolvedValue({ data: { lowStockDigestEnabled: "false" } });
    renderWithProviders(<LowStockDigestToggle />);
    fireEvent.click(await screen.findByRole("switch", { name: /low-stock digest/i }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/users/me/preferences", {
        lowStockDigestEnabled: "false",
      }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" })),
    );
  });

  it('sends the exact string "true" when toggled back on', async () => {
    get.mockResolvedValue({ data: { lowStockDigestEnabled: "false" } });
    patch.mockResolvedValue({ data: { lowStockDigestEnabled: "true" } });
    renderWithProviders(<LowStockDigestToggle />);
    fireEvent.click(await screen.findByRole("switch", { name: /low-stock digest/i }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/users/me/preferences", {
        lowStockDigestEnabled: "true",
      }),
    );
  });

  it("toasts an error when the save fails", async () => {
    get.mockResolvedValue({ data: {} });
    patch.mockRejectedValue(new Error("boom"));
    renderWithProviders(<LowStockDigestToggle />);
    fireEvent.click(await screen.findByRole("switch", { name: /low-stock digest/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error" })),
    );
  });

  it("shows an error with retry when preferences fail to load", async () => {
    get.mockRejectedValueOnce(new Error("down"));
    renderWithProviders(<LowStockDigestToggle />);
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    get.mockResolvedValue({ data: {} });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("switch")).toBeInTheDocument();
  });
});
