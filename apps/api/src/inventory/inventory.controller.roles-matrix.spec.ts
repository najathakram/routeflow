import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { InventoryController } from "./inventory.controller";

/**
 * Inventory W0 / X4 — the exact effective @Roles of EVERY InventoryController handler.
 *
 * RolesGuard resolves `getAllAndOverride(handler, class)`, so a handler-level @Roles replaces the
 * class-level @Roles(OPERATOR). `inventory.controller.roles.spec.ts` (B168) pins only 8 writes, the
 * four reads and recomputeCosts; this matrix pins the other handlers too and fails when a NEW
 * handler is added without a row here (so a widened or forgotten role cannot ship silently).
 *
 * Contract: DRIVER is admitted on exactly the four reads; recompute-costs is TENANT_ADMIN;
 * every other handler is exactly [OPERATOR].
 */
const OP = [UserRole.OPERATOR];
const OP_DRIVER = [UserRole.OPERATOR, UserRole.DRIVER];
const ADMIN = [UserRole.TENANT_ADMIN];

const EXPECTED: Record<string, UserRole[]> = {
  // the four reads that keep DRIVER
  getStockOverview: OP_DRIVER,
  listMovements: OP_DRIVER,
  listPOs: OP_DRIVER,
  getPO: OP_DRIVER,
  // cost correction is admin-only
  recomputeCosts: ADMIN,
  // everything else is class-level OPERATOR
  exportMovementsCsv: OP,
  recordPurchase: OP,
  recordAdjustment: OP,
  commitStockCount: OP,
  assignToVariants: OP,
  startStockCountSession: OP,
  listStockCountSessions: OP,
  getStockCountSession: OP,
  upsertStockCountLine: OP,
  removeStockCountLine: OP,
  commitStockCountSession: OP,
  discardStockCountSession: OP,
  getValuation: OP,
  setCostBasis: OP,
  bulkSetCostBasis: OP,
  listSuppliers: OP,
  createSupplier: OP,
  updateSupplier: OP,
  createPO: OP,
  updatePO: OP,
  sendPO: OP,
  receivePO: OP,
  closePO: OP,
  getForecasting: OP,
  setReorderPoint: OP,
};

describe("InventoryController exact role matrix (inventory W0 X4)", () => {
  const reflector = new Reflector();
  const proto = InventoryController.prototype as unknown as Record<string, unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (n) => n !== "constructor" && typeof proto[n] === "function",
  );
  const effective = (h: string) =>
    reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      proto[h] as () => void,
      InventoryController,
    ]);

  it("every handler on the controller has a row in the matrix (no unpinned handler)", () => {
    expect([...handlers].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("%s resolves to exactly its pinned role list", (h, roles) => {
    expect(effective(h)).toEqual(roles);
  });

  it("DRIVER is admitted on exactly the four reads and nowhere else", () => {
    const withDriver = handlers.filter((h) => effective(h)?.includes(UserRole.DRIVER)).sort();
    expect(withDriver).toEqual(["getPO", "getStockOverview", "listMovements", "listPOs"]);
  });
});
