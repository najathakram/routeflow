import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../../auth/decorators/roles.decorator";
import { OrdersController } from "../orders.controller";
import { CreateOrderDto } from "./create-order.dto";
import { CREATE_ORDER_MAX_ITEMS } from "./create-order-limits";
import { CreateSaleDto } from "./create-sale.dto";
import { ListOrdersDto } from "./list-orders.dto";
import { ResolveReviewFlagDto } from "./resolve-review-flag.dto";

// The real global ValidationPipe options (apps/api/src/main.ts): whitelist + forbidNonWhitelisted.
const OPTS = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = (cls: new () => object, body: object) =>
  validate(plainToInstance(cls, body) as object, OPTS);

const line = { index: 0, unitPrice: 10, unitsPerBox: null, unitLabel: null };
const offlineBody = (extra: Record<string, unknown> = {}) => ({
  customerId: "c1",
  items: [{ productId: "p1", qty: 1 }],
  offline: true,
  offlineCreatedAt: "2026-11-07T15:00:00.000Z",
  offlineQuote: { total: 10, lines: [line] },
  ...extra,
});

describe("CreateOrderDto: the offline fields (SA-1124 item 1)", () => {
  it("a well-formed offline body validates", async () => {
    expect(await errorsOf(CreateOrderDto, offlineBody())).toHaveLength(0);
  });

  it.each([
    ["a non-boolean offline", { offline: "yes" }],
    ["a malformed device time", { offlineCreatedAt: "last tuesday" }],
    ["a quote total with 3 decimals", { offlineQuote: { total: 10.005, lines: [line] } }],
    [
      "a quote line price with 3 decimals",
      { offlineQuote: { total: 10, lines: [{ ...line, unitPrice: 9.999 }] } },
    ],
    [
      "a negative quote line index",
      { offlineQuote: { total: 10, lines: [{ ...line, index: -1 }] } },
    ],
    ["a fractional pack", { offlineQuote: { total: 10, lines: [{ ...line, unitsPerBox: 2.5 }] } }],
    ["a quote with no lines array", { offlineQuote: { total: 10 } }],
  ])("%s is rejected", async (_name, extra) => {
    expect((await errorsOf(CreateOrderDto, offlineBody(extra))).length).toBeGreaterThan(0);
  });

  it("the quote's line cap is the items cap: one constant", async () => {
    expect(CREATE_ORDER_MAX_ITEMS).toBe(500);
    const lines = Array.from({ length: CREATE_ORDER_MAX_ITEMS + 1 }, (_, index) => ({
      ...line,
      index,
    }));
    const errors = await errorsOf(
      CreateOrderDto,
      offlineBody({ offlineQuote: { total: 1, lines } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("offline fields exist on CreateOrderDto only (counter sale and sell stay without them)", async () => {
    const body = { customerId: "c1", items: [{ productId: "p1", qty: 1 }], offline: true };
    const errors = await errorsOf(CreateSaleDto as never, body);
    expect(errors.some((e) => e.property === "offline" && e.constraints?.whitelistValidation)).toBe(
      true,
    );
  });
});

describe("ListOrdersDto.needsReview", () => {
  it("only the literal true filters", async () => {
    const t: any = plainToInstance(ListOrdersDto, { needsReview: "true" });
    const f: any = plainToInstance(ListOrdersDto, { needsReview: "false" });
    const x: any = plainToInstance(ListOrdersDto, { needsReview: "1" });
    expect([t.needsReview, f.needsReview, x.needsReview]).toEqual([true, undefined, undefined]);
    expect(await validate(t, OPTS)).toHaveLength(0);
  });
});

describe("ResolveReviewFlagDto", () => {
  it("trims, and holds the note to 3 to 500 characters (the table's CHECK)", async () => {
    const ok: any = plainToInstance(ResolveReviewFlagDto, { resolution: "  Checked it  " });
    expect(await validate(ok, OPTS)).toHaveLength(0);
    expect(ok.resolution).toBe("Checked it");
    for (const resolution of ["  ab ", "x".repeat(501), 5, undefined]) {
      expect((await errorsOf(ResolveReviewFlagDto, { resolution })).length).toBeGreaterThan(0);
    }
  });
});

describe("POST /orders/:id/review-flags/:flagId/resolve", () => {
  const fn = OrdersController.prototype.resolveReviewFlag;

  it("is a POST on the sub-resource that answers 200, OPERATOR and above only", () => {
    expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(":id/review-flags/:flagId/resolve");
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, fn)).toBe(200);
    expect(Reflect.getMetadata(ROLES_KEY, fn)).toEqual([UserRole.OPERATOR]);
  });
});
