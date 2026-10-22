import { AuditInterceptor } from "./audit.interceptor";

/**
 * SA-824 race ruling 4: the resolve of a payment Idempotency-Key writes ONE audit row of its own (actor, the
 * key's sha256, outcome). The generic mutation row would be a second row AND would carry the RAW key in its
 * `action` path, so a `by-key` mutation path is left to its handler's own row.
 */
describe("AuditInterceptor: a payment by-key resolve is audited by its handler, never with the raw key", () => {
  const makeCtx = (req: unknown) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;
  const next = () => ({ handle: jest.fn().mockReturnValue("handled") });
  const flush = () => new Promise((r) => setImmediate(r));

  it("POST /invoices/payments/by-key/:key/resolve: no generic row (the raw key never reaches the trail)", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const req = {
      method: "POST",
      url: "/api/v1/invoices/payments/by-key/RAW-KEY-123/resolve",
      ip: "203.0.113.9",
      headers: {},
      socket: {},
      user: { sub: "u1", tenantId: "t1" },
    };
    expect(new AuditInterceptor(audit as any).intercept(makeCtx(req), next())).toBe("handled");
    await flush();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("every other mutation keeps its generic row", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const req = {
      method: "POST",
      url: "/api/v1/invoices/payments/record",
      ip: "203.0.113.9",
      headers: {},
      socket: {},
      user: { sub: "u1", tenantId: "t1" },
    };
    new AuditInterceptor(audit as any).intercept(makeCtx(req), next());
    await flush();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "POST /invoices/payments/record" }),
    );
  });

  it("a resolve with a query string is still skipped; any OTHER by-key mutation is still audited", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const mk = (method: string, url: string) => ({
      method,
      url,
      ip: "203.0.113.9",
      headers: {},
      socket: {},
      user: { sub: "u1", tenantId: "t1" },
    });
    const i = new AuditInterceptor(audit as any);
    i.intercept(makeCtx(mk("POST", "/api/v1/invoices/payments/by-key/K1/resolve?x=1")), next());
    i.intercept(makeCtx(mk("DELETE", "/api/v1/invoices/payments/by-key/K2")), next());
    i.intercept(makeCtx(mk("POST", "/api/v1/orders/by-key/K3/cancel")), next());
    i.intercept(makeCtx(mk("POST", "/api/v1/invoices/payments/by-key/K4/other")), next());
    await flush();
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual([
      "DELETE /invoices/payments/by-key/K2",
      "POST /orders/by-key/K3/cancel",
      "POST /invoices/payments/by-key/K4/other",
    ]);
  });

  it("routing is case-insensitive, so a mixed-case resolve path is skipped too (no raw key in a generic row)", async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const req = {
      method: "POST",
      url: "/api/v1/INVOICES/payments/By-Key/RAW-KEY-123/RESOLVE",
      ip: "203.0.113.9",
      headers: {},
      socket: {},
      user: { sub: "u1", tenantId: "t1" },
    };
    new AuditInterceptor(audit as any).intercept(makeCtx(req), next());
    await flush();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
