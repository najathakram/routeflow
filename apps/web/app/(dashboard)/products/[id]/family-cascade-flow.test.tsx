import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { deactivateFailureToast } from "@/lib/product-reactivation-refusal";
import { getFamilyCascadePrompt } from "@/lib/product-family-cascade";
import { useReactivateFlow } from "./useReactivateFlow";
import { useDeleteProductFlow } from "./useDeleteProductFlow";

/**
 * #3323 fold (a): the web handles the server's new 409s with FIXED copy and a confirm step. The REAL
 * global MutationCache handler (app/providers.tsx) wraps the real flow hooks; only the network is mocked.
 * Never the server message, never an auto-confirmed resend.
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

const RAW = "RAW SERVER TEXT must never show";
const reject = (mock: jest.Mock, status: number, data: object) =>
  mock.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );
const cascade409 = { code: "FAMILY_HAS_ACTIVE_VARIANTS", message: RAW, variantCount: 3 };
const mount = (ui: React.ReactNode) => render(<Providers>{ui}</Providers>);
const toasts = () => toast.mock.calls.map((c) => c[0]);

function Flow() {
  const flow = useReactivateFlow();
  return (
    <>
      <button onClick={() => flow.start("v1", "variant")}>reactivate variant</button>
      <button onClick={() => flow.askDeactivate("f1", "Sample Pod")}>deactivate</button>
      {flow.dialog}
    </>
  );
}
function Deleter() {
  const flow = useDeleteProductFlow({ onDeleted: () => toast({ title: "after-delete" }) });
  return (
    <>
      <button onClick={() => flow.start("f1")}>delete</button>
      {flow.dialog}
    </>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  patch.mockResolvedValue({ data: {} });
  del.mockResolvedValue({ data: {} });
});

describe("getFamilyCascadePrompt (web mirror of the mobile prompt)", () => {
  const err = (status: number, data: unknown) => ({ response: { status, data } });
  it("builds fixed copy that names the variant count, never the server message", () => {
    const p = getFamilyCascadePrompt(err(409, cascade409));
    expect(p).toMatchObject({ variantCount: 3, confirmText: "Deactivate all" });
    expect(p?.body).toContain("3 active variants");
    expect(`${p?.title} ${p?.body}`).not.toContain("RAW");
  });
  it("singular for one, generic when the count is missing, null for anything else", () => {
    expect(
      getFamilyCascadePrompt(err(409, { code: "FAMILY_HAS_ACTIVE_VARIANTS", variantCount: 1 }))
        ?.body,
    ).toContain("1 active variant.");
    expect(
      getFamilyCascadePrompt(err(409, { code: "FAMILY_HAS_ACTIVE_VARIANTS" }))?.body,
    ).toContain("active variants");
    expect(getFamilyCascadePrompt(err(409, { code: "CODE_TAKEN" }))).toBeNull();
    expect(getFamilyCascadePrompt(err(400, { code: "FAMILY_HAS_ACTIVE_VARIANTS" }))).toBeNull();
    expect(getFamilyCascadePrompt(null)).toBeNull();
  });
});

describe("fixed copy for the other new codes", () => {
  const e = (code: string) => ({ response: { status: 409, data: { code, message: RAW } } });
  it("VARIANT_PARENT_INACTIVE and PRODUCT_DELETE_CONFLICT get one fixed sentence each", () => {
    const a = deactivateFailureToast(e("VARIANT_PARENT_INACTIVE"), "Couldn't reactivate");
    expect(a.description).toBe("Turn the family back on first, then reactivate this variant.");
    const b = deactivateFailureToast(e("PRODUCT_DELETE_CONFLICT"), "Failed to delete");
    expect(b.description).toBe(
      "Nothing was deleted because something changed at the same time. Reload and try again.",
    );
    expect(`${a.description} ${b.description}`).not.toContain("RAW");
  });
});

describe("deactivating a family that still has active variants", () => {
  it("asks first; the confirmed resend carries confirmCascade; nothing auto-confirms", async () => {
    mount(<Flow />);
    reject(patch, 409, cascade409);
    fireEvent.click(screen.getByText("deactivate"));
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    // the cascade prompt: fixed copy with the count, not the server message
    expect(await screen.findByText("Deactivate the variants too?")).toBeInTheDocument();
    expect(screen.getByText(/3 active variants/)).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenLastCalledWith("/products/f1", { isActive: false });
    // confirm: the SAME write again, now with confirmCascade
    fireEvent.click(screen.getByRole("button", { name: "Deactivate all" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith("/products/f1", {
      isActive: false,
      confirmCascade: true,
    });
    await waitFor(() => expect(toasts().some((t) => t.title === "Product deactivated")).toBe(true));
  });

  it("cancelling the cascade prompt sends nothing more and shows no error toast", async () => {
    mount(<Flow />);
    reject(patch, 409, cascade409);
    fireEvent.click(screen.getByText("deactivate"));
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await screen.findByText("Deactivate the variants too?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Deactivate the variants too?")).toBeNull());
    expect(patch).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(0);
  });
});

describe("reactivating a variant under an inactive family", () => {
  it("one toast with the fixed line, never the server message", async () => {
    mount(<Flow />);
    reject(patch, 409, { code: "VARIANT_PARENT_INACTIVE", message: RAW });
    fireEvent.click(screen.getByText("reactivate variant"));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({
      title: "Couldn't reactivate this variant",
      description: "Turn the family back on first, then reactivate this variant.",
      variant: "error",
    });
    expect(JSON.stringify(toasts())).not.toContain("RAW");
  });
});

describe("deleting a family that still has active variants", () => {
  it("asks first; the confirmed resend is DELETE ?confirmCascade=true", async () => {
    mount(<Deleter />);
    reject(del, 409, cascade409);
    fireEvent.click(screen.getByText("delete"));
    expect(await screen.findByText("Deactivate the variants too?")).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenLastCalledWith("/products/f1", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Deactivate all" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
    expect(del).toHaveBeenLastCalledWith("/products/f1", { params: { confirmCascade: "true" } });
    await waitFor(() => expect(toasts().some((t) => t.title === "Product deleted")).toBe(true));
    expect(toasts().some((t) => t.title === "after-delete")).toBe(true);
  });

  it("any other failure is one fixed toast and no prompt", async () => {
    mount(<Deleter />);
    reject(del, 409, { code: "PRODUCT_DELETE_CONFLICT", message: RAW });
    fireEvent.click(screen.getByText("delete"));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ title: "Failed to delete product", variant: "error" });
    expect(toasts()[0].description).toContain("Reload and try again");
    expect(screen.queryByText("Deactivate the variants too?")).toBeNull();
    expect(JSON.stringify(toasts())).not.toContain("RAW");
  });
});
