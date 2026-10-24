import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateInvoiceDto } from "./create-invoice.dto";
import { UpdateInvoiceDto } from "./update-invoice.dto";

/**
 * H3b: the invoice line's optional `overrideReason` (the staff reason a price moves off the customer's
 * tier price), on POST /invoices AND on the PATCH line (UpdateInvoiceItemDto extends the create line).
 * Mirrors OrderItemDto: a string capped at 200, and trimmed on the way in. Uses the real global
 * ValidationPipe options (apps/api/src/main.ts): { whitelist: true, forbidNonWhitelisted: true }.
 */
const UUID = "11111111-1111-4111-8111-111111111111";
const line = (extra: Record<string, unknown>) => ({
  description: "Chips",
  qty: 5,
  unitPrice: 11,
  ...extra,
});
const create = (extra: Record<string, unknown>) =>
  plainToInstance(CreateInvoiceDto, { customerId: UUID, items: [line(extra)] });
const update = (extra: Record<string, unknown>) =>
  plainToInstance(UpdateInvoiceDto, { items: [line(extra)] });
const opts = { whitelist: true, forbidNonWhitelisted: true };

describe("invoice line overrideReason (H3b)", () => {
  it.each([
    ["create", create],
    ["update", update],
  ])("%s: is accepted, whitelisted and trimmed", async (_n, make) => {
    const dto = make({ overrideReason: "  agreed at list  " });
    expect(await validate(dto, opts)).toEqual([]);
    expect((dto.items as Array<{ overrideReason?: string }>)[0].overrideReason).toBe(
      "agreed at list",
    );
  });

  it.each([
    ["create", create],
    ["update", update],
  ])("%s: is optional", async (_n, make) => {
    expect(await validate(make({}), opts)).toEqual([]);
  });

  it.each([
    ["create", create],
    ["update", update],
  ])("%s: 200 characters pass, 201 fail", async (_n, make) => {
    expect(await validate(make({ overrideReason: "x".repeat(200) }), opts)).toEqual([]);
    expect(
      (await validate(make({ overrideReason: "x".repeat(201) }), opts)).length,
    ).toBeGreaterThan(0);
  });

  it("a non-string reason is rejected", async () => {
    expect((await validate(create({ overrideReason: 5 }), opts)).length).toBeGreaterThan(0);
  });

  it("the cap counts the TRIMMED text (padding does not eat the 200)", async () => {
    expect(await validate(create({ overrideReason: `  ${"x".repeat(200)}  ` }), opts)).toEqual([]);
  });
});
