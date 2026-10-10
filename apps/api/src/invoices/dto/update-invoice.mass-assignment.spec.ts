import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateInvoiceDto } from "./update-invoice.dto";

/**
 * SA-186 / SA-189 (B670): the optional line `id` and explicit `unitsPerBox` on the PATCH body. They
 * select a row / attest a pack and can write nothing else. Uses the real global ValidationPipe options
 * (apps/api/src/main.ts): { whitelist: true, forbidNonWhitelisted: true }.
 */
const UUID = "11111111-1111-4111-8111-111111111111";
const body = (item: Record<string, unknown>) =>
  plainToInstance(UpdateInvoiceDto, {
    items: [{ description: "Chips", qty: 5, unitPrice: 11, ...item }],
  });
const errorsOf = async (item: Record<string, unknown>) =>
  validate(body(item), { whitelist: true, forbidNonWhitelisted: true });
const flat = (errors: Awaited<ReturnType<typeof errorsOf>>): string =>
  JSON.stringify(errors, (_k, v) =>
    v instanceof Object && "target" in v ? { ...v, target: undefined } : v,
  );

describe("UpdateInvoiceDto line id / unitsPerBox — mass assignment", () => {
  it("accepts a uuid id and an explicit pack of 2 or more", async () => {
    expect(await errorsOf({ id: UUID, unitsPerBox: 12 })).toEqual([]);
  });

  it.each([
    ["a non-uuid id", { id: "item-1" }],
    ["a pack of 1", { unitsPerBox: 1 }],
    ["a fractional pack", { unitsPerBox: 12.5 }],
    ["a string pack", { unitsPerBox: "12" }],
  ])("rejects %s", async (_l, item) => {
    expect((await errorsOf(item)).length).toBeGreaterThan(0);
  });

  it.each(["subtotal", "tenantId", "invoiceId", "categoryTaxAmount", "createdAt"])(
    "an id line cannot smuggle the server-owned field %s (whitelist rejects it)",
    async (field) => {
      const errors = await errorsOf({ id: UUID, [field]: "attacker" });
      expect(flat(errors)).toContain("whitelistValidation");
      expect(flat(errors)).toContain(field);
    },
  );
});
