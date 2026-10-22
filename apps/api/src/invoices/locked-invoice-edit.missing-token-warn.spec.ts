import { Logger } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { classifyInvoiceEditClient, noTokenWarner, updateHeaderOnly } from "./locked-invoice-edit";

/**
 * SA-837 row 500, step 1 (dark): an invoice edit that omits expectedUpdatedAt logs ONE structured warn
 * (route, client, app version, tenant id) and is accepted exactly as before. Step 2 (a 400) is not here.
 */
describe("row 500 step 1 - missing expectedUpdatedAt is reported, never refused", () => {
  const AT = new Date("2026-10-13T10:00:00.000Z");
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const ctx = {
    route: "PATCH /invoices/:id",
    tenantId: "t-1",
    client: "web" as const,
    appVersion: "unknown",
  };
  const mk = () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      invoice: {
        findUnique: jest.fn().mockResolvedValue({ id: "inv-1", updatedAt: AT, status: "DRAFT" }),
        update: jest.fn().mockResolvedValue({ id: "inv-1" }),
      },
    };
    const plain = { invoice: { update: jest.fn().mockResolvedValue({ id: "inv-1" }) } };
    const prisma = {
      forTenant: () => plain,
      tenantTransaction: jest.fn((fn: (t: any) => Promise<any>) => fn(tx)),
    };
    return { plain, prisma, tx };
  };

  it("missing: ONE warn with route, client, app version and tenant id; the update still succeeds", async () => {
    const { plain, prisma } = mk();
    const result = await updateHeaderOnly(
      prisma,
      "inv-1",
      {},
      { notes: "n" },
      {},
      noTokenWarner("inv-1", ctx),
    );
    expect(result).toEqual({ id: "inv-1" });
    expect(plain.invoice.update).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        event: "INVOICE_EDIT_TOKEN_MISSING",
        route: "PATCH /invoices/:id",
        invoiceId: "inv-1",
        tenantId: "t-1",
        client: "web",
        appVersion: "unknown",
      }),
    );
  });

  it("a warner invoked twice in one request still logs once", () => {
    const warner = noTokenWarner("inv-1", ctx);
    warner();
    warner();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("present: no warn", async () => {
    const { prisma } = mk();
    await updateHeaderOnly(
      prisma,
      "inv-1",
      { expectedUpdatedAt: AT.toISOString() },
      {},
      {},
      noTokenWarner("inv-1", ctx),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the client from the user agent and the app version from its header", () => {
    expect(
      classifyInvoiceEditClient("Mozilla/5.0 (Macintosh) Chrome/130 Safari/537", undefined),
    ).toEqual({ client: "web", appVersion: "unknown" });
    expect(classifyInvoiceEditClient("okhttp/4.12.0", "2.4.1")).toEqual({
      client: "mobile",
      appVersion: "2.4.1",
    });
    expect(
      classifyInvoiceEditClient("RouteFlow/312 CFNetwork/1568 Darwin/24.0", undefined),
    ).toEqual({ client: "mobile", appVersion: "unknown" });
    expect(classifyInvoiceEditClient(undefined, undefined)).toEqual({
      client: "unknown",
      appVersion: "unknown",
    });
  });

  it("the controller hands the service the client identity from the request headers", async () => {
    const service = { update: jest.fn() };
    const controller = new InvoicesController(service as never, {} as never);
    const dto = { items: [] } as never;
    await controller.update("inv-1", dto, { sub: "user-1" } as never, "okhttp/4.12.0", "2.4.1");
    expect(service.update).toHaveBeenCalledWith("inv-1", dto, "user-1", {
      userAgent: "okhttp/4.12.0",
      appVersion: "2.4.1",
    });
  });
});
