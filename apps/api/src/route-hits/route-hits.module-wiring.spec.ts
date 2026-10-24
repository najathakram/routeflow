import * as fs from "fs";
import * as path from "path";

/** W3: the route hit counter must stay wired: AppModule imports it and the module registers the global interceptor. */
describe("RouteHitsModule wiring (static)", () => {
  it("AppModule imports RouteHitsModule", () => {
    const src = fs.readFileSync(path.join(__dirname, "../app.module.ts"), "utf8");
    expect(src).toMatch(/import \{ RouteHitsModule \} from "\.\/route-hits\/route-hits\.module"/);
    expect(src).toMatch(/^\s+RouteHitsModule,$/m);
  });

  it("the module provides RouteHitsInterceptor as APP_INTERCEPTOR", () => {
    const src = fs.readFileSync(path.join(__dirname, "route-hits.module.ts"), "utf8");
    expect(src).toMatch(/provide:\s*APP_INTERCEPTOR\s*,\s*useClass:\s*RouteHitsInterceptor/);
  });

  it("the interceptor counts before next.handle() and never awaits (source pin)", () => {
    const src = fs.readFileSync(path.join(__dirname, "route-hits.interceptor.ts"), "utf8");
    expect(src.indexOf("this.hits.record")).toBeGreaterThan(-1);
    expect(src.indexOf("this.hits.record")).toBeLessThan(src.indexOf("return next.handle()"));
    expect(src).not.toMatch(/\bawait\b|async /);
  });
});
