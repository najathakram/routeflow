/**
 * REG-B124 — impersonation kept the previous tenant's logo, business name and
 * username: AuthProvider/TenantProvider never re-read the acting identity when
 * an operator impersonated a tenant from the SAME tab (no route change, no
 * storage event — same-tab `localStorage` writes don't fire `storage`). Fixed
 * in #491 (28cb0a25): `setImpersonation`/`clearImpersonation` now dispatch a
 * same-tab change event, and `subscribeImpersonation` is the single place both
 * providers listen for it (plus a key-filtered cross-tab `storage` fallback).
 *
 * Pinned at the source module — no React tree needed — so a regression that
 * drops the same-tab dispatch, or that widens the storage filter back to
 * "every key", fails here directly.
 */
import {
  setImpersonation,
  clearImpersonation,
  subscribeImpersonation,
  exitImpersonationTarget,
} from "./impersonation";

describe("impersonation change notifications (B124)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("REG-B124 setImpersonation notifies same-tab subscribers synchronously (no route change needed)", () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeImpersonation(onChange);

    setImpersonation("fake.token.value", "acme", "acting-admin");

    // RED against the pre-fix module, which never dispatched anything on
    // set/clear — AuthProvider/TenantProvider had no signal to re-read the
    // acting tenant's identity within the same tab.
    expect(onChange).toHaveBeenCalledTimes(1);

    clearImpersonation();
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("subscribeImpersonation reacts to a cross-tab storage event on an impersonation key, but not on an unrelated key", () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeImpersonation(onChange);

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "impersonationTenantSlug",
        storageArea: localStorage,
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    // An unrelated cross-tab write (sidebar state, view mode, ...) must NOT
    // re-fire the subscription — that would tear down or refetch identity on
    // noise, the exact over-broad-listener trap the fix's comment calls out.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "some-unrelated-ui-pref",
        storageArea: localStorage,
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

describe("Exit impersonation returns to the tenant it started from (back-office P2)", () => {
  const ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
  beforeEach(() => {
    localStorage.clear();
  });

  it("a stored tenant id leads to that tenant's page, built from the id", () => {
    setImpersonation("t.t.t", "acme", "admin", ID);
    expect(exitImpersonationTarget()).toBe(`/admin/tenants/${ID}`);
  });

  it("no stored id (an older session, or started elsewhere) leads to the tenants list", () => {
    setImpersonation("t.t.t", "acme", "admin");
    expect(exitImpersonationTarget()).toBe("/admin/tenants");
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "/admin/tenants/../../logout",
    `${ID}/../../x`,
    "not-a-uuid",
    "",
    `${ID}?next=https://evil.example`,
  ])("an invalid stored value (%s) leads to the tenants list, never to it", (bad) => {
    setImpersonation("t.t.t", "acme", "admin");
    localStorage.setItem("impersonationSourceTenantId", bad);
    expect(exitImpersonationTarget()).toBe("/admin/tenants");
  });

  it("clearing the impersonation drops the stored source id", () => {
    setImpersonation("t.t.t", "acme", "admin", ID);
    clearImpersonation();
    expect(localStorage.getItem("impersonationSourceTenantId")).toBeNull();
    expect(exitImpersonationTarget()).toBe("/admin/tenants");
  });
});
