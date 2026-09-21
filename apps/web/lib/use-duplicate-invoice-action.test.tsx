import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { useDuplicateInvoiceAction } from "./use-duplicate-invoice-action";

/**
 * B644 - the invoice page's "Duplicate" used to rebuild each line from { qty, unitPrice } and POST
 * /invoices. A stored qty is in BASE pieces and a boxed line's unitPrice is per BOX, so 6 boxes of 12 at
 * $40 ($240) came back as 72 x $40 = $2,880. It must ask the SERVER to duplicate and send nothing derived
 * from the lines. (The real-Providers proof that the server's refusals are shown is in
 * use-duplicate-invoice-action.surfaces.test.tsx.)
 */

const post = jest.fn();
const push = jest.fn();
const toast = jest.fn();

jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  post.mockResolvedValue({ data: { id: "inv-2", invoiceNumber: "INV-0002" } });
});

describe("useDuplicateInvoiceAction", () => {
  it("MONEY: asks the server to duplicate - POST /invoices/:id/duplicate with NO body, never POST /invoices", async () => {
    const { result } = renderHook(() => useDuplicateInvoiceAction(), { wrapper });
    act(() => result.current.duplicate("inv-1"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    expect(post.mock.calls[0]).toEqual(["/invoices/inv-1/duplicate"]); // exactly one argument: no body
    expect(post.mock.calls.some(([url]) => url === "/invoices")).toBe(false);
  });

  it("MONEY: nothing derived from the invoice's lines is ever sent (no qty / unitPrice / items / boxes)", async () => {
    const { result } = renderHook(() => useDuplicateInvoiceAction(), { wrapper });
    act(() => result.current.duplicate("inv-1"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(JSON.stringify(post.mock.calls)).not.toMatch(
      /qty|unitPrice|items|boxes|pieces|subtotal/,
    );
  });

  it("opens the new DRAFT and says which invoice it made", async () => {
    const { result } = renderHook(() => useDuplicateInvoiceAction(), { wrapper });
    act(() => result.current.duplicate("inv-1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/invoices/inv-2"));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Invoice duplicated",
        description: "New invoice INV-0002 created as a draft.",
        variant: "success",
      }),
    );
  });

  it("a double-click while one duplicate is in flight makes ONE copy", async () => {
    let resolve!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useDuplicateInvoiceAction(), { wrapper });
    act(() => result.current.duplicate("inv-1"));
    await waitFor(() => expect(result.current.isPending).toBe(true));
    act(() => result.current.duplicate("inv-1"));
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ data: { id: "inv-2", invoiceNumber: "INV-0002" } }));
  });

  it.each([
    [
      "an ORDER-LINKED invoice (400)",
      { response: { status: 400, data: { message: "Cannot duplicate an order-linked invoice." } } },
    ],
    [
      "an invoice with a UNIT line (409 UNIT_AWARE_LINE)",
      { response: { status: 409, data: { code: "UNIT_AWARE_LINE", message: "sold by the Case" } } },
    ],
  ])(
    "%s is refused: no navigation and NO local toast (the global handler shows the server's message once)",
    async (_n, err) => {
      post.mockRejectedValue(err);
      const { result } = renderHook(() => useDuplicateInvoiceAction(), { wrapper });
      act(() => result.current.duplicate("inv-1"));
      await waitFor(() => expect(post).toHaveBeenCalled());
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(push).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
    },
  );
});

describe("wiring - the invoice page's Duplicate action goes through the hook, not a client rebuild", () => {
  // The page is too large to render in a spec; this pins the two lines that regressed.
  const page = fs.readFileSync(
    path.join(__dirname, "../app/(dashboard)/invoices/[id]/page.tsx"),
    "utf8",
  );

  it("handleDuplicate calls the server duplicate and no longer builds items from qty/unitPrice", () => {
    expect(page).toContain("const handleDuplicate = () => duplicateInvoice(invoice.id);");
    expect(page).not.toContain("useCreateInvoice");
    const body = page.slice(
      page.indexOf("const handleDuplicate"),
      page.indexOf("const handleUpdateTerms"),
    );
    expect(body).not.toMatch(/qty:\s*Number\(it\.qty\)|unitPrice:\s*Number\(it\.unitPrice\)/);
  });
});
