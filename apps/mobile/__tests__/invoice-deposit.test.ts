/**
 * #1529 (B87) / SA-517 PR-B: mobile's new-invoice screen offers the same OPT-IN deposit schedule
 * web's has (a percent + a due date), posting the same CreateInvoiceDto fields. The rules mirror
 * web's new-invoice page exactly: all-or-nothing — a percent with no due date, or a due date with no
 * percent, blocks submit; only a complete deposit is sent. No tenant/customer default is applied
 * (SA-517 item 3). The 0.01–99.99 range stays the server's (DTO), as on web.
 */
import { depositErrors, depositPayload } from "../lib/invoice-deposit";

describe("depositErrors (#1529, mirrors web)", () => {
  it("closed ⇒ never an error, whatever was typed", () => {
    expect(depositErrors(false, 50, "")).toEqual({});
    expect(depositErrors(false, null, "2026-10-01")).toEqual({});
  });

  it("a percent without a due date ⇒ the due date is required", () => {
    expect(depositErrors(true, 50, "")).toEqual({
      depositDueDate: "Deposit due date is required.",
    });
  });

  it("a due date without a positive percent ⇒ a percentage is required", () => {
    expect(depositErrors(true, null, "2026-10-01")).toEqual({
      depositPercent: "Enter a deposit percentage.",
    });
    expect(depositErrors(true, 0, "2026-10-01")).toEqual({
      depositPercent: "Enter a deposit percentage.",
    });
  });

  it("both set, or open but both empty ⇒ no error", () => {
    expect(depositErrors(true, 50, "2026-10-01")).toEqual({});
    expect(depositErrors(true, null, "")).toEqual({});
  });
});

describe("depositPayload (#1529, mirrors web)", () => {
  it("a complete deposit is sent as depositPercent + depositDueDate", () => {
    expect(depositPayload(true, 50, "2026-10-01")).toEqual({
      depositPercent: 50,
      depositDueDate: "2026-10-01",
    });
  });

  it("closed, incomplete or zero ⇒ nothing is sent (no half-set deposit, no default)", () => {
    expect(depositPayload(false, 50, "2026-10-01")).toEqual({});
    expect(depositPayload(true, 50, "")).toEqual({});
    expect(depositPayload(true, null, "2026-10-01")).toEqual({});
    expect(depositPayload(true, 0, "2026-10-01")).toEqual({});
  });
});
