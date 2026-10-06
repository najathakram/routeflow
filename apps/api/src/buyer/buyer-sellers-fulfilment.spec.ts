import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BuyerService } from "./buyer.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Order ahead (web): the portal learns a seller's buyer-facing fulfilment choice from
 * `GET /buyer/sellers`. Exactly `{ portalMethods, portalDefault }` per seller, derived through the one
 * capability path, scoped to THAT seller's tenant. Nothing else of the capability may leak.
 */
describe("BuyerService.getSellers fulfilment offer", () => {
  let service: BuyerService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let modes: Record<string, string>;
  let getEffectiveMode: jest.Mock;

  const link = (tenantId: string, slug: string) => ({
    id: `l-${tenantId}`,
    status: "ACTIVE",
    linkedAt: new Date(),
    tenantId,
    tenant: { id: tenantId, name: slug, slug },
    customer: { id: "c1", businessName: "Retail Corner", email: "c@x.com" },
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.tenantConfig.findFirst.mockResolvedValue(null);
    modes = {};
    getEffectiveMode = jest.fn(async (tenantId: string) => modes[tenantId] ?? "unset");
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: FeatureConfigService, useValue: { getEffectiveMode } },
      ],
    }).compile();
    service = module.get(BuyerService);
  });

  it("pickup_ship offers PICKUP and SHIP, defaulting to PICKUP, and nothing else", async () => {
    modes.t1 = "pickup_ship";
    prisma.customerLink.findMany.mockResolvedValue([link("t1", "acme")] as any);
    const [row] = await service.getSellers("b1");
    expect(row.fulfilment).toEqual({ portalMethods: ["PICKUP", "SHIP"], portalDefault: "PICKUP" });
    expect(Object.keys(row.fulfilment).sort()).toEqual(["portalDefault", "portalMethods"]);
    expect(getEffectiveMode).toHaveBeenCalledWith("t1", "fulfilment_model");
  });

  it("unset offers no choice", async () => {
    prisma.customerLink.findMany.mockResolvedValue([link("t1", "acme")] as any);
    const [row] = await service.getSellers("b1");
    expect(row.fulfilment).toEqual({ portalMethods: [], portalDefault: null });
  });

  it("ship offers SHIP only", async () => {
    modes.t1 = "ship";
    prisma.customerLink.findMany.mockResolvedValue([link("t1", "acme")] as any);
    const [row] = await service.getSellers("b1");
    expect(row.fulfilment).toEqual({ portalMethods: ["SHIP"], portalDefault: "SHIP" });
  });

  it("each seller reads its OWN tenant's mode", async () => {
    modes.t1 = "pickup_ship";
    modes.t2 = "ship";
    prisma.customerLink.findMany.mockResolvedValue([link("t1", "a"), link("t2", "b")] as any);
    const rows = await service.getSellers("b1");
    expect(rows.map((r) => r.fulfilment.portalDefault)).toEqual(["PICKUP", "SHIP"]);
  });

  it("a failed mode read falls back to no choice, never a 500", async () => {
    getEffectiveMode.mockRejectedValue(new Error("db down"));
    prisma.customerLink.findMany.mockResolvedValue([link("t1", "acme")] as any);
    const [row] = await service.getSellers("b1");
    expect(row.fulfilment).toEqual({ portalMethods: [], portalDefault: null });
  });
});
