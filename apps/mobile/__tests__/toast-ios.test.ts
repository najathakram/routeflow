/**
 * iOS toast routing (F30 · REG-B151).
 *
 * `lib/toast.ts`'s iOS branch used to be a bare fallthrough — `showToast` did
 * nothing at all on iOS (no Alert, no in-screen feedback), so every
 * wedge-path miss/failure sink (edit-items.tsx, ProductPickerSheet.tsx,
 * movements.tsx, adjust-picker.tsx, vendor-bills/new.tsx) was invisible on
 * iOS. `InlineToast.tsx` exists precisely to fill this gap but `showToast`
 * had no way to reach a screen's mounted instance.
 *
 * The fix wires `showToast`'s iOS branch to `lib/toast-host.ts`'s registry:
 * when a screen has registered a host (its InlineToast is mounted), route
 * there; otherwise fall back to `Alert.alert` so the message is never just
 * dropped. The last case below pins the production side of that seam — a
 * registry nothing registers with would leave every iOS toast on the Alert
 * fallback while the first three cases still passed.
 */

const mockAlert = jest.fn();
jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ToastAndroid: { show: jest.fn(), SHORT: 0, LONG: 1 },
  Alert: { alert: mockAlert },
}));

import { readFileSync } from "fs";
import { join } from "path";
import { showToast } from "../lib/toast";
import { registerToastHost, releaseToastHost } from "../lib/toast-host";

describe("showToast on iOS (T-B151, REG-B151)", () => {
  beforeEach(() => {
    mockAlert.mockClear();
    registerToastHost(null);
  });

  it("routes to the mounted InlineToast host instead of Alert when one is registered", () => {
    const host = jest.fn();
    registerToastHost(host);

    showToast("Order for Acme Corp could not be submitted");

    expect(host).toHaveBeenCalledWith("Order for Acme Corp could not be submitted");
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("falls back to Alert.alert with the message when no InlineToast host is mounted", () => {
    registerToastHost(null);

    showToast("Order for Acme Corp could not be submitted");

    // The MESSAGE, not merely "an alert fired" — a fallback that alerted a
    // constant ("Something went wrong") would lose the only thing the operator
    // needs, and a bare toHaveBeenCalled() would wave it through.
    expect(mockAlert).toHaveBeenCalledWith("Order for Acme Corp could not be submitted");
  });

  /**
   * A pushed screen leaves the one beneath it MOUNTED. Unregistering on unmount
   * must therefore hand the toast back to the screen underneath, not blank the
   * registry and demote a still-visible screen to blocking Alerts.
   */
  it("hands the toast back to the screen underneath when a pushed screen unmounts", () => {
    const beneath = jest.fn();
    const pushed = jest.fn();
    registerToastHost(beneath);
    registerToastHost(pushed);

    showToast("Line added");
    expect(pushed).toHaveBeenCalledWith("Line added");
    expect(beneath).not.toHaveBeenCalled();

    releaseToastHost(pushed);
    showToast("Draft saved");

    expect(beneath).toHaveBeenCalledWith("Draft saved");
    expect(mockAlert).not.toHaveBeenCalled();
  });

  /**
   * WIRING — the registry only ever holds a host if production code puts one
   * there. Nothing in the app registered itself at first: `registerToastHost`'s
   * only callers were this spec, so both cases above passed while EVERY iOS
   * toast in the shipped app fell through to a blocking `Alert` mid-scan-burst.
   * `useInlineToast` is the single seam every `<InlineToast>` owner goes
   * through; assert it keeps registering so a refactor cannot silently strand
   * the registry again.
   */
  it("useInlineToast registers and releases the host so the registry has a real caller", () => {
    const hookSrc = readFileSync(join(__dirname, "..", "components", "InlineToast.tsx"), "utf8");

    expect(hookSrc).toMatch(/registerToastHost\(\s*show\s*\)/);
    expect(hookSrc).toMatch(/releaseToastHost\(\s*show\s*\)/);
  });
});
