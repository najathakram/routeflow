/**
 * The stored audit action is built from the route template, so a secret carried in a path
 * parameter never reaches storage, on a successful request or a failing one. The entity id is
 * redacted when it comes from a token-named parameter and kept for ordinary ids.
 */
import { AuditInterceptor, AUDIT_REDACTED, AUDIT_UNMATCHED_PATH } from "./audit.interceptor";

// Synthetic, token-shaped (43 url-safe chars); not a real secret.
const TOKEN = "Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0";
const UUID = "3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b";

describe("AuditInterceptor — route-template redaction", () => {
  const makeCtx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;
  const flush = () => new Promise((r) => setImmediate(r));

  const run = async (req: any, handle: () => unknown = () => "handled") => {
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AuditInterceptor(auditService as any);
    try {
      interceptor.intercept(makeCtx(req), { handle } as any);
    } catch {
      // a failing handler is the point of the error-path cases
    }
    await flush();
    return auditService.log.mock.calls.map((c) => c[0]);
  };

  const base = { ip: "203.0.113.9", headers: {}, socket: {}, user: { sub: "u1", tenantId: "t1" } };

  it("stores the template, not the raw URL, for a token route (success)", async () => {
    const [entry, ...rest] = await run({
      ...base,
      method: "POST",
      url: `/api/v1/buyer/invites/${TOKEN}/accept?t=${TOKEN}`,
      route: { path: "/api/v1/buyer/invites/:token/accept" },
    });
    expect(rest).toHaveLength(0);
    expect(entry.action).toBe("POST /buyer/invites/:token/accept");
    expect(entry.entityType).toBe("buyer");
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("stores the same redacted entry when the request fails", async () => {
    const entries = await run(
      {
        ...base,
        method: "POST",
        url: `/api/v1/buyer/invites/${TOKEN}/accept`,
        route: { path: "/api/v1/buyer/invites/:token/accept" },
      },
      () => {
        throw new Error("refused");
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("POST /buyer/invites/:token/accept");
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });

  it("redacts the entity id when the second segment is a token parameter", async () => {
    const [entry] = await run({
      ...base,
      method: "POST",
      url: `/api/v1/${"reset-links"}/${TOKEN}/use`,
      route: { path: "/api/v1/reset-links/:resetToken/use" },
    });
    expect(entry.entityId).toBe(AUDIT_REDACTED);
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("redacts the notifications device-token route", async () => {
    const [entry] = await run({
      ...base,
      method: "DELETE",
      url: `/api/v1/notifications/token/${TOKEN}`,
      route: { path: "/api/v1/notifications/token/:token" },
    });
    expect(entry.action).toBe("DELETE /notifications/token/:token");
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("keeps an ordinary UUID entity id", async () => {
    const [entry] = await run({
      ...base,
      method: "PATCH",
      url: `/api/v1/orders/${UUID}?x=1`,
      route: { path: "/api/v1/orders/:id" },
    });
    expect(entry.entityType).toBe("orders");
    expect(entry.entityId).toBe(UUID);
    expect(entry.action).toBe("PATCH /orders/:id");
  });

  it("keeps ids from other ordinary parameter names", async () => {
    const [entry] = await run({
      ...base,
      method: "PUT",
      url: `/api/v1/customers/${UUID}/orders/abc`,
      route: { path: "/api/v1/customers/:orderId/orders/:lineId" },
    });
    expect(entry.entityId).toBe(UUID);
  });

  it("never stores a query string", async () => {
    const [entry] = await run({
      ...base,
      method: "POST",
      url: `/api/v1/orders?token=${TOKEN}`,
      route: { path: "/api/v1/orders" },
    });
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
    expect(entry.action).toBe("POST /orders");
    expect(entry.entityId).toBeNull();
  });

  it("stores only the method and a placeholder when no template is available", async () => {
    const entries = await run(
      { ...base, method: "POST", url: `/api/v1/buyer/invites/${TOKEN}/accept` },
      () => {
        throw new Error("no route");
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe(`POST ${AUDIT_UNMATCHED_PATH}`);
    expect(entries[0].entityId).toBeNull();
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });
});
