import { ValidationPipe } from "@nestjs/common";
import { UpdateInvoiceDto } from "./update-invoice.dto";

/**
 * B777 — PATCH /invoices/:id is unvalidated today (paramtype `Object` in the
 * compiled controller: `Partial<CreateInvoiceDto>` erases at runtime).
 * Mirrors the global pipe's exact options (main.ts:145-149 — not exported,
 * so reproduced here; see that file if these ever drift).
 */
describe("UpdateInvoiceDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const meta = { type: "body" as const, metatype: UpdateInvoiceDto, data: "" };

  it("REG-B777: a string shippingFee is rejected, not silently coerced/rounded to 0", async () => {
    await expect(pipe.transform({ shippingFee: "25" }, meta)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("REG-B777: a negative top-level discount is rejected", async () => {
    await expect(pipe.transform({ discount: -5 }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("REG-B777: a negative per-line item discount is rejected", async () => {
    await expect(
      pipe.transform(
        { items: [{ description: "Widget", qty: 1, unitPrice: 10, discount: -1 }] },
        meta,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("REG-B777: an unknown key (e.g. status) is rejected — whitelist is live", async () => {
    await expect(pipe.transform({ status: "PAID" }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("PASS — web edit page's traced payload (invoices/[id]/edit/page.tsx:503-538)", async () => {
    const body = {
      issueDate: "2026-01-01",
      dueDate: "2026-01-31",
      discount: 10,
      shippingFee: 5,
      notes: "some notes",
      terms: "",
      paymentTermsLabel: "Net 30",
      referenceNumber: "",
      subject: "",
      items: [
        {
          productId: "11111111-1111-4111-8111-111111111111",
          description: "Widget",
          qty: 2,
          unitPrice: 10,
        },
      ],
    };
    await expect(pipe.transform({ ...body }, meta)).resolves.toBeDefined();
  });

  it("PASS — web draft-builder's traced payload (invoices/new/page.tsx buildInvoiceDto)", async () => {
    const body = {
      customerId: "11111111-1111-4111-8111-111111111111",
      dueDate: "2026-01-31",
      issueDate: "2026-01-01",
      terms: "Standard terms",
      paymentTermsLabel: "Net 30",
      items: [{ description: "Widget", qty: 1, unitPrice: 10, taxRate: 0 }],
      notes: undefined,
      referenceNumber: undefined,
      subject: undefined,
      send: true,
    };
    await expect(pipe.transform({ ...body }, meta)).resolves.toBeDefined();
  });

  it("PASS — mobile due-date-only payload (invoices/[id].tsx:1077-1078)", async () => {
    await expect(pipe.transform({ dueDate: "2026-01-31" }, meta)).resolves.toEqual({
      dueDate: "2026-01-31",
    });
  });

  it("PASS — mobile full-edit payload (invoices/[id]/edit.tsx:343-372, invoiceLineDto())", async () => {
    const body = {
      issueDate: "2026-01-01",
      dueDate: "2026-01-31",
      discount: 0,
      shippingFee: 0,
      notes: "",
      terms: "",
      referenceNumber: "",
      subject: "",
      items: [
        {
          description: "Widget",
          productId: "11111111-1111-4111-8111-111111111111",
          qty: 3,
          unitPrice: 10,
          taxRate: 0.08,
        },
      ],
    };
    await expect(pipe.transform({ ...body }, meta)).resolves.toBeDefined();
  });
});
