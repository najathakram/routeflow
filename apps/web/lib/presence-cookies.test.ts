// `export {}` makes this file a MODULE — see portal-routing.test.ts for why
// (the `load` helper would otherwise be a duplicate global, TS2393).
export {};

/**
 * T26 (spec R11, R6): setLastPortalCookie / hasOpPresence / hasBuyerPresence.
 * These exports do not exist yet on `presence-cookies.ts` — the guarded load
 * below falls back to no-ops so the import itself never throws; the tests
 * then fail on their own assertion (empty cookie jar / undefined boolean),
 * never on a module-resolution error.
 */

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

const presenceCookies = load<typeof import("./presence-cookies")>("./presence-cookies");

const setLastPortalCookie = presenceCookies.setLastPortalCookie ?? ((_portal: string) => {});
const hasOpPresence = presenceCookies.hasOpPresence ?? (() => undefined as unknown as boolean);
const hasBuyerPresence =
  presenceCookies.hasBuyerPresence ?? (() => undefined as unknown as boolean);

function clearCookies(): void {
  for (const name of ["rf-op-auth", "rf-buyer-auth", "rf-last-portal"]) {
    document.cookie = `${name}=; path=/; max-age=0`;
  }
}

describe("presence-cookies (T26, R11)", () => {
  beforeEach(() => {
    clearCookies();
  });

  it("T26: setLastPortalCookie('op') writes rf-last-portal=op", () => {
    setLastPortalCookie("op");
    expect(document.cookie).toContain("rf-last-portal=op");
  });

  it("T26: setLastPortalCookie('buyer') after 'op' overwrites the cookie to buyer", () => {
    setLastPortalCookie("op");
    setLastPortalCookie("buyer");
    expect(document.cookie).toContain("rf-last-portal=buyer");
    expect(document.cookie).not.toContain("rf-last-portal=op");
  });

  it("T26: hasOpPresence() is true when rf-op-auth=1", () => {
    document.cookie = "rf-op-auth=1; path=/";
    expect(hasOpPresence()).toBe(true);
  });

  it("T26 (negative): hasOpPresence() is false when rf-op-auth=0", () => {
    document.cookie = "rf-op-auth=0; path=/";
    expect(hasOpPresence()).toBe(false);
  });

  it("T26 (negative): hasOpPresence() is false with no cookie at all", () => {
    expect(hasOpPresence()).toBe(false);
  });

  it("T26: hasBuyerPresence() is true when rf-buyer-auth=1", () => {
    document.cookie = "rf-buyer-auth=1; path=/";
    expect(hasBuyerPresence()).toBe(true);
  });

  it("T26 (negative): hasBuyerPresence() is false when rf-buyer-auth=0", () => {
    document.cookie = "rf-buyer-auth=0; path=/";
    expect(hasBuyerPresence()).toBe(false);
  });

  it("T26 (negative): hasBuyerPresence() is false with no cookie at all", () => {
    expect(hasBuyerPresence()).toBe(false);
  });
});
