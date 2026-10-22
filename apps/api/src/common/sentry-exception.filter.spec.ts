import { InternalServerErrorException } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { redactKeyPath, SentryExceptionFilter } from "./sentry-exception.filter";

const mockScope = { setTag: jest.fn(), setUser: jest.fn() };
jest.mock("@sentry/node", () => ({
  withScope: jest.fn((cb: (scope: unknown) => void) => cb(mockScope)),
  captureException: jest.fn(),
}));

/**
 * SA-824 review finding 6: the `path` tag of a Sentry event must never carry a payment Idempotency-Key
 * (the raw key of /invoices/payments/by-key/:key and its /resolve).
 */
describe("SentryExceptionFilter path tag", () => {
  const run = (url: string) => {
    mockScope.setTag.mockClear();
    const filter = new SentryExceptionFilter();
    const host = { switchToHttp: () => ({ getRequest: () => ({ originalUrl: url }) }) } as any;
    try {
      filter.catch(new InternalServerErrorException(), host);
    } catch {
      /* super.catch has no adapter in this unit test */
    }
    return mockScope.setTag.mock.calls.find((c) => c[0] === "path")?.[1];
  };

  it("redacts the key segment of by-key and by-key/resolve, keeps the rest", () => {
    expect(run("/api/v1/invoices/payments/by-key/RAW-KEY-123")).toBe(
      "/api/v1/invoices/payments/by-key/:key",
    );
    expect(run("/api/v1/invoices/payments/by-key/RAW-KEY-123/resolve?x=1")).toBe(
      "/api/v1/invoices/payments/by-key/:key/resolve",
    );
    expect(run("/api/v1/invoices/payments/record")).toBe("/api/v1/invoices/payments/record");
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it("redactKeyPath is generic for any by-key path", () => {
    expect(redactKeyPath("/x/by-key/abc/y")).toBe("/x/by-key/:key/y");
  });
});
