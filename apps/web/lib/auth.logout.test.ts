/**
 * ROW 447: signing out wipes every stored unsaved-invoice draft on this browser, and a broken storage never stops the
 * sign-out.
 */
jest.mock("./api-client", () => ({
  apiClient: { post: jest.fn().mockResolvedValue({}), get: jest.fn() },
}));

import { logout } from "./auth";
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
});
