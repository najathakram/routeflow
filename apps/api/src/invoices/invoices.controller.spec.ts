import { InvoicesController } from "./invoices.controller";
import { UpdateInvoiceDto } from "./dto/update-invoice.dto";

/**
 * B777 — the actual erasure bug: `update(id, dto: Partial<CreateInvoiceDto>)` compiled with
 * `design:paramtypes` naming `Object` for the body param (a mapped TS type carries no runtime
 * class), which is what makes the global ValidationPipe (whitelist + forbidNonWhitelisted,
 * main.ts:145-149) skip the body entirely — `update-invoice.dto.spec.ts` proves the DTO class
 * itself validates correctly; this proves the controller actually BINDS to it.
 */
describe("InvoicesController — PATCH /:id body metatype (B777)", () => {
  it("REG-B777: update()'s body param is UpdateInvoiceDto, never the bare Object a mapped type erases to", () => {
    const paramTypes = Reflect.getMetadata(
      "design:paramtypes",
      InvoicesController.prototype,
      "update",
    ) as unknown[];
    // update(id: string, dto: UpdateInvoiceDto) — the body is the second param.
    expect(paramTypes?.[1]).toBe(UpdateInvoiceDto);
    expect(paramTypes?.[1]).not.toBe(Object);
  });
});
