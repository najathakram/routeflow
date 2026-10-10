import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * B1215: every mutation that changes WHICH products exist or which are sellable (family create /
 * variant edit, activate / deactivate / update, bulk group-as-variants, import resolution) must
 * refresh the whole product set through the shared `invalidateProductSet` - ["products"] AND the
 * stock views keyed ["inventory"] - so a changed catalog never leaves a stale stock table or
 * picker behind.
 */

jest.mock("../api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

import {
  useUpdateProduct,
  useReactivateProduct,
  useDeactivateProduct,
  useBulkAssignParent,
} from "./products";
import { useCreateFamily, useUpdateFamilyVariants } from "./product-families";
import { useCreateVariant, useCreateBrandNew, useCompleteSetup } from "./import-resolution";
import { useAssignToVariants } from "./variant-assign";

function setup<T>(useHook: () => T) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const spy = jest.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useHook, { wrapper });
  const keys = () =>
    spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  return { result, keys };
}

async function run(mutate: () => Promise<unknown>) {
  await act(async () => {
    await mutate();
  });
}

describe("product mutation hooks refresh the whole product set (products + inventory)", () => {
  it.each([
    [
      "useUpdateProduct",
      () => useUpdateProduct(),
      (r: any) => r.mutateAsync({ id: "p1", name: "x" }),
    ],
    ["useReactivateProduct", () => useReactivateProduct(), (r: any) => r.mutateAsync({ id: "p1" })],
    ["useDeactivateProduct", () => useDeactivateProduct(), (r: any) => r.mutateAsync("p1")],
    [
      "useBulkAssignParent",
      () => useBulkAssignParent(),
      (r: any) =>
        r.mutateAsync({ parentProductId: "f1", assignments: [{ id: "p1", variantName: "Mint" }] }),
    ],
    [
      "useCreateFamily",
      () => useCreateFamily(),
      (r: any) => r.mutateAsync({ name: "Sample Pod", variants: [] }),
    ],
    [
      "useUpdateFamilyVariants",
      () => useUpdateFamilyVariants("f1"),
      (r: any) => r.mutateAsync({ variants: [] }),
    ],
    [
      "useCreateVariant",
      () => useCreateVariant(),
      (r: any) => r.mutateAsync({ parentProductId: "f1", variantName: "Mint" }),
    ],
    ["useCreateBrandNew", () => useCreateBrandNew(), (r: any) => r.mutateAsync({ name: "Sample" })],
    [
      "useAssignToVariants",
      () => useAssignToVariants(),
      (r: any) => r.mutateAsync({ parentProductId: "f1", assignments: [] }),
    ],
    [
      "useCompleteSetup",
      () => useCompleteSetup(),
      (r: any) => r.mutateAsync({ id: "p1", data: {} }),
    ],
  ])("%s invalidates ['products'] and ['inventory']", async (_name, hook, call) => {
    const { result, keys } = setup(hook as () => any);
    await run(() => call(result.current));
    expect(keys()).toEqual(
      expect.arrayContaining([JSON.stringify(["products"]), JSON.stringify(["inventory"])]),
    );
  });
});
