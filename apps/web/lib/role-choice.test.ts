import {
  BUYER_LOGIN_PATH,
  CHOOSE_ROLE_PATH,
  drives,
  postSignInDestination,
  rememberRoleStepLanding,
  roleStepLanding,
  shouldAskRole,
  stashBuyerLoginEmail,
  takeBuyerLoginEmail,
} from "./role-choice";

/**
 * W-839 / SA-937 MUST 6: ONE predicate decides when a staff sign-in asks "which role" (the owner ruled: a user who is
 * both a driver and a buyer is asked at sign-in). Today: the user drives (DRIVER, or canActAsDriver), /users/me says
 * alsoBuyer, and no explicit redirect was asked for. forcePasswordChange is decided before this, by the callers.
 */
describe("drives", () => {
  it.each([
    [{ role: "DRIVER" }, true],
    [{ role: "OPERATOR", canActAsDriver: true }, true],
    [{ role: "OPERATOR", canActAsDriver: false }, false],
    [{ role: "TENANT_ADMIN" }, false],
    [null, false],
  ])("%j -> %s", (user, want) => {
    expect(drives(user as Parameters<typeof drives>[0])).toBe(want);
  });
});

describe("shouldAskRole", () => {
  const driver = { role: "DRIVER" };
  it("a driver who also buys, with no explicit redirect, is asked", () => {
    expect(shouldAskRole(driver, true, null)).toBe(true);
  });
  it.each<[string, unknown, boolean | undefined, string | null]>([
    ["not a buyer", driver, false, null],
    ["the buyer signal unknown", driver, undefined, null],
    ["an explicit redirect", driver, true, "/orders/abc"],
    ["a non-driver who buys", { role: "OPERATOR" }, true, null],
  ])("not asked: %s", (_l, user, alsoBuyer, redirect) => {
    expect(shouldAskRole(user as Parameters<typeof shouldAskRole>[0], alsoBuyer, redirect)).toBe(
      false,
    );
  });
});

describe("postSignInDestination", () => {
  it("asks only when the predicate says so; otherwise today's landing", () => {
    expect(postSignInDestination({ role: "DRIVER" }, true, null, "/routes/my-runs")).toBe(
      CHOOSE_ROLE_PATH,
    );
    expect(postSignInDestination({ role: "DRIVER" }, false, null, "/routes/my-runs")).toBe(
      "/routes/my-runs",
    );
  });
});

// #3731 review (2): Drive keeps the landing of the path the user signed in on (the Google path lands on /dashboard).
describe("the role step's landing", () => {
  beforeEach(() => sessionStorage.clear());
  it("is the one the entry path remembered", () => {
    rememberRoleStepLanding("/dashboard");
    expect(roleStepLanding("/routes/my-runs")).toBe("/dashboard");
  });
  it("falls back when none was remembered, and ignores an off-origin value", () => {
    expect(roleStepLanding("/routes/my-runs")).toBe("/routes/my-runs");
    sessionStorage.setItem("rf.roleStep.landing", "https://evil.example");
    expect(roleStepLanding("/routes/my-runs")).toBe("/routes/my-runs");
  });
});

// #3731 review (4): the email prefill never goes in a URL; it is stashed for the buyer login and read once.
describe("the buyer login prefill", () => {
  beforeEach(() => sessionStorage.clear());
  it("is read once, then gone", () => {
    stashBuyerLoginEmail("sam+1@acme.example");
    expect(takeBuyerLoginEmail()).toBe("sam+1@acme.example");
    expect(takeBuyerLoginEmail()).toBeNull();
  });
  it("no email: nothing stashed; the buyer login path carries no query", () => {
    stashBuyerLoginEmail(null);
    expect(takeBuyerLoginEmail()).toBeNull();
    expect(BUYER_LOGIN_PATH).toBe("/buyer/login");
  });
});
