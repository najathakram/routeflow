import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";

/**
 * B964-1 (lead Opus on #3010): three surfaces showed the RAW server message for a refused formula-led address / license number /
 * buyer name. Each must use the fixed copy first (`safeTextErrorCopy(err) ?? <fixed sentence>`), never `response.data.message`, and the
 * two mutation surfaces must opt out of the app-wide error toast (`localErrorToast`) so a failure is shown ONCE.
 * The pages are too large to render per case, so the handlers are pinned at source level (the fixed-copy behaviour itself is covered
 * by safe-text-error-copy.test.ts and the CustomerFormModal / register / mutation-error-toast specs).
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const region = (src: string, start: string, len = 1800) => {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, i + len);
};

describe("customers/[id] handleSaveAddress", () => {
  const src = read("app/(dashboard)/customers/[id]/page.tsx");
  const start = src.indexOf("const handleSaveAddress");
  const handler = src.slice(start, src.indexOf("const handleSetPrimaryAddress", start));
  it("shows safeTextErrorCopy(err) first with a FIXED fallback, never the raw server message", () => {
    expect(handler).toContain("safeTextErrorCopy(err)");
    expect(handler).not.toMatch(/response\??\.data\??\.message/);
  });
  it("the two address mutations opt out of the global error toast (no double toast)", () => {
    expect(src).toContain("useAddCustomerAddress({ localErrorToast: true })");
    expect(src).toContain("useUpdateCustomerAddress({ localErrorToast: true })");
  });
});

describe("buyer portal licenses page", () => {
  const src = read("app/buyer/portal/[seller]/licenses/page.tsx");
  const onError = region(src, "onError: (err: unknown)", 600);
  it("uses safeTextErrorCopy(err) then a fixed sentence, never the raw server message", () => {
    expect(onError).toContain("safeTextErrorCopy(err)");
    expect(onError).not.toMatch(/response\??\.data\??\.message/);
  });
  it("opts out of the global error toast", () => {
    expect(src).toContain("useSubmitBuyerAuthorization({ localErrorToast: true })");
  });
});

describe("platform-admin buyers/[id] save", () => {
  const src = read("app/(platform-admin)/admin/buyers/[id]/page.tsx");
  const catchBlock = region(src, "} catch (err", 400);
  it("uses safeTextErrorCopy(err) then a fixed sentence, never the raw server message", () => {
    expect(catchBlock).toContain("safeTextErrorCopy(err)");
    expect(catchBlock).not.toMatch(/response\??\.data\??\.message/);
  });
});

describe("the mutation hooks carry the localErrorToast meta when asked", () => {
  jest.mock("@/lib/api-client", () => ({
    __esModule: true,
    default: { post: jest.fn().mockRejectedValue(new Error("boom")), patch: jest.fn() },
    apiClient: { post: jest.fn().mockRejectedValue(new Error("boom")), patch: jest.fn() },
  }));

  const run = async (make: () => { mutate: (v: any, o?: any) => void }) => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(make, { wrapper });
    await act(async () => {
      result.current.mutate({ id: "c1", addrId: "a1" }, { onError: () => undefined });
    });
    return qc.getMutationCache().getAll()[0]?.meta;
  };

  it("useAddCustomerAddress / useUpdateCustomerAddress", async () => {
    const { useAddCustomerAddress, useUpdateCustomerAddress } = await import("./api/customers");
    expect(await run(() => useAddCustomerAddress({ localErrorToast: true }))).toEqual({
      localErrorToast: true,
    });
    expect(await run(() => useUpdateCustomerAddress({ localErrorToast: true }))).toEqual({
      localErrorToast: true,
    });
    expect(await run(() => useAddCustomerAddress())).toBeUndefined();
  });

  it("useSubmitBuyerAuthorization", async () => {
    const { useSubmitBuyerAuthorization } = await import("./api/buyer");
    expect(await run(() => useSubmitBuyerAuthorization({ localErrorToast: true }))).toEqual({
      localErrorToast: true,
    });
  });
});
