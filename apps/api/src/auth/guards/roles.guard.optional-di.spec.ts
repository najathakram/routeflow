import { Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../app.module";
import { OperatorPermissionsModule } from "../permissions/operator-permissions.module";
import { OperatorPermissionsService } from "../permissions/operator-permissions.service";
import { RolesGuard } from "./roles.guard";

/**
 * `RolesGuard` takes the permission service as @Optional(), so a wiring slip would not fail loudly: the guard would
 * resolve it as undefined and quietly skip every permission check. Two things must both hold, and each is pinned:
 *   1. the module is @Global, so a guard built inside ANY feature module (not just one that imports it) gets the service;
 *   2. the app graph imports the module at all (today through UsersModule): a global module nobody imports provides nothing.
 */
@Module({ providers: [RolesGuard, Reflector] })
class UnrelatedFeatureModule {}

/** Every module reachable from `root` through `imports` (forwardRefs resolved), by class. */
function reachable(root: unknown, seen = new Set<unknown>()): Set<unknown> {
  const mod = (
    typeof root === "function" && "forwardRef" in (root as object) ? null : root
  ) as never;
  const resolved = (root as { forwardRef?: () => unknown })?.forwardRef?.() ?? mod ?? root;
  if (!resolved || seen.has(resolved)) return seen;
  seen.add(resolved);
  const imports: unknown[] = Reflect.getMetadata("imports", resolved as object) ?? [];
  for (const i of imports) reachable((i as { module?: unknown })?.module ?? i, seen);
  return seen;
}

describe("RolesGuard permission service wiring", () => {
  it("a guard in an UNRELATED feature module still gets the service (the module is @Global)", async () => {
    const stub = { mode: () => "shadow", hasAny: async () => true };
    const mod = await Test.createTestingModule({
      imports: [OperatorPermissionsModule, UnrelatedFeatureModule],
    })
      .overrideProvider(OperatorPermissionsService)
      .useValue(stub)
      .compile();
    const guard = mod.select(UnrelatedFeatureModule).get(RolesGuard) as unknown as {
      permissions?: unknown;
    };
    expect(guard.permissions).toBe(stub);
  });

  it("OperatorPermissionsModule is marked @Global", () => {
    expect(Reflect.getMetadata("__module:global__", OperatorPermissionsModule)).toBe(true);
  });

  it("the app's module graph imports OperatorPermissionsModule", () => {
    expect(reachable(AppModule).has(OperatorPermissionsModule)).toBe(true);
  });
});
