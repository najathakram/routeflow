import { CallHandler, ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { RouteHitsInterceptor } from "./route-hits.interceptor";
import { RouteHitsService } from "./route-hits.service";

const ctx = (type: string, req: unknown) =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe("RouteHitsInterceptor (W3)", () => {
  const record = jest.fn();
  const hits = { record } as unknown as RouteHitsService;
  const interceptor = new RouteHitsInterceptor(hits);
  beforeEach(() => record.mockReset());

  it("counts the matched route template BEFORE the handler runs (a throwing handler is still counted)", () => {
    const order: string[] = [];
    record.mockImplementation(() => order.push("record"));
    const next: CallHandler = {
      handle: () => {
        order.push("handle");
        return of(1);
      },
    };
    interceptor.intercept(
      ctx("http", { method: "GET", route: { path: "/api/v1/customers/:id" } }),
      next,
    );
    expect(record).toHaveBeenCalledWith("GET /api/v1/customers/:id");
    expect(order).toEqual(["record", "handle"]); // before next.handle(), not on success only
  });

  it("returns next.handle() synchronously: no await, no promise on the request path", () => {
    const stream = of(1);
    const out = interceptor.intercept(ctx("http", { method: "GET", route: { path: "/x" } }), {
      handle: () => stream,
    });
    expect(out).toBe(stream);
    expect(typeof (out as { then?: unknown }).then).toBe("undefined");
  });

  it("ignores non-HTTP contexts (websocket / rpc)", () => {
    interceptor.intercept(ctx("ws", {}), { handle: () => of(1) });
    expect(record).not.toHaveBeenCalled();
  });

  it("a failure inside counting never fails the request", () => {
    record.mockImplementation(() => {
      throw new Error("boom");
    });
    const stream = of(1);
    expect(() =>
      interceptor.intercept(ctx("http", { method: "GET", route: { path: "/x" } }), {
        handle: () => stream,
      }),
    ).not.toThrow();
  });
});
