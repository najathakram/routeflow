import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { useDeleteProductFlow } from "./useDeleteProductFlow";
import { DeleteProductConfirm } from "./DeleteProductConfirm";

/** Row 213 (2): the delete-confirm dialog stays open while the DELETE is in flight, so a second click cannot fire a second DELETE. */
const toast = jest.fn();
const del = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { delete: (...a: unknown[]) => del(...a) },
}));

function Harness() {
  const flow = useDeleteProductFlow();
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <DeleteProductConfirm
        id="p1"
        name="Cola"
        open={open}
        onClose={() => setOpen(false)}
        flow={flow}
      />
      {flow.dialog}
    </>
  );
}
const mount = () =>
  render(
    <Providers>
      <Harness />
    </Providers>,
  );
const yes = () => screen.getByRole("button", { name: /Yes, delete/ });

beforeEach(() => jest.clearAllMocks());

describe("DeleteProductConfirm", () => {
  it("P-15: stays red and opens with focus on Cancel", () => {
    mount();
    expect(yes().className).toMatch(/bg-danger/);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("keeps its title and 'Yes, delete', with the vu-2 body (codes are freed)", () => {
    mount();
    expect(screen.getByText("Delete product?")).toBeInTheDocument();
    expect(yes()).toBeInTheDocument();
    expect(
      screen.getByText(
        /will be deactivated and hidden from the catalog\. Its SKU and barcode are freed, so another product can use them\. Order and invoice history is kept\. A product on an undelivered order can't be deleted\./,
      ),
    ).toBeInTheDocument();
  });

  it("a second click while the DELETE is pending sends exactly one DELETE and keeps the dialog open", async () => {
    let resolve!: (v: unknown) => void;
    del.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    mount();
    fireEvent.click(yes());
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Delete product?")).toBeInTheDocument();
    fireEvent.click(yes());
    expect(del).toHaveBeenCalledTimes(1);
    resolve({ data: {} });
    await waitFor(() => expect(screen.queryByText("Delete product?")).toBeNull());
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("on error the dialog stays open and the failure goes through the toast path", async () => {
    del.mockRejectedValueOnce(
      Object.assign(new Error("x"), { response: { status: 500, data: { message: "RAW" } } }),
    );
    mount();
    fireEvent.click(yes());
    await waitFor(() =>
      expect(toast.mock.calls.some((c) => c[0].title === "Failed to delete product")).toBe(true),
    );
    expect(screen.getByText("Delete product?")).toBeInTheDocument();
  });

  it("hands over to the cascade prompt (confirm dialog closes) on FAMILY_HAS_ACTIVE_VARIANTS", async () => {
    del.mockRejectedValueOnce(
      Object.assign(new Error("x"), {
        response: { status: 409, data: { code: "FAMILY_HAS_ACTIVE_VARIANTS", variantCount: 2 } },
      }),
    );
    mount();
    fireEvent.click(yes());
    expect(await screen.findByText("Delete the variants too?")).toBeInTheDocument();
    expect(screen.queryByText("Delete product?")).toBeNull();
  });
});
