// `export {}` makes this file a MODULE. Without it TS treats a file with no
// top-level import/export as a global script, and the `load` helper below
// collides with the identically-named one in presence-cookies.test.ts
// (TS2393 "Duplicate function implementation") under `tsc --noEmit`.
export {};

// Guarded require: apps/web/lib/portal-routing.ts does not exist yet (TP1 is
// test-first). A plain `import` would fail with a module-resolution error —
// never an assertion — before the implementation lands. Requiring through a
// try/catch means an absent module surfaces as `undefined` exports instead,
// so every case below fails on its OWN expected value (an assertion), per
// test-plan.md §2.1.
function load<T>(path: string): Partial<T> {
  try {
    return require(path);
  } catch (e) {
    // ONLY a genuinely-absent module falls back to `{}`. A syntax error or an
    // import-time throw inside the real module must surface as itself, not as
    // another `Received: undefined` that looks identical to "not written yet".
    if ((e as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw e;
    return {};
  }
}
const routing = load<typeof import("./portal-routing")>("./portal-routing");

describe("resolveOperatorPathGuard", () => {
  // T1/R1: buyer-only session requesting an operator path -> /login?redirect=<encoded path>
  it("T1/R1: buyer-only + operator path -> /login?redirect=%2Fdashboard", () => {
    expect(
      routing.resolveOperatorPathGuard?.({
        pathname: "/dashboard",
        search: "",
        opAuthed: false,
        buyerAuthed: true,
      }),
    ).toBe("/login?redirect=%2Fdashboard");
  });

  // T2/R1,R14: query string is folded into the encoded redirect target, and the
  // location never carries a host/scheme.
  it("T2/R1,R14: buyer-only + operator path with query -> encoded path+query, same-origin only", () => {
    const result = routing.resolveOperatorPathGuard?.({
      pathname: "/orders/abc",
      search: "?tab=1",
      opAuthed: false,
      buyerAuthed: true,
    });
    expect(result).toBe("/login?redirect=%2Forders%2Fabc%3Ftab%3D1");
    expect(result).toEqual(expect.stringMatching(/^\/login\?redirect=/));
    expect(result).not.toContain("http");
  });

  // T6/R3: the guard never fires for an operator with a session, a signed-out
  // visitor, or a buyer-only visitor already off an operator path (covered by T7).
  it("T6/R3: guard is a no-op for an operator session, a signed-out visitor, and a fully signed-out visitor", () => {
    expect(
      routing.resolveOperatorPathGuard?.({
        pathname: "/dashboard",
        search: "",
        opAuthed: true,
        buyerAuthed: true,
      }),
    ).toBeNull();
    expect(
      routing.resolveOperatorPathGuard?.({
        pathname: "/dashboard",
        search: "",
        opAuthed: true,
        buyerAuthed: false,
      }),
    ).toBeNull();
    expect(
      routing.resolveOperatorPathGuard?.({
        pathname: "/dashboard",
        search: "",
        opAuthed: false,
        buyerAuthed: false,
      }),
    ).toBeNull();
  });

  // T7/R3: prefix matching is "equal, or prefix + /" — /dashboards must NOT match
  // the /dashboard prefix. Non-operator, buyer-only, and boundary paths all pass through.
  it.each([["/login"], ["/buyer/portal"], ["/pricing"], ["/dashboards"], ["/"]])(
    "T7/R3: buyer-only + non-operator path %s -> null",
    (pathname) => {
      expect(
        routing.resolveOperatorPathGuard?.({
          pathname,
          search: "",
          opAuthed: false,
          buyerAuthed: true,
        }),
      ).toBeNull();
    },
  );
});

describe("resolveLandingTarget", () => {
  // T3/R2,R13: today's landing contract (CC-11/12/14) — operator wins, buyer-only
  // lands on the buyer portal, signed-out gets no redirect.
  it("T3/R2,R13: single-session landings with no lastPortal preference", () => {
    expect(
      routing.resolveLandingTarget?.({ opAuthed: true, buyerAuthed: false, lastPortal: undefined }),
    ).toBe("/dashboard");
    expect(
      routing.resolveLandingTarget?.({ opAuthed: false, buyerAuthed: true, lastPortal: undefined }),
    ).toBe("/buyer/portal");
    expect(
      routing.resolveLandingTarget?.({
        opAuthed: false,
        buyerAuthed: false,
        lastPortal: undefined,
      }),
    ).toBeNull();
  });

  // T4/R2,R13: with both sessions live, operator is the default and any invalid
  // preference (missing, unrecognized, or empty) is treated as absent.
  it.each([[undefined], ["op"], ["garbage"], [""]])(
    "T4/R2,R13: both sessions live, lastPortal=%p -> /dashboard (operator default / invalid = absent)",
    (lastPortal) => {
      expect(
        routing.resolveLandingTarget?.({ opAuthed: true, buyerAuthed: true, lastPortal }),
      ).toBe("/dashboard");
    },
  );

  // T5/R2: a preference never overrides a missing session.
  it("T5/R2: lastPortal preference only applies when that session actually exists", () => {
    expect(
      routing.resolveLandingTarget?.({ opAuthed: true, buyerAuthed: true, lastPortal: "buyer" }),
    ).toBe("/buyer/portal");
    expect(
      routing.resolveLandingTarget?.({ opAuthed: true, buyerAuthed: false, lastPortal: "buyer" }),
    ).toBe("/dashboard");
    expect(
      routing.resolveLandingTarget?.({ opAuthed: false, buyerAuthed: true, lastPortal: "op" }),
    ).toBe("/buyer/portal");
  });
});

describe("safeOperatorRedirect", () => {
  // T8/R4: a genuinely safe, same-origin operator path is returned unchanged.
  it.each([["/dashboard"], ["/orders/abc?tab=1"], ["/settings/users"]])(
    "T8/R4: safe operator path %s is returned unchanged",
    (value) => {
      expect(routing.safeOperatorRedirect?.(value)).toBe(value);
    },
  );

  // T9/R5,R14: every unsafe, off-origin, non-operator, or malformed value falls
  // back to /dashboard — never an open redirect, never a non-operator surface.
  it.each([
    [null],
    [""],
    ["//evil.com"],
    ["https://evil.com/dashboard"],
    ["/\\evil.com"],
    ["/dashboard/../admin"],
    ["/orders//x"],
    ["/buyer/portal"],
    ["/pricing"],
    ["dashboard"],
    ["/login"],
    ["/dashboard?next=https://evil.com"],
  ])("T9/R5,R14: unsafe redirect target %p -> /dashboard", (value) => {
    expect(routing.safeOperatorRedirect?.(value)).toBe("/dashboard");
  });
});

describe("landingForRole (PHASE 1a — driver-mode 1a)", () => {
  it("REG-1a: a DRIVER's default landing (/dashboard) becomes /routes/my-runs", () => {
    expect(routing.landingForRole?.("/dashboard", "DRIVER")).toBe("/routes/my-runs");
  });

  it.each([["OPERATOR"], ["SUPER_ADMIN"], ["TENANT_ADMIN"], [null], [undefined]])(
    "REG-1a: a non-DRIVER role (%p) keeps the default /dashboard landing",
    (role) => {
      expect(routing.landingForRole?.("/dashboard", role as any)).toBe("/dashboard");
    },
  );

  it("REG-1a: an explicit valid redirect still wins for a DRIVER (e.g. a deep-link bounce)", () => {
    expect(routing.landingForRole?.("/orders", "DRIVER")).toBe("/orders");
  });

  it("REG-1a: a DRIVER explicitly redirected to /dashboard itself still lands on my-runs", () => {
    // safeOperatorRedirect("/dashboard") resolves to "/dashboard" whether that
    // came from an explicit ?redirect=/dashboard or the no-redirect default —
    // either way a driver has no reason to see the operator dashboard.
    expect(
      routing.landingForRole?.(routing.safeOperatorRedirect?.("/dashboard") ?? "", "DRIVER"),
    ).toBe("/routes/my-runs");
  });
});

describe("driverNavItemVisible (PHASE 1a nav filter)", () => {
  const none = { routesAccess: false, deliveryAccess: false };

  it.each([["/routes"], ["/routes/my-runs"]])(
    "%s is hidden for a driver with neither add-on",
    (href) => {
      expect(routing.driverNavItemVisible?.(href, none)).toBe(false);
    },
  );

  it.each([
    [{ routesAccess: true, deliveryAccess: false }],
    [{ routesAccess: false, deliveryAccess: true }],
  ])("Today's route and My Routes show with either add-on (%p)", (access) => {
    expect(routing.driverNavItemVisible?.("/routes/my-runs", access)).toBe(true);
    expect(routing.driverNavItemVisible?.("/routes", access)).toBe(true);
  });

  it("Dashboard shows only without runs access (it redirects to Today's route otherwise)", () => {
    expect(routing.driverNavItemVisible?.("/dashboard", none)).toBe(true);
    expect(
      routing.driverNavItemVisible?.("/dashboard", { routesAccess: true, deliveryAccess: false }),
    ).toBe(false);
  });

  it("Settings is never gated", () => {
    expect(routing.driverNavItemVisible?.("/settings", none)).toBe(true);
  });
});
