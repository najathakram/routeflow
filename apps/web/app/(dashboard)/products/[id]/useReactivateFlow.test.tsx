import * as React from "react";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { useReactivateFlow } from "./useReactivateFlow";

const toast = jest.fn();
const patch = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { patch: (...a: unknown[]) => patch(...a) },
}));

const conflict = (extra: Record<string, unknown> = {}) => ({
  response: {
    status: 409,
    data: {
      code: "CODE_TAKEN",
      message: "RAW SERVER MESSAGE",
      field: "sku",
      value: "COLA-6",
      productId: "h1",
      productName: "Cola 6pk",
      holders: [
        {
          code: "CODE_TAKEN",
          field: "sku",
          value: "COLA-6",
          productId: "h1",
          productName: "Cola 6pk",
        },
      ],
      ...extra,
    },
  },
});

function Harness({ onReactivated }: { onReactivated?: (id: string) => void }) {
  const flow = useReactivateFlow({ onReactivated });
  return (
    <>
      <button onClick={() => flow.start("p1")}>go</button>
      <button onClick={() => flow.askDeactivate("p1", "Cola 6pk")}>off</button>
      {flow.dialog}
    </>
  );
}

beforeEach(() => jest.clearAllMocks());

describe("useReactivateFlow", () => {
  it("plain success: PATCH {isActive:true}, toast, callback, no dialog", async () => {
    patch.mockResolvedValue({ data: {} });
    const done = jest.fn();
    renderWithProviders(<Harness onReactivated={done} />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(done).toHaveBeenCalledWith("p1"));
    expect(patch).toHaveBeenCalledWith("/products/p1", { isActive: true });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("CODE_TAKEN 409 opens the dialog (approved copy, never the raw message); resolve resends with the holder ids", async () => {
    patch.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ data: {} });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    expect(await screen.findByText(/Can't reactivate: the SKU "COLA-6"/)).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER MESSAGE/)).toBeNull();
    fireEvent.click(screen.getByText('Deactivate "Cola 6pk" and reactivate this'));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith("/products/p1", {
        isActive: true,
        deactivateHolderIds: ["h1"],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("HOLDERS_CHANGED on a resolve -> retry prompt; Try again sends a PLAIN reactivation", async () => {
    patch
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce({
        response: { status: 409, data: { code: "HOLDERS_CHANGED", message: "x", holders: [] } },
      })
      .mockResolvedValueOnce({ data: {} });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByTestId("reactivate-resolve"));
    fireEvent.click(await screen.findByText("Try again"));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("/products/p1", { isActive: true }));
  });

  it("any other failure -> a generic toast with no server text and no dialog", async () => {
    patch.mockRejectedValue({ response: { status: 500, data: { message: "SQL exploded" } } });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error" })),
    );
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/SQL exploded/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("useReactivateFlow — Deactivate confirm (moved out of the page, #2861)", () => {
  it("asks first; Cancel sends nothing; Deactivate PATCHes {isActive:false} and toasts", async () => {
    patch.mockResolvedValue({ data: {} });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("off"));
    expect(await screen.findByText(/Cola 6pk will be hidden from the catalog/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("off"));
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/products/p1", { isActive: false }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Product deactivated" })),
    );
  });

  it("CODES_CHANGED on deactivate -> the fixed sentence; CATALOG_TOO_LARGE is not special here; raw text never shown", async () => {
    patch.mockRejectedValue({
      response: { status: 409, data: { code: "CODES_CHANGED", message: "RAW SERVER TEXT" } },
    });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("off"));
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: "Couldn't deactivate this product",
        description:
          "Someone changed this product's codes at the same time. Refresh and try again.",
        variant: "error",
      }),
    );
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/RAW SERVER TEXT/);
  });
});
