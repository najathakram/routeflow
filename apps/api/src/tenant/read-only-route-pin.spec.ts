import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AppModule } from "../app.module";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { BuyerJwtAuthGuard } from "../buyer/guards/buyer-jwt-auth.guard";
import {
  BUYER_ACCOUNT_WRITES,
  PUBLIC_WRITE_ROUTES,
  READ_ONLY_ALLOWED_MUTATIONS,
  isReadOnlyAllowedMutation,
} from "./read-only-registry";
import {
  classifyRoutes,
  concretePath,
  formatRouteTable,
  routeTableOf,
  type RouteRegistries,
} from "../common/testing/route-table";

/**
 * SA-776 route pin (row 382): EVERY mutating route in the Nest module graph is classified against the read-only
 * registries. A staff-JWT route is guarded by default; the ones the guard lets through are exactly the registry
 * entries; buyer-JWT writes carry BuyerSellerContextGuard or are in BUYER_ACCOUNT_WRITES; no-auth writes are in
 * PUBLIC_WRITE_ROUTES; admin routes carry SuperAdminGuard. Static metadata walk: no DB, no Redis, no Nest boot.
 *
 * The deliverable table: `RF_WRITE_ROUTE_TABLE=1 npx jest src/tenant/read-only-route-pin` writes
 * `local-assets/read-only-route-table.md` (gitignored); a failing run prints it in full.
 */
const REGISTRIES: RouteRegistries = {
  allowList: READ_ONLY_ALLOWED_MUTATIONS,
  buyerAccountWrites: BUYER_ACCOUNT_WRITES,
  publicWrites: PUBLIC_WRITE_ROUTES,
};

const REAL = routeTableOf(AppModule);
const { rows, problems } = classifyRoutes(REAL, REGISTRIES);

/** The concrete mutating routes the global guard lets through under READ_ONLY - pinned so a new one is reviewed. */
const EXPECTED_ALLOWED: string[] = [
  "DELETE /api/v1/auth/sessions/:id",
  "POST /api/v1/auth/apple",
  "POST /api/v1/auth/apple/link",
  "POST /api/v1/auth/apple/nonce",
  "POST /api/v1/auth/apple/notifications",
  "POST /api/v1/auth/change-password",
  "POST /api/v1/auth/google/exchange",
  "POST /api/v1/auth/handoff",
  "POST /api/v1/auth/handoff/exchange",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/request-password-reset",
  "POST /api/v1/auth/reset-password",
  "POST /api/v1/auth/set-password",
  "POST /api/v1/auth/verify-email",
  "POST /api/v1/billing/portal",
  "POST /api/v1/billing/quote",
  "POST /api/v1/billing/subscribe",
  "POST /api/v1/billing/subscription",
  "POST /api/v1/billing/subscription/cancel",
  "POST /api/v1/billing/subscription/checkout",
  "POST /api/v1/billing/subscription/downgrade",
  "POST /api/v1/billing/subscription/resume",
  "POST /api/v1/orders/:id/receipt",
  "POST /api/v1/orders/counter-sale/day-close",
  "POST /api/v1/orders/counter-sale/day-close/:id/reopen",
  "POST /api/v1/orders/counter-sale/day-close/:id/report",
];

