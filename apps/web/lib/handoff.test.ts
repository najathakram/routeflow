/**
 * #2653 (SA-542a/b): the web handoff, red-first. Pins: fragment-only (a ?code= query is
 * refused), the hash is stripped BEFORE the first await, the realm picks the endpoint AND the
 * adopter, a realm mismatch adopts nothing, and failures never throw.
 */
import {
  HANDOFF_ENTRY_PATH,
  buildHandoffFragment,
  parseHandoffLocation,
} from "@routeflow/ui/shell-handoff";
import { runHandoff, type HandoffDeps } from "./handoff";

function deps(hash: string, search = "", post?: HandoffDeps["post"]) {
  const order: string[] = [];
  const d = {
    location: {
      hash,
      search,
      pathname: HANDOFF_ENTRY_PATH,
      assign: jest.fn((url: string) => order.push(`assign:${url}`)),
    },
    history: {
      replaceState: jest.fn((_d: unknown, _u: string, url: string) => order.push(`replace:${url}`)),
    },
    apiUrl: "https://api.acme.test/api/v1",
    post: jest.fn(
      post ??
        (async (url: string) => {
          order.push(`post:${url}`);
          return {
            realm: url.includes("/buyer/") ? "BUYER" : "STAFF",
            accessToken: "a",
            refreshToken: "r",
          };
        }),
    ),
    adoptTokenPair: jest.fn(() => order.push("adopt:staff")),
    adoptBuyerTokenPair: jest.fn(() => order.push("adopt:buyer")),
  };
  return { d, order };
}

describe("handoff fragment format (shared with the shell)", () => {
  it("builds and parses the one format", () => {
    const f = buildHandoffFragment({ code: "n.s", realm: "buyer", seller: "acme-foods" });
    expect(parseHandoffLocation(`#${f}`, "")).toEqual({
      ok: true,
      code: "n.s",
      realm: "buyer",
      seller: "acme-foods",
    });
  });

  it("refuses a code in the QUERY string, even with a fragment too", () => {
    expect(parseHandoffLocation("#code=x&realm=staff", "?code=x")).toEqual({
      ok: false,
      reason: "query-refused",
    });
  });

  it("needs a code and a known realm; drops an unsafe seller slug", () => {
    expect(parseHandoffLocation("", "")).toEqual({ ok: false, reason: "missing" });
    expect(parseHandoffLocation("#code=x&realm=admin", "")).toEqual({
      ok: false,
      reason: "bad-realm",
    });
    expect(parseHandoffLocation("#code=x&realm=buyer&seller=../evil", "")).toMatchObject({
      ok: true,
      seller: null,
    });
  });
});

describe("runHandoff", () => {
  it("staff: strip the hash first, exchange at /auth/handoff/exchange, adopt staff, go /", async () => {
    const { d, order } = deps("#code=n.s&realm=staff");
    await expect(runHandoff(d)).resolves.toEqual({ ok: true, to: "/" });
    expect(order).toEqual([
      "replace:/handoff",
      "post:https://api.acme.test/api/v1/auth/handoff/exchange",
      "adopt:staff",
      "assign:/",
    ]);
    expect(d.post).toHaveBeenCalledWith(expect.any(String), { code: "n.s" });
  });

  it("buyer: exchange at /buyer/auth/handoff/exchange, adopt buyer, land on the seller", async () => {
    const { d, order } = deps("#code=n.s&realm=buyer&seller=acme-foods");
    await runHandoff(d);
    expect(order).toEqual([
      "replace:/handoff",
      "post:https://api.acme.test/api/v1/buyer/auth/handoff/exchange",
      "adopt:buyer",
      "assign:/buyer/portal/acme-foods/dashboard",
    ]);
  });

  it("strips the hash even when the link is refused, and never posts a query-string code", async () => {
    const { d, order } = deps("", "?code=n.s");
    await expect(runHandoff(d)).resolves.toEqual({ ok: false, reason: "query-refused" });
    expect(order).toEqual(["replace:/handoff"]);
    expect(d.post).not.toHaveBeenCalled();
  });

  it("a refused exchange adopts nothing and does not navigate", async () => {
    const { d } = deps("#code=n.s&realm=staff", "", async () => {
      throw new Error("401");
    });
    await expect(runHandoff(d)).resolves.toEqual({ ok: false, reason: "exchange-refused" });
    expect(d.adoptTokenPair).not.toHaveBeenCalled();
    expect(d.location.assign).not.toHaveBeenCalled();
  });

  it("a response for the other realm adopts nothing", async () => {
    const { d } = deps("#code=n.s&realm=staff", "", async () => ({
      realm: "BUYER",
      accessToken: "a",
      refreshToken: "r",
    }));
    await expect(runHandoff(d)).resolves.toEqual({ ok: false, reason: "realm-mismatch" });
    expect(d.adoptTokenPair).not.toHaveBeenCalled();
    expect(d.adoptBuyerTokenPair).not.toHaveBeenCalled();
  });
});
