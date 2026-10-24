import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { restrictionRuleKey, useRuleDetail } from "./restrictions-admin";

const get = jest.fn();
jest.mock("../api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
beforeEach(() => jest.clearAllMocks());

describe("useRuleDetail", () => {
  it("GETs the rule; the first page sends no cursor", async () => {
    get.mockResolvedValueOnce({ data: { id: "r1", targets: [], nextCursor: null } });
    const { result } = renderHook(() => useRuleDetail("r1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("/selling-restrictions/r1", { params: undefined });
  });

  it("a later page sends its cursor and lives under the same prefix as the list", async () => {
    get.mockResolvedValueOnce({ data: { id: "r1", targets: [], nextCursor: null } });
    const { result } = renderHook(() => useRuleDetail("r1", "cur2"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("/selling-restrictions/r1", { params: { cursor: "cur2" } });
    expect(restrictionRuleKey("r1", "cur2").slice(0, 1)).toEqual(["selling-restrictions"]);
    expect(restrictionRuleKey("r1")).not.toEqual(restrictionRuleKey("r1", "cur2"));
  });

  it("does not fetch without an id", () => {
    renderHook(() => useRuleDetail(""), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });
});
