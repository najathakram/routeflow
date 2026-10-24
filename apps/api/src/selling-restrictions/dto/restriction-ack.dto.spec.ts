import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ReopenOrderDto } from "../../orders/dto/reopen-order.dto";
import { ResolveChangeRequestDto } from "../../orders/dto/resolve-change-request.dto";
import { UpdateFulfillPathDto } from "../../orders/dto/update-fulfill-path.dto";
import { ChangeOrderStatusDto } from "../../orders/dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "../../orders/dto/update-order-items.dto";
import { CreateOrderDto } from "../../orders/dto/create-order.dto";
import { CreateSaleDto } from "../../orders/dto/create-sale.dto";
import { CreateInvoiceDto } from "../../invoices/dto/create-invoice.dto";
import { UpdateInvoiceDto } from "../../invoices/dto/update-invoice.dto";
import { DuplicateInvoiceDto } from "../../invoices/dto/duplicate-invoice.dto";
import { ConvertEstimateDto } from "../../estimates/dto/convert-estimate.dto";

/**
 * Row 510: every body of a staff write that can sell a restricted product accepts the acknowledgement fields
 * (`restrictionOverrides`, `warningHash`) under the app's global pipe (whitelist + forbidNonWhitelisted). The routes
 * that had no body (reopen, duplicate, estimate convert) accept an EMPTY body, and carry the ack alone on a resubmit.
 */
const ACK = {
  restrictionOverrides: [{ lineKey: "n:0", reason: "Customer is licensed" }],
  warningHash: "rw1:" + "a".repeat(64),
};
const PIPE = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = (cls: new () => object, body: object) =>
  validateSync(plainToInstance(cls, body) as object, PIPE);
const ackErrors = (cls: new () => object, body: object) =>
  errorsOf(cls, body).filter((e) => ["restrictionOverrides", "warningHash"].includes(e.property));

describe("the acknowledgement fields", () => {
  const MIN: Array<[string, new () => object, object]> = [
    ["CreateOrderDto", CreateOrderDto, { items: [{ productId: "p", qty: 1 }] }],
    ["UpdateOrderItemsDto", UpdateOrderItemsDto, { items: [{ id: "x", qty: 1 }] }],
    ["ChangeOrderStatusDto", ChangeOrderStatusDto, { status: "PENDING" }],
    ["ResolveChangeRequestDto", ResolveChangeRequestDto, { action: "APPROVE_AT_STOP" }],
    ["UpdateFulfillPathDto", UpdateFulfillPathDto, { fulfillPath: "PICKUP" }],
    ["DuplicateInvoiceDto", DuplicateInvoiceDto, {}],
    ["ConvertEstimateDto", ConvertEstimateDto, {}],
    ["ReopenOrderDto", ReopenOrderDto, {}],
  ];

  it.each(MIN)("%s accepts the ack (nothing else is wrong with it)", (_n, cls, body) => {
    expect(errorsOf(cls, { ...body, ...ACK })).toEqual([]);
    expect(errorsOf(cls, body)).toEqual([]); // and a bare body (no ack) stays valid
  });

  it.each([
    ["CreateSaleDto", CreateSaleDto],
    ["CreateInvoiceDto", CreateInvoiceDto],
    ["UpdateInvoiceDto", UpdateInvoiceDto],
    ["CreateOrderDto", CreateOrderDto],
  ])("%s declares both fields (not rejected as non-whitelisted)", (_n, cls) => {
    expect(ackErrors(cls, ACK)).toEqual([]);
  });

  it.each(MIN)(
    "%s refuses an over-long hash, a non-array override list and an over-long lineKey",
    (_n, cls, body) => {
      expect(ackErrors(cls, { ...body, warningHash: "x".repeat(81) })).not.toEqual([]);
      expect(ackErrors(cls, { ...body, restrictionOverrides: "n:0" })).not.toEqual([]);
      expect(
        errorsOf(cls, {
          ...body,
          restrictionOverrides: [{ lineKey: "k".repeat(81), reason: "fine" }],
        }),
      ).not.toEqual([]);
    },
  );

  it("an unknown extra field is still rejected (the ack did not open the whitelist)", () => {
    expect(errorsOf(ReopenOrderDto, { surprise: true }).length).toBeGreaterThan(0);
  });
});
