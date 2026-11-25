import * as React from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { useDeleteProductFlow } from "./useDeleteProductFlow";
import { DeleteProductConfirm } from "./DeleteProductConfirm";

/**
 * UX audit 2026-11-24 F07: "Product deleted" offered no way back. A delete only switches the product off, so the
 * message now carries Undo, which switches it back on.
 */
const toast = jest.fn();
const del = jest.fn();
const patch = jest.fn();
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
  apiClient: {
    delete: (...a: unknown[]) => del(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

const onRestored = jest.fn();
function Harness() {
  const flow = useDeleteProductFlow({ onRestored });
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
const titled = (title: string) => toast.mock.calls.map((c) => c[0]).find((t) => t.title === title);

async function deleteIt() {
  del.mockResolvedValueOnce({ data: {} });
  mount();
  fireEvent.click(screen.getByRole("button", { name: /Yes, delete/ }));
  await waitFor(() => expect(titled("Product deleted")).toBeTruthy());
  return titled("Product deleted");
}

beforeEach(() => jest.clearAllMocks());

describe("Product deleted: Undo (F07)", () => {
  it("the message carries Undo and stays up long enough to reach it", async () => {
    const t = await deleteIt();
    expect(t.action.label).toBe("Undo");
    expect(t.duration).toBeGreaterThanOrEqual(10_000);
  });

  it("Undo switches the product back on and says so", async () => {
    const t = await deleteIt();
    patch.mockResolvedValueOnce({ data: {} });
    await act(async () => t.action.onClick());
    expect(patch).toHaveBeenCalledWith("/products/p1", { isActive: true });
    await waitFor(() => expect(titled("Product is back")).toBeTruthy());
    expect(onRestored).toHaveBeenCalledWith("p1");
  });

  it("a second Undo click sends no second request", async () => {
    const t = await deleteIt();
    patch.mockResolvedValue({ data: {} });
    await act(async () => {
      t.action.onClick();
      t.action.onClick();
    });
    await waitFor(() => expect(titled("Product is back")).toBeTruthy());
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("when Undo is refused it says where to find the product, with no server text", async () => {
    const t = await deleteIt();
    patch.mockRejectedValueOnce(
      Object.assign(new Error("x"), { response: { status: 409, data: { message: "RAW" } } }),
    );
    await act(async () => t.action.onClick());
    await waitFor(() => expect(titled("Couldn't bring it back")).toBeTruthy());
    const failed = titled("Couldn't bring it back");
    expect(failed.description).toBe("Find it under Inactive in Products and choose Reactivate.");
    expect(failed.variant).toBe("error");
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/RAW/);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("a family deleted together with its variants gets no Undo (the variants would stay off)", async () => {
    del
      .mockRejectedValueOnce(
        Object.assign(new Error("x"), {
          response: { status: 409, data: { code: "FAMILY_HAS_ACTIVE_VARIANTS", variantCount: 2 } },
        }),
      )
      .mockResolvedValueOnce({ data: {} });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Yes, delete/ }));
    await screen.findByText("Delete the variants too?");
    const confirm = screen
      .getAllByRole("button")
      .filter((b) => /delete/i.test(b.textContent ?? ""))
      .pop()!;
    fireEvent.click(confirm);
    await waitFor(() => expect(titled("Product deleted")).toBeTruthy());
    expect(titled("Product deleted").action).toBeUndefined();
  });
});
