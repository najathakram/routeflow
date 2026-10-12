import { AUTO_LOCK_KIND_VALUES } from "@routeflow/types";
import {
  AUTO_LOCK_KIND_LABELS,
  autoLockBanner,
  isReasonValid,
  kindLabel,
  unpauseConfirmCopy,
  wouldLockRowText,
} from "./auto-locks";

const row = (tenantId: string, kind = "trial_expired" as const) => ({
  tenantId,
  kind,
  key: "k",
});

describe("autoLockBanner", () => {
  it("paused with N tenants: the spec'd sentence, singular and plural", () => {
    expect(autoLockBanner({ paused: true, wouldLockNow: [row("a"), row("b")] })).toBe(
      "Automatic locks paused — 2 tenants would be locked now",
    );
    expect(autoLockBanner({ paused: true, wouldLockNow: [row("a")] })).toBe(
      "Automatic locks paused — 1 tenant would be locked now",
    );
  });

  it("paused with nobody due, unpaused, and an unloaded state", () => {
    expect(autoLockBanner({ paused: true, wouldLockNow: [] })).toBe(
      "Automatic locks paused — no tenants would be locked now",
    );
    expect(autoLockBanner({ paused: false, wouldLockNow: [row("a")] })).toBe(
      "Automatic locks are on",
    );
    expect(autoLockBanner(null)).toBe("Automatic locks: status unavailable");
  });
});

describe("unpauseConfirmCopy", () => {
  it("names the number of tenants the owner is about to lock", () => {
    expect(unpauseConfirmCopy({ wouldLock: [row("a"), row("b"), row("c")] }).body).toBe(
      "Unpausing will lock these 3 tenants within the hour:",
    );
    expect(unpauseConfirmCopy({ wouldLock: [row("a")] }).body).toBe(
      "Unpausing will lock this tenant within the hour:",
    );
  });

  it("an empty preview says nothing locks now; a missing preview tells the owner not to unpause", () => {
    expect(unpauseConfirmCopy({ wouldLock: [] }).body).toMatch(
      /No tenant would be locked right now/,
    );
    expect(unpauseConfirmCopy(null).body).toMatch(/Don't unpause until it loads/);
  });

  it("the confirm label is explicit about what the click does", () => {
    expect(unpauseConfirmCopy({ wouldLock: [] }).confirmLabel).toBe("Unpause and allow locks");
  });
});

describe("reason + labels", () => {
  it("a reason is trimmed and 3..500 characters", () => {
    expect(isReasonValid("")).toBe(false);
    expect(isReasonValid("  ab  ")).toBe(false);
    expect(isReasonValid(" abc ")).toBe(true);
    expect(isReasonValid("x".repeat(500))).toBe(true);
    expect(isReasonValid("x".repeat(501))).toBe(false);
  });

  it("every shared kind has a plain-words label (no raw code shown)", () => {
    for (const k of AUTO_LOCK_KIND_VALUES) {
      expect(AUTO_LOCK_KIND_LABELS[k]).toBeTruthy();
      expect(kindLabel(k)).not.toBe(k);
    }
    expect(kindLabel("something_new")).toBe("something_new");
  });

  it("a list row shows the tenant id and the kind label only", () => {
    expect(wouldLockRowText(row("t-1", "trial_expired"))).toBe("t-1 — Trial ended");
  });
});
