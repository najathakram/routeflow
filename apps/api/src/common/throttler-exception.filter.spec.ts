/**
 * RF-160 / pB10: the Retry-After header for /auth/login must follow the
 * configured login-throttle window (AUTH_LOGIN_THROTTLE_TTL_MS), not a
 * duplicated 300 s literal — otherwise the local Docker stack (60 s window)
 * tells clients to back off 5x longer than the limiter actually holds them.
 */

import { HttpStatus } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { ThrottlerExceptionFilter } from "./throttler-exception.filter";
import { __resetLoginThrottleCache } from "../auth/login-throttle.config";

function makeHost(path: string): any {
  const res = {
    status: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ path, ip: "127.0.0.1" }),
    }),
    res,
  };
}

describe("ThrottlerExceptionFilter – Retry-After follows the login throttle config", () => {
  let filter: ThrottlerExceptionFilter;

  beforeEach(() => {
    delete process.env.AUTH_LOGIN_THROTTLE_LIMIT;
    delete process.env.AUTH_LOGIN_THROTTLE_TTL_MS;
    __resetLoginThrottleCache();
    filter = new ThrottlerExceptionFilter();
  });

  afterEach(() => {
    delete process.env.AUTH_LOGIN_THROTTLE_LIMIT;
    delete process.env.AUTH_LOGIN_THROTTLE_TTL_MS;
    __resetLoginThrottleCache();
  });

  it("uses the overridden TTL for /auth/login (60 s local stack value)", () => {
    process.env.AUTH_LOGIN_THROTTLE_TTL_MS = "60000";
    __resetLoginThrottleCache();

    const host = makeHost("/api/v1/auth/login");
    filter.catch(new ThrottlerException(), host);

    expect(host.res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(host.res.header).toHaveBeenCalledWith("Retry-After", "60");
    const body = host.res.json.mock.calls[0][0];
    expect(body.retryAfter).toBe(60);
    expect(body.message).toBe("Too many requests. Please try again in 1 minute.");
  });

  it("falls back to the production default of 300 s when the env knob is unset", () => {
    const host = makeHost("/api/v1/auth/login");
    filter.catch(new ThrottlerException(), host);

    expect(host.res.header).toHaveBeenCalledWith("Retry-After", "300");
    const body = host.res.json.mock.calls[0][0];
    expect(body.statusCode).toBe(429);
    expect(body.error).toBe("Too Many Requests");
    expect(body.retryAfter).toBe(300);
    expect(body.message).toBe("Too many requests. Please try again in 5 minutes.");
  });

  it("leaves non-login routes on the 60 s default", () => {
    process.env.AUTH_LOGIN_THROTTLE_TTL_MS = "900000";
    __resetLoginThrottleCache();

    const host = makeHost("/api/v1/products");
    filter.catch(new ThrottlerException(), host);

    expect(host.res.header).toHaveBeenCalledWith("Retry-After", "60");
    expect(host.res.json.mock.calls[0][0].retryAfter).toBe(60);
  });
});
