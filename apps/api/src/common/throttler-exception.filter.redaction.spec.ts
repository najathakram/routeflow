import { Logger } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { ThrottlerExceptionFilter } from "./throttler-exception.filter";

// Synthetic, token-shaped (43 url-safe chars); not a real secret.
const TOKEN = "Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0";

function hostFor(req: Record<string, unknown>): any {
  const res = {
    status: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
}

describe("ThrottlerExceptionFilter — the rate-limit log line never carries a path-borne token", () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  it("logs the route template for a matched route", () => {
    new ThrottlerExceptionFilter().catch(
      new ThrottlerException(),
      hostFor({
        method: "POST",
        path: `/api/v1/buyer/invites/${TOKEN}/accept`,
        route: { path: "/api/v1/buyer/invites/:token/accept" },
        ip: "127.0.0.1",
      }),
    );
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain("Rate limit hit: POST /buyer/invites/:token/accept");
    expect(line).not.toContain(TOKEN);
  });

  it("redacts the token segment when no route matched", () => {
    new ThrottlerExceptionFilter().catch(
      new ThrottlerException(),
      hostFor({ method: "GET", path: `/api/v1/unknown/${TOKEN}`, ip: "127.0.0.1" }),
    );
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain("GET /api/v1/unknown/:redacted");
    expect(line).not.toContain(TOKEN);
  });
});
