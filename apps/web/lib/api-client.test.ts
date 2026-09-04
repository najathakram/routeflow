/**
 * api-client.ts is a module singleton: `axios.create(...)` runs once at import
 * time and the request/response interceptor handlers close over module-level
 * state (`isRefreshing`, `failedQueue`). To keep each test isolated we
 * `jest.resetModules()` and re-`require` a fresh copy of both the mocked
 * `axios` module and `./api-client` before every test, then pull the
 * registered interceptor handlers off the mock instance's `.mock.calls`.
 *
 * OBSTACLE: two of the module's branches call `window.location.assign(...)` /
 * `window.location.href = ...`. In jest-environment-jsdom@30.2.0 neither
 * `Location.prototype.assign` nor `window`'s own `location` property is
 * configurable, so `jest.spyOn(window.location, "assign")` and
 * `Object.defineProperty(window, "location", {...})` both throw
 * ("Cannot assign/redefine..."). There is no browser global this file's mocks
 * can substitute to make that call interceptable. The uncalled real
 * `Location.assign` still runs in jsdom, which logs (not throws) "Not
 * implemented: navigation" via its virtual console -- muted locally in the one
 * test that hits it. Net effect: this suite verifies every side effect of the
 * impersonation-401 branch EXCEPT the exact redirect URL passed to
 * `window.location.assign`.
 */
import { OP_KEYS } from "./auth-keys";
import { setImpersonation } from "./impersonation";

type Config = { url?: string; method?: string; headers: Record<string, string>; _retry?: boolean };
type RequestHandler = (config: Config) => Config | Promise<Config>;
type ErrorHandler = (error: unknown) => Promise<unknown>;

interface MockAxiosInstance extends jest.Mock {
  interceptors: {
    request: { use: jest.Mock };
    response: { use: jest.Mock };
  };
}

let mockInstance: MockAxiosInstance;
let axiosPost: jest.Mock;
let requestHandler: RequestHandler;
let errorHandler: ErrorHandler;

function makeMockInstance(): MockAxiosInstance {
  const instance = jest.fn(() => Promise.resolve({ data: {} })) as MockAxiosInstance;
  instance.interceptors = {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  };
  return instance;
}

/** Fresh module graph + fresh axios mock, then pull the registered handlers. */
function loadApiClient() {
  jest.resetModules();
  jest.doMock("axios", () => {
    mockInstance = makeMockInstance();
    axiosPost = jest.fn();
    const create = jest.fn(() => mockInstance);
    return { __esModule: true, default: { create, post: axiosPost }, create, post: axiosPost };
  });
  require("./api-client");
  requestHandler = mockInstance.interceptors.request.use.mock.calls[0][0];
  const responseUseCall = mockInstance.interceptors.response.use.mock.calls[0];
  errorHandler = responseUseCall[1];
}

function clearAllCookies() {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
  });
}

