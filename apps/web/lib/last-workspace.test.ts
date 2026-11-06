import { clearTenantCookie } from "./tenant-cookie";
import { readLastWorkspace, rememberLastWorkspace } from "./last-workspace";

// W2 B3: sign-in remembers the last Workspace ID on the device. It is its own stored value because
// logout clears the tenant cookie (lib/auth.ts endStaffSession), and the point is to survive that.
describe("last Workspace ID", () => {
  beforeEach(() => localStorage.clear());

  it("reads nothing when none was stored", () => {
    expect(readLastWorkspace()).toBeNull();
  });

  it("stores and reads back a Workspace ID", () => {
    rememberLastWorkspace("acme-distribution");
    expect(readLastWorkspace()).toBe("acme-distribution");
  });

  it("survives clearing the tenant cookie, which is what sign-out does", () => {
    rememberLastWorkspace("acme-distribution");
    clearTenantCookie();
    expect(readLastWorkspace()).toBe("acme-distribution");
  });

  it("ignores a value that is not a Workspace ID, on write and on read", () => {
    rememberLastWorkspace("Not A Slug!");
    expect(readLastWorkspace()).toBeNull();
    localStorage.setItem("rf-last-workspace", "<script>");
    expect(readLastWorkspace()).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => rememberLastWorkspace("acme")).not.toThrow();
    spy.mockRestore();
  });
});
