import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { useOptimizeRoute, useOptimizeTemplate } from "./routes";

/**
 * UXG B14. A refused optimize raised TWO toasts: the app-wide one ("Some details aren't valid...") and the page's own
 * (the raw server message). The page owns the failure now: both hooks opt out of the app-wide toast, and every page toast
 * reads `codedToastCopy(err) ?? genericToastCopy(err)`. Entry condition: the optimize POST is refused with the coded 400.
 * Red before the fix: the app-wide handler fired for both hooks and the pages printed `err.message`.
 */
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => mockPost(...a), get: jest.fn() },
}));

const CODED = {
  code: API_ERROR_CODES.ROUTE_STOPS_NOT_PLACED,
  message: "We couldn't place these customers on the map: Acme Deli. Check their addresses.",
  count: 1,
  names: ["Acme Deli"],
};

describe.each([
  ["useOptimizeRoute", useOptimizeRoute],
  ["useOptimizeTemplate", useOptimizeTemplate],
])("%s on the coded refusal", (_n, useHook) => {
  it("leaves the app-wide error toast quiet (the page toasts once)", async () => {
    const global = jest.fn();
    const client = queryClientWithGlobalErrorToast(global);
    mockPost.mockRejectedValue(refusal(400, CODED));
    const { result } = renderHook(() => useHook(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => {
      await result.current.mutateAsync("r1").catch(() => undefined);
    });
    expect(global).not.toHaveBeenCalled();
  });
});

describe("every optimize failure toast reads the coded copy", () => {
  const WEB = join(__dirname, "..", "..");
  const read = (f: string) => readFileSync(join(WEB, f), "utf8");
  const READ = "codedToastCopy(err) ?? genericToastCopy(err)";
  it("the run page has one, the new-delivery page two, and none prints err.message", () => {
    const run = read("app/(dashboard)/routes/[id]/page.tsx");
    const nu = read("app/(dashboard)/deliveries/new/page.tsx");
    expect(run.split(READ)).toHaveLength(2);
    expect(nu.split(READ)).toHaveLength(3);
    expect(run).not.toMatch(/Optimization failed",\s*description: err\.message/);
    expect(nu).not.toMatch(/(unavailable|kept in current order)[^]{0,80}description: err.message/);
  });
});
