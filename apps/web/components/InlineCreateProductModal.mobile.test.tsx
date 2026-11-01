import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InlineCreateProductModal } from "./InlineCreateProductModal";

/**
 * SA-1066 F12: at 390 the SKU field takes a full row (it was 111 px beside Unit).
 */
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useCreateProduct: () => ({ mutate: jest.fn(), isPending: false }),
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

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InlineCreateProductModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />
    </QueryClientProvider>,
  );
};

describe("InlineCreateProductModal at 390 (SA-1066)", () => {
  it("R13: the SKU row is one column below sm, two from sm up", () => {
    mount();
    const row = screen.getByText("SKU / Barcode").closest(".grid") as HTMLElement;
    expect(row.className).toMatch(/(^|\s)grid-cols-1(\s|$)/);
    expect(row.className).toMatch(/(^|\s)sm:grid-cols-2(\s|$)/);
    expect(row.className).not.toMatch(/(^|\s)grid-cols-2(\s|$)/);
  });
});
