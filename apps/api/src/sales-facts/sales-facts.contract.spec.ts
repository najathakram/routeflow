import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import {
  INSIGHT_GRAINS,
  INSIGHT_MAX_BUCKETS,
  INSIGHT_MAX_WINDOW_MONTHS,
} from "../analytics/demand-range";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { ProductInsightsController } from "./product-insights.controller";
import { INSIGHT_CSV_MAX_LINES, INSIGHT_TOP_BUYERS } from "./sales-facts.constants";

/**
 * #2118 — the API may only `import type` from `@routeflow/types` (its entry is raw TypeScript;
 * see `no-runtime-workspace-imports.spec.ts`), so the runtime values it enforces are local
 * copies. L-072/L-206: pin each copy to the shared value READ AT TEST TIME, never to a second
 * hand-typed literal, so the DTO the web/mobile lanes read and the limits the API enforces can
 * never disagree.
 */
function readShared(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@routeflow/types") as Record<string, unknown>;
  } catch {
    return {};
  }
}
const SHARED = readShared();

describe("sales-facts ↔ @routeflow/types contract (#2118)", () => {
  it("INSIGHT_GRAINS is exactly the shared INSIGHT_GRAIN_VALUES, in order", () => {
    const shared = SHARED["INSIGHT_GRAIN_VALUES"];
    expect(Array.isArray(shared)).toBe(true);
    expect([...INSIGHT_GRAINS]).toEqual(shared);
  });

  it.each([
    ["INSIGHT_MAX_WINDOW_MONTHS", INSIGHT_MAX_WINDOW_MONTHS],
    ["INSIGHT_MAX_BUCKETS", INSIGHT_MAX_BUCKETS],
    ["INSIGHT_CSV_MAX_LINES", INSIGHT_CSV_MAX_LINES],
    ["INSIGHT_TOP_BUYERS", INSIGHT_TOP_BUYERS],
  ])("the API's %s equals the shared constant", (name, local) => {
    expect(typeof SHARED[name]).toBe("number");
    expect(local).toBe(SHARED[name]);
  });

  it("the plan's limits: 36-month window, 400 buckets, 50k CSV lines, top 50 buyers", () => {
    expect([INSIGHT_MAX_WINDOW_MONTHS, INSIGHT_MAX_BUCKETS]).toEqual([36, 400]);
    expect([INSIGHT_CSV_MAX_LINES, INSIGHT_TOP_BUYERS]).toEqual([50_000, 50]);
  });
});

describe("ProductInsightsController gate (plan A8)", () => {
  it("lives under /analytics/* so the class-level flag.analytics registry text stays true", () => {
    expect(Reflect.getMetadata(PATH_METADATA, ProductInsightsController)).toBe(
      "analytics/products",
    );
  });

  it("is OPERATOR-only at class level (TENANT_ADMIN satisfies OPERATOR; no buyer access)", () => {
    expect(Reflect.getMetadata(ROLES_KEY, ProductInsightsController)).toEqual([UserRole.OPERATOR]);
  });

  it("requires flag.analytics at class level", () => {
    const keys = Reflect.getMetadataKeys(ProductInsightsController);
    const flagKey = keys.find(
      (k) => Reflect.getMetadata(k, ProductInsightsController) === "flag.analytics",
    );
    expect(flagKey).toBeDefined();
  });
});
