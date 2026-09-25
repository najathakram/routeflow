import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateOrderDto } from "./create-order.dto";
import { UpdateOrderItemsDto } from "./update-order-items.dto";
import { InlineReturnLinesDto } from "../../returns/dto/capture-inline-return.dto";

/**
 * #2094 PR-A (SA-194): the nested `inlineReturn` payload on POST /orders and the order-items edit.
 * Customer and order are DERIVED from the document, never client-supplied, and the same global
 * ValidationPipe options main.ts sets (whitelist + forbidNonWhitelisted) apply to the nested object.
 */
const PIPE = { whitelist: true, forbidNonWhitelisted: true };
const lines = () => ({
  returnKey: "attempt-1",
  items: [{ productId: "prod-1", boxes: 0, pieces: 6 }],
});

const errorsOf = async (cls: any, body: Record<string, unknown>) =>
  validate(plainToInstance(cls, body), PIPE);
const flat = (errs: any[], prefix = ""): string[] =>
  errs.flatMap((e) => [
    ...(e.constraints ? [`${prefix}${e.property}`] : []),
    ...flat(e.children ?? [], `${prefix}${e.property}.`),
  ]);

const create = (extra: Record<string, unknown>) => ({
  customerId: "cust-1",
  items: [{ productId: "prod-1", qty: 1 }],
  ...extra,
});
const edit = (extra: Record<string, unknown>) => ({
  items: [{ productId: "prod-1", qty: 1 }],
  ...extra,
});

describe.each([["CreateOrderDto", CreateOrderDto, create]] as const)(
  "%s.inlineReturn (#2094)",
  (_name, cls, build) => {
    it("accepts a well-formed inlineReturn", async () => {
      expect(await errorsOf(cls, build({ inlineReturn: lines() }))).toHaveLength(0);
    });

    it("is optional: a payload without it is unchanged", async () => {
      expect(await errorsOf(cls, build({}))).toHaveLength(0);
    });

    it("requires the per-attempt returnKey", async () => {
      const { returnKey: _omit, ...noKey } = lines();
      expect(flat(await errorsOf(cls, build({ inlineReturn: noKey })))).toContain(
        "inlineReturn.returnKey",
      );
    });

    it("requires at least one item", async () => {
      const bad = { ...lines(), items: [] };
      expect(flat(await errorsOf(cls, build({ inlineReturn: bad })))).toContain(
        "inlineReturn.items",
      );
    });

    it("caps the per-attempt nonce at 128 characters", async () => {
      const bad = { ...lines(), returnKey: "k".repeat(129) };
      expect(flat(await errorsOf(cls, build({ inlineReturn: bad })))).toContain(
        "inlineReturn.returnKey",
      );
      const ok = { ...lines(), returnKey: "k".repeat(128) };
      expect(await errorsOf(cls, build({ inlineReturn: ok }))).toHaveLength(0);
    });

    it.each(["customerId", "orderId", "tenantId"])(
      "refuses a client-supplied %s inside inlineReturn (derived from the document)",
      async (field) => {
        const bad = { ...lines(), [field]: "x" };
        expect(flat(await errorsOf(cls, build({ inlineReturn: bad })))).toContain(
          `inlineReturn.${field}`,
        );
      },
    );

    it("refuses an unknown property on a nested item", async () => {
      const bad = { ...lines(), items: [{ productId: "prod-1", boxes: 0, pieces: 6, price: 1 }] };
      expect(flat(await errorsOf(cls, build({ inlineReturn: bad })))).toContain(
        "inlineReturn.items.0.price",
      );
    });
  },
);

/**
 * The edit path (updateOrderItems) is NOT wired yet, so its DTO must not accept the field: a silently
 * ignored `inlineReturn` would tell the client a return was recorded when it was not. Fail closed
 * (the pipe's forbidNonWhitelisted 400) until the edit path lands, then this flips to the shared
 * describe.each above.
 */
describe("UpdateOrderItemsDto refuses inlineReturn until the edit path is wired (#2094)", () => {
  it("is a whitelist error today", async () => {
    expect(flat(await errorsOf(UpdateOrderItemsDto, edit({ inlineReturn: lines() })))).toContain(
      "inlineReturn",
    );
  });
});

describe("InlineReturnLinesDto is what CaptureInlineReturnDto builds on", () => {
  it("exists as its own exported class", () => {
    expect(typeof InlineReturnLinesDto).toBe("function");
  });
});
