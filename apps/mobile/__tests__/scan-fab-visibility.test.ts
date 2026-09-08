/**
 * B246 Option C / T2 (REG-B246) — `scan-fab-visibility.test.ts`
 *
 * `cause-ruling.md` §2/§3: the order-edit line-list scan FAB must stay
 * hidden while pricing is not ready (the REG-B62 guard — the picker is the
 * only place a line gets priced, so nothing scan-shaped may act before the
 * customer's contract loads), while the product picker is open, or while the
 * price-edit modal is open, or while any other transparent modal on the
 * screen (unlisted item, credit note, licence / credit-limit guards) is up;
 * it is visible only when none of those hold.
 *
 * Every case compares the whole boolean via `toBe` against the plan's literal
 * expected value: the rule is a single conjunction, so any partial-credit
 * matcher (truthiness, `not.toBe(false)`) would let a constant-`true` or
 * constant-`false` implementation through. Each case flips exactly one input.
 */
import { scanFabHidden } from "../lib/scan-fab-visibility";

describe("scanFabHidden (REG-B246)", () => {
  it("REG-B246: hidden while pricing is not ready, even with nothing else open (REG-B62 guard)", () => {
    expect(
      scanFabHidden({
        pricingReady: false,
        pickerOpen: false,
        priceModalOpen: false,
        blockingModalOpen: false,
      }),
    ).toBe(true);
  });

  // `pickerOpen` is defensive-only: at the only call site (edit-items.tsx,
  // inside the `showPicker ? <ProductPicker/> : (...)` else-branch) the FAB
  // renders solely when `showPicker` is false, so this case pins a guard
  // against a future re-layout, not a reachable render today.
  it("REG-B246: hidden while the product picker is open, even once pricing is ready", () => {
    expect(
      scanFabHidden({
        pricingReady: true,
        pickerOpen: true,
        priceModalOpen: false,
        blockingModalOpen: false,
      }),
    ).toBe(true);
  });

  it("REG-B246: hidden while the price-edit modal is open, even once pricing is ready", () => {
    expect(
      scanFabHidden({
        pricingReady: true,
        pickerOpen: false,
        priceModalOpen: true,
        blockingModalOpen: false,
      }),
    ).toBe(true);
  });

  // The other four modals on the edit screen are `<Modal transparent>` and
  // render OUTSIDE the `showPicker ? … : …` ternary, so the FAB is still on
  // screen behind their scrim unless the rule hides it.
  it("REG-B246: hidden while another blocking modal (unlisted item / credit note / licence or credit-limit guard) is open, even once pricing is ready", () => {
    expect(
      scanFabHidden({
        pricingReady: true,
        pickerOpen: false,
        priceModalOpen: false,
        blockingModalOpen: true,
      }),
    ).toBe(true);
  });

  it("REG-B246: visible once pricing is ready and neither the picker nor the price modal is open", () => {
    expect(
      scanFabHidden({
        pricingReady: true,
        pickerOpen: false,
        priceModalOpen: false,
        blockingModalOpen: false,
      }),
    ).toBe(false);
  });
});
