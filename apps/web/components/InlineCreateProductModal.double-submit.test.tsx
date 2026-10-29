import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InlineCreateProductModal } from "./InlineCreateProductModal";

/**
 * I-79: a double-click on "Create product" sent two POSTs, and the second came back 409 "already exists".
 * The button's `loading` only disables it after React re-renders, so a second click in the same frame still
 * submits. Create is one request per attempt: a second submit while the first is unsettled is dropped, and a
 * failed attempt frees the form for a retry.
 */
const createMutate = jest.fn();
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useCreateProduct: () => ({ mutate: createMutate, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  useProductCategories: () => ({ data: [] }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), post: jest.fn() },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InlineCreateProductModal
        isOpen
        onClose={jest.fn()}
        onCreated={jest.fn()}
        initialName="Widget"
      />
    </QueryClientProvider>,
  );
}

// The real form needs a Unit, and jsdom's constraint check would block a click on an empty one; two submit
// events are what a fast double-click produces once the form is valid.
const submitForm = () =>
  fireEvent.submit(screen.getByRole("button", { name: /create product/i }).closest("form")!);

beforeEach(() => createMutate.mockReset());

describe("I-79: inline product create sends one request per attempt", () => {
  it("a double-click while the first create is in flight sends one create", () => {
    mount();
    submitForm();
    submitForm();
    expect(createMutate).toHaveBeenCalledTimes(1);
  });

  it("after a failed create, the next click retries", () => {
    createMutate.mockImplementationOnce(
      (_p: unknown, o?: { onError?: (e: unknown) => void; onSettled?: () => void }) => {
        o?.onError?.(new Error("network"));
        o?.onSettled?.();
      },
    );
    mount();
    submitForm();
    submitForm();
    expect(createMutate).toHaveBeenCalledTimes(2);
  });
});
