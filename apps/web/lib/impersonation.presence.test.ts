import {
  clearImpersonation,
  exitImpersonation,
  getImpersonation,
  setImpersonation,
} from "./impersonation";
import {
  BUYER_PRESENCE_COOKIE,
  OP_PRESENCE_COOKIE,
  hasBuyerPresence,
  hasOpPresence,
  setBuyerPresenceCookie,
  setOpPresenceCookie,
  clearOpPresenceCookie,
  clearBuyerPresenceCookie,
} from "./presence-cookies";
import { resolveOperatorPathGuard } from "./portal-routing";
import { OP_KEYS } from "./auth-keys";

/**
 * B1304: a super admin's own session has no operator presence cookie (rf-op-auth), so "Sign in as admin" in a browser that also
 * holds a buyer session looked buyer-only to the middleware guard and bounced /dashboard to /login. The impersonation start
 * sets the same operator presence cookie a normal sign-in sets (presence-cookies.ts, no second copy of the name or options);
 * Exit clears it exactly when the browser has no operator session of its own.
 */
const guard = (pathname = "/dashboard") =>
  resolveOperatorPathGuard({
    opAuthed: hasOpPresence(),
    buyerAuthed: hasBuyerPresence(),
    pathname,
    search: "",
  });

beforeEach(() => {
  localStorage.clear();
  clearOpPresenceCookie();
  clearBuyerPresenceCookie();
  jest.spyOn(console, "error").mockImplementation(() => undefined); // jsdom: navigation not implemented
});
afterEach(() => {
  clearImpersonation();
  jest.restoreAllMocks();
});

describe("B1304 impersonation and the operator presence cookie", () => {
  it("with a buyer session in the browser, starting an impersonation lets /dashboard through", () => {
    setBuyerPresenceCookie();
    expect(guard()).toMatch(/^\/login\?redirect=/); // the buyer-only browser, before
    setImpersonation("tok", "acme", "admin");
    expect(document.cookie).toContain(`${OP_PRESENCE_COOKIE}=1`);
    expect(guard()).toBeNull();
  });

  it("a buyer-only browser still cannot open operator paths", () => {
    setBuyerPresenceCookie();
    expect(guard("/orders")).toBe("/login?redirect=%2Forders");
    expect(document.cookie).toContain(`${BUYER_PRESENCE_COOKIE}=1`);
  });

  it("Exit with a buyer session and no operator session of its own returns the browser to buyer-only", () => {
    setBuyerPresenceCookie();
    setImpersonation("tok", "acme", "admin");
    exitImpersonation();
    expect(getImpersonation()).toBeNull();
    expect(hasOpPresence()).toBe(false);
    expect(hasBuyerPresence()).toBe(true);
    expect(guard()).toMatch(/^\/login\?redirect=/);
  });

  it("Exit leaves a real operator session's presence cookie alone", () => {
    localStorage.setItem(OP_KEYS.accessToken, "op-access");
    localStorage.setItem(OP_KEYS.refreshToken, "op-refresh");
    setOpPresenceCookie();
    setImpersonation("tok", "acme", "admin");
    exitImpersonation();
    expect(hasOpPresence()).toBe(true);
  });

  it("an impersonation start never touches the buyer cookie", () => {
    setImpersonation("tok", "acme", "admin");
    expect(hasBuyerPresence()).toBe(false);
  });
});
