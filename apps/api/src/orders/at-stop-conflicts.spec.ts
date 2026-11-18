// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { AT_STOP_CONFLICT_MESSAGES, atStopConflict, paidOrderAtStop } from "./at-stop-conflicts";

/**
 * B796 (REG-B796) — every at-stop 409 carries a human `message`, with its `code`/`reason`
 * unchanged. Without one, B790's decline reason and the driver's toast read "Request failed with
 * status code 409".
 */
describe("B796 — at-stop refusals carry a human message (REG-B796)", () => {
  it.each([
    ["CHANGE_WINDOW_CLOSED:ORDER_STATUS", { code: "CHANGE_WINDOW_CLOSED", reason: "ORDER_STATUS" }],
    [
      "CHANGE_WINDOW_CLOSED:RUN_NOT_ACTIVE",
      { code: "CHANGE_WINDOW_CLOSED", reason: "RUN_NOT_ACTIVE" },
    ],
    ["STOP_ALREADY_COMPLETED", { code: "STOP_ALREADY_COMPLETED" }],
    ["ORDER_EDIT_INVOICE_HAS_PAYMENTS", { code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS" }],
  ] as const)("%s → a 409 with its code, reason and message", (kind, body) => {
    const err = atStopConflict(kind);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({ ...body, message: AT_STOP_CONFLICT_MESSAGES[kind] });
  });

  it("pins each message, so a wording change is deliberate", () => {
    expect(AT_STOP_CONFLICT_MESSAGES).toEqual({
      "CHANGE_WINDOW_CLOSED:ORDER_STATUS": "This order is no longer open for changes at the stop.",
      "CHANGE_WINDOW_CLOSED:RUN_NOT_ACTIVE":
        "This order's delivery run isn't in progress, so the change can't be applied at the stop.",
      STOP_ALREADY_COMPLETED:
        "This stop is already completed or skipped. Approve the request for the next delivery, or decline it.",
      ORDER_EDIT_INVOICE_HAS_PAYMENTS:
        "This order's invoice can't change at the door. The office can add these items on a new order.",
    });
  });

  it("SA-1144 case 22: the paid-order refusal is rethrown in the at-stop shape (409, same code, the driver's sentence); anything else passes through", () => {
    const refusal = new BadRequestException({
      code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS",
      message: "Remove its payments first",
    });
    const out = (() => {
      try {
        return paidOrderAtStop(refusal);
      } catch (e) {
        return e as ConflictException;
      }
    })();
    expect(out).toBeInstanceOf(ConflictException);
    expect(out.getResponse()).toEqual({
      code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS",
      message:
        "This order's invoice can't change at the door. The office can add these items on a new order.",
    });
    const other = new Error("boom");
    expect(() => paidOrderAtStop(other)).toThrow(other);
    const plain = new BadRequestException("plain");
    expect(() => paidOrderAtStop(plain)).toThrow(plain);
  });

  it("SA-1156 E5d-u: the source-gone refusal is rethrown in the at-stop shape; a Conflict with any other code passes through", () => {
    const gone = new ConflictException({
      code: "CREDIT_NOTE_SOURCE_GONE",
      message:
        "Credit note X came from a deleted invoice. Void that credit note first, then try again.",
    });
    const out = (() => {
      try {
        return paidOrderAtStop(gone);
      } catch (e) {
        return e as ConflictException;
      }
    })();
    expect(out).toBeInstanceOf(ConflictException);
    expect(out.getResponse()).toEqual({
      code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS",
      message:
        "This order's invoice can't change at the door. The office can add these items on a new order.",
    });
    const other = new ConflictException({ code: "SOMETHING_ELSE", message: "x" });
    expect(() => paidOrderAtStop(other)).toThrow(other);
    // a BadRequest carrying the source-gone code is not the refusal the helper maps
    const badRequest = new BadRequestException({ code: "CREDIT_NOTE_SOURCE_GONE", message: "x" });
    expect(() => paidOrderAtStop(badRequest)).toThrow(badRequest);
  });

  it("orders.service.ts throws no bare CHANGE_WINDOW_CLOSED / STOP_ALREADY_COMPLETED (all six via atStopConflict)", () => {
    const src = readFileSync(join(__dirname, "orders.service.ts"), "utf8");
    expect(src).not.toMatch(
      /new ConflictException\(\{\s*code: (?:"|API_ERROR_CODES\.)(CHANGE_WINDOW_CLOSED|STOP_ALREADY_COMPLETED)/,
    );
    expect(src.match(/throw atStopConflict\((?:"|API_ERROR_CODES\.|CHANGE_WINDOW_)/g)).toHaveLength(
      6,
    );
  });

  it("B987-B: the message keys are built from API_ERROR_CODES, never spelled as a bare code", () => {
    const src = readFileSync(join(__dirname, "at-stop-conflicts.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(src).not.toMatch(/["'`]\$?\{?(CHANGE_WINDOW_CLOSED|STOP_ALREADY_COMPLETED)/);
    expect(src).toContain("API_ERROR_CODES.CHANGE_WINDOW_CLOSED");
    expect(src).toContain("[API_ERROR_CODES.STOP_ALREADY_COMPLETED]");
  });

  describe("approveChangeRequestAtStop surfaces the message (snapshot-side refusals)", () => {
    let h: Awaited<ReturnType<typeof buildOrdersService>>;

    beforeEach(async () => {
      h = await buildOrdersService();
      h.prisma.changeRequest.findUnique.mockResolvedValue({
        id: "cr-1",
        tenantId: "test-tenant",
        orderId: "ord-1",
        orderItemId: null,
        productId: null,
        routeRunStopId: "stop-1",
        type: "NOTE",
        status: "PENDING",
        payload: { text: "please substitute if out" },
        note: null,
        requestedById: "user-x",
        requestedByName: "someone",
        requestedByRole: "DRIVER",
      });
    });

    const orderWith = (over: object) => ({
      id: "ord-1",
      customerId: "cust-1",
      status: "OUT_FOR_DELIVERY",
      lineItems: [],
      routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
      routeRunStop: { id: "stop-1", status: "PENDING" },
      ...over,
    });

    it.each([
      ["CHANGE_WINDOW_CLOSED:ORDER_STATUS", { status: "DELIVERED" }],
      [
        "CHANGE_WINDOW_CLOSED:RUN_NOT_ACTIVE",
        { routeRun: { id: "run-1", status: "COMPLETED", driverId: "drv-1" } },
      ],
      ["STOP_ALREADY_COMPLETED", { routeRunStop: { id: "stop-1", status: "COMPLETED" } }],
    ] as const)("%s", async (kind, over) => {
      h.prisma.order.findUnique.mockResolvedValue(orderWith(over));

      await expect(
        h.service.approveChangeRequestAtStop("cr-1", operatorPayload as never, null),
      ).rejects.toMatchObject({ response: { message: AT_STOP_CONFLICT_MESSAGES[kind] } });
      expect(h.prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    });
  });
});
