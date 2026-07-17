/**
 * Security test — F9-006: the audit interceptor logged the LEFTMOST
 * X-Forwarded-For entry, which a client can spoof by prepending a fake value,
 * poisoning the audit trail's source IP. It now uses Express's trust-proxy-aware
 * `req.ip` (trust proxy = 2 is set in main.ts), which strips the trusted proxy
 * hops from the RIGHT to resolve the real client IP.
 */
import { AuditInterceptor } from "./audit.interceptor";

describe("AuditInterceptor — F9-006 spoof-resistant client IP", () => {
  const makeCtx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;
  const nextHandler = () => ({ handle: jest.fn().mockReturnValue("handled") });

  it("logs req.ip (trust-proxy client IP), NOT the spoofable leftmost X-Forwarded-For", async () => {
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AuditInterceptor(auditService as any);
    const req = {
      method: "POST",
      url: "/api/v1/orders",
      path: "/orders",
      ip: "203.0.113.9", // Express-resolved real client IP (trust proxy = 2)
      // Attacker prepended "1.2.3.4" — the leftmost entry the OLD code trusted.
      headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
      user: { sub: "u1", tenantId: "t1" },
    };
    const next = nextHandler();

    expect(interceptor.intercept(makeCtx(req), next)).toBe("handled");
    // Flush the fire-and-forget setImmediate log.
    await new Promise((r) => setImmediate(r));

    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ ip: "203.0.113.9" }));
    expect(auditService.log).not.toHaveBeenCalledWith(expect.objectContaining({ ip: "1.2.3.4" }));
  });

  it("does not audit non-mutation (GET) requests", () => {
    const auditService = { log: jest.fn() };
    const interceptor = new AuditInterceptor(auditService as any);
    const req = { method: "GET", url: "/api/v1/orders", headers: {}, socket: {} };
    interceptor.intercept(makeCtx(req), nextHandler());
    expect(auditService.log).not.toHaveBeenCalled();
  });
});
