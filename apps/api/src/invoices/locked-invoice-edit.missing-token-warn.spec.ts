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

  const hdrs = { xClient: "web", userAgent: undefined, appVersion: undefined };
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
      noTokenWarner("inv-1", "t-1", hdrs),
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
    const warner = noTokenWarner("inv-1", "t-1", hdrs);
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
      noTokenWarner("inv-1", "t-1", hdrs),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("x-client wins over the user agent; only web or mobile is accepted; the UA is the fallback", () => {
    const browserUa = "Mozilla/5.0 (iPhone) AppleWebKit Safari/604";
    // an Expo web export is a browser, so the header is the only signal
    expect(classifyInvoiceEditClient({ xClient: "mobile", userAgent: browserUa })).toEqual({
      client: "mobile",
      appVersion: "unknown",
    });
    expect(classifyInvoiceEditClient({ xClient: "web", userAgent: "okhttp/4.12.0" }).client).toBe(
      "web",
    );
    expect(classifyInvoiceEditClient({ xClient: "toaster", userAgent: browserUa }).client).toBe(
      "web",
    );
    expect(classifyInvoiceEditClient({ xClient: "toaster" }).client).toBe("unknown");
    expect(classifyInvoiceEditClient({ userAgent: "okhttp/4.12.0" }).client).toBe("mobile");
    expect(classifyInvoiceEditClient({ userAgent: "CFNetwork/1568 Darwin/24" }).client).toBe(
      "mobile",
    );
    expect(classifyInvoiceEditClient({}).client).toBe("unknown");
  });

  it("the app version is the trimmed, capped x-app-version, else unknown", () => {
    expect(classifyInvoiceEditClient({ appVersion: "  abc123  " }).appVersion).toBe("abc123");
    expect(classifyInvoiceEditClient({ appVersion: "x".repeat(80) }).appVersion).toHaveLength(32);
    expect(classifyInvoiceEditClient({ appVersion: "  " }).appVersion).toBe("unknown");
  });

  it("the controller hands the service the client identity from the request headers", async () => {
    const service = { update: jest.fn() };
    const controller = new InvoicesController(service as never, {} as never);
    const dto = { items: [] } as never;
    const user = { sub: "user-1" };
    await controller.update("inv-1", dto, user as never, "okhttp/4.12.0", "2.4.1", "mobile");
    expect(service.update).toHaveBeenCalledWith("inv-1", dto, user, {
      userAgent: "okhttp/4.12.0",
      appVersion: "2.4.1",
      xClient: "mobile",
    });
  });
});
