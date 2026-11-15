import * as React from "react";
import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
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

/**
 * Inventory pin (class, not instance): the two optimize hooks opt out of the app-wide toast, so EVERY caller owns the failure
 * toast and must build it through `codedToastCopy` (then the generic sentence), never print the raw message. A new caller turns
 * the list red until it is added here and converted.
 */
describe("every caller of the optimize hooks toasts the coded copy", () => {
  const WEB = join(__dirname, "..", "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === ".next") return [];
      const full = join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) ? [full] : [];
    });
  const CALL = /(?<!function )\buse(OptimizeRoute|OptimizeTemplate)\(/;
  const callers = walk(WEB)
    .filter((f) => CALL.test(readFileSync(f, "utf8")))
    .map((f) => relative(WEB, f).split(sep).join("/"))
    .sort();

  it("the callers are exactly these four pages", () => {
    expect(callers).toEqual([
      "app/(dashboard)/deliveries/new/page.tsx",
      "app/(dashboard)/routes/[id]/dispatch/page.tsx",
      "app/(dashboard)/routes/[id]/page.tsx",
      "app/(dashboard)/routes/templates/[id]/page.tsx",
    ]);
  });

  it.each(callers)(
    "%s: each optimize error handler goes through codedToastCopy, not err.message",
    (f) => {
      const src = readFileSync(join(WEB, f), "utf8");
      const calls = [...src.matchAll(/\b(optimizeRoute|optimizeTemplate\.mutate)\(/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        const tail = src.slice(c.index, c.index! + 3000);
        const at = tail.indexOf("onError");
        expect(at).toBeGreaterThan(-1);
        const handler = tail.slice(at, at + 400);
        expect(handler).toContain("codedToastCopy(err)");
        expect(handler).not.toMatch(/description:\s*err\??\.message/);
        // The two-sentence refusal needs time to read: ten seconds, not the 4 s default.
        expect(handler).toContain("duration: LONG_TOAST_MS");
      }
    },
  );
});
