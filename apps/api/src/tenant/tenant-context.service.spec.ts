import { TenantContextService } from "./tenant-context.service";

/**
 * SA-619 PR-1: the tenant context carries a KIND, so "SUPER_ADMIN" and "no context" are no longer the
 * same null. The kind drives PrismaService.forTenant()'s warn/throw (dark first).
 */
describe("TenantContextService kinds (SA-619)", () => {
  let ctx: TenantContextService;
  beforeEach(() => {
    ctx = new TenantContextService();
  });

  it("outside any run there is no context: kind NONE, no tenant, not a super admin", () => {
    expect(ctx.getKind()).toBe("NONE");
    expect(ctx.getOrNull()).toBeNull();
    expect(ctx.isSuperAdmin()).toBe(false);
  });

  it("run(tenantId) is a TENANT context (every existing caller is unchanged)", () => {
    ctx.run("t-1", () => {
      expect(ctx.getKind()).toBe("TENANT");
      expect(ctx.getOrNull()).toBe("t-1");
      expect(ctx.get()).toBe("t-1");
      expect(ctx.isSuperAdmin()).toBe(false);
    });
  });

  it("run(null, fn, 'SUPER_ADMIN') is a super admin; run(null, fn) alone is ANONYMOUS", () => {
    ctx.run(
      null,
      () => {
        expect(ctx.getKind()).toBe("ANONYMOUS");
        expect(ctx.isSuperAdmin()).toBe(false); // the old `getOrNull() === null` said true
        expect(() => ctx.get()).toThrow(/TenantContext not initialized/);
      },
      undefined,
    );
    ctx.run(
      null,
      () => {
        expect(ctx.getKind()).toBe("SUPER_ADMIN");
        expect(ctx.isSuperAdmin()).toBe(true);
        expect(ctx.getOrNull()).toBeNull();
      },
      "SUPER_ADMIN",
    );
  });

  it("run(null, fn, 'SYSTEM') is a SYSTEM context with no tenant", () => {
    ctx.run(null, () => expect(ctx.getKind()).toBe("SYSTEM"), "SYSTEM");
  });

  it("a tenant id always wins: the kind argument cannot turn a tenant context into a super admin", () => {
    ctx.run(
      "t-1",
      () => {
        expect(ctx.getKind()).toBe("TENANT");
        expect(ctx.isSuperAdmin()).toBe(false);
      },
      "SUPER_ADMIN",
    );
  });

  it("nested runs restore the outer context", () => {
    ctx.run("outer", () => {
      ctx.run(null, () => expect(ctx.getKind()).toBe("ANONYMOUS"));
      expect(ctx.getOrNull()).toBe("outer");
      expect(ctx.getKind()).toBe("TENANT");
    });
    expect(ctx.getKind()).toBe("NONE");
  });

  it("the context survives await and timers, and does not leak to a sibling run", async () => {
    const seen: Array<[string | null, string]> = [];
    await Promise.all([
      ctx.run("a", async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push([ctx.getOrNull(), ctx.getKind()]);
      }),
      ctx.run(
        null,
        async () => {
          await new Promise((r) => setTimeout(r, 1));
          seen.push([ctx.getOrNull(), ctx.getKind()]);
        },
        "SUPER_ADMIN",
      ),
    ]);
    expect(seen).toContainEqual(["a", "TENANT"]);
    expect(seen).toContainEqual([null, "SUPER_ADMIN"]);
    expect(ctx.getKind()).toBe("NONE");
  });
});
