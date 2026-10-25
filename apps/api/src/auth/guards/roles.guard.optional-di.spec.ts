import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { OperatorPermissionsModule } from "../permissions/operator-permissions.module";
import { OperatorPermissionsService } from "../permissions/operator-permissions.service";
import { RolesGuard } from "./roles.guard";

/**
 * `RolesGuard` takes the permission service as @Optional(), so a wiring slip would not fail loudly: the guard would
 * resolve it as undefined and quietly skip every permission check. This pins the real wiring: the global module
 * provides the service to a guard built by Nest's injector.
 */
describe("RolesGuard permission service wiring", () => {
  it("is injected from the global OperatorPermissionsModule, not left undefined", async () => {
    const stub = { mode: () => "shadow", hasAny: async () => true };
    const mod = await Test.createTestingModule({
      imports: [OperatorPermissionsModule],
      providers: [RolesGuard, Reflector],
    })
      .overrideProvider(OperatorPermissionsService)
      .useValue(stub)
      .compile();
    const guard = mod.get(RolesGuard) as unknown as { permissions?: unknown };
    expect(guard.permissions).toBe(stub);
  });
});
