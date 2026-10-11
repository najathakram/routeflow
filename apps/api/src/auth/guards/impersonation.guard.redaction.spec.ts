import { ExecutionContext, Logger } from "@nestjs/common";
import { ImpersonationGuard } from "./impersonation.guard";

// Synthetic, token-shaped (43 url-safe chars); not a real secret.
const TOKEN = "Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0";
const UUID = "3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b";

const bearer = `Bearer h.${Buffer.from(
  JSON.stringify({ sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" }),
).toString("base64url")}.s`;

const ctx = (req: Record<string, unknown>) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

describe("ImpersonationGuard — the write log line never carries a path-borne token", () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });
  afterEach(() => logSpy.mockRestore());

  const lineFor = (req: Record<string, unknown>) => {
    new ImpersonationGuard().canActivate(
      ctx({ headers: { authorization: bearer }, method: "POST", ...req }),
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    return String(logSpy.mock.calls[0]![0]);
  };

  it("logs the route template for a matched route", () => {
    const line = lineFor({
      url: `/api/v1/buyer/invites/${TOKEN}/accept?x=${TOKEN}`,
      route: { path: "/api/v1/buyer/invites/:token/accept" },
    });
    expect(line).toContain("Impersonation write: POST /buyer/invites/:token/accept");
    expect(line).not.toContain(TOKEN);
  });

  it("redacts a token-shaped segment when the request matched no route", () => {
    const line = lineFor({ url: `/api/v1/unknown/${TOKEN}` });
    expect(line).toContain("POST /api/v1/unknown/:redacted");
    expect(line).not.toContain(TOKEN);
  });

  it("keeps an ordinary uuid id readable on an unmatched path, drops the query", () => {
    const line = lineFor({ url: `/api/v1/orders/${UUID}?x=1` });
    expect(line).toContain(`POST /api/v1/orders/${UUID}`);
    expect(line).not.toContain("?x=1");
  });
});
