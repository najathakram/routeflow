import { HttpException } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { SentryExceptionFilter } from "./sentry-exception.filter";

jest.mock("@sentry/node", () => ({ withScope: jest.fn(), captureException: jest.fn() }));

// Synthetic, token-shaped (43 url-safe chars); not a real secret.
const TOKEN = "Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0";
const UUID = "3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b";

describe("SentryExceptionFilter — the path tag never carries a path-borne token", () => {
  let tags: Record<string, string>;
  let superCatch: jest.SpyInstance;

  beforeEach(() => {
    tags = {};
    (Sentry.withScope as jest.Mock).mockImplementation((cb: (s: unknown) => void) =>
      cb({
        setTag: (k: string, v: string) => {
          tags[k] = v;
        },
        setUser: jest.fn(),
      }),
    );
    superCatch = jest
      .spyOn(Object.getPrototypeOf(SentryExceptionFilter.prototype), "catch")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.clearAllMocks();
    superCatch.mockRestore();
  });

  const host = (req: Record<string, unknown>) =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

  it("tags a 5xx on a matched route with the template", () => {
    new SentryExceptionFilter().catch(
      new Error("boom"),
      host({
        method: "POST",
        originalUrl: `/api/v1/buyer/invites/${TOKEN}/accept?t=${TOKEN}`,
        route: { path: "/api/v1/buyer/invites/:token/accept" },
      }),
    );
    expect(tags.path).toBe("POST /buyer/invites/:token/accept");
    expect(JSON.stringify(tags)).not.toContain(TOKEN);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("tags an unmatched 5xx with the token segment redacted and uuids kept", () => {
    new SentryExceptionFilter().catch(
      new HttpException("x", 503),
      host({ method: "GET", originalUrl: `/api/v1/orders/${UUID}/f/${TOKEN}?q=1` }),
    );
    expect(tags.path).toBe(`GET /api/v1/orders/${UUID}/f/:redacted`);
    expect(JSON.stringify(tags)).not.toContain(TOKEN);
  });

  it("does not tag or capture a 4xx", () => {
    new SentryExceptionFilter().catch(
      new HttpException("nope", 404),
      host({ method: "GET", originalUrl: `/x/${TOKEN}` }),
    );
    expect(Sentry.withScope).not.toHaveBeenCalled();
  });
});
