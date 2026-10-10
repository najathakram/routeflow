import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { ApplyCreditNoteDto, UnapplyCreditNoteDto } from "./apply-credit-note.dto";

/**
 * #2416: a missing invoiceId on apply/unapply is a readable 400 from the SAME ValidationPipe
 * options main.ts registers globally, never a 500 from the service.
 */
describe("#2416 — apply/unapply credit-note body validation", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const run = (metatype: any, value: unknown) =>
    pipe.transform(value, { type: "body", metatype, data: "" });

  it.each([
    ["apply", ApplyCreditNoteDto],
    ["unapply", UnapplyCreditNoteDto],
  ])("%s without invoiceId ⇒ 400 naming invoiceId", async (_n, dto) => {
    const err = await run(dto, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((err as BadRequestException).getResponse())).toContain("invoiceId");
  });

  it("apply with an empty invoiceId ⇒ 400", async () => {
    await expect(run(ApplyCreditNoteDto, { invoiceId: "" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("apply with a non-positive amount ⇒ 400", async () => {
    await expect(run(ApplyCreditNoteDto, { invoiceId: "inv-1", amount: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("the shapes the web and mobile clients send are accepted", async () => {
    await expect(run(ApplyCreditNoteDto, { invoiceId: "inv-1" })).resolves.toEqual({
      invoiceId: "inv-1",
    });
    await expect(run(ApplyCreditNoteDto, { invoiceId: "inv-1", amount: 12.5 })).resolves.toEqual({
      invoiceId: "inv-1",
      amount: 12.5,
    });
    await expect(run(UnapplyCreditNoteDto, { invoiceId: "inv-1" })).resolves.toEqual({
      invoiceId: "inv-1",
    });
  });
});
