/**
 * #2266 (SA-388d): SA-388 locks every unit line with no derivable count, and labelled them all
 * "needs repair". But a PARTIAL Case — e.g. 40 pieces on a 12-pack delivered short — is a
 * legitimate physical quantity (SA-178 / B652). Only SA-388d's all-empty split is a repair case:
 * a unit line (unitLabel set, factor > 1, qty > 0) whose boxes AND pieces are both 0/null — the
 * shape the DB CHECK refuses. A valid partial line shows whole units + remainder ("3 Cases +
 * 4 pcs") and stays not count-editable; the save refusal stays. Fixtures are base pieces.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { buildEditItemFromLine } from "./page";
import {
  LockedUnitLineBadge,
  lockedUnitLineDisplay,
  lockedUnitLineRefusal,
  isEmptyUnitLineSplit,
} from "./_components/unit-line-lock";
import type { OrderItem } from "@/lib/api/orders";

const line = (
  qty: number,
  boxes: number | null,
  pieces: number | null,
  factor = 12,
  unitLabel: string | null = "Case",
): OrderItem =>
  ({
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Widget", unit: "Box", unitsPerBox: factor },
    qty,
    unitPrice: 40,
    boxes,
    pieces,
    unitsPerBox: factor,
    unitLabel,
    status: "DELIVERED",
  }) as OrderItem;

describe("isEmptyUnitLineSplit — SA-388d's repair shape only (#2266)", () => {
  it.each([
    ["{40, 0, 0}", line(40, 0, 0)],
    ["{40, null, null}", line(40, null, null)],
    ["{36, 0, 0}", line(36, 0, 0)],
  ])("%s on a 12-pack Case line ⇒ repair", (_l, li) => {
    expect(isEmptyUnitLineSplit(li)).toBe(true);
  });

  it.each([
    ["a partial Case {40, 0, 40}", line(40, 0, 40)],
    ["a partial Case {40, null, 40}", line(40, null, 40)],
    ["a whole-Case split {36, 3, 0}", line(36, 3, 0)],
    ["a factor-1 Each line stores no split {5, 0, 0}", line(5, 0, 0, 1, "Each")],
    ["a pack line (no unitLabel) {40, 0, 0}", line(40, 0, 0, 12, null)],
    ["a zero-qty row {0, 0, 0}", line(0, 0, 0)],
  ])("%s ⇒ not repair", (_l, li) => {
    expect(isEmptyUnitLineSplit(li)).toBe(false);
  });
});

describe("lockedUnitLineDisplay (#2266)", () => {
  it("a valid partial line reads as whole units + remainder", () => {
    expect(lockedUnitLineDisplay(line(40, 0, 40))).toEqual({
      needsRepair: false,
      text: "3 Cases + 4 pcs",
    });
    expect(lockedUnitLineDisplay(line(4, null, 4))).toEqual({ needsRepair: false, text: "4 pcs" });
  });

  it("the all-empty split still needs repair", () => {
    expect(lockedUnitLineDisplay(line(40, 0, 0))).toEqual({ needsRepair: true, text: null });
  });
});

describe("LockedUnitLineBadge (#2266)", () => {
  it("a partial line shows its quantity, not 'needs repair'", () => {
    render(<LockedUnitLineBadge display={{ needsRepair: false, text: "3 Cases + 4 pcs" }} />);
    expect(screen.getByRole("status").textContent).toBe("3 Cases + 4 pcs");
    expect(screen.queryByText(/needs repair/)).toBeNull();
  });

  it("a repair line keeps 'This line needs repair'", () => {
    render(<LockedUnitLineBadge display={{ needsRepair: true, text: null }} />);
    expect(screen.getByRole("status").textContent).toBe("This line needs repair");
  });
});

describe("buildEditItemFromLine carries the display; the lock itself is unchanged (#2266)", () => {
  it("a partial Case is still LOCKED (not count-editable) but displays 3 Cases + 4 pcs", () => {
    const seeded = buildEditItemFromLine(line(40, 0, 40));
    expect(seeded.countLocked).toBe(true);
    expect(seeded.lockedDisplay).toEqual({ needsRepair: false, text: "3 Cases + 4 pcs" });
  });

  it("an unlocked line carries no locked display", () => {
    expect(buildEditItemFromLine(line(36, 3, 0)).lockedDisplay).toBeUndefined();
  });
});

describe("the save refusal names the right reason (#2266)", () => {
  it("a partial line: can't be edited as a count; cancel and re-add", () => {
    const msg = lockedUnitLineRefusal("Widget", { needsRepair: false, text: "3 Cases + 4 pcs" });
    expect(msg).toMatch(/Widget is a partial quantity \(3 Cases \+ 4 pcs\)/);
    expect(msg).not.toMatch(/needs repair/);
    expect(msg).toMatch(/Nothing was saved\.$/);
  });

  it("a repair line keeps the needs-repair message", () => {
    expect(lockedUnitLineRefusal("Widget", { needsRepair: true, text: null })).toMatch(
      /^Widget needs repair/,
    );
  });
});
