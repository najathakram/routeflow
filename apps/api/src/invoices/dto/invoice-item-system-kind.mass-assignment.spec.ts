import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateInvoiceDto } from "./create-invoice.dto";
import { UpdateInvoiceDto } from "./update-invoice.dto";

/**
 * #2169 (SA-395): `systemKind` is a SYSTEM-written column — the ONLY writer is
 * `InvoicesService.setCheckStatus`'s BOUNCED branch. Neither `CreateInvoiceItemDto` nor
 * `UpdateInvoiceItemDto` (which extends it) declares the field, so the global ValidationPipe
 * ({ whitelist: true, forbidNonWhitelisted: true }, main.ts:152-156) rejects any client payload
 * that sends it with a 400 — pin that behaviour directly, the same way
 * create-invoice.mass-assignment.spec.ts pins the sibling top-level fields.
 */
describe("InvoiceItem systemKind — mass assignment (#2169, SA-395)", () => {
  it("REFUTED: CreateInvoiceDto items[].systemKind is not a declared field — forbidNonWhitelisted rejects it (400)", async () => {
    const instance = plainToInstance(CreateInvoiceDto, {
      customerId: "cust-1",
      items: [{ description: "Widget", qty: 1, unitPrice: 10, systemKind: "NSF_FEE" }],
    });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    const itemErrors = errors.find((e) => e.property === "items")?.children?.[0]?.children ?? [];
    const whitelistError = itemErrors.find((e: any) => e.constraints?.whitelistValidation);
    expect(whitelistError).toBeDefined();
    expect(whitelistError!.property).toBe("systemKind");
  });

  it("REFUTED: UpdateInvoiceDto items[].systemKind is not a declared field — forbidNonWhitelisted rejects it (400)", async () => {
    const instance = plainToInstance(UpdateInvoiceDto, {
      items: [{ description: "Widget", qty: 1, unitPrice: 10, systemKind: "NSF_FEE" }],
    });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    const itemErrors = errors.find((e) => e.property === "items")?.children?.[0]?.children ?? [];
    const whitelistError = itemErrors.find((e: any) => e.constraints?.whitelistValidation);
    expect(whitelistError).toBeDefined();
    expect(whitelistError!.property).toBe("systemKind");
  });
});
