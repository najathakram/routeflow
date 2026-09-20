import { Global, Module } from "@nestjs/common";
import {
  MODULE_METADATA,
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
} from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { OrdersModule } from "./orders.module";
import { OrdersService } from "./orders.service";

/**
 * Lane R: `OrdersService` takes `SellingRestrictionsService` as a REQUIRED constructor dependency
 * (never `@Optional` — a missing provider must be a DI error, not a silent bypass of a ban). A
 * unit test that hand-builds `OrdersService` cannot see a module-graph mistake, so this pins the two
 * facts the running app depends on: `OrdersModule` imports `SellingRestrictionsModule`, and that
 * module really resolves the service from its own imports (L-113: a DI-scope bug is invisible to
 * tsc and to every hand-built provider list).
 */
describe("OrdersModule ↔ SellingRestrictionsModule wiring", () => {
  it("OrdersModule imports SellingRestrictionsModule", () => {
    const imports: unknown[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, OrdersModule) ?? [];
    expect(imports).toContain(SellingRestrictionsModule);
  });

  it("the dependency is REQUIRED: OrdersService never marks SellingRestrictionsService @Optional (a missing provider must be a DI error, not a bypass)", () => {
    const params: unknown[] = Reflect.getMetadata(PARAMTYPES_METADATA, OrdersService) ?? [];
    const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, OrdersService) ?? [];
    expect(params).toContain(SellingRestrictionsService);
    expect(optional).not.toContain(params.indexOf(SellingRestrictionsService));
  });

  it("SellingRestrictionsModule provides and exports the choke point, resolvable from a real module graph", async () => {
    const exportsList: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, SellingRestrictionsModule) ?? [];
    expect(exportsList).toContain(SellingRestrictionsService);

    // PrismaModule is @Global in the app; stand in for it so the module graph resolves for real.
    @Global()
    @Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
    class FakePrismaModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [FakePrismaModule, SellingRestrictionsModule],
    }).compile();
    expect(moduleRef.get(SellingRestrictionsService)).toBeInstanceOf(SellingRestrictionsService);
  });
});
