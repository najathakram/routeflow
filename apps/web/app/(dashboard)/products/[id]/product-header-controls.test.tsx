import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProductHeaderControls } from "./ProductHeaderControls";

let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));

const flow = () => ({ start: jest.fn(), askDeactivate: jest.fn(), isPending: false });

function setup(over: { isActive?: boolean } = {}) {
  const reactivateFlow = flow();
  const onDelete = jest.fn().mockResolvedValue(undefined);
  render(
    <ProductHeaderControls
      product={{
        id: "p1",
        name: "Cola 12pk",
        isActive: over.isActive ?? true,
        parentProductId: null,
        kind: "SIMPLE",
      }}
      reactivateFlow={reactivateFlow}
      hasTobaccoAddon={false}
      isTobacco={false}
      tobaccoLoading={false}
      onToggleTobacco={jest.fn()}
      onMakeVariant={jest.fn()}
      onDelete={onDelete}
      deleting={false}
    />,
  );
  return { reactivateFlow, onDelete };
}

beforeEach(() => {
  role = "OPERATOR";
});

describe("ProductHeaderControls (VU-2)", () => {
  it("an inactive product offers Reactivate, never Activate", () => {
    setup({ isActive: false });
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("an active product offers Deactivate", () => {
    setup();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reactivate" })).toBeNull();
  });

  it("Reactivate starts the same flow; Deactivate asks first (unchanged)", () => {
    const a = setup({ isActive: false });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    expect(a.reactivateFlow.start).toHaveBeenCalledWith("p1", "product", "Cola 12pk");
    expect(a.reactivateFlow.askDeactivate).not.toHaveBeenCalled();
  });

  it("Deactivate opens the deactivate confirm path", () => {
    const a = setup();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(a.reactivateFlow.askDeactivate).toHaveBeenCalledWith("p1", "Cola 12pk");
    expect(a.reactivateFlow.start).not.toHaveBeenCalled();
  });

  it("Delete is an OPERATOR control in the lighter danger-outline style", () => {
    setup();
    const del = screen.getByRole("button", { name: "Delete" });
    expect(del.className).toContain("border-danger/40");
    expect(del.className).toContain("text-danger");
    expect(del.className).not.toContain("bg-danger ");
  });

  it.each(["TENANT_ADMIN", "DRIVER", "CUSTOMER", "STAFF"])("Delete is absent for %s", (r) => {
    role = r;
    setup();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("the delete dialog keeps its title and 'Yes, delete', with the new body", async () => {
    const { onDelete } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete product?")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Cola 12pk will be deactivated and hidden from the catalog. Its SKU and barcode are freed, so another product can use them. Order and invoice history is kept. A product on an undelivered order can't be deleted.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
