import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useOnTenantToday } from "./tenant-timezone";

let settle: ((v: { data: { timezone?: string } }) => void) | undefined;
jest.mock("./api-client", () => ({
  apiClient: {
    get: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

/**
 * SA-964 §4: a date field starts EMPTY and is seeded with the tenant's day once, when the zone resolves; the browser's
 * day is never a stand-in. The browser clock here is deliberately a different day (the 24th) from the tenant's (the 26th).
 */
describe("useOnTenantToday", () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date("2026-10-25T20:00:00Z"),
      doNotFake: ["setTimeout", "setInterval", "setImmediate", "nextTick", "queueMicrotask"],
    });
  });
  afterEach(() => jest.useRealTimers());

  it("does not apply anything while the zone is unknown, then applies the tenant's day once", async () => {
    const apply = jest.fn();
    const { result } = renderHook(() => useOnTenantToday(apply), { wrapper });
    expect(apply).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
    await act(async () => settle?.({ data: { timezone: "Pacific/Auckland" } }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith("2026-10-26");
    expect(result.current).toBe("2026-10-26");
  });

  it("a value typed while the zone loaded is kept when the caller seeds only into an empty field", async () => {
    let value = "2026-12-01"; // the user typed this before the zone resolved
    const { result } = renderHook(() => useOnTenantToday((day) => (value = value || day)), {
      wrapper,
    });
    await act(async () => settle?.({ data: { timezone: "Pacific/Auckland" } }));
    await waitFor(() => expect(result.current).toBe("2026-10-26"));
    expect(value).toBe("2026-12-01");
  });

  it("a tenant with no zone configured never seeds (the server stays the authority)", async () => {
    const apply = jest.fn();
    renderHook(() => useOnTenantToday(apply), { wrapper });
    await act(async () => settle?.({ data: {} }));
    expect(apply).not.toHaveBeenCalled();
  });
});
