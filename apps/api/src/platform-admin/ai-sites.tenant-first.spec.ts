import { ForbiddenException } from "@nestjs/common";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";
import { SupplierStatementsService } from "../supplier-statements/supplier-statements.service";
import { RouteAnalysisService } from "../route-optimization/route-analysis.service";

/**
 * SA-1102 A-4 M3 (rows M3-1..M3-5): tenant first at every AI site. With no business selected (`requireAiTenant`
 * refuses), each of the five AI methods throws 403 TENANT_CONTEXT_REQUIRED BEFORE it touches `prisma` or `systemConfig`:
 * no read of an id from the request in any business, and no 404-versus-403 signal about another business's rows.
 *
 * The service is built without its constructor (`Object.create`), so every collaborator is a recording stand-in:
 * any `this.prisma...` / `this.systemConfig...` access (directly or through a helper such as `findScanByHash`) is
 * logged, and the log must stay empty. Everything else (logger, storage, optimizer) is inert.
 */
const RECORDED = new Set(["prisma", "systemConfig"]);

function recorder(touched: string[], path: string, record: boolean): any {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      const next = `${path}.${prop}`;
      if (record) touched.push(next);
      return recorder(touched, next, record);
    },
    apply() {
      if (record) touched.push(`${path}()`);
      return recorder(touched, `${path}()`, record);
    },
  });
}

function tenantlessHarness<T extends object>(Cls: { prototype: T }) {
  const touched: string[] = [];
  const platformConfig = {
    requireAiTenant: jest.fn(() => {
      throw new ForbiddenException({
        code: "TENANT_CONTEXT_REQUIRED",
        message: "Choose a business before scanning.",
      });
    }),
    prepareAiCall: jest.fn(),
  };
  const svc = new Proxy(Object.create(Cls.prototype), {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (prop === "platformConfig") return platformConfig;
      if (typeof prop === "symbol") return undefined;
      return recorder(touched, `this.${prop}`, RECORDED.has(prop));
    },
  }) as T;
  return { svc, touched, platformConfig };
}

const jpegPage = { buffer: Buffer.from("page"), mimeType: "image/jpeg", originalname: "p.jpg" };
const tenantRefusal = { response: expect.objectContaining({ code: "TENANT_CONTEXT_REQUIRED" }) };

describe("tenant first at every AI site (SA-1102 A-4 M3)", () => {
  it("M3-1 scanInvoice (bill scan)", async () => {
    const { svc, touched, platformConfig } = tenantlessHarness(VendorBillsService);
    await expect((svc as any).scanInvoice([jpegPage])).rejects.toMatchObject(tenantRefusal);
    expect(touched).toEqual([]);
    expect(platformConfig.prepareAiCall).not.toHaveBeenCalled();
  });

  it("M3-2 extractExpenseItems (receipt scan)", async () => {
    const { svc, touched, platformConfig } = tenantlessHarness(BookkeepingService);
    await expect((svc as any).extractExpenseItems("exp-1")).rejects.toMatchObject(tenantRefusal);
    expect(touched).toEqual([]);
    expect(platformConfig.prepareAiCall).not.toHaveBeenCalled();
  });

  it("M3-3 scanStatement (supplier statement scan)", async () => {
    const { svc, touched, platformConfig } = tenantlessHarness(SupplierStatementsService);
    await expect((svc as any).scanStatement([jpegPage])).rejects.toMatchObject(tenantRefusal);
    expect(touched).toEqual([]);
    expect(platformConfig.prepareAiCall).not.toHaveBeenCalled();
  });

  it("M3-4 analyzeRoute (including the windows-only pass)", async () => {
    for (const options of [undefined, { windowsOnly: true }]) {
      const { svc, touched } = tenantlessHarness(RouteAnalysisService);
      await expect((svc as any).analyzeRoute("route-1", undefined, options)).rejects.toMatchObject(
        tenantRefusal,
      );
      expect(touched).toEqual([]);
    }
  });

  it("M3-5 analyzeRouteRun", async () => {
    const { svc, touched } = tenantlessHarness(RouteAnalysisService);
    await expect((svc as any).analyzeRouteRun("run-1")).rejects.toMatchObject(tenantRefusal);
    expect(touched).toEqual([]);
  });
});
