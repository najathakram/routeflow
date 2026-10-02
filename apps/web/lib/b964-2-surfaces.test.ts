import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { groupAssignErrorCopy } from "./group-assign-error-copy";
import { localToastForSafeTextRefusal } from "./local-error-toast";
import { handleMutationError } from "./mutation-error-toast";

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
  it("any other error is NOT ours (null): it reaches the global toast, never a raw message from here", () => {
    expect(
      groupAssignErrorCopy({ response: { status: 500, data: { message: "db down" } } }, products),
    ).toBeNull();
    expect(groupAssignErrorCopy(new Error("boom"), products)).toBeNull();
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

  it("no surface falls back to its OWN sentence for a non-refusal (that would double the global toast)", () => {
    for (const f of [
      "components/VariantSplitModal.tsx",
      "components/BatchItemReviewModal.tsx",
      "components/ProductCreateModal.tsx",
    ])
      expect(read(f)).not.toMatch(/safeTextErrorCopy\([^)]*\)\s*\?\?/);
    expect(read("components/GroupAsVariantsModal.tsx")).not.toContain("Please try again");
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

  it("GroupAsVariantsModal catches the grouping failure (no unhandled rejection)", () => {
    expect(read("components/GroupAsVariantsModal.tsx")).toMatch(
      /try \{\s*result = await bulkAssign\.mutateAsync/,
    );
  });

  it("every mutation surface opts out ONLY for the refusal it renders (a predicate, never `true`)", () => {
    const P = "localErrorToast: localToastForSafeTextRefusal";
    expect(read("components/GroupAsVariantsModal.tsx")).toContain(`useBulkAssignParent({ ${P} })`);
    expect(read("components/ProductCreateModal.tsx")).toContain(`useCreateProduct({ ${P} })`);
    expect(read("components/VariantSplitModal.tsx")).toContain(`useAssignToVariants({ ${P} })`);
    const b = read("components/BatchItemReviewModal.tsx");
    expect(b).toContain(`useUpdateBatchItem({ ${P} })`);
    expect(b).toContain(`useResolveItem({ ${P} })`);
    for (const f of [
      "components/GroupAsVariantsModal.tsx",
      "components/ProductCreateModal.tsx",
      "components/VariantSplitModal.tsx",
      "components/BatchItemReviewModal.tsx",
    ])
      expect(read(f)).not.toContain("localErrorToast: true");
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
    const on = { localErrorToast: localToastForSafeTextRefusal };
    expect(
      await metaOf(() =>
        products.useCreateProduct({ localErrorToast: localToastForSafeTextRefusal }),
      ),
    ).toEqual(on);
    expect(
      await metaOf(() =>
        products.useBulkAssignParent({ localErrorToast: localToastForSafeTextRefusal }),
      ),
    ).toEqual(on);
    expect(
      await metaOf(() =>
        batch.useUpdateBatchItem({ localErrorToast: localToastForSafeTextRefusal }),
      ),
    ).toEqual(on);
    expect(
      await metaOf(() => batch.useResolveItem({ localErrorToast: localToastForSafeTextRefusal })),
    ).toEqual(on);
    const variant = await import("./api/variant-assign");
    expect(
      await metaOf(() =>
        variant.useAssignToVariants({ localErrorToast: localToastForSafeTextRefusal }),
      ),
    ).toEqual(on);
    expect(await metaOf(() => products.useCreateProduct())).toBeUndefined();
  });
});

describe("handleMutationError with a predicate localErrorToast (B964-2)", () => {
  const meta = { localErrorToast: localToastForSafeTextRefusal };
  const run = (e: unknown) => {
    const toast = jest.fn();
    handleMutationError(e, { meta }, toast, { push: jest.fn() });
    return toast;
  };
  it("skips the global toast for the formula-led refusal (the surface renders it)", () => {
    expect(run(refusal("b"))).not.toHaveBeenCalled();
  });
  it("shows the global toast for any other error: exactly once", () => {
    const toast = run({ response: { status: 500, data: { message: "db down" } } });
    expect(toast).toHaveBeenCalledTimes(1);
  });
  it("a read-only tenant still gets 'Choose a plan' (the predicate never hides it)", () => {
    const toast = run({ response: { status: 403, data: { code: "READ_ONLY", message: "x" } } });
    expect(toast.mock.calls[0][0].title).toBe("Your workspace is read-only");
  });
});
