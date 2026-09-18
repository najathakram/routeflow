/**
 * B524 fix round (Opus review of PR #913) — `EntitlementAuthority.assertFeatureRequiresMet`/
 * `.invalidate`, extracted here as a dedicated, lightweight suite rather than folded into
 * `entitlement-authority.service.spec.ts`'s heavy fixture-driven shadow-parity oracles (that
 * file exercises `can()`/`config()` against real `FeatureResolverService` resolution over
 * `V11_PIN_FIXTURE`/`LITE_FIXTURE`; this behavior only needs a bare mocked resolver).
 *
 * Only `resolver` is exercised by `assertFeatureRequiresMet`/`invalidate` — every other
 * constructor dependency is a stub the code path under test never calls.
 */
import { BadRequestException } from "@nestjs/common";
import { EntitlementAuthority } from "./entitlement-authority.service";

function stub() {
  return new Proxy({}, { get: () => jest.fn() });
}

function make(opts: { effectiveKeys?: string[] | null } = {}) {
  const resolvedValue =
    opts.effectiveKeys === null
      ? null
      : { byKey: new Map((opts.effectiveKeys ?? []).map((k) => [k, { key: k, effective: true }])) };
  const resolver = {
    resolve: jest.fn().mockResolvedValue(resolvedValue),
    invalidate: jest.fn(),
  };
  const authority = new EntitlementAuthority(
    stub() as any, // entitlements
    stub() as any, // featureOverrides
    resolver as any,
    stub() as any, // modeService
    stub() as any, // diffService
    stub() as any, // prisma
  );
  return { authority, resolver };
}

describe("EntitlementAuthority.assertFeatureRequiresMet", () => {
  it("a key with no registry entry is a no-op passthrough", async () => {
    const { authority, resolver } = make({ effectiveKeys: [] });
    await authority.assertFeatureRequiresMet("t1", "not_a_real_registry_key");
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("a registered key with no requires is a no-op passthrough", async () => {
    const { authority, resolver } = make({ effectiveKeys: [] });
    await authority.assertFeatureRequiresMet("t1", "recurring_routes"); // registered, no requires
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("400s driver_payments (requires anyOf recurring_routes/order_delivery) when neither is effective", async () => {
    const { authority } = make({ effectiveKeys: [] });
    await expect(authority.assertFeatureRequiresMet("t1", "driver_payments")).rejects.toThrow(
      BadRequestException,
    );
    await expect(authority.assertFeatureRequiresMet("t1", "driver_payments")).rejects.toMatchObject(
      {
        response: expect.objectContaining({
          code: "FEATURE_REQUIRES_UNMET",
          key: "driver_payments",
        }),
      },
    );
  });

  it("proceeds when ONE of the anyOf prerequisites is effective", async () => {
    const { authority } = make({ effectiveKeys: ["order_delivery"] });
    await expect(
      authority.assertFeatureRequiresMet("t1", "driver_payments"),
    ).resolves.toBeUndefined();
  });

  it("proceeds on an unmet requirement when acknowledge is true, without ever resolving", async () => {
    const { authority, resolver } = make({ effectiveKeys: [] });
    await authority.assertFeatureRequiresMet("t1", "driver_payments", true);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("fails open (proceeds) when the resolver itself returns null", async () => {
    const { authority } = make({ effectiveKeys: null });
    await expect(
      authority.assertFeatureRequiresMet("t1", "driver_payments"),
    ).resolves.toBeUndefined();
  });

  it("orders_inline_returns (requires allOf flag.returns) is unmet with no plan flags and met once granted", async () => {
    const unmet = make({ effectiveKeys: [] });
    await expect(
      unmet.authority.assertFeatureRequiresMet("t1", "orders_inline_returns"),
    ).rejects.toThrow(BadRequestException);

    const met = make({ effectiveKeys: ["flag.returns"] });
    await expect(
      met.authority.assertFeatureRequiresMet("t1", "orders_inline_returns"),
    ).resolves.toBeUndefined();
  });
});

describe("EntitlementAuthority.invalidate", () => {
  it("delegates to the resolver's own invalidate", () => {
    const { authority, resolver } = make();
    authority.invalidate("t1");
    expect(resolver.invalidate).toHaveBeenCalledWith("t1");
  });
});
