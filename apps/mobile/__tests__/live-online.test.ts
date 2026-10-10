import { readFileSync } from "fs";
import { join } from "path";
import { DRIVER_CRITICAL_NETWORK_MODE, isLiveOnline } from "../lib/live-online";

// #2265: on the Expo web export the driver's offline states never surfaced — the post-completion
// decision read a render-time `isOnline` (stale), and TanStack's default networkMode "online"
// PAUSED the completion mutation and the invoice fetch offline instead of failing them.

describe("isLiveOnline — either signal saying offline wins (#2265)", () => {
  it.each([
    [true, true, true],
    [true, undefined, true], // NetInfo never wrote: positive-signal-only, counts as online
    [false, true, false], // web: the browser went offline, NetInfo hasn't noticed (the F2 repro)
    [true, false, false], // native: NetInfo says offline
    [false, false, false],
  ])("browser %s, netInfo %s => %s", (browserOnline, netInfoOnline, expected) => {
    expect(isLiveOnline({ browserOnline, netInfoOnline })).toBe(expected);
  });

  it("driver-critical calls fail fast offline instead of pausing", () => {
    expect(DRIVER_CRITICAL_NETWORK_MODE).toBe("always");
  });
});

describe("wiring pins (#2265)", () => {
  const payment = readFileSync(
    join(__dirname, "../app/(driver)/route/stop/[stopId]/payment.tsx"),
    "utf8",
  );
  const routes = readFileSync(join(__dirname, "../lib/api/routes.ts"), "utf8");

  it("the post-delivery offline decision reads connectivity live, not the render-time isOnline", () => {
    const at = payment.indexOf("postDeliveryInvoicePrompt({ invoice: undefined");
    expect(at).toBeGreaterThan(-1);
    // The live read sits right above the decision; the render-time selector is gone entirely.
    const decision = payment.slice(payment.lastIndexOf("isLiveOnline(", at), at + 80);
    expect(decision).toMatch(/onlineManager\.isOnline\(\)/);
    expect(decision).toMatch(/useOfflineQueue\.getState\(\)\.isOnline/);
    expect(decision).toMatch(/postDeliveryInvoicePrompt\(\{ invoice: undefined, online \}\)/);
    expect(payment).not.toMatch(/useOfflineQueue\(\(s\) => s\.isOnline\)/);
  });

  it("the post-completion invoice fetch uses networkMode 'always' so it fails into its fallback", () => {
    const at = payment.indexOf("qc.fetchQuery(");
    expect(at).toBeGreaterThan(-1);
    expect(payment.slice(at, payment.indexOf("})", at))).toMatch(
      /networkMode:\s*DRIVER_CRITICAL_NETWORK_MODE/,
    );
  });

  it("the stop-completion mutation uses networkMode 'always' so offline reaches the queue", () => {
    const at = routes.indexOf("export function useCompleteWithPayment(");
    expect(at).toBeGreaterThan(-1);
    const body = routes.slice(at, routes.indexOf("\n}\n", at));
    expect(body).toMatch(/networkMode:\s*DRIVER_CRITICAL_NETWORK_MODE/);
  });
});
