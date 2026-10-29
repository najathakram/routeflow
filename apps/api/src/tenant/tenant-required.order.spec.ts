import "reflect-metadata";
import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  NestInterceptor,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../app.module";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { AuditInterceptor } from "../audit/audit.interceptor";
import { RouteHitsInterceptor } from "../route-hits/route-hits.interceptor";
import { TenantRequiredInterceptor } from "./tenant-required.interceptor";

/**
 * W-767 (SA-917): TenantRequiredInterceptor must refuse BEFORE any global interceptor with a side effect records the write.
 * AuditInterceptor queues its row and RouteHitsInterceptor counts the hit BEFORE `next.handle()`, so either one ahead of it
 * would log a refused write as done.
 *
 * Nest runs global (APP_INTERCEPTOR) interceptors in module-scan order, and index 0 runs first. Its scanner inserts a module
 * BEFORE its imports, depth-first, in `imports` order (DependenciesScanner.scanForModules), then reads each module's
 * providers in that insertion order. This walks the real module graph the same way: no Nest boot, no DB.
 */
function globalInterceptorOrder(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const walk = (m: unknown) => {
    let ref: any = m;
    if (ref && typeof ref === "object" && "forwardRef" in ref) ref = ref.forwardRef();
    const cls = ref && typeof ref === "object" && "module" in ref ? ref.module : ref;
    if (typeof cls !== "function" || seen.has(cls)) return;
    seen.add(cls);
    const providers: any[] = [
      ...(Reflect.getMetadata("providers", cls) ?? []),
      ...(ref !== cls ? (ref.providers ?? []) : []),
    ];
    for (const p of providers) {
      if (p && typeof p === "object" && p.provide === APP_INTERCEPTOR)
        out.push(p.useClass ?? p.useExisting);
    }
    const imports: unknown[] = [
      ...(Reflect.getMetadata("imports", cls) ?? []),
      ...(ref !== cls ? (ref.imports ?? []) : []),
    ];
    for (const i of imports) walk(i);
  };
  walk(root);
  return out;
}

describe("W-767 (SA-917): TenantRequiredInterceptor runs before the audit and route-hit interceptors", () => {
  const order = globalInterceptorOrder(AppModule);

  it("the walk reproduces REAL Nest's global-interceptor order (a tiny booted app, so the pin's premise is tested)", async () => {
    const ran: string[] = [];
    const make = (name: string) => {
      @Injectable()
      class Probe implements NestInterceptor {
        intercept(_ctx: ExecutionContext, next: CallHandler) {
          ran.push(name);
          return next.handle();
        }
      }
      Object.defineProperty(Probe, "name", { value: name });
      return Probe;
    };
    const [Y, W, X, Z] = ["Y", "W", "X", "Z"].map(make);
    @Module({ providers: [{ provide: APP_INTERCEPTOR, useClass: Z }] })
    class Deep {}
    @Module({ imports: [Deep], providers: [{ provide: APP_INTERCEPTOR, useClass: X }] })
    class B {}
    @Module({ providers: [{ provide: APP_INTERCEPTOR, useClass: W }] })
    class C {}
    @Controller("probe")
    class ProbeController {
      @Get()
      get() {
        return "ok";
      }
    }
    @Module({
      imports: [C, B],
      controllers: [ProbeController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: Y }],
    })
    class Root {}

    const app = (
      await Test.createTestingModule({ imports: [Root] }).compile()
    ).createNestApplication();
    await app.init();
    await listenOnLoopback(app); // #2267: own a 127.0.0.1 port before request(), so no other worker's server answers
    try {
      await request(app.getHttpServer()).get("/probe").expect(200);
    } finally {
      await app.close();
    }
    expect(ran).toEqual(["Y", "W", "X", "Z"]); // the module itself, then its imports depth-first, in order
    expect(globalInterceptorOrder(Root)).toEqual([Y, W, X, Z]);
  });

  it("is registered exactly once as a global interceptor", () => {
    expect(order.filter((c) => c === TenantRequiredInterceptor)).toHaveLength(1);
  });

  it("runs ahead of AuditInterceptor and RouteHitsInterceptor, so a refused write is never logged or counted", () => {
    const at = (c: unknown) => order.indexOf(c);
    expect(at(AuditInterceptor)).toBeGreaterThan(-1);
    expect(at(RouteHitsInterceptor)).toBeGreaterThan(-1);
    expect(at(TenantRequiredInterceptor)).toBeLessThan(at(AuditInterceptor));
    expect(at(TenantRequiredInterceptor)).toBeLessThan(at(RouteHitsInterceptor));
  });
});