describe("SA-776 read-only route pin: every mutating route is classified", () => {
  if (process.env.RF_WRITE_ROUTE_TABLE === "1") {
    it("writes the route table to local-assets/", () => {
      const out = path.resolve(__dirname, "../../../../local-assets/read-only-route-table.md");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${formatRouteTable(rows)}\n`);
      expect(fs.existsSync(out)).toBe(true);
    });
  }

  it("sees the whole graph (an empty walk must not report green)", () => {
    expect(new Set(REAL.map((r) => r.controller)).size).toBeGreaterThanOrEqual(90);
    expect(rows.length).toBeGreaterThanOrEqual(500);
    for (const klass of [
      "STAFF_GUARDED",
      "STAFF_ALLOW_LISTED",
      "SUPER_ADMIN",
      "BUYER_SELLER_GUARDED",
      "BUYER_ACCOUNT",
      "PUBLIC",
    ]) {
      expect(rows.some((r) => r.klass === klass)).toBe(true);
    }
  });

  it("classifies every mutating route; prints the full table on a failure", () => {
    if (problems.length > 0) {
      throw new Error(
        `${problems.length} read-only classification problem(s):\n- ${problems.join("\n- ")}\n\n${formatRouteTable(rows)}`,
      );
    }
    expect(rows.every((r) => r.klass !== "UNCLASSIFIED")).toBe(true);
  });

  it("the routes the guard lets through under READ_ONLY are exactly the reviewed list", () => {
    const allowed = rows
      .filter(
        (r) =>
          r.klass === "STAFF_ALLOW_LISTED" ||
          isReadOnlyAllowedMutation(r.route.method, concretePath(r.route.path)),
      )
      .map((r) => r.key)
      .sort();
    expect(allowed).toEqual([...EXPECTED_ALLOWED].sort());
  });

  it("every staff-JWT mutating route the guard refuses is refused by DEFAULT (no entry needed)", () => {
    const guarded = rows.filter((r) => r.klass === "STAFF_GUARDED");
    expect(guarded.length).toBeGreaterThanOrEqual(380);
    for (const r of guarded) {
      expect(isReadOnlyAllowedMutation(r.route.method, concretePath(r.route.path))).toBe(false);
    }
  });

  it("the buyer's seller-scoped writes all carry BuyerSellerContextGuard", () => {
    const buyer = rows.filter((r) => r.klass === "BUYER_SELLER_GUARDED");
    expect(buyer.length).toBeGreaterThanOrEqual(18);
    for (const r of buyer) expect(r.route.guards).toContain("BuyerSellerContextGuard");
  });

  it("invites/:token/accept and sellers/request are classified as gated by the shared seller-status rule (SA-776 GAP-2)", () => {
    const reasons = BUYER_ACCOUNT_WRITES.filter((e) =>
      /invites\/:token\/accept$|sellers\/request$/.test(e.route),
    ).map((e) => e.reason);
    expect(reasons).toHaveLength(2);
    for (const r of reasons) expect(r).toMatch(/gated by the shared seller-status rule/);
  });
});

describe("SA-776 read-only route pin: red proofs on a fixture graph", () => {
  @Controller("fixture")
  class FixtureController {
    @Post("unclassified")
    unclassified() {
      return null;
    }
    @Get("read")
    read() {
      return null;
    }
  }

  @Controller("fixture-staff")
  @UseGuards(JwtAuthGuard)
  class FixtureStaffController {
    @Post("write")
    write() {
      return null;
    }
  }

  @Controller("platform-admin/fixture")
  @UseGuards(JwtAuthGuard)
  class FixtureAdminController {
    @Post("danger")
    danger() {
      return null;
    }
  }

  @Controller("buyer/fixture")
  @UseGuards(BuyerJwtAuthGuard)
  class FixtureBuyerController {
    @Post("write")
    write() {
      return null;
    }
  }

  const fixtureTable = (...ctrls: Array<new () => unknown>) => {
    // routeTableOf walks a root module; a bare class list is wrapped in a throwaway module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Module } = require("@nestjs/common");
    @Module({ controllers: ctrls })
    class FixtureModule {}
    return routeTableOf(FixtureModule);
  };
  const empty: RouteRegistries = { allowList: [], buyerAccountWrites: [], publicWrites: [] };

  it("a no-auth @Post that is not in PUBLIC_WRITE_ROUTES FAILS", () => {
    const r = classifyRoutes(fixtureTable(FixtureController), empty);
    expect(r.problems.join("\n")).toMatch(
      /POST \/api\/v1\/fixture\/unclassified.*not in PUBLIC_WRITE_ROUTES/,
    );
    // a GET is never a finding
    expect(r.rows.map((x) => x.key)).toEqual(["POST /api/v1/fixture/unclassified"]);
  });

  it("listing the route in PUBLIC_WRITE_ROUTES with a reason makes it pass", () => {
    const r = classifyRoutes(fixtureTable(FixtureController), {
      ...empty,
      publicWrites: [{ route: "POST /api/v1/fixture/unclassified", reason: "fixture" }],
    });
    expect(r.problems).toEqual([]);
  });

  it("a staff-JWT route is guarded by default and passes with no entry", () => {
    const r = classifyRoutes(fixtureTable(FixtureStaffController), empty);
    expect(r.problems).toEqual([]);
    expect(r.rows[0].klass).toBe("STAFF_GUARDED");
  });

  it("an allow-list entry that matches no route FAILS (no dead entries)", () => {
    const r = classifyRoutes(fixtureTable(FixtureStaffController), {
      ...empty,
      allowList: [{ method: "POST", pattern: /^\/api\/v1\/nothing$/, reason: "dead" }],
    });
    expect(r.problems.join("\n")).toMatch(/dead entry/);
  });

  it("an allow-list entry with an empty reason FAILS", () => {
    const r = classifyRoutes(fixtureTable(FixtureStaffController), {
      ...empty,
      allowList: [{ method: "POST", pattern: /^\/api\/v1\/fixture-staff\/write$/, reason: "  " }],
    });
    expect(r.problems.join("\n")).toMatch(/empty reason/);
  });

  it("a stale PUBLIC / BUYER_ACCOUNT entry (route now authed, or gone) FAILS", () => {
    const r = classifyRoutes(fixtureTable(FixtureStaffController), {
      ...empty,
      publicWrites: [{ route: "POST /api/v1/fixture-staff/write", reason: "was public" }],
      buyerAccountWrites: [{ route: "POST /api/v1/gone", reason: "removed" }],
    });
    const text = r.problems.join("\n");
    expect(text).toMatch(/stale, the route's auth context is now STAFF/);
    expect(text).toMatch(/POST \/api\/v1\/gone: dead entry/);
  });

  it("an /admin route without SuperAdminGuard FAILS", () => {
    const r = classifyRoutes(fixtureTable(FixtureAdminController), empty);
    expect(r.problems.join("\n")).toMatch(/lacks SuperAdminGuard/);
  });

  it("a buyer-JWT write with neither BuyerSellerContextGuard nor a BUYER_ACCOUNT_WRITES entry FAILS", () => {
    const r = classifyRoutes(fixtureTable(FixtureBuyerController), empty);
    expect(r.problems.join("\n")).toMatch(/not in BUYER_ACCOUNT_WRITES/);
  });
});
