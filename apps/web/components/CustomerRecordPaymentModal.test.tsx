import { clampAllocationInput } from "./CustomerRecordPaymentModal";

// B313: mobile's payments/record.tsx caps each allocation row at the invoice's balance
// ("Cap at the invoice's balance — the server would happily over-pay it"), but this web
// modal edited the raw string with no cap at all — an operator could allocate past an
// invoice's amountDue here while mobile silently clamped the identical input.
describe("REG-B313 clampAllocationInput", () => {
  it("caps an over-allocation at the invoice's amountDue", () => {
    // Before the fix, updateAlloc stored the raw string verbatim — "500" past a $100 balance.
    expect(clampAllocationInput("500", 100)).toBe("100");
  });

  it("clamps a negative value up to 0", () => {
    expect(clampAllocationInput("-20", 100)).toBe("0");
  });

  it("leaves an in-range value completely untouched", () => {
    expect(clampAllocationInput("40", 100)).toBe("40");
  });

  it("passes blank input through so the field stays editable while typing", () => {
    expect(clampAllocationInput("", 100)).toBe("");
  });

  it("passes unparseable input through rather than coercing to a number", () => {
    expect(clampAllocationInput("abc", 100)).toBe("abc");
  });

  it("rounds an OUT-OF-RANGE value to cents when capping it (@routeflow/pricing roundMoney)", () => {
    expect(clampAllocationInput("133.3339", 100)).toBe("100");
  });

  // Opus review (F39): an earlier version reformatted every keystroke through
  // roundMoney/String, which rewrote "12.50" to "12.5" mid-type and made a cents-ending-in-0
  // value impossible to type. An in-range decimal-in-progress must survive verbatim.
  it("does NOT reformat an in-range value — a decimal in progress (or a trailing zero) survives every keystroke", () => {
    expect(clampAllocationInput("12.50", 100)).toBe("12.50");
    expect(clampAllocationInput("33.3339", 100)).toBe("33.3339");
    expect(clampAllocationInput("12.", 100)).toBe("12.");
  });
});
