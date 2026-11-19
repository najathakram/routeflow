/**
 * B139: a buyer who signed in with Google and then signed out was bounced back into the portal.
 * The Google callback also wrote the pre-namespacing "buyerAccessToken" key, getBuyerAccessToken()
 * fell back to it, and buyerLogout() cleared only the namespaced keys, so the buyer still read as
 * signed in. The legacy keys are no longer written or read, and logout clears them once for the
 * browsers that already hold them.
 */
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({}) },
}));

import { BUYER_KEYS } from "./auth-keys";
import { buyerLogout, getBuyerAccessToken, getStoredBuyer } from "./buyer-auth";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const buyerJwt = () =>
  `${b64({ alg: "none" })}.${b64({
    sub: "buyer-1",
    email: "pat@acme.test",
    name: "Pat",
    type: "BUYER",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.sig`;

describe("legacy buyer token keys (B139)", () => {
  beforeEach(() => localStorage.clear());

  it("a legacy-only token is not a session", () => {
    localStorage.setItem("buyerAccessToken", buyerJwt());
    expect(getBuyerAccessToken()).toBeNull();
    expect(getStoredBuyer()).toBeNull();
  });

  it("after sign-out a browser that still holds the legacy keys reads as signed out", async () => {
    const jwt = buyerJwt();
    localStorage.setItem(BUYER_KEYS.accessToken, jwt);
    localStorage.setItem(BUYER_KEYS.refreshToken, "r");
    localStorage.setItem("buyerAccessToken", jwt);
    localStorage.setItem("buyerRefreshToken", "r");
    expect(getStoredBuyer()).not.toBeNull();

    await buyerLogout();

    expect(localStorage.getItem("buyerAccessToken")).toBeNull();
    expect(localStorage.getItem("buyerRefreshToken")).toBeNull();
    expect(getBuyerAccessToken()).toBeNull();
    expect(getStoredBuyer()).toBeNull();
  });
});
