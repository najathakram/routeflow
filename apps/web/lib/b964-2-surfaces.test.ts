import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { groupAssignErrorCopy } from "./group-assign-error-copy";

/**
 * B964-2 (lead Opus on #3020): the four product surfaces that showed a raw server / axios message for a
 * refused formula-led product or variant name now show FIXED copy, once, and the grouping modal names
 * the offending product. Source-level pins are per file; the weak file-by-file scan is B986's job.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const refusal = (productId: string, field = "variantName") => ({
  response: {
    status: 400,
    data: {
      code: "TEXT_CELL_FORMULA_LEAD",
      field,
      index: 1,
      productId,
      message: "variantName must not start with = + - @ or a tab/line break",
    },
  },
});

describe("groupAssignErrorCopy", () => {
  const products = [
    { id: "a", name: "Mango 5ct" },
    { id: "b", name: "Lime 5ct" },
  ];
  it("names the offending product with the fixed refusal copy", () => {
    expect(groupAssignErrorCopy(refusal("b"), products)).toBe(
      "Lime 5ct: Variant name can't start with =, +, -, @ or a tab/line break. Nothing was grouped.",
    );
  });
  it("an unknown productId still shows the fixed copy, without a name", () => {
    expect(groupAssignErrorCopy(refusal("zzz"), products)).toBe(
      "Variant name can't start with =, +, -, @ or a tab/line break. Nothing was grouped.",
    );
  });
  it("any other error is a fixed sentence, never the server text", () => {
    expect(
      groupAssignErrorCopy({ response: { status: 500, data: { message: "db down" } } }, products),
    ).toBe("Couldn't group these products. Please try again.");
    expect(groupAssignErrorCopy(new Error("boom"), products)).toBe(
      "Couldn't group these products. Please try again.",
    );
  });
});

describe("the four surfaces", () => {
  it.each([
    ["components/VariantSplitModal.tsx"],
    ["components/BatchItemReviewModal.tsx"],
    ["components/ProductCreateModal.tsx"],
    ["components/GroupAsVariantsModal.tsx"],
  ])("%s never reads a raw response message or err.message into a toast", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/response\??\.data\??\.message/);
    expect(src).not.toMatch(/\b(?:err|e|error)\??\.message/);
  });

  it("they use the shared safe copy", () => {
    for (const f of [
      "components/VariantSplitModal.tsx",
      "components/BatchItemReviewModal.tsx",
      "components/ProductCreateModal.tsx",
    ])
      expect(read(f)).toContain("safeTextErrorCopy(");
    expect(read("components/GroupAsVariantsModal.tsx")).toContain("groupAssignErrorCopy(");
  });

  it("GroupAsVariantsModal catches the grouping failure (no unhandled rejection) and opts out of the global toast", () => {
    const src = read("components/GroupAsVariantsModal.tsx");
    expect(src).toMatch(/try \{\s*result = await bulkAssign\.mutateAsync/);
    expect(src).toContain("useBulkAssignParent({ localErrorToast: true })");
  });

  it("the other two mutation surfaces opt out so a failure shows once", () => {
    expect(read("components/ProductCreateModal.tsx")).toContain(
      "useCreateProduct({ localErrorToast: true })",
    );
    const b = read("components/BatchItemReviewModal.tsx");
    expect(b).toContain("useUpdateBatchItem({ localErrorToast: true })");
    expect(b).toContain("useResolveItem({ localErrorToast: true })");
  });
});

describe("the hooks carry meta.localErrorToast only when asked", () => {
  jest.mock("@/lib/api-client", () => ({
    __esModule: true,
    default: {
      post: jest.fn().mockRejectedValue(new Error("x")),
      patch: jest.fn().mockRejectedValue(new Error("x")),
    },
    apiClient: {
      post: jest.fn().mockRejectedValue(new Error("x")),
      patch: jest.fn().mockRejectedValue(new Error("x")),
    },
  }));
  const metaOf = async (make: () => { mutate: (v: any, o?: any) => void }) => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(make, { wrapper });
    await act(async () => {
      result.current.mutate(
        { batchId: "b", itemId: "i", parentProductId: "p", assignments: [] },
        { onError: () => undefined },
      );
    });
    return qc.getMutationCache().getAll()[0]?.meta;
  };
  it("useCreateProduct / useBulkAssignParent / useUpdateBatchItem / useResolveItem", async () => {
    const products = await import("./api/products");
    const batch = await import("./api/batch-import");
    const on = { localErrorToast: true };
    expect(await metaOf(() => products.useCreateProduct({ localErrorToast: true }))).toEqual(on);
    expect(await metaOf(() => products.useBulkAssignParent({ localErrorToast: true }))).toEqual(on);
    expect(await metaOf(() => batch.useUpdateBatchItem({ localErrorToast: true }))).toEqual(on);
    expect(await metaOf(() => batch.useResolveItem({ localErrorToast: true }))).toEqual(on);
    expect(await metaOf(() => products.useCreateProduct())).toBeUndefined();
  });
});
