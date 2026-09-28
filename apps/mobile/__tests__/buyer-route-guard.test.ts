/**
 * #2341 (Tier 1, auth): a signed-in buyer with 0 sellers — a fresh in-app
 * sign-up, or a login whose account has no seller yet — may reach ONLY the
 * seller picker and connect screens (mirrors web's /buyer/portal). Every other
 * (customer) route still requires an active seller; the active-seller and
 * signed-out paths are unchanged.
 */
import {
  SELLERLESS_LANDING,
  customerLayoutTarget,
  isSellerlessRoute,
  postSignInStep,
  rootBuyerGate,
} from "../lib/buyer-route-guard";
import type { BuyerSeller } from "../lib/buyer-auth";

const CONNECT = "/(customer)/sellers/connect";
const LOGIN = "/(auth)/customer-login";
const HOME = "/(customer)/(tabs)/home";

const GATED_ROUTES: string[][] = [
  ["(customer)", "(tabs)", "home"],
  ["(customer)", "(tabs)", "catalog"],
  ["(customer)", "orders", "[id]"],
  ["(customer)", "invoices", "[id]"],
  ["(customer)", "profile"],
  ["(customer)", "scan"],
  ["(customer)", "payments"],
  ["(customer)", "sellers", "connect", "extra"],
  ["(customer)", "sellersX"],
];
const ALLOWED_ROUTES: string[][] = [
  ["(customer)", "sellers"],
  ["(customer)", "sellers", "connect"],
];

describe("isSellerlessRoute", () => {
  it.each(ALLOWED_ROUTES)("allows %s/%s…", (...segs) => {
    expect(isSellerlessRoute(segs)).toBe(true);
  });
  it.each(GATED_ROUTES.map((s) => [s.join("/"), s]))("gates %s", (_l, segs) => {
    expect(isSellerlessRoute(segs as string[])).toBe(false);
  });
  it("gates non-customer groups that happen to be named sellers", () => {
    expect(isSellerlessRoute(["(operator)", "sellers"])).toBe(false);
    expect(isSellerlessRoute([])).toBe(false);
  });
  it("lands on connect", () => {
    expect(SELLERLESS_LANDING).toBe(CONNECT);
  });
});

describe("customerLayoutTarget", () => {
  describe("(a) signed-in buyer, 0 sellers", () => {
    const s = { hasBuyer: true, hasSeller: false };
    it.each(ALLOWED_ROUTES)("stays on %s/%s…", (...segs) => {
      expect(customerLayoutTarget({ ...s, segments: segs })).toBeNull();
    });
    it.each(GATED_ROUTES.map((r) => [r.join("/"), r]))("redirects %s to connect", (_l, segs) => {
      expect(customerLayoutTarget({ ...s, segments: segs as string[] })).toBe(CONNECT);
    });
  });

  describe("(b) active seller — unchanged", () => {
    const s = { hasBuyer: true, hasSeller: true };
    it.each([...GATED_ROUTES, ...ALLOWED_ROUTES].map((r) => [r.join("/"), r]))(
      "allows %s",
      (_l, segs) => {
        expect(customerLayoutTarget({ ...s, segments: segs as string[] })).toBeNull();
      },
    );
  });

  describe("(c) signed out — unchanged", () => {
    it.each([true, false])(
      "redirects every customer route to login (hasSeller=%s)",
      (hasSeller) => {
        for (const segs of [...GATED_ROUTES, ...ALLOWED_ROUTES]) {
          expect(customerLayoutTarget({ hasBuyer: false, hasSeller, segments: segs })).toBe(LOGIN);
        }
      },
    );
    it("does not bounce when already on customer-login", () => {
      expect(
        customerLayoutTarget({
          hasBuyer: false,
          hasSeller: false,
          segments: ["(auth)", "customer-login"],
        }),
      ).toBeNull();
    });
  });
});

describe("rootBuyerGate", () => {
  describe("(a) buyer, 0 sellers, no staff", () => {
    const s = { hasBuyer: true, hasSeller: false, hasStaff: false };
    it.each(ALLOWED_ROUTES)("handles and stays on %s/%s…", (...segs) => {
      expect(rootBuyerGate({ ...s, segments: segs })).toEqual({ handled: true, to: null });
    });
    it.each(
      [
        ...GATED_ROUTES,
        [],
        ["(auth)", "customer-login"],
        ["(auth)", "login"],
        ["(operator)", "(tabs)", "home"],
      ].map((r) => [r.join("/") || "/", r]),
    )("redirects %s to connect", (_l, segs) => {
      expect(rootBuyerGate({ ...s, segments: segs as string[] })).toEqual({
        handled: true,
        to: CONNECT,
      });
    });
  });

  describe("(b) buyer with active seller, no staff — unchanged", () => {
    const s = { hasBuyer: true, hasSeller: true, hasStaff: false };
    it("stays anywhere under (customer)", () => {
      for (const segs of [...GATED_ROUTES, ...ALLOWED_ROUTES]) {
        expect(rootBuyerGate({ ...s, segments: segs })).toEqual({ handled: true, to: null });
      }
    });
    it("sends a non-customer route home", () => {
      expect(rootBuyerGate({ ...s, segments: ["(auth)", "login"] })).toEqual({
        handled: true,
        to: HOME,
      });
      expect(rootBuyerGate({ ...s, segments: [] })).toEqual({ handled: true, to: HOME });
    });
  });

  describe("(c) not handled — falls through to the existing staff/signed-out logic", () => {
    it.each([
      ["signed out", { hasBuyer: false, hasSeller: false, hasStaff: false }],
      ["signed out, stale seller", { hasBuyer: false, hasSeller: true, hasStaff: false }],
      ["staff + sellerless buyer", { hasBuyer: true, hasSeller: false, hasStaff: true }],
      ["staff + buyer with seller", { hasBuyer: true, hasSeller: true, hasStaff: true }],
    ])("%s", (_l, s) => {
      for (const segs of [[], ["(customer)", "sellers"], ["(customer)", "(tabs)", "home"]]) {
        expect(rootBuyerGate({ ...s, segments: segs })).toEqual({ handled: false, to: null });
      }
    });
  });
});

describe("postSignInStep (#2546: only an ACTIVE link can become the active seller)", () => {
  const link = (slug: string, linkStatus: string): BuyerSeller => ({
    linkId: `link-${slug}`,
    linkStatus,
    tenant: { id: `t-${slug}`, slug, name: slug, logoKey: null, primaryColor: null },
    customer: null,
  });

  it("no links at all → connect", () => {
    expect(postSignInStep([])).toEqual({ kind: "connect" });
  });

  it.each(["INVITED", "PENDING_SELLER_APPROVAL"])(
    "only a %s link → the seller list, never activated",
    (status) => {
      expect(postSignInStep([link("acme", status)])).toEqual({ kind: "list" });
    },
  );

  it("one ACTIVE link among pending ones → open that one", () => {
    const active = link("acme", "ACTIVE");
    expect(
      postSignInStep([link("beta", "PENDING_SELLER_APPROVAL"), active, link("gamma", "INVITED")]),
    ).toEqual({ kind: "open", seller: active });
  });

  it("several ACTIVE links → pick among the ACTIVE ones only", () => {
    const a = link("acme", "ACTIVE");
    const b = link("beta", "ACTIVE");
    expect(postSignInStep([a, link("gamma", "INVITED"), b])).toEqual({
      kind: "pick",
      sellers: [a, b],
    });
  });
});
