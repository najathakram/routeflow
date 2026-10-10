/**
 * #2198 (SA-329, SA-397): every flag.msrp gate inside a service — ProductsService / CustomersService
 * assertMsrpAllowed, InvoicesService.applyMsrpSnapshots, EstimatesService.msrpEnabled — must return the SAME
 * verdict as the flag.msrp route guard. Both ask `EntitlementAuthority.can` — the one evaluation point
 * (overrides, the resolver's verdict in live mode, the diff log) — never `EntitlementsService.hasFlag`,
 * which only knows the old path and so disagrees with the guard whenever live mode's resolver does.
 *
 * Real EntitlementAuthority + real PlanFlagGuard + the real `hasFlag` body over mocked collaborators;
 * the two service helpers run with a minimal `this` (they read only prisma, the authority and the catalog).
 */
// InvoicesService pulls ESM-only deps (same guard as invoices.service.spec.ts).
jest.mock("../invoices/invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { EntitlementsService } from "./entitlements.service";
import { PlanFlagGuard } from "./plan-flag.guard";
import { ProductsService } from "../products/products.service";
import { CustomersService } from "../customers/customers.service";
import { InvoicesService } from "../invoices/invoices.service";
import { EstimatesService } from "../estimates/estimates.service";

type Override = "GRANT" | "DENY" | null;
interface Case {
  name: string;
  mode: "shadow" | "live";
  override: Override;
  planHasFlag: boolean;
  resolverEffective: boolean;
}

const TENANT = "tn-msrp";
const FLAG = "flag.msrp";

function build(c: Case) {
  const featureOverrides = { get: jest.fn().mockResolvedValue(c.override) };
  const ent = {
    planKey: "pro",
    flags: c.planHasFlag ? [FLAG] : [],
    addons: [],
  };
  const entitlements: any = {
    resolve: jest.fn().mockResolvedValue(ent),
    isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false),
  };
  // The REAL hasFlag body, so the pin tracks what the service used to ask.
  entitlements.hasFlag = (t: string, k: string) =>
    EntitlementsService.prototype.hasFlag.call(
      { featureOverrides, resolve: entitlements.resolve },
      t,
      k,
    );
  const resolver = {
    resolve: jest.fn().mockResolvedValue({
      byKey: new Map([[FLAG, { effective: c.resolverEffective, source: "PRESET" }]]),
    }),
  };
  const modeService = { getMode: jest.fn().mockResolvedValue(c.mode) };
  const diffService = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma: any = {
    tenantAddon: { findUnique: jest.fn().mockResolvedValue(null) },
    getTenantId: () => TENANT,
  };
  const authority = new EntitlementAuthority(
    entitlements,
    featureOverrides as any,
    resolver as any,
    modeService as any,
    diffService as any,
    prisma,
  );
  const catalog = {
    upgradeTargetForFlag: jest.fn().mockResolvedValue({
      planKey: "pro",
      planMonthlyPrice: 99,
      addonSku: null,
      addonMonthlyPrice: null,
    }),
  };
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(FLAG) } as unknown as Reflector;
  const guard = new PlanFlagGuard(
    reflector,
    entitlements,
    catalog as any,
    featureOverrides as any,
    authority,
  );
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: { tenantId: TENANT } }) }),
  } as unknown as ExecutionContext;
  // Minimal `this` for each helper: ProductsService names the catalog `planCatalog`, Customers `catalog`.
  const self = { prisma, entitlements, authority, planCatalog: catalog, catalog };
  return { guard, ctx, self };
}

const allowed = (p: Promise<unknown>) =>
  p.then(
    () => true,
    (e) => {
      if (e instanceof ForbiddenException) return false;
      throw e;
    },
  );

const CASES: Case[] = [
  {
    name: "GRANT override (live)",
    mode: "live",
    override: "GRANT",
    planHasFlag: false,
    resolverEffective: true,
  },
  {
    name: "DENY override (live)",
    mode: "live",
    override: "DENY",
    planHasFlag: true,
    resolverEffective: false,
  },
  {
    name: "no override, plan lacks it, live resolver grants",
    mode: "live",
    override: null,
    planHasFlag: false,
    resolverEffective: true,
  },
  {
    name: "no override, plan has it, live resolver denies",
    mode: "live",
    override: null,
    planHasFlag: true,
    resolverEffective: false,
  },
  {
    name: "no override, plan has it (shadow)",
    mode: "shadow",
    override: null,
    planHasFlag: true,
    resolverEffective: false,
  },
  {
    name: "no override, plan lacks it (shadow)",
    mode: "shadow",
    override: null,
    planHasFlag: false,
    resolverEffective: true,
  },
];

describe("flag.msrp: the service write gate agrees with the route guard (#2198)", () => {
  it.each(CASES)("$name", async (c) => {
    const { guard, ctx, self } = build(c);
    const guardVerdict = await allowed(guard.canActivate(ctx));
    const products = await allowed((ProductsService.prototype as any).assertMsrpAllowed.call(self));
    const customers = await allowed(
      (CustomersService.prototype as any).assertMsrpAllowed.call(self),
    );
    // Invoices: the snapshot runs (reads the MSRP map) only when flag.msrp is allowed.
    const db = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", msrp: 9 }]) },
      customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await (InvoicesService.prototype as any).applyMsrpSnapshots.call(self, db, "cust-1", [
      { productId: "p1" },
    ]);
    const invoices = db.product.findMany.mock.calls.length > 0;
    const estimates = await (EstimatesService.prototype as any).msrpEnabled.call(self, TENANT);
    expect({ products, customers, invoices, estimates }).toEqual({
      products: guardVerdict,
      customers: guardVerdict,
      invoices: guardVerdict,
      estimates: guardVerdict,
    });
  });
});
