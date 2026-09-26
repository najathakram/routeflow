/**
 * #2230 / SA-388g, Opus delta on #2274: drive the REAL writer, not a hand-fed shape. A legacy unit order
 * line with no split (Case, pack 12, qty 36, boxes/pieces NULL) reaching buildInvoiceItemData must be
 * refused with a 409 that NAMES the product, and the Sentry report must carry that row's id — the
 * fields the call site itself passes to assertUnitLineSplit.
 */
jest.mock("@sentry/node", () => ({ captureMessage: jest.fn() }));
// InvoicesService pulls ESM-only deps (same guard as invoices.service.spec.ts).
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { ConflictException } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { InvoicesService } from "./invoices.service";
import { orderLineShape } from "./order-backsync-lines";

const capture = Sentry.captureMessage as unknown as jest.Mock;

describe("buildInvoiceItemData refuses a legacy all-empty unit line by name (#2230)", () => {
  const legacy = {
    id: "oi-legacy-1",
    productId: "p-cola",
    product: { name: "Cola 12oz", unitsPerBox: 12 },
    unitLabel: "Case",
    unitsPerBox: 12,
    qty: 36,
    boxes: null,
    pieces: null,
    unitPrice: 40,
    subtotal: 120,
  };
  const build = (li: unknown) =>
    (InvoicesService.prototype as any).buildInvoiceItemData.call({}, li, 36, "tenant-x");

  beforeEach(() => capture.mockClear());

  it("throws a 409 naming the product, and reports that row's id once", () => {
    let err: any;
    try {
      build(legacy);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      code: "UNIT_LINE_SPLIT_MISSING",
      message:
        "Cola 12oz is sold by the Case but its Case/Each split is missing — ask support to repair " +
        "this line before invoicing",
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toEqual({
      level: "error",
      extra: { where: "buildInvoiceItemData", lineIds: ["oi-legacy-1"] },
    });
  });

  it("a whole-Case unit line is billed and never reported", () => {
    expect(build({ ...legacy, boxes: 3, pieces: 0 })).toMatchObject({
      unitLabel: "Case",
      boxes: 3,
      pieces: 0,
      orderItemId: "oi-legacy-1",
    });
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("the invoice -> order back-sync refuses a legacy all-empty unit line by its id (#2230)", () => {
  beforeEach(() => capture.mockClear());

  it("orderLineShape over a legacy null-split Case line throws the 409 and reports that order line's id", () => {
    const existing = {
      id: "oi-legacy-2",
      productId: "p-cola",
      name: null,
      unitLabel: "Case",
      unitsPerBox: 12,
      qty: 24,
      boxes: null,
      pieces: null,
    };
    const agg = {
      qty: 36,
      n: 1,
      sample: {
        boxes: null,
        pieces: null,
        unitsPerBox: 12,
        description: "Cola 12oz",
        productId: "p-cola",
      },
    };
    let err: any;
    try {
      orderLineShape(existing, agg);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/^Cola 12oz is sold by the Case/);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toEqual({
      level: "error",
      extra: { where: "orderLineShape", lineIds: ["oi-legacy-2"] },
    });
  });
});
