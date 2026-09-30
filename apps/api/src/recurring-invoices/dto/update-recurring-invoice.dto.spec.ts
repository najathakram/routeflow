import { ValidationPipe } from "@nestjs/common";

/**
 * F13 / B92 — `PATCH /recurring-invoices/:id` is unvalidated today (paramtype
 * `Object` in the compiled controller). Dynamic require + try/catch so this
 * file compiles and runs before `UpdateRecurringInvoiceDto` exists: T29 fails
 * on its own `toBeDefined()` assertion, not an import/build error.
 */
const Dto = (() => {
  try {
    return require("./update-recurring-invoice.dto").UpdateRecurringInvoiceDto;
  } catch {
    return undefined;
  }
})();

describe("UpdateRecurringInvoiceDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const meta = { type: "body" as const, metatype: Dto, data: "" };

  it("REG-B92 T29 — a partial body such as { notes } validates against the DTO class", async () => {
    expect(Dto).toBeDefined();
    await expect(pipe.transform({ notes: "x" }, meta)).resolves.toEqual({ notes: "x" });
  });

  it("T30 — rejects a non-whitelisted key (isActive)", async () => {
    await expect(pipe.transform({ isActive: true }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("T30 — rejects an empty items array", async () => {
    await expect(pipe.transform({ items: [] }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("T30 — rejects an item with a non-numeric qty", async () => {
    await expect(
      pipe.transform({ items: [{ description: "x", qty: "abc", unitPrice: 1 }] }, meta),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("T30 — accepts a full create-shaped body", async () => {
    const full = {
      customerId: "11111111-1111-4111-8111-111111111111",
      frequency: "MONTHLY",
      dayOfMonth: 15,
      nextRunAt: "2026-08-15T00:00:00.000Z",
      items: [{ description: "d", qty: 1, unitPrice: 5 }],
    };
    await expect(pipe.transform({ ...full }, meta)).resolves.toMatchObject(full);
  });
});
