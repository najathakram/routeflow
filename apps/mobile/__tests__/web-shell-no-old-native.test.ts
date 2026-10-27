/**
 * W-830 (owner 2026-10-24: "not the old native UIs") — with the hybrid shell ON, no buyer and no
 * staff user may reach the old native buyer screens. Pure routing decisions, pinned here:
 *   1. a buyer with a native session, a signed-out buyer on a (customer) route, and a buyer who
 *      opened native customer-login all go to the shell (role=buyer);
 *   2. staff on customer-login (the RF-087 exemption) go to their own (operator) shell too;
 *   3. the native buyer session is cleared locally, so a later shell-off build finds no token;
 *   4. the (customer) layout and the entry buttons never offer the native route;
 *   5. the offline-drain "Open order" action never pushes an operator route the shell would bounce.
 * Shell OFF stays byte-for-byte the old behaviour.
 */
import {
  SHELL_BUYER_ROUTE,
  SHELL_ROUTE,
  buyerEntryRoute,
  creditsPendingOpenRoute,
  shellGate,
  shouldClearNativeBuyer,
} from "../lib/web-shell/shell-routing";
import { customerLayoutTarget } from "../lib/buyer-route-guard";

const buyerShell = `${SHELL_ROUTE}?role=buyer`;
const signedOut = { shellOn: true, hasStaffUser: false, hasBuyerSession: false };

describe("shellGate: buyers (W-830 leak 1)", () => {
  it("exports the buyer shell route", () => {
    expect(SHELL_BUYER_ROUTE).toBe(buyerShell);
  });

  it.each([
    [["(customer)", "(tabs)", "home"]],
    [["(customer)", "orders", "cart"]],
    [["(customer)", "sellers", "connect"]],
    [["(auth)", "sign-in"]],
    [["(auth)", "customer-login"]],
    [[]],
  ])("a buyer WITH a native session on %j goes to the shell", (segments) => {
    expect(shellGate({ ...signedOut, hasBuyerSession: true, segments })).toEqual({
      handled: true,
      to: buyerShell,
    });
  });

  it("leaves a buyer already in the shell alone", () => {
    expect(
      shellGate({ ...signedOut, hasBuyerSession: true, segments: ["(shell)", "web"] }),
    ).toEqual({ handled: true, to: null });
  });

  it.each([
    [["(customer)", "(tabs)", "home"]],
    // BUG-B2-5 deep link: the shell takes no path, so it lands on the shell home.
    [["(customer)", "invoices", "abc"]],
    [["(auth)", "customer-login"]],
  ])("a signed-out user on the native buyer route %j goes to the shell", (segments) => {
    expect(shellGate({ ...signedOut, segments })).toEqual({ handled: true, to: buyerShell });
  });

  it("still leaves every other signed-out route to the native gate", () => {
    for (const segments of [
      [],
      ["(auth)", "login"],
      ["(auth)", "sign-in"],
      ["(operator)", "home"],
    ]) {
      expect(shellGate({ ...signedOut, segments })).toEqual({ handled: false, to: null });
    }
  });

  it("shell OFF changes nothing for a buyer", () => {
    for (const segments of [["(customer)", "(tabs)", "home"], ["(auth)", "customer-login"], []]) {
      expect(shellGate({ ...signedOut, shellOn: false, hasBuyerSession: true, segments })).toEqual({
        handled: false,
        to: null,
      });
    }
  });
});

describe("shellGate: staff on customer-login (W-830 leak 2, RF-087)", () => {
  const staff = { shellOn: true, hasStaffUser: true, hasBuyerSession: false };

  it("sends an operator on native customer-login to the operator shell (review nit 2: never stuck in a buyer shell)", () => {
    expect(
      shellGate({ ...staff, activeRole: "operator", segments: ["(auth)", "customer-login"] }),
    ).toEqual({ handled: true, to: `${SHELL_ROUTE}?role=operator` });
  });

  it("an operator who reaches a (customer) route is moved to the shell, never the native page", () => {
    const r = shellGate({
      ...staff,
      activeRole: "operator",
      segments: ["(customer)", "invoices", "abc"],
    });
    expect(r.handled).toBe(true);
    expect(r.to).toContain(`${SHELL_ROUTE}?role=`);
  });

  it("an operator already in the shell stays", () => {
    expect(shellGate({ ...staff, activeRole: "operator", segments: ["(shell)", "web"] })).toEqual({
      handled: true,
      to: null,
    });
  });

  it("shell OFF keeps the RF-087 exemption (not handled here)", () => {
    expect(
      shellGate({
        ...staff,
        shellOn: false,
        activeRole: "operator",
        segments: ["(auth)", "customer-login"],
      }),
    ).toEqual({ handled: false, to: null });
  });

  it("a driver is still the native gate's call", () => {
    expect(
      shellGate({ ...staff, activeRole: "driver", segments: ["(auth)", "customer-login"] }),
    ).toEqual({ handled: false, to: null });
  });
});

describe("shouldClearNativeBuyer: no stale buyer token (W-830 leak 1)", () => {
  it("clears a native buyer session when the shell is on, staff or not", () => {
    expect(shouldClearNativeBuyer({ shellOn: true, hasBuyer: true })).toBe(true);
  });
  it("never clears with the shell off (the native portal is the app) or with no buyer", () => {
    expect(shouldClearNativeBuyer({ shellOn: false, hasBuyer: true })).toBe(false);
    expect(shouldClearNativeBuyer({ shellOn: true, hasBuyer: false })).toBe(false);
  });
});

describe("buyerEntryRoute", () => {
  it("is the shell with the shell on, native customer-login with it off", () => {
    expect(buyerEntryRoute(true)).toBe(buyerShell);
    expect(buyerEntryRoute(false)).toBe("/(auth)/customer-login");
  });
});

describe("customerLayoutTarget: the (customer) group never stays up under the shell", () => {
  const segs = ["(customer)", "(tabs)", "home"];
  it("redirects to the shell for every buyer state", () => {
    for (const [hasBuyer, hasSeller] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      expect(customerLayoutTarget({ hasBuyer, hasSeller, segments: segs, shellOn: true })).toBe(
        buyerShell,
      );
    }
  });
  it("is unchanged with the shell off or the flag omitted", () => {
    expect(customerLayoutTarget({ hasBuyer: true, hasSeller: true, segments: segs })).toBeNull();
    expect(
      customerLayoutTarget({ hasBuyer: false, hasSeller: false, segments: segs, shellOn: false }),
    ).toBe("/(auth)/customer-login");
  });
});

describe("creditsPendingOpenRoute: the offline-drain 'Open order' action", () => {
  it("shell OFF: the operator order, as before", () => {
    expect(creditsPendingOpenRoute({ shellOn: false, orderId: "o1", activeRole: "operator" })).toBe(
      "/(operator)/orders/o1",
    );
  });
  it("shell ON: no operator route (the shell would bounce it), so no action is offered", () => {
    expect(
      creditsPendingOpenRoute({ shellOn: true, orderId: "o1", activeRole: "operator" }),
    ).toBeNull();
    expect(
      creditsPendingOpenRoute({ shellOn: true, orderId: "o1", activeRole: "driver" }),
    ).toBeNull();
  });
});
