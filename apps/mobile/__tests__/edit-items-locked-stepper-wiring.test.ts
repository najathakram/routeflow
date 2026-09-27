import { readFileSync } from "fs";
import { join } from "path";
import { readEditItemsSurface } from "./support/edit-items-source";

/**
 * #2232 (SA-388a UX follow-up): a LOCKED unit line — a stored line whose count can't be derived
 * (`needsRepair`, see lib/edit-items-draft.ts `unitLineCount`) — is refused at save. Its stepper must
 * also be visibly disabled, so the operator never edits a count that can't be saved.
 *
 * Mobile tests are pure-logic (no render harness), so this pins the WIRING: the screen passes the
 * line's `needsRepair` to its Qty StepperRow, and StepperRow disables both buttons and the input.
 */
// #2340: the Qty StepperRow lives in the DraftItemCard module now — read the edit-items surface.
const screen = readEditItemsSurface();
const stepper = readFileSync(
  join(__dirname, "..", "components", "EditItemsStepperRow.tsx"),
  "utf8",
);

describe("#2232 — a LOCKED unit line's stepper is disabled", () => {
  it("the unit line's Qty StepperRow receives disabled={item.needsRepair}", () => {
    // A unit line never takes the boxed branch (isBoxed requires !item.unitLabel), so its count is
    // edited through the single Qty StepperRow — the one labelled with item.unitLabel.
    const qtyRow = screen.match(/<StepperRow\s+label=\{`Qty\$\{item\.unitLabel[\s\S]*?\/>/);
    expect(qtyRow).not.toBeNull();
    expect(qtyRow![0]).toMatch(/disabled=\{!!item\.needsRepair\}/);
  });

  it("StepperRow takes a disabled prop and applies it to both buttons and the input", () => {
    expect(stepper).toMatch(/disabled\?: boolean;/);
    expect(stepper.match(/<Pressable[^>]*disabled=\{disabled\}/g) ?? []).toHaveLength(2);
    expect(stepper).toMatch(/editable=\{!disabled\}/);
    expect(stepper).toMatch(/accessibilityState=\{\{ disabled \}\}/);
  });
});
