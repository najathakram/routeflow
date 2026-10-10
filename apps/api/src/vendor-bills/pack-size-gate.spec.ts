import { type Logger } from "@nestjs/common";
import {
  assertPackSizeKnownOrLog,
  isPackSizeGateEnforced,
  type PackSizeGateLine,
} from "./pack-size-gate";

function mockLogger() {
  const warn = jest.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

const boxedLine: PackSizeGateLine = {
  id: "item-1",
  lineIndex: 0,
  description: "Widget case",
  productId: "prod-1",
  packSize: null,
  qty: 2,
  unitCost: 10,
  product: { name: "Widget", unitsPerBox: 12 },
};

describe("isPackSizeGateEnforced (Opus review finding 5 — code constant + env var)", () => {
  it("stays dark with the env var 'on' — PACK_SIZE_GATE_READY_FOR_ENFORCEMENT is false until PR D flips it", () => {
    // The P0-class trap this guards: an env var ALONE let PLAN_FLAG_ENFORCEMENT
    // flip in production before its own prerequisite had shipped
    // (plan-flag-policy.ts:29). This gate requires the source-level constant
    // too, so an infra-only env change can never enable it on its own.
    expect(isPackSizeGateEnforced({ PACK_SIZE_GATE_ENFORCED: "on" } as any)).toBe(false);
  });

  it("stays dark with no env var either (the default)", () => {
    expect(isPackSizeGateEnforced({} as any)).toBe(false);
  });
});

describe("assertPackSizeKnownOrLog — dark log detail (Opus review finding 2)", () => {
  it("logs path, bill (id+number), tenant, line count, and each unknown line's productId/productPack", () => {
    const { logger, warn } = mockLogger();
    assertPackSizeKnownOrLog(logger, "tenant-1", [boxedLine], false, {
      path: "receive",
      billId: "bill-1",
      billNumber: "B-0001",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("path=receive");
    expect(message).toContain("bill=bill-1(B-0001)");
    expect(message).toContain("tenant=tenant-1");
    expect(message).toContain("lines=1");
    expect(message).toContain("prod-1:pack=12");
  });

  it("logs bill=new for the raise-PO path, which runs before a bill exists", () => {
    const { logger, warn } = mockLogger();
    assertPackSizeKnownOrLog(logger, "tenant-1", [{ ...boxedLine, id: null }], false, {
      path: "raise-po",
      billId: null,
      billNumber: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("path=raise-po");
    expect(message).toContain("bill=new");
  });

  it("carries every unknown line's product, not just the first, when several are ambiguous", () => {
    const { logger, warn } = mockLogger();
    const second: PackSizeGateLine = {
      ...boxedLine,
      id: "item-2",
      lineIndex: 1,
      productId: "prod-2",
      product: { name: "Gadget", unitsPerBox: 24 },
    };
    assertPackSizeKnownOrLog(logger, "tenant-1", [boxedLine, second], false, {
      path: "receive",
      billId: "bill-1",
      billNumber: "B-0001",
    });
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("lines=2");
    expect(message).toContain("prod-1:pack=12");
    expect(message).toContain("prod-2:pack=24");
  });

  it("never logs (and never throws) while dark with no unknown lines", () => {
    const { logger, warn } = mockLogger();
    assertPackSizeKnownOrLog(logger, "tenant-1", [], false, { path: "receive" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("never logs a line the classifier resolves as known ('case') or 'loose'", () => {
    const { logger, warn } = mockLogger();
    const knownCase: PackSizeGateLine = { ...boxedLine, packSize: 12 };
    const loose: PackSizeGateLine = {
      ...boxedLine,
      id: "item-3",
      product: { name: "Loose thing", unitsPerBox: 1 },
    };
    assertPackSizeKnownOrLog(logger, "tenant-1", [knownCase, loose], false, { path: "receive" });
    expect(warn).not.toHaveBeenCalled();
  });
});
