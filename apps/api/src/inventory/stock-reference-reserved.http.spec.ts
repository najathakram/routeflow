import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { buildGlobalValidationPipe } from "../common/global-validation-pipe";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { InventoryController } from "./inventory.controller";
import { InventoryMovementsExportService } from "./inventory-movements-export.service";
import { InventoryService } from "./inventory.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/**
 * B640 (row 562 S1), over HTTP with the REAL global ValidationPipe (the one main.ts installs): a free-text
 * stock `reference` that starts with the count head is refused 400 and the body carries
 * `code: "STOCK_REFERENCE_RESERVED"` (web and mobile branch on `code`), not a plain ValidationPipe 400 that
 * only has a message array. Only the guards and the service are stand-ins.
 */
describe("a reserved stock reference over HTTP (B640)", () => {
  let app: INestApplication;
  const inventory = { recordAdjustment: jest.fn(), recordPurchase: jest.fn() };

  const allow: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      ctx.switchToHttp().getRequest().user = { id: "u-1", sub: "u-1", role: "OPERATOR" };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [
        { provide: InventoryService, useValue: inventory },
        { provide: InventoryMovementsExportService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PlanFlagGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(buildGlobalValidationPipe());
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    inventory.recordAdjustment.mockReset().mockResolvedValue({ id: "m-1" });
    inventory.recordPurchase.mockReset().mockResolvedValue({ id: "m-2" });
  });

  const post = (path: string, body: object) => request(app.getHttpServer()).post(path).send(body);

  it.each([
    ["adjustment", "/movements/adjustment", { productId: "p1", quantity: 1 }],
    ["purchase", "/movements/purchase", { productId: "p1", quantity: 1, unitCost: 2 }],
  ])(
    "%s with the count's reference: 400 with code STOCK_REFERENCE_RESERVED, no write",
    async (_n, path, base) => {
      const res = await post(`/inventory${path}`, { ...base, reference: " stock_count-abc" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("STOCK_REFERENCE_RESERVED");
      expect(typeof res.body.message).toBe("string");
      expect(inventory.recordAdjustment).not.toHaveBeenCalled();
      expect(inventory.recordPurchase).not.toHaveBeenCalled();
    },
  );

  it("an ordinary reference passes the pipe and reaches the service", async () => {
    const res = await post("/inventory/movements/adjustment", {
      productId: "p1",
      quantity: 1,
      reference: "RECOUNT-AISLE-3",
    });

    expect(res.status).toBeLessThan(300);
    expect(inventory.recordAdjustment).toHaveBeenCalledTimes(1);
  });

  it("every other validation failure keeps the pipe's own body (a message array, no code)", async () => {
    const res = await post("/inventory/movements/adjustment", { productId: "p1", quantity: 0 });

    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.code).toBeUndefined();
    expect(inventory.recordAdjustment).not.toHaveBeenCalled();
  });

  it("main.ts installs this same pipe (not a hand-built ValidationPipe)", () => {
    const main = readFileSync(join(__dirname, "..", "main.ts"), "utf8");
    expect(main).toContain("buildGlobalValidationPipe()");
    expect(main).not.toContain("new ValidationPipe(");
  });
});
