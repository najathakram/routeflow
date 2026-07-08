import { BadRequestException } from "@nestjs/common";
import {
  assertRegulatedDeliverySatisfied,
  deriveStopRegulatedRequirements,
  loadAgeIdCategorySets,
  type RegulatedDeliveryDb,
  type StopRegulatedRequirements,
} from "./regulated-delivery";

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof BadRequestException) {
      const res = err.getResponse() as { reason?: string; code?: string };
      expect(res.code).toBe("REGULATED_POD_REQUIRED");
      return res.reason ?? "";
    }
    throw err;
  }
  throw new Error("expected assertRegulatedDeliverySatisfied to throw");
}

const NONE: StopRegulatedRequirements = { requiresAge: false, requiresId: false };
const AGE: StopRegulatedRequirements = { requiresAge: true, requiresId: false };
const ID: StopRegulatedRequirements = { requiresAge: false, requiresId: true };
const BOTH: StopRegulatedRequirements = { requiresAge: true, requiresId: true };

describe("assertRegulatedDeliverySatisfied", () => {
  it("never throws for a non-regulated stop and normalises capture", () => {
    const patch = assertRegulatedDeliverySatisfied({
      requirements: NONE,
      capture: { safeDropEnabled: true, ageVerified: false },
    });
    expect(patch).toMatchObject({
      ageCheckRequired: false,
      identityCheckRequired: false,
      ageVerified: false,
      identityVerified: false,
      identityType: null,
      identityVerifiedAt: null,
    });
  });

  it("blocks a safe-drop on a regulated stop", () => {
    expect(
      reasonOf(() =>
        assertRegulatedDeliverySatisfied({
          requirements: AGE,
          capture: { safeDropEnabled: true, signatureUrl: "sig.png", ageVerified: true },
        }),
      ),
    ).toBe("SAFE_DROP_FORBIDDEN");
  });

  it("requires a signature on a regulated stop", () => {
    expect(
      reasonOf(() =>
        assertRegulatedDeliverySatisfied({ requirements: AGE, capture: { ageVerified: true } }),
      ),
    ).toBe("SIGNATURE_REQUIRED");
  });

  it("accepts an already-persisted signature via existingSignatureUrl", () => {
    const patch = assertRegulatedDeliverySatisfied({
      requirements: AGE,
      capture: { ageVerified: true },
      existingSignatureUrl: "prior-sig.png",
    });
    expect(patch.ageVerified).toBe(true);
    expect(patch.ageCheckRequired).toBe(true);
  });

  it("requires the age check when demanded", () => {
    expect(
      reasonOf(() =>
        assertRegulatedDeliverySatisfied({
          requirements: AGE,
          capture: { signatureUrl: "sig.png" },
        }),
      ),
    ).toBe("AGE_CHECK_REQUIRED");
  });

  it("requires the identity check when demanded", () => {
    expect(
      reasonOf(() =>
        assertRegulatedDeliverySatisfied({
          requirements: ID,
          capture: { signatureUrl: "sig.png" },
        }),
      ),
    ).toBe("ID_CHECK_REQUIRED");
  });

  it("requires an identity type once identity is verified", () => {
    expect(
      reasonOf(() =>
        assertRegulatedDeliverySatisfied({
          requirements: ID,
          capture: { signatureUrl: "sig.png", identityVerified: true },
        }),
      ),
    ).toBe("ID_TYPE_REQUIRED");
  });

  it("stamps identityVerifiedAt and keeps identityType when identity is verified", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");
    const patch = assertRegulatedDeliverySatisfied({
      requirements: BOTH,
      now,
      capture: {
        signatureUrl: "sig.png",
        ageVerified: true,
        identityVerified: true,
        identityType: "DRIVERS_LICENSE",
      },
    });
    expect(patch).toEqual({
      ageCheckRequired: true,
      identityCheckRequired: true,
      ageVerified: true,
      identityVerified: true,
      identityType: "DRIVERS_LICENSE",
      identityVerifiedAt: now,
    });
  });

  it("clears identityType/identityVerifiedAt when identity is not verified", () => {
    const patch = assertRegulatedDeliverySatisfied({
      requirements: NONE,
      capture: { identityVerified: false, identityType: "PASSPORT" },
    });
    expect(patch.identityType).toBeNull();
    expect(patch.identityVerifiedAt).toBeNull();
  });
});

function makeDb(
  cats: Array<{ id: string; requiresAgeCheck: boolean; requiresIdCheck: boolean }>,
  items: Array<{
    trackedCategoryId: string | null;
    product: { trackedCategoryId: string | null } | null;
  }>,
): { db: RegulatedDeliveryDb; itemQueries: unknown[] } {
  const itemQueries: unknown[] = [];
  const db: RegulatedDeliveryDb = {
    trackedCategory: { findMany: async () => cats },
    orderItem: {
      findMany: async (args) => {
        itemQueries.push(args);
        return items;
      },
    },
  };
  return { db, itemQueries };
}

describe("loadAgeIdCategorySets + deriveStopRegulatedRequirements", () => {
  it("fast-paths to no requirement (no item query) when the tenant runs no gated category", async () => {
    const { db, itemQueries } = makeDb([], [{ trackedCategoryId: "c1", product: null }]);
    const sets = await loadAgeIdCategorySets(db);
    expect(sets.any).toBe(false);
    await expect(deriveStopRegulatedRequirements(db, { stopId: "stop" }, sets)).resolves.toEqual(
      NONE,
    );
    expect(itemQueries).toHaveLength(0);
  });

  it("resolves the line category from the item snapshot, else the product", async () => {
    const { db } = makeDb(
      [
        { id: "age", requiresAgeCheck: true, requiresIdCheck: false },
        { id: "id", requiresAgeCheck: false, requiresIdCheck: true },
      ],
      [
        { trackedCategoryId: null, product: { trackedCategoryId: "age" } },
        { trackedCategoryId: "id", product: { trackedCategoryId: null } },
        { trackedCategoryId: null, product: null },
      ],
    );
    const sets = await loadAgeIdCategorySets(db);
    await expect(deriveStopRegulatedRequirements(db, { stopId: "stop" }, sets)).resolves.toEqual(
      BOTH,
    );
  });

  it("returns no requirement when no line is in a gated category", async () => {
    const { db } = makeDb(
      [{ id: "age", requiresAgeCheck: true, requiresIdCheck: false }],
      [{ trackedCategoryId: "other", product: { trackedCategoryId: "other" } }],
    );
    const sets = await loadAgeIdCategorySets(db);
    await expect(deriveStopRegulatedRequirements(db, { stopId: "stop" }, sets)).resolves.toEqual(
      NONE,
    );
  });

  it("also matches the delivered orderItemIds (closes the unlinked/cross-stop bypass)", async () => {
    const { db, itemQueries } = makeDb(
      [{ id: "age", requiresAgeCheck: true, requiresIdCheck: false }],
      [{ trackedCategoryId: "age", product: null }],
    );
    const sets = await loadAgeIdCategorySets(db);
    await expect(
      deriveStopRegulatedRequirements(db, { stopId: "stop", orderItemIds: ["oi-1", "oi-2"] }, sets),
    ).resolves.toEqual(AGE);
    // the query ORs the stop link with the delivered item ids
    expect(itemQueries[0]).toEqual({
      where: { OR: [{ order: { routeRunStopId: "stop" } }, { id: { in: ["oi-1", "oi-2"] } }] },
      select: { trackedCategoryId: true, product: { select: { trackedCategoryId: true } } },
    });
  });
});
