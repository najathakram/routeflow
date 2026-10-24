import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { localToastForSafeTextRefusal } from "./local-error-toast";

/**
 * B983 (Opus on #3044): the category surfaces render ONLY the formula-led refusal themselves (fixed labelled copy, never the
 * server text) and let every other error reach the global toast once: the #3020 pattern.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const FILES = [
  "components/CategoryFormModal.tsx",
  "components/SubcategoryCombobox.tsx",
  "app/(dashboard)/settings/_components/RegulatedSettingsTab.tsx",
];

describe("category surfaces (B983)", () => {
  it.each(FILES)(
    "%s reads no raw server message and never falls back to its own text for a non-refusal",
    (f) => {
      const src = read(f);
      expect(src).not.toMatch(/response\??\.data\??\.message/);
      expect(src).not.toMatch(/safeTextErrorCopy\([^)]*\)\s*\?\?/);
      expect(src).toContain("safeTextErrorCopy(");
    },
  );

  it("every mutation they own opts out only for the refusal (a predicate, never `true`)", () => {
    const P = "localErrorToast: localToastForSafeTextRefusal";
    const form = read("components/CategoryFormModal.tsx");
    expect(form).toContain(`useCreateTrackedCategory({ ${P} })`);
    expect(form).toContain(`useUpdateTrackedCategory({ ${P} })`);
    const tab = read("app/(dashboard)/settings/_components/RegulatedSettingsTab.tsx");
    for (const h of ["useCreateSubcategory", "useUpdateSubcategory", "useToggleSubcategory"])
      expect(tab).toContain(`${h}({ ${P} })`);
    expect(read("components/SubcategoryCombobox.tsx")).toContain("useCreateSubcategory({");
    for (const f of FILES) expect(read(f)).not.toContain("localErrorToast: true");
  });
});

describe("the hooks carry the meta only when asked", () => {
  jest.mock("@/lib/api-client", () => {
    const fail = () => jest.fn().mockRejectedValue(new Error("x"));
    return {
      __esModule: true,
      default: { post: fail(), patch: fail() },
      apiClient: { post: fail(), patch: fail() },
    };
  });
  const metaOf = async (make: () => { mutate: (v: any, o?: any) => void }) => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(make, { wrapper });
    await act(async () => {
      result.current.mutate(
        { id: "1", data: {}, categoryId: "c", subId: "s", name: "n" },
        { onError: () => undefined },
      );
    });
    return qc.getMutationCache().getAll()[0]?.meta;
  };
  it("create/update category and create/update/toggle subcategory", async () => {
    const api = await import("./api/tracked-categories");
    const o = { localErrorToast: localToastForSafeTextRefusal };
    const on = { localErrorToast: localToastForSafeTextRefusal };
    expect(await metaOf(() => api.useCreateTrackedCategory(o))).toEqual(on);
    expect(await metaOf(() => api.useUpdateTrackedCategory(o))).toEqual(on);
    expect(await metaOf(() => api.useCreateSubcategory(o))).toEqual(on);
    expect(await metaOf(() => api.useUpdateSubcategory(o))).toEqual(on);
    expect(await metaOf(() => api.useToggleSubcategory(o))).toEqual(on);
    expect(await metaOf(() => api.useCreateSubcategory())).toBeUndefined();
  });
});