describe("api-client", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllCookies();
    loadApiClient();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("request interceptor attaches Authorization + the tenant header from stored values", async () => {
    localStorage.setItem(OP_KEYS.accessToken, "tok-123");
    document.cookie = "tenant-slug=acme";

    const config: Config = { headers: {} };
    const result = await requestHandler(config);

    expect(result.headers.Authorization).toBe("Bearer tok-123");
    expect(result.headers["X-Tenant-Slug"]).toBe("acme");
  });

  it("a 401 on a normal request triggers exactly one refresh call and replays the original request with the new token", async () => {
    localStorage.setItem(OP_KEYS.accessToken, "old-token");
    localStorage.setItem(OP_KEYS.refreshToken, "refresh-token");
    axiosPost.mockResolvedValue({
      data: { accessToken: "new-token", refreshToken: "new-refresh" },
    });
    mockInstance.mockResolvedValue({ data: "replayed" });

    const original: Config = {
      url: "/orders",
      method: "get",
      headers: { Authorization: "Bearer old-token" },
    };
    const error = { response: { status: 401 }, config: original };

    await errorHandler(error);

    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost.mock.calls[0][0]).toEqual(expect.stringContaining("/auth/refresh"));
    expect(axiosPost.mock.calls[0][1]).toEqual({ refreshToken: "refresh-token" });
    expect(mockInstance).toHaveBeenCalledTimes(1);
    expect(mockInstance).toHaveBeenCalledWith(original);
    expect(original.headers.Authorization).toBe("Bearer new-token");
    expect(localStorage.getItem(OP_KEYS.accessToken)).toBe("new-token");
    expect(localStorage.getItem(OP_KEYS.refreshToken)).toBe("new-refresh");
  });

  // FINDING: the brief (PR-9 R3) claims a 401 on /auth/refresh itself "clears the
  // stored tokens". Reading apps/web/lib/api-client.ts:178-187, the guard that
  // matches original.url?.includes("/auth/refresh") returns Promise.reject(error)
  // immediately -- it never touches localStorage. This test asserts the actual
  // (weaker) behavior: no recursive refresh, and the stored tokens are left as-is.
  it("a 401 on the refresh endpoint itself does not recurse, and does NOT clear stored tokens (brief claim was inaccurate)", async () => {
    localStorage.setItem(OP_KEYS.accessToken, "old-token");
    localStorage.setItem(OP_KEYS.refreshToken, "refresh-token");
    const removeItemSpy = jest.spyOn(Storage.prototype, "removeItem");

    const original: Config = { url: "/auth/refresh", headers: {} };
    const error = { response: { status: 401 }, config: original };

    await expect(errorHandler(error)).rejects.toBe(error);

    expect(axiosPost).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(OP_KEYS.accessToken)).toBe("old-token");
    expect(localStorage.getItem(OP_KEYS.refreshToken)).toBe("refresh-token");
  });

  it("an active impersonation token is used on the request instead of the operator token/cookie", async () => {
    setImpersonation("impersonation-token", "imp-acme", "op-user");

    const config: Config = { headers: {} };
    const result = await requestHandler(config);

    expect(result.headers.Authorization).toBe("Bearer impersonation-token");
    expect(result.headers["X-Tenant-Slug"]).toBe("imp-acme");
  });

  // OBSTACLE (see the file-level note above `describe`): this branch also calls
  // `window.location.assign(...)`, which this jsdom cannot be made to intercept, so
  // the redirect URL itself is not asserted here -- only the effects that ARE
  // observable (no refresh call, impersonation cleared). console.error is muted for
  // just this test to swallow jsdom's expected "Not implemented: navigation" log.
  it("an impersonation token bypasses refresh on a 401: no refresh call, impersonation is cleared", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    setImpersonation("impersonation-token", "imp-acme", "op-user");

    const original: Config = { url: "/orders", headers: {} };
    const error = { response: { status: 401 }, config: original };

    await expect(errorHandler(error)).rejects.toBe(error);

    expect(axiosPost).not.toHaveBeenCalled();
    expect(mockInstance).not.toHaveBeenCalled();
    expect(localStorage.getItem("impersonationToken")).toBeNull();
    consoleErrorSpy.mockRestore();
  });

  it("two concurrent 401s issue a single refresh call and both requests replay with the new token", async () => {
    localStorage.setItem(OP_KEYS.accessToken, "old-token");
    localStorage.setItem(OP_KEYS.refreshToken, "refresh-token");
    let resolveRefresh!: (v: { data: { accessToken: string; refreshToken: string } }) => void;
    axiosPost.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    mockInstance.mockResolvedValue({ data: "replayed" });

    const original1: Config = { url: "/orders", headers: {} };
    const original2: Config = { url: "/invoices", headers: {} };
    const error1 = { response: { status: 401 }, config: original1 };
    const error2 = { response: { status: 401 }, config: original2 };

    // Both errors are dispatched before the refresh promise settles, simulating
    // two requests 401ing concurrently. The interceptor is synchronous up to its
    // first `await`, so by the time the second call runs, isRefreshing is already
    // true and it must queue instead of firing a second refresh.
    const p1 = errorHandler(error1);
    const p2 = errorHandler(error2);

    expect(axiosPost).toHaveBeenCalledTimes(1);

    resolveRefresh({ data: { accessToken: "new-token", refreshToken: "new-refresh" } });
    await Promise.all([p1, p2]);

    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(mockInstance).toHaveBeenCalledTimes(2);
    expect(original1.headers.Authorization).toBe("Bearer new-token");
    expect(original2.headers.Authorization).toBe("Bearer new-token");
  });
});
