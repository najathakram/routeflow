/**
 * ROW 447: signing out wipes every stored unsaved-invoice draft on this browser, and a broken storage never stops the
 * sign-out.
 */
jest.mock("./api-client", () => ({
  apiClient: { post: jest.fn().mockResolvedValue({}), get: jest.fn() },
}));

import { apiClient } from "./api-client";
import { logout } from "./auth";
import { writeLiveCart } from "./counter-live-cart";
import { liveCartKey } from "./counter-live-cart-keys";
import { setImpersonation } from "./impersonation";

describe("logout and unsaved-invoice drafts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("removes every user's draft", async () => {
    window.localStorage.setItem("rf.invoice-draft.v1:acme:u1", "{}");
    window.localStorage.setItem("rf.invoice-draft.v1:acme:u2", "{}");
    window.localStorage.setItem("rf.invoice-draft.v1:globex:u1", "{}");
    await logout();
    expect(
      Object.keys(window.localStorage).filter((k) => k.startsWith("rf.invoice-draft.v1:")),
    ).toEqual([]);
  });

  it("still signs out when draft storage throws", async () => {
    jest.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(logout()).resolves.toBeUndefined();
  });

  it("a support session's logout leaves the real user's draft alone", async () => {
    window.localStorage.setItem("rf.invoice-draft.v1:acme:u1", '{"keep":1}');
    setImpersonation("tok", "acme", "support");
    await logout();
    expect(window.localStorage.getItem("rf.invoice-draft.v1:acme:u1")).toBe('{"keep":1}');
  });

  it("a support session's logout parks nothing in the client's business", async () => {
    const post = apiClient.post as unknown as jest.Mock;
    post.mockClear();
    const payload = Buffer.from(JSON.stringify({ sub: "u1", tenantSlug: "acme" })).toString(
      "base64url",
    );
    window.localStorage.setItem("impersonationToken", `h.${payload}.s`);
    window.localStorage.setItem("impersonationTenantSlug", "acme");
    const key = liveCartKey("acme", "u1")!;
    writeLiveCart(
      key,
      {
        lines: [
          {
            tempId: "t1",
            productId: "p1",
            name: "Cola",
            unitPrice: 2.5,
            qty: 2,
            listPrice: 2.5,
            unit: "each",
            priceType: "STANDARD",
          },
        ],
        customer: null,
        method: "CASH",
        tendered: "",
        reference: "",
        walkIn: true,
      },
      "tab",
    );
    expect(window.localStorage.getItem(key)).not.toBeNull();
    await logout();
    expect(post.mock.calls.filter((c) => /parked/.test(String(c[0])))).toHaveLength(0);
  });
});
