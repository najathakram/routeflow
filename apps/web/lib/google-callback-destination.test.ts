import { buyerLandingDestination } from "./google-callback-destination";

describe("buyerLandingDestination", () => {
  it.each([
    ["true", null, "/buyer/portal?linked=true"],
    ["false", "seller_unavailable", "/buyer/portal?invite=seller_unavailable"],
    [null, "seller_unavailable", "/buyer/portal?invite=seller_unavailable"],
    ["false", null, "/buyer/portal"],
    [null, null, "/buyer/portal"],
    ["false", "something-else", "/buyer/portal"],
  ])("linked=%s invite=%s lands on %s", (linked, invite, destination) => {
    expect(buyerLandingDestination(linked, invite)).toBe(destination);
  });
});
