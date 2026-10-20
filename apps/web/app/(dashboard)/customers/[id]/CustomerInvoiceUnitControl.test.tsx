import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CustomerInvoiceUnitControl } from "./CustomerInvoiceUnitControl";

/** Staff-only per-customer "Invoice in" choice (SA-827 G7); same inline-edit as payment terms. */
const mutate = jest.fn();
const toast = jest.fn();
let pending = false;

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useUpdateCustomer: () => ({ mutate, isPending: pending }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const select = () => screen.getByLabelText("Invoice in") as HTMLSelectElement;

describe("CustomerInvoiceUnitControl", () => {
  beforeEach(() => {
    mutate.mockReset();
    toast.mockReset();
    pending = false;
  });

  it("renders the current value and the three options in order", () => {
    renderWithProviders(<CustomerInvoiceUnitControl customerId="c1" value="PIECES" />);
    expect(select().value).toBe("PIECES");
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual([
      "Default",
      "Pieces",
      "Packs",
    ]);
    expect(screen.getByText("Mixed boxes list each item; boxes show their pieces.")).toBeTruthy();
  });

  it("treats a missing value as Default", () => {
    renderWithProviders(<CustomerInvoiceUnitControl customerId="c1" />);
    expect(select().value).toBe("LEGACY");
    expect(screen.getByText("Follows the product and business setting.")).toBeTruthy();
  });

  it("selecting Pieces saves { id, invoiceUnitDefault: 'PIECES' }", () => {
    renderWithProviders(<CustomerInvoiceUnitControl customerId="c1" value="LEGACY" />);
    fireEvent.change(select(), { target: { value: "PIECES" } });
    expect(mutate).toHaveBeenCalledWith(
      { id: "c1", invoiceUnitDefault: "PIECES" },
      expect.any(Object),
    );
  });

  it("is disabled while saving", () => {
    pending = true;
    renderWithProviders(<CustomerInvoiceUnitControl customerId="c1" value="LEGACY" />);
    expect(select().disabled).toBe(true);
  });

  it("shows the error toast when the save fails", () => {
    renderWithProviders(<CustomerInvoiceUnitControl customerId="c1" value="LEGACY" />);
    fireEvent.change(select(), { target: { value: "PACK" } });
    const opts = mutate.mock.calls[0][1];
    opts.onError({ response: { data: { message: "nope" } } });
    expect(toast).toHaveBeenCalledWith({
      title: "Couldn't save invoice unit",
      description: "nope",
      variant: "error",
    });
  });

  it("non-operator sees the read-only label and hint, no select", () => {
    renderWithProviders(
      <CustomerInvoiceUnitControl customerId="c1" value="PIECES" canEdit={false} />,
    );
    expect(screen.getByText("Invoice in")).toBeTruthy();
    expect(screen.getByText("Pieces")).toBeTruthy();
    expect(screen.getByText("Mixed boxes list each item; boxes show their pieces.")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("non-operator with no value reads Default", () => {
    renderWithProviders(<CustomerInvoiceUnitControl customerId="c1" canEdit={false} />);
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("tolerates a non-axios error without throwing", () => {
    renderWithProviders(<CustomerInvoiceUnitControl customerId="c1" value="LEGACY" />);
    fireEvent.change(select(), { target: { value: "PACK" } });
    mutate.mock.calls[0][1].onError(new Error("boom"));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: "" }));
  });
});
