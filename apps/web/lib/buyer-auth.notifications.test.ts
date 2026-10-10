/**
 * #2142 N2 — the buyer bell's local copy dies with the buyer's session.
 *
 * The notification bell kept every order / invoice / credit-note notice in one localStorage slot
 * that no logout cleared, so the next buyer on the same browser opened the previous buyer's
 * list. `buyerLogout` now removes every bell slot (the per-buyer ones and the old shared one),
 * and `getStoredBuyerId` is the identity the bell is keyed by.
 *
 * Fixtures are placeholders.
 */
import axios from "axios";
import { BUYER_KEYS } from "./auth-keys";
import { buyerLogout, buyerNotificationsKey, getStoredBuyerId } from "./buyer-auth";

jest.mock("axios", () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockedPost = axios.post as jest.Mock;

function buyerJwt(payload: Record<string, unknown>) {
  const part = (o: object) => btoa(JSON.stringify(o));
  return [part({ alg: "HS256", typ: "JWT" }), part(payload), "sig"].join(".");
}

beforeEach(() => {
  localStorage.clear();
  mockedPost.mockReset();
  mockedPost.mockResolvedValue({ data: {} });
});

describe("buyerLogout — clears the bell (#2142 N2)", () => {
  it("#2142 N2: removes every bell slot, and nothing that is not the buyer's", async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt({ sub: "buyer-a", type: "BUYER" }));
    localStorage.setItem(buyerNotificationsKey("buyer-a", "t-1"), "[]");
    localStorage.setItem(buyerNotificationsKey("buyer-b", "t-1"), "[]");
    localStorage.setItem("rf_buyer_notifications", "[]"); // the pre-#2142 shared slot
    localStorage.setItem("rf_buyer_notifications:buyer-a", "[]"); // the per-buyer-only slot
    localStorage.setItem("rf:op:accessToken", "staff-token"); // another portal's session

    await buyerLogout();

    expect(Object.keys(localStorage).filter((k) => k.startsWith("rf_buyer_notifications"))).toEqual(
      [],
    );
    expect(localStorage.getItem(BUYER_KEYS.accessToken)).toBeNull();
    expect(localStorage.getItem("rf:op:accessToken")).toBe("staff-token");
  });

  it("clears the bell even when the server logout call fails", async () => {
    mockedPost.mockRejectedValueOnce(new Error("offline"));
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt({ sub: "buyer-a", type: "BUYER" }));
    localStorage.setItem(buyerNotificationsKey("buyer-a", "t-1"), "[]");

    await buyerLogout();

    expect(localStorage.getItem(buyerNotificationsKey("buyer-a", "t-1"))).toBeNull();
  });
});

describe("getStoredBuyerId — the identity the bell is keyed by", () => {
  it("is the buyer token's sub, even once the token has expired", () => {
    localStorage.setItem(
      BUYER_KEYS.accessToken,
      buyerJwt({ sub: "buyer-a", type: "BUYER", exp: 1 }),
    );
    expect(getStoredBuyerId()).toBe("buyer-a");
  });

  it("is null without a buyer token, or for a token that is not a buyer's", () => {
    expect(getStoredBuyerId()).toBeNull();
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt({ sub: "u-1", role: "OPERATOR" }));
    expect(getStoredBuyerId()).toBeNull();
    localStorage.setItem(BUYER_KEYS.accessToken, "not-a-jwt");
    expect(getStoredBuyerId()).toBeNull();
  });
});
