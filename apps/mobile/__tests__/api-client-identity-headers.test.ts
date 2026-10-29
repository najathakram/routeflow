/**
 * Row 500 (SA-837): every mobile API request names itself, so the API's missing-token warn can tell
 * mobile from web. Mobile also ships as an Expo web export (a browser User-Agent), so this header is the
 * only reliable signal.
 */
jest.mock("react-native", () => ({ Platform: { OS: "web" } }));
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => ({ enqueue: jest.fn(), isOnline: true }) },
}));

import { apiClient } from "../lib/api-client";

function requestFulfilled(): (c: any) => Promise<any> {
  const handlers = (apiClient.interceptors.request as unknown as { handlers: any[] }).handlers;
  return handlers[0]!.fulfilled;
}

describe("mobile api-client identity headers (row 500)", () => {
  beforeAll(() => {
    (global as any).localStorage = { getItem: () => null, setItem: () => undefined };
  });

  it("sends x-client: mobile and an x-app-version on every request", async () => {
    const out = await requestFulfilled()({ headers: {} });
    expect(out.headers["x-client"]).toBe("mobile");
    expect(typeof out.headers["x-app-version"]).toBe("string");
    expect(out.headers["x-app-version"].length).toBeGreaterThan(0);
  });
});
