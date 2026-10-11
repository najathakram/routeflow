/**
 * Row 331 (3): /orders/new had no route, so it fell into orders/[id] and read "Order not found." for every
 * tenant. It now redirects to the builder intent on the Orders page, which that page opens (skipping the counter).
 */
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
jest.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import OrdersNewPage from "./page";

const go = (searchParams: Record<string, string | string[] | undefined> = {}) => {
  try {
    OrdersNewPage({ searchParams });
  } catch {
    /* the mocked redirect throws like Next's does */
  }
  return redirect.mock.calls.at(-1)?.[0];
};

beforeEach(() => jest.clearAllMocks());

describe("/orders/new", () => {
  it("redirects to the builder intent on the Orders page", () => {
    expect(go()).toBe("/orders?action=new&builder=1");
  });
  it("keeps a scan code and a ship preselect through the redirect", () => {
    expect(go({ scan: "0123", preselect: "SHIP" })).toBe(
      "/orders?action=new&builder=1&scan=0123&preselect=SHIP",
    );
  });
  it("ignores unknown params and takes the first of a repeated one", () => {
    expect(go({ scan: ["1", "2"], evil: "x" })).toBe("/orders?action=new&builder=1&scan=1");
  });
});
