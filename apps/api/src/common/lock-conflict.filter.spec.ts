import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpException,
  INestApplication,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ThrottlerException } from "@nestjs/throttler";
import { MulterError } from "multer";
import * as Sentry from "@sentry/node";
import request from "supertest";
import { LockConflictFilter, LOCK_UNAVAILABLE_BODY } from "./lock-conflict.filter";
import {
  buildGlobalExceptionFilters,
  registerGlobalExceptionFilters,
} from "./global-exception-filters";
import { retryStockTx } from "./tx-retry";

/**
 * SA-767 r-note 5 SA-4: every mapped error is also reported to Sentry at WARNING level, fingerprinted by
 * route + code (the mapping is never silent). The Sentry module is mocked: one captured event per
 * mapped error, none for what the filter delegates.
 */
const mockScope = {
  setLevel: jest.fn(),
  setFingerprint: jest.fn(),
  setTag: jest.fn(),
  setUser: jest.fn(),
};
jest.mock("@sentry/node", () => ({
  withScope: jest.fn((cb: (scope: unknown) => void) => cb(mockScope)),
  captureException: jest.fn(),
}));
const captured = () => (Sentry.captureException as unknown as jest.Mock).mock.calls;

/**
 * SA-767 r-note 3 (a): the backstop. A stock-writer lock wait that gave up (55P03), a deadlock
 * (40P01), a serialization failure (40001) or Prisma's P2028 / P2034 that reaches the HTTP layer is
 * a coded, retryable 503 LOCK_UNAVAILABLE with Retry-After: 2 - never an uncoded 500. It maps ONLY
 * these; every other error (every HttpException included) reaches the catch-all untouched.
 */
const pgCode = (code: string) => Object.assign(new Error("pg"), { code });
const SHAPES: Array<[string, string, () => Error]> = [
  ["55P03", "pg code", () => pgCode("55P03")],
  [
    "55P03",
    "raw-query meta.code",
    () => Object.assign(new Error("raw"), { code: "P2010", meta: { code: "55P03" } }),
  ],
  [
    "55P03",
    "driver-adapter cause.originalCode",
    () =>
      Object.assign(new Error("lock timeout"), {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      }),
  ],
  [
    "55P03",
    "err.cause.originalCode",
    () => Object.assign(new Error("lock timeout"), { cause: { originalCode: "55P03" } }),
  ],
  ["40P01", "pg code", () => pgCode("40P01")],
  [
    "40P01",
    "driver-adapter cause.originalCode",
    () =>
      Object.assign(new Error("deadlock"), {
        meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
      }),
  ],
  ["40001", "pg code", () => pgCode("40001")],
  [
    "40001",
    "driver-adapter cause.originalCode",
    () =>
      Object.assign(new Error("serialization"), {
        meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
      }),
  ],
  ["P2028", "Prisma code", () => pgCode("P2028")],
  ["P2034", "Prisma code", () => pgCode("P2034")],
  [
    "TransactionWriteConflict",
    "DriverAdapterError",
    () =>
      Object.assign(new Error("conflict"), {
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      }),
  ],
];

function makeHost(method = "POST", url = "/api/v1/orders") {
  const res = {
    status: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host: any = {
    getType: () => "http",
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method, originalUrl: url, url }),
    }),
  };
  return { host, res };
}

