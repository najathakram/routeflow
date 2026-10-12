import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateOrderItemsDto } from "./update-order-items.dto";

/**
 * Multi-line per-item notes: `UpdateOrderItemDto.notes` had no `@MaxLength` at all — the create
 * path already capped at 2000 (`OrderItemDto.notes`), so an edit could write an unbounded note the
 * create path would have refused. Closing that gap here, not raising it — 2000 is create's own
 * existing cap, kept in step rather than picked fresh.
 */
describe("UpdateOrderItemsDto — items[].notes is bounded (was unbounded)", () => {
  function payloadWithNote(notes: string) {
    return plainToInstance(UpdateOrderItemsDto, {
      items: [{ id: "li-1", action: "UPDATE", notes }],
    });
  }

  it("refuses a note over 2000 characters", async () => {
    const errors = await validate(payloadWithNote("x".repeat(2001)));
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    const notesError = itemErrors.find((e) => e.property === "notes");
    expect(notesError?.constraints).toHaveProperty("maxLength");
  });

  it("accepts a note at exactly 2000 characters — the same cap the create path enforces", async () => {
    const errors = await validate(payloadWithNote("x".repeat(2000)));
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    expect(itemErrors.find((e) => e.property === "notes")).toBeUndefined();
  });

  it("accepts a genuinely multi-line note well under the cap", async () => {
    const errors = await validate(payloadWithNote("line one\nline two\nline three"));
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    expect(itemErrors.find((e) => e.property === "notes")).toBeUndefined();
  });
});

/**
 * SA-124i (option i, #938): `sourceLineId` (the fold -> updateOrderItems disambiguator,
 * ./replace-all-line-build.ts) is deliberately NOT a DTO field — "no column, no DTO field, no
 * migration" — it only ever travels on the INTERNAL call the controller makes after running
 * `foldMergeItems` (orders.controller.ts:225, buyer.controller.ts:617), never through the
 * public HTTP body. main.ts's global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true` (src/main.ts:145-148) — this pins that a CLIENT attempting to
 * smuggle one in over HTTP still gets refused (400), not silently stripped or accepted.
 */
describe("UpdateOrderItemsDto — sourceLineId is not a client-facing field (SA-124i)", () => {
  it("a client-supplied items[].sourceLineId is refused under the app's actual whitelist/forbidNonWhitelisted config", async () => {
    const dto = plainToInstance(UpdateOrderItemsDto, {
      replaceAll: true,
      items: [{ productId: "prod-1", qty: 1, sourceLineId: "li-someone-elses" }],
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    const sourceLineIdError = itemErrors.find((e) => e.property === "sourceLineId");
    expect(sourceLineIdError?.constraints).toHaveProperty("whitelistValidation");
  });
});

/**
 * B297 row 352: the buyer's PATCH items edit names the stored line each entry edits with
 * `items[].orderItemId` — the one PUBLIC line-naming field (the internal `sourceLineId` above stays refused;
 * the buyer branch maps a validated `orderItemId` onto it after confirming the line is on this order).
 */
describe("UpdateOrderItemsDto — items[].orderItemId (row 352)", () => {
  const check = async (orderItemId: unknown) => {
    const dto = plainToInstance(UpdateOrderItemsDto, {
      replaceAll: true,
      items: [{ productId: "prod-1", qty: 1, orderItemId }],
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    return itemErrors.find((e) => e.property === "orderItemId");
  };

  it("accepts a string id under the app's whitelist config", async () => {
    expect(await check("li-1")).toBeUndefined();
  });

  it("refuses a non-string id", async () => {
    expect((await check(42))?.constraints).toHaveProperty("isString");
  });

  it("namesLines is an accepted boolean flag, and refuses a non-boolean", async () => {
    const ok = plainToInstance(UpdateOrderItemsDto, {
      replaceAll: true,
      namesLines: true,
      items: [{ productId: "prod-1", qty: 1 }],
    });
    expect(await validate(ok, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    const bad = plainToInstance(UpdateOrderItemsDto, {
      replaceAll: true,
      namesLines: "yes",
      items: [{ productId: "prod-1", qty: 1 }],
    });
    const errors = await validate(bad, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.find((e) => e.property === "namesLines")?.constraints).toHaveProperty(
      "isBoolean",
    );
  });
});
