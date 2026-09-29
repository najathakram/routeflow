/**
 * #2653 — the root gate's shell decision: operators → the shell; drivers → native, unchanged;
 * signed-out buyers may stay in the shell (web login fallback); shell off → nothing changes.
 */
import { SHELL_ROUTE, shellGate } from "../lib/web-shell/shell-routing";

const base = { shellOn: true, segments: [] as string[], hasStaffUser: false, activeRole: null };

describe("shellGate", () => {
  it("does nothing when the shell is off (old native screens, unchanged)", () => {
    for (const activeRole of ["operator", "driver", null]) {
      expect(
        shellGate({
          ...base,
          shellOn: false,
          hasStaffUser: true,
          activeRole,
          segments: ["(operator)", "home"],
        }),
      ).toEqual({ handled: false, to: null });
    }
  });

  it("sends a signed-in operator to the shell, and leaves them there", () => {
    expect(
      shellGate({
        ...base,
        hasStaffUser: true,
        activeRole: "operator",
        segments: ["(operator)", "home"],
      }),
    ).toEqual({ handled: true, to: `${SHELL_ROUTE}?role=operator` });
    expect(
      shellGate({
        ...base,
        hasStaffUser: true,
        activeRole: "operator",
        segments: ["(shell)", "web"],
      }),
    ).toEqual({ handled: true, to: null });
  });

  it("never handles a driver: the native driver app is unchanged", () => {
    for (const segments of [["(driver)", "route"], ["(shell)", "web"], []]) {
      expect(shellGate({ ...base, hasStaffUser: true, activeRole: "driver", segments })).toEqual({
        handled: false,
        to: null,
      });
    }
  });

  it("lets a signed-out buyer stay in the shell (web buyer login fallback)", () => {
    expect(shellGate({ ...base, segments: ["(shell)", "web"] })).toEqual({
      handled: true,
      to: null,
    });
  });

  it("leaves every other signed-out route to the native gate", () => {
    for (const segments of [[], ["(auth)", "login"], ["(customer)", "(tabs)", "home"]]) {
      expect(shellGate({ ...base, segments })).toEqual({ handled: false, to: null });
    }
  });
});
