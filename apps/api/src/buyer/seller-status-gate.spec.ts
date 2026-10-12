import { ForbiddenException } from "@nestjs/common";
import {
  sellerAcceptsBuyerWrite,
  sellerReadOnlyBuyerGate,
  sellerUnavailableException,
} from "./seller-status-gate";

/**
 * SA-776: the ONE seller-status rule for a buyer write toward a seller. The buyer-seller context guard, the
 * invite acceptance and the seller request all ask this function; these cases are the whole decision table.
 */
describe("sellerAcceptsBuyerWrite", () => {
  const logger = { warn: jest.fn() };
  const ask = (sellerStatus: string, gate?: "dark" | "enforced") =>
    sellerAcceptsBuyerWrite({
      sellerStatus,
      sellerId: "tn-1",
      gate,
      logger,
      context: "POST /api/v1/buyer/orders",
    });

  beforeEach(() => logger.warn.mockClear());

  it.each(["ACTIVE", "TRIAL"])("%s seller: allowed, nothing logged (either gate)", (status) => {
    expect(ask(status, "dark")).toEqual({ allowed: true, wouldDeny: false });
    expect(ask(status, "enforced")).toEqual({ allowed: true, wouldDeny: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["SUSPENDED", "CANCELLED"])("%s seller: refused under BOTH gate values", (status) => {
    expect(ask(status, "dark")).toEqual({ allowed: false, reason: "SELLER_BLOCKED" });
    expect(ask(status, "enforced")).toEqual({ allowed: false, reason: "SELLER_BLOCKED" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("READ_ONLY seller + enforced: refused, no would-deny line", () => {
    expect(ask("READ_ONLY", "enforced")).toEqual({ allowed: false, reason: "SELLER_READ_ONLY" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("READ_ONLY seller + dark: allowed and exactly one would-deny line (seller id + route)", () => {
    expect(ask("READ_ONLY", "dark")).toEqual({ allowed: true, wouldDeny: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "seller_read_only.would_deny code=SELLER_UNAVAILABLE seller=tn-1 route=POST /api/v1/buyer/orders",
    );
  });

  it("with no explicit gate it reads SELLER_READ_ONLY_BUYER_GATE (default dark)", () => {
    const saved = process.env.SELLER_READ_ONLY_BUYER_GATE;
    try {
      delete process.env.SELLER_READ_ONLY_BUYER_GATE;
      expect(ask("READ_ONLY")).toEqual({ allowed: true, wouldDeny: true });
      process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
      expect(ask("READ_ONLY")).toEqual({ allowed: false, reason: "SELLER_READ_ONLY" });
    } finally {
      if (saved === undefined) delete process.env.SELLER_READ_ONLY_BUYER_GATE;
      else process.env.SELLER_READ_ONLY_BUYER_GATE = saved;
    }
  });

  it("an unknown gate value is dark", () => {
    expect(sellerReadOnlyBuyerGate({ SELLER_READ_ONLY_BUYER_GATE: "enforce" })).toBe("dark");
    expect(sellerReadOnlyBuyerGate({ SELLER_READ_ONLY_BUYER_GATE: " Enforced " })).toBe("enforced");
  });

  it("the refusal body is one fixed 403 SELLER_UNAVAILABLE with neutral copy", () => {
    const e = sellerUnavailableException();
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({
      code: "SELLER_UNAVAILABLE",
      message: "This seller isn't taking online orders right now. Please check back soon.",
    });
  });
});
