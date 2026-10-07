import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { useDeleteProduct, useBulkDeleteProducts } from "@/lib/api/products";
import { deactivateFailureToast } from "@/lib/product-reactivation-refusal";
import { useReactivateFlow } from "./useReactivateFlow";

/**
 * One failed write = exactly ONE toast (B594 class, #2861 review B1): the REAL global MutationCache
 * handler (app/providers.tsx) around the real flow hook, only the network mocked. The flow's own fixed
 * sentence must not be doubled by the global handler's raw `data.message` toast.
 */
const toast = jest.fn();
const patch = jest.fn();
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
  apiClient: {
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

const fail = (mock: jest.Mock, status: number, data: object) =>
  mock.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );

function Flow() {
  const flow = useReactivateFlow();
  return (
    <>
      <button onClick={() => flow.start("p1")}>reactivate</button>
      <button onClick={() => flow.askDeactivate("p1", "Cola 6pk")}>deactivate</button>
      {flow.dialog}
    </>
  );
}
function Deleter() {
  const del1 = useDeleteProduct();
  const bulk = useBulkDeleteProducts();
  return (
    <>
      <button
        onClick={() =>
          del1
            .mutateAsync("p1")
            .catch((e) => toast(deactivateFailureToast(e, "Failed to delete product")))
        }
      >
        delete
      </button>
      <button
        onClick={() =>
          bulk
            .mutateAsync(["p1"])
            .catch((e) => toast(deactivateFailureToast(e, "Failed to delete products")))
        }
      >
        bulk
      </button>
    </>
  );
}
const mount = (ui: React.ReactNode) => render(<Providers>{ui}</Providers>);
const toasts = () => toast.mock.calls.map((c) => c[0]);

beforeEach(() => jest.clearAllMocks());

describe("one failed write = exactly one toast (real Providers)", () => {
  it("reactivate 409 CODE_TAKEN: the dialog only — no toast at all, no raw message anywhere", async () => {
    fail(patch, 409, {
      code: "CODE_TAKEN",
      message: "RAW SERVER TEXT",
      field: "sku",
      value: "COLA-6",
      productId: "h1",
      productName: "Cola 6pk",
    });
    mount(<Flow />);
    fireEvent.click(screen.getByText("reactivate"));
    expect(await screen.findByText(/The SKU "COLA-6" is now used by/)).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("reactivate 500: exactly ONE toast, the fixed line, never the server text", async () => {
    fail(patch, 500, { message: "SQL exploded" });
    mount(<Flow />);
    fireEvent.click(screen.getByText("reactivate"));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toasts()[0]).toMatchObject({
      title: "Couldn't reactivate this product",
      variant: "error",
    });
    expect(JSON.stringify(toasts())).not.toMatch(/SQL exploded/);
  });

  it("deactivate 409 CODES_CHANGED: exactly ONE toast, the fixed sentence", async () => {
    fail(patch, 409, { code: "CODES_CHANGED", message: "RAW SERVER TEXT" });
    mount(<Flow />);
    fireEvent.click(screen.getByText("deactivate"));
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toasts()[0]).toMatchObject({
      description: "Someone changed this product's codes at the same time. Refresh and try again.",
    });
    expect(JSON.stringify(toasts())).not.toMatch(/RAW SERVER TEXT/);
  });

  it("delete 500 and bulk delete 409 CATALOG_TOO_LARGE: exactly ONE toast each, no raw text", async () => {
    fail(del, 500, { message: "SQL exploded" });
    fail(del, 409, { code: "CATALOG_TOO_LARGE_FOR_CLEAR_ALL", message: "RAW SERVER TEXT" });
    mount(<Deleter />);
    fireEvent.click(screen.getByText("delete"));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("bulk"));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(toasts()[0]).toEqual({ title: "Failed to delete product", variant: "error" });
    expect(toasts()[1]).toMatchObject({
      description: "Too many products to remove at once. Select fewer and try again.",
    });
    expect(JSON.stringify(toasts())).not.toMatch(/SQL exploded|RAW SERVER TEXT/);
  });

  it("READ_ONLY keeps its own global 'read-only' toast and the flow adds no second one", async () => {
    fail(patch, 403, { code: "READ_ONLY", message: "tenant is read only" });
    mount(<Flow />);
    fireEvent.click(screen.getByText("reactivate"));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toasts()[0]).toMatchObject({ title: "Your workspace is read-only" });
  });
});
