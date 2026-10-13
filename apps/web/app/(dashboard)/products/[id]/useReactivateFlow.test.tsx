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
      <button onClick={() => flow.start("p1", "product", "Cola 12pk")}>go</button>
      <button
        onClick={() => {
          flow.start("p1", "product", "Cola 12pk");
          flow.start("p1", "product", "Cola 12pk");
        }}
      >
        double
      </button>
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
    expect(await screen.findByText(/The SKU "COLA-6" is now used by/)).toBeInTheDocument();
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

  it("Use a new code instead -> PATCH {isActive:true, sku} with NO deactivateHolderIds; success closes + toasts", async () => {
    patch.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ data: {} });
    const done = jest.fn();
    renderWithProviders(<Harness onReactivated={done} />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByRole("button", { name: "Use a new code instead" }));
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "NEW-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith("/products/p1", { isActive: true, sku: "NEW-1" }),
    );
    expect(patch.mock.calls[1][1]).not.toHaveProperty("deactivateHolderIds");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast).toHaveBeenCalledWith({ title: "Product reactivated", variant: "success" });
    expect(done).toHaveBeenCalledWith("p1");
  });

  it("a 409 CODE_TAKEN on a new-code submit keeps the dialog on the new-code step, input kept, inline message, no toast, no holder list", async () => {
    patch.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(
      conflict({
        value: "NEW-1",
        productId: "h9",
        productName: "Taken Meanwhile",
        holders: [
          {
            code: "CODE_TAKEN",
            field: "sku",
            value: "NEW-1",
            productId: "h9",
            productName: "Taken Meanwhile",
          },
        ],
      }),
    );
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByRole("button", { name: "Use a new code instead" }));
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "NEW-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith("/products/p1", { isActive: true, sku: "NEW-1" });
    expect(await screen.findByTestId("reactivate-code-message-sku")).toHaveTextContent(
      "That code is already used by another product.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("New SKU")).toHaveValue("NEW-1");
    expect(screen.getByRole("button", { name: "Reactivate with new code" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Taken Meanwhile" })).toBeNull();
    expect(screen.queryByText(/RAW SERVER MESSAGE/)).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    // editing the input lifts the block; a free code goes through
    patch.mockResolvedValueOnce({ data: {} });
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "FREE-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith("/products/p1", { isActive: true, sku: "FREE-1" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a 409 CODE_TAKEN naming unitSku flags the unit code input only; the SKU input stays clean", async () => {
    const two = conflict({
      holders: [
        { code: "CODE_TAKEN", field: "sku", value: "COLA-6", productId: "h1", productName: "A" },
        {
          code: "CODE_TAKEN",
          field: "unitSku",
          value: "COLA-U",
          productId: "h2",
          productName: "B",
        },
      ],
    });
    patch
      .mockRejectedValueOnce(two)
      .mockRejectedValueOnce(
        conflict({
          field: "unitSku",
          value: "U-2",
          productId: "h9",
          productName: "Z",
          holders: [],
        }),
      );
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByRole("button", { name: "Use a new code instead" }));
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "S-2" } });
    fireEvent.change(screen.getByLabelText("New unit code"), { target: { value: "U-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith("/products/p1", {
      isActive: true,
      sku: "S-2",
      unitSku: "U-2",
    });
    expect(await screen.findByTestId("reactivate-code-message-unitSku")).toHaveTextContent(
      "That code is already used by another product.",
    );
    expect(screen.queryByTestId("reactivate-code-message-sku")).toBeNull();
    expect(screen.getByLabelText("New SKU")).toHaveValue("S-2");
    expect(screen.getByLabelText("New unit code")).toHaveValue("U-2");
    expect(screen.getByRole("button", { name: "Reactivate with new code" })).toBeDisabled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a 409 BARCODE_TAKEN on a new-code submit flags the barcode input (no field in the body), dialog open, no toast", async () => {
    patch
      .mockRejectedValueOnce(
        conflict({
          code: "BARCODE_TAKEN",
          field: "barcode",
          value: "111",
          holders: [
            {
              code: "BARCODE_TAKEN",
              field: "barcode",
              value: "111",
              productId: "h1",
              productName: "Cola 6pk",
            },
          ],
        }),
      )
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: { code: "BARCODE_TAKEN", message: "RAW", barcode: "222", productId: "h9" },
        },
      });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByRole("button", { name: "Use a new code instead" }));
    fireEvent.change(screen.getByLabelText("New barcode"), { target: { value: "222" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("reactivate-code-message-barcode")).toHaveTextContent(
      "That code is already used by another product.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("New barcode")).toHaveValue("222");
    expect(screen.getByRole("button", { name: "Reactivate with new code" })).toBeDisabled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a 409 CODE_TAKEN on a request WITHOUT new codes still opens the holders refusal (unchanged)", async () => {
    patch.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    expect(await screen.findByText(/The SKU "COLA-6" is now used by/)).toBeInTheDocument();
    // a resolve (holder ids, no new codes) refused again with a fresh holder set replaces the list
    fireEvent.click(screen.getByTestId("reactivate-resolve"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1][1]).not.toHaveProperty("newCodes");
    expect(await screen.findByText(/The SKU "COLA-6" is now used by/)).toBeInTheDocument();
    expect(screen.queryByTestId("reactivate-code-message-sku")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a 400 PRODUCT_CODE_IN_USE on a new-code submit keeps the dialog open, input kept, inline message, no toast", async () => {
    patch.mockRejectedValueOnce(conflict()).mockRejectedValueOnce({
      // the server text is deliberately odd: only the code and the field are read
      response: {
        status: 400,
        data: { code: "PRODUCT_CODE_IN_USE", field: "sku", message: "not read" },
      },
    });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(await screen.findByRole("button", { name: "Use a new code instead" }));
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "TAKEN-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("That code is already used by another product."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("New SKU")).toHaveValue("TAKEN-1");
    expect(screen.getByRole("button", { name: "Reactivate with new code" })).toBeDisabled();
    expect(toast).not.toHaveBeenCalled();
    // a different code goes through
    patch.mockResolvedValueOnce({ data: {} });
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "FREE-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith("/products/p1", { isActive: true, sku: "FREE-1" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a double click sends one request", async () => {
    patch.mockResolvedValue({ data: {} });
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByText("double"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledTimes(1);
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
