// The controllers pull the services' ESM-only dependency chains in; the routes need none of them.
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../bookkeeping/invoice.service", () => ({ InvoiceService: jest.fn() }));
jest.mock("../vendor-bills/vendor-bills.service", () => ({ VendorBillsService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Reflector } from "@nestjs/core";
import { InvoicesController } from "./invoices.controller";
import { BookkeepingController } from "../bookkeeping/bookkeeping.controller";
import { RolesGuard } from "../auth/guards/roles.guard";
import { refDedupeFromRequest } from "./payment-ref-dedupe";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * Row 498 (SA-837): the three staff routes that record an invoice payment (a) hand the actor, the role and the
 * body's `recordAnyway` flag to the service, and (b) are OPERATOR-only at the route, so the role guard answers
 * 403 to any non-staff caller before the flag can matter (the service ALSO ignores the flag for a non-staff role:
 * payment-ref-dedupe.writers.spec.ts).
 */
const user = { sub: "user-1", role: "OPERATOR" } as JwtPayload;

describe("refDedupeFromRequest", () => {
  it("carries the actor, the role and the flag", () => {
    expect(refDedupeFromRequest(user, { recordAnyway: true })).toEqual({
      actor: "user-1",
      role: "OPERATOR",
      recordAnyway: true,
    });
  });
  it("is recordAnyway false unless the body says exactly true", () => {
    expect(refDedupeFromRequest(user, {}).recordAnyway).toBe(false);
    expect(refDedupeFromRequest(user, { recordAnyway: "yes" as never }).recordAnyway).toBe(false);
    expect(refDedupeFromRequest(undefined, {})).toEqual({
      actor: null,
      role: null,
      recordAnyway: false,
    });
  });
});

describe("the staff payment routes pass the staff flag to the service", () => {
  it("POST /invoices/:id/payments", async () => {
    const service = { recordPayment: jest.fn() };
    const c = new InvoicesController(service as never, {} as never);
    const dto = { amount: 10, method: "CHECK", reference: "R-1", recordAnyway: true } as never;
    await c.recordPayment("inv-1", dto, user, "key-1");
    expect(service.recordPayment).toHaveBeenCalledWith("inv-1", dto, {
      idempotencyKey: "key-1",
      refDedupe: { actor: "user-1", role: "OPERATOR", recordAnyway: true },
    });
  });

  it("POST /invoices/payments/record", async () => {
    const service = { recordStandalonePayment: jest.fn() };
    const c = new InvoicesController(service as never, {} as never);
    const dto = { customerId: "c1", totalAmount: 10, recordAnyway: true } as never;
    await c.recordStandalonePayment(dto, user, "key-2");
    expect(service.recordStandalonePayment).toHaveBeenCalledWith(dto, {
      actor: "user-1",
      idempotencyKey: "key-2",
      refDedupe: { actor: "user-1", role: "OPERATOR", recordAnyway: true },
    });
  });

  it("POST /bookkeeping/transactions/:id/payments", async () => {
    const service = { recordPayment: jest.fn() };
    const c = new BookkeepingController(service as never);
    const dto = { amount: 10, method: "CHECK", recordAnyway: true } as never;
    await c.recordPayment("inv-1", dto, user);
    expect(service.recordPayment).toHaveBeenCalledWith("inv-1", dto, {
      refDedupe: { actor: "user-1", role: "OPERATOR", recordAnyway: true },
    });
  });
});

describe("the three routes are staff-only (a non-staff role is 403 before recordAnyway can matter)", () => {
  const guard = new RolesGuard(new Reflector());
  const ctx = (Cls: new (...a: never[]) => object, handler: string, role: string) =>
    ({
      getHandler: () => (Cls.prototype as Record<string, () => void>)[handler],
      getClass: () => Cls,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as never;
  const routes: Array<[string, new (...a: never[]) => object, string]> = [
    ["POST /invoices/:id/payments", InvoicesController as never, "recordPayment"],
    ["POST /invoices/payments/record", InvoicesController as never, "recordStandalonePayment"],
    [
      "POST /bookkeeping/transactions/:id/payments",
      BookkeepingController as never,
      "recordPayment",
    ],
  ];
  it.each(routes)("%s", (_name, Cls, handler) => {
    for (const role of ["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])
      expect(guard.canActivate(ctx(Cls, handler, role))).toBe(true);
    for (const role of ["CUSTOMER", "DRIVER"])
      expect(guard.canActivate(ctx(Cls, handler, role))).toBe(false);
  });
});