describe("LockConflictFilter (unit)", () => {
  let warn: jest.SpyInstance;
  let next: { catch: jest.Mock };
  let filter: LockConflictFilter;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    next = { catch: jest.fn() };
    filter = new LockConflictFilter(next);
  });
  afterEach(() => warn.mockRestore());

  it.each(SHAPES)("%s (%s) -> 503 LOCK_UNAVAILABLE + Retry-After: 2", (_state, _shape, mk) => {
    const { host, res } = makeHost();
    filter.catch(mk(), host);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.header).toHaveBeenCalledWith("Retry-After", "2");
    expect(res.json).toHaveBeenCalledWith({
      code: "LOCK_UNAVAILABLE",
      message: "Stock is busy being updated — try again in a moment.",
    });
    expect(res.json.mock.calls[0][0]).toEqual(LOCK_UNAVAILABLE_BODY);
    expect(next.catch).not.toHaveBeenCalled();
  });

  it.each(SHAPES)("%s (%s) logs at warn with the route and the code", (state, _shape, mk) => {
    const { host } = makeHost("PATCH", "/api/v1/orders/abc/status");
    filter.catch(mk(), host);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("PATCH /api/v1/orders/abc/status");
    expect(line).toContain(state);
  });

  it.each(SHAPES)(
    "%s (%s) is reported to Sentry ONCE, at warning level, fingerprinted by route + code",
    (state, _shape, mk) => {
      const { host } = makeHost("POST", "/api/v1/orders");
      filter.catch(mk(), host);
      expect(captured()).toHaveLength(1);
      expect(mockScope.setLevel).toHaveBeenCalledWith("warning");
      expect(mockScope.setFingerprint).toHaveBeenCalledWith(["POST /api/v1/orders", state]);
    },
  );

  it("the fingerprint uses the matched route pattern, not the URL with ids and a query", () => {
    const req = {
      method: "PATCH",
      originalUrl: "/api/v1/orders/abc/status?x=1",
      baseUrl: "/api/v1",
      route: { path: "/orders/:id/status" },
    };
    const host: any = {
      getType: () => "http",
      switchToHttp: () => ({ getResponse: () => makeHost().res, getRequest: () => req }),
    };
    filter.catch(pgCode("40P01"), host);
    expect(mockScope.setFingerprint).toHaveBeenCalledWith([
      "PATCH /api/v1/orders/:id/status",
      "40P01",
    ]);
  });

  // "maps ONLY these": everything else is delegated to the next filter, response untouched.
  const NOT_MAPPED: Array<[string, () => unknown]> = [
    ["a plain Error", () => new Error("boom")],
    ["a TypeError", () => new TypeError("x is not a function")],
    ["a P2002 unique violation", () => pgCode("P2002")],
    ["a 23505 unique violation", () => pgCode("23505")],
    ["a P2025 record not found", () => pgCode("P2025")],
    ["a string", () => "55P03"],
    ["undefined", () => undefined],
    ["a BadRequestException", () => new BadRequestException("nope")],
    ["a CAS ConflictException", () => new ConflictException({ code: "CONCURRENT_UPDATE" })],
    ["MERGE_IN_PROGRESS", () => new ConflictException({ code: "MERGE_IN_PROGRESS", message: "x" })],
    [
      "STOCK_COUNT_COMMITTING",
      () => new ConflictException({ code: "STOCK_COUNT_COMMITTING", message: "x" }),
    ],
    [
      "a 503 with a DIFFERENT code",
      () => new ServiceUnavailableException({ code: "SOMETHING_ELSE", message: "x" }),
    ],
    ["a 503 with a plain string body", () => new ServiceUnavailableException("down")],
    [
      "a non-503 HttpException that carries the LOCK_UNAVAILABLE code",
      () => new HttpException({ code: "LOCK_UNAVAILABLE", message: "x" }, 429),
    ],
    ["a generic HttpException", () => new HttpException("teapot", 418)],
    [
      "an HttpException whose text names 55P03",
      () => new BadRequestException("Bill is already received (ref 55P03 40001)"),
    ],
    [
      "an HttpException carrying a conflict code property",
      () => Object.assign(new BadRequestException("x"), { code: "55P03" }),
    ],
  ];

  it.each(NOT_MAPPED)("%s is NOT mapped: delegated untouched", (_n, mk) => {
    const err = mk();
    const { host, res } = makeHost();
    filter.catch(err, host);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.header).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(captured()).toHaveLength(0); // delegated: the catch-all owns any capture
    expect(next.catch).toHaveBeenCalledTimes(1);
    expect(next.catch).toHaveBeenCalledWith(err, host);
  });

  describe("an HttpException 503 whose body code is LOCK_UNAVAILABLE (MF2)", () => {
    const exhausted = () =>
      new ServiceUnavailableException({
        code: "LOCK_UNAVAILABLE",
        message: "Another stock change was in progress.",
      });
    const countStyle = () =>
      new ServiceUnavailableException({
        code: "LOCK_UNAVAILABLE",
        message: "Part of this count was saved. Commit again to finish.",
        committedLines: 3,
        totalLines: 10,
      });

    it.each([
      ["a retryStockTx-style body", exhausted],
      ["a count-committer body with progress fields", countStyle],
    ])("%s: Retry-After 2, status and body exactly as thrown", (_n, mk) => {
      const err = mk();
      const { host, res } = makeHost();
      filter.catch(err, host);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.header).toHaveBeenCalledWith("Retry-After", "2");
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.json.mock.calls[0][0]).toEqual(err.getResponse());
    });

    it("renders it itself (the catch-all is not called) and reports ONE warning event to Sentry", () => {
      const { host } = makeHost("POST", "/api/v1/orders");
      filter.catch(exhausted(), host);
      expect(next.catch).not.toHaveBeenCalled();
      expect(captured()).toHaveLength(1);
      expect(mockScope.setLevel).toHaveBeenCalledWith("warning");
      expect(mockScope.setFingerprint).toHaveBeenCalledWith([
        "POST /api/v1/orders",
        "LOCK_UNAVAILABLE",
      ]);
    });

    it("a Sentry that throws never breaks the response", () => {
      (Sentry.withScope as unknown as jest.Mock).mockImplementationOnce(() => {
        throw new Error("sentry down");
      });
      const { host, res } = makeHost();
      expect(() => filter.catch(exhausted(), host)).not.toThrow();
      expect(res.header).toHaveBeenCalledWith("Retry-After", "2");
    });

    it("logs at warn with the route and the code", () => {
      const { host } = makeHost("POST", "/api/v1/orders");
      filter.catch(exhausted(), host);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("POST /api/v1/orders");
      expect(line).toContain("LOCK_UNAVAILABLE");
    });

    it("a non-HTTP context still delegates", () => {
      const { host, res } = makeHost();
      host.getType = () => "ws";
      filter.catch(exhausted(), host);
      expect(res.header).not.toHaveBeenCalled();
      expect(next.catch).toHaveBeenCalledTimes(1);
    });
  });

  it("a non-HTTP context (e.g. a websocket gateway) is delegated, never written to", () => {
    const { host, res } = makeHost();
    host.getType = () => "ws";
    filter.catch(pgCode("55P03"), host);
    expect(res.status).not.toHaveBeenCalled();
    expect(next.catch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Filter ORDER against the real Nest dispatcher: `registerGlobalExceptionFilters` is what main.ts
 * calls, so this proves the lock filter is reached BEFORE the catch-all (a lock error is not a 500)
 * while everything else still reaches the catch-all exactly as before.
 */
@Controller("t")
class ThrowController {
  @Get("lock")
  lock() {
    throw pgCode("55P03");
  }
  @Get("deadlock-nested")
  nested() {
    throw Object.assign(new Error("x"), {
      meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
    });
  }
  @Get("plain")
  plain() {
    throw new Error("boom");
  }
  @Get("type")
  type() {
    throw new TypeError("bad");
  }
  @Get("cas")
  cas() {
    throw new ConflictException({ code: "CONCURRENT_UPDATE", message: "cas" });
  }
  @Get("bad")
  bad() {
    throw new BadRequestException("bad input");
  }
  @Get("throttle")
  throttle() {
    throw new ThrottlerException();
  }
  @Get("multer")
  multer() {
    throw new MulterError("LIMIT_FILE_SIZE", "file");
  }
  @Get("count-503")
  count503() {
    throw new ServiceUnavailableException({
      code: "LOCK_UNAVAILABLE",
      message: "Part of this count was saved. Commit again to finish.",
      committedLines: 3,
      totalLines: 10,
    });
  }
  @Get("other-503")
  other503() {
    throw new ServiceUnavailableException({ code: "SOMETHING_ELSE", message: "down" });
  }
  @Get("committing")
  committing() {
    throw new ConflictException({ code: "STOCK_COUNT_COMMITTING", message: "committing" });
  }
  @Get("merge")
  merge() {
    throw new ConflictException({ code: "MERGE_IN_PROGRESS", message: "merging" });
  }
  @Get("exhausted")
  async exhausted() {
    return retryStockTx("spec", async () => {
      throw pgCode("55P03");
    });
  }
}

describe("registerGlobalExceptionFilters (real Nest dispatch)", () => {
  let app: INestApplication;
  let warn: jest.SpyInstance;
  let errLog: jest.SpyInstance;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [ThrowController] }).compile();
    app = mod.createNestApplication();
    registerGlobalExceptionFilters(app);
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    errLog = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    errLog.mockRestore();
  });

  it("a raw 55P03 over HTTP is the coded 503 with Retry-After (was an uncoded 500)", async () => {
    const res = await request(app.getHttpServer()).get("/t/lock");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    expect(res.body).toEqual({
      code: "LOCK_UNAVAILABLE",
      message: "Stock is busy being updated — try again in a moment.",
    });
  });

  it("a nested driver-adapter 40P01 is the coded 503 too", async () => {
    const res = await request(app.getHttpServer()).get("/t/deadlock-nested");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("LOCK_UNAVAILABLE");
  });

  it("a plain Error and a TypeError still reach the catch-all: 500, not 503", async () => {
    for (const path of ["/t/plain", "/t/type"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(500);
      expect(res.headers["retry-after"]).toBeUndefined();
      expect(res.body.code).toBeUndefined();
    }
  });

  it("HttpExceptions are untouched (CAS 409 keeps its body, 400 stays 400)", async () => {
    const cas = await request(app.getHttpServer()).get("/t/cas");
    expect(cas.status).toBe(409);
    expect(cas.body).toEqual({ code: "CONCURRENT_UPDATE", message: "cas" });
    const bad = await request(app.getHttpServer()).get("/t/bad");
    expect(bad.status).toBe(400);
    expect(bad.headers["retry-after"]).toBeUndefined();
  });

  it("the narrow filters are not shadowed: throttle stays 429 + Retry-After, multer stays 400", async () => {
    const thr = await request(app.getHttpServer()).get("/t/throttle");
    expect(thr.status).toBe(429);
    expect(thr.headers["retry-after"]).toBe("60");
    const mul = await request(app.getHttpServer()).get("/t/multer");
    expect(mul.status).toBe(400);
  });

  it("an exhausted retryStockTx 503 keeps ITS body (the filter is the second line, not a rewrite)", async () => {
    const res = await request(app.getHttpServer()).get("/t/exhausted");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("LOCK_UNAVAILABLE");
    expect(res.body.message).toMatch(/Another stock change was in progress/);
  });

  it("MF2: that exhausted retryStockTx 503 now carries Retry-After: 2, body unchanged", async () => {
    const res = await request(app.getHttpServer()).get("/t/exhausted");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    expect(res.body.code).toBe("LOCK_UNAVAILABLE");
    expect(res.body.message).toMatch(/Another stock change was in progress/);
  });

  it("MF2: the count committer 503 keeps committedLines / totalLines and gets the header", async () => {
    const res = await request(app.getHttpServer()).get("/t/count-503");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    expect(res.body).toEqual({
      code: "LOCK_UNAVAILABLE",
      message: "Part of this count was saved. Commit again to finish.",
      committedLines: 3,
      totalLines: 10,
    });
  });

  it("MF2: a 503 with a DIFFERENT code gets NO Retry-After", async () => {
    const res = await request(app.getHttpServer()).get("/t/other-503");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(res.body.code).toBe("SOMETHING_ELSE");
  });

  it("MF2: 409s (STOCK_COUNT_COMMITTING, MERGE_IN_PROGRESS, CAS) are untouched", async () => {
    for (const [path, code] of [
      ["/t/committing", "STOCK_COUNT_COMMITTING"],
      ["/t/merge", "MERGE_IN_PROGRESS"],
      ["/t/cas", "CONCURRENT_UPDATE"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(409);
      expect(res.headers["retry-after"]).toBeUndefined();
      expect(res.body.code).toBe(code);
    }
  });

  it("SA-4: a mapped error over HTTP reaches Sentry once, at warning level, by matched route", async () => {
    jest.clearAllMocks();
    const res = await request(app.getHttpServer()).get("/t/lock");
    expect(res.status).toBe(503);
    expect(captured()).toHaveLength(1);
    expect(mockScope.setLevel).toHaveBeenCalledWith("warning");
    expect(mockScope.setFingerprint).toHaveBeenCalledWith(["GET /t/lock", "55P03"]);
  });

  it("SA-4: the exhausted retryStockTx 503 is reported at warning level too (not an error-level 5xx)", async () => {
    jest.clearAllMocks();
    await request(app.getHttpServer()).get("/t/exhausted");
    expect(captured()).toHaveLength(1);
    expect(mockScope.setLevel).toHaveBeenCalledWith("warning");
    expect(mockScope.setFingerprint).toHaveBeenCalledWith(["GET /t/exhausted", "LOCK_UNAVAILABLE"]);
  });

  it("registers the catch-all FIRST, the lock filter right after it, the narrow ones last", () => {
    // Nest checks global filters in REVERSE registration order and a @Catch() filter matches
    // everything, so the lock filter (which delegates non-lock errors to the catch-all itself) must
    // sit BEFORE the narrow Throttler / Multer filters or it would shadow them.
    expect(buildGlobalExceptionFilters({} as any).map((f) => f.constructor.name)).toEqual([
      "SentryExceptionFilter",
      "LockConflictFilter",
      "ThrottlerExceptionFilter",
      "MulterExceptionFilter",
    ]);
  });
});
