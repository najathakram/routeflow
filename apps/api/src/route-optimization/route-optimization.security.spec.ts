/**
 * Security tests for the route-optimization module.
 *
 * F9-007: optimize/analyze hit the external ORS matrix API + a TSP solve and
 * previously relied only on the global 100/60s throttle. They now carry a tight
 * per-route @Throttle (10/60s). This locks that decorator onto every expensive
 * endpoint so it can't silently regress.
 */
import "reflect-metadata";
import {
  RouteOptimizationController,
  RouteTemplateOptimizationController,
} from "./route-optimization.controller";

const LIMIT_KEY = "THROTTLER:LIMITdefault";
const TTL_KEY = "THROTTLER:TTLdefault";

describe("Route optimization — F9-007 per-route throttle", () => {
  const cases: Array<[string, (...a: any[]) => any]> = [
    ["run optimize", RouteOptimizationController.prototype.optimize],
    ["run analyze", RouteOptimizationController.prototype.analyze],
    ["template optimize", RouteTemplateOptimizationController.prototype.optimize],
    ["template analyze", RouteTemplateOptimizationController.prototype.analyze],
  ];

  it.each(cases)("%s carries a tight @Throttle (10 / 60s)", (_name, handler) => {
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(10);
    expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60_000);
  });
});
