/**
 * H2 / SA #3457 MUST 3: a lossy reparent must not deadlock against an admin `setLabel`.
 *
 * `setLabel` takes the per-category label advisory lock, THEN writes the membership row (an FK KEY SHARE on the
 * product row). `update()` used to take the family + product rows FOR UPDATE first and the label lock only inside the
 * keep, after the parent write: the opposite order, so the two could cycle (40P01, a raw 500). Now update() reads the
 * candidate lost set read-only and takes those label locks, sorted, BEFORE any row lock; the keep re-checks under the
 * row locks and a lost label it did not pre-lock is the retryable coded 409, never a lock taken out of order. A
 * deadlock / write conflict that still reaches this path is the same coded 409, never a 500.
 *
 * Real keep-labels code, mocked Prisma: the spec records every raw statement on the transaction, in order.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { LabelLockTimeoutError } from "../product-categories/label-writer";
import { API_ERROR_CODES } from "../common/api-error-codes";

const TENANT = "t-1";

const PRODUCT = {
  id: "prod-1",
  name: "Cherry Tomatoes",
  sku: "TOM-001",
  unit: "punnet",
  pricePerUnit: 4.99,
  category: "Produce",
  isActive: true,
  kind: "VARIANT",
  parentProductId: "old",
  imageKeys: [] as string[],
  variants: [],
  barcodes: [],
  images: [],
};
const FAMILY = (id: string) => ({ id, isActive: true, kind: "FAMILY", parentProductId: null });

type LabelRow = {
  productId: string;
  categoryId: string;
  mode: "INCLUDE" | "EXCLUDE";
};

describe("ProductsService.update: a lossy reparent takes the label locks BEFORE the row locks (H2 MUST 3)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let events: string[];
  let labelRows: LabelRow[];
  /** Label rows the keep's re-read sees (after the pre-lock read): simulates a concurrent label write. */
  let labelRowsAfterPlan: LabelRow[] | null;
  let labelReads: number;
  let tx: Record<string, unknown>;

  const rawOf = (strings: TemplateStringsArray, values: unknown[]) => {
    const sql = strings.join("?");
    if (/pg_advisory_xact_lock/.test(sql))
      return `advisory:${String(values[0])}:${String(values[1])}`;
    if (/FOR UPDATE/i.test(sql)) return `for-update:${String(values[0])}`;
    return null;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn(),
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn(),
            delete: jest.fn(),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
    (prisma as unknown as { getTenantId: jest.Mock }).getTenantId = jest
      .fn()
      .mockReturnValue(TENANT);

    events = [];
    labelReads = 0;
    labelRowsAfterPlan = null;
    // The OLD family carries two bans; the new family "fam" carries none, so both are lost.
    labelRows = [
      { productId: "old", categoryId: "ny", mode: "INCLUDE" },
      { productId: "old", categoryId: "ca", mode: "INCLUDE" },
    ];
    const parents: Record<string, string | null> = { "prod-1": "old", old: null, fam: null };

    prisma.product.findUnique.mockResolvedValue({ ...PRODUCT });
    prisma.product.findFirst.mockImplementation(async (args: { where?: { id?: string } }) => {
      const id = args?.where?.id;
      if (id === "prod-1")
        return { id, parentProductId: "old", unitsPerBox: null, category: "Produce" };
      return id === "fam" || id === "old" ? FAMILY(id) : null;
    });
    prisma.product.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: string[] } } }) =>
        (args?.where?.id?.in ?? [])
          .filter((id) => id in parents)
          .map((id) => ({ id, parentProductId: parents[id] })),
    );
    prisma.product.count.mockResolvedValue(0);
    prisma.product.update.mockImplementation(async () => {
      events.push("write:product");
      return { ...PRODUCT, parentProductId: "fam" };
    });
    prisma.recipe.findFirst.mockResolvedValue(null);
    prisma.recipe.findMany.mockResolvedValue([]);
    prisma.productCategoryLabel.findMany.mockImplementation(
      async (args: { where?: { productId?: { in?: string[] } } }) => {
        labelReads += 1;
        const rows = labelReads > 2 && labelRowsAfterPlan ? labelRowsAfterPlan : labelRows;
        const ids = args?.where?.productId?.in ?? [];
        return rows.filter((r) => ids.includes(r.productId));
      },
    );
    prisma.productCategoryLabel.findFirst.mockResolvedValue(null);
    prisma.productCategoryLabel.create.mockImplementation(async (args: { data: LabelRow }) => {
      events.push(`write:label:${args.data.categoryId}`);
      return args.data;
    });
    prisma.productCategory.findFirst.mockImplementation(
      async (args: { where?: { id?: string } }) => ({
        name: `${String(args?.where?.id).toUpperCase()} ban`,
      }),
    );
    prisma.productCategory.findMany.mockResolvedValue([]);
    prisma.auditLog.createMany.mockResolvedValue({ count: 2 });

    tx = {
      ...prisma,
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const e = rawOf(strings, values);
        if (e) events.push(e);
        return 0;
      }),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const e = rawOf(strings, values);
        if (e) events.push(e);
        return /lock_timeout/.test(strings.join("?")) ? [{ lock_timeout: "0" }] : [];
      }),
      $executeRawUnsafe: jest.fn(async () => 0),
    };
    (prisma.tenantTransaction as jest.Mock).mockImplementation(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
  });

  const labelLocks = () => events.filter((e) => e.startsWith("advisory:product-labels:"));
  const firstIndex = (pred: (e: string) => boolean) => events.findIndex(pred);

  it("every label lock is taken, in sorted key order, before the first FOR UPDATE row lock and before any write", async () => {
    const out = await service.update("prod-1", { parentProductId: "fam" } as never, {
      packPrecondition: "internal",
    });
    expect((out as { keptLabels?: string[] }).keptLabels).toEqual(["CA ban", "NY ban"]);

    const firstRowLock = firstIndex((e) => e.startsWith("for-update:"));
    const firstWrite = firstIndex((e) => e.startsWith("write:"));
    expect(firstRowLock).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(-1);
    const locks = labelLocks();
    // ca + ny, pre-locked once each in sorted order (re-entrant re-takes inside the keep come later)
    expect(locks.slice(0, 2)).toEqual([
      `advisory:product-labels:${TENANT}:ca`,
      `advisory:product-labels:${TENANT}:ny`,
    ]);
    const lastPreLock = events.indexOf(`advisory:product-labels:${TENANT}:ny`);
    expect(lastPreLock).toBeLessThan(firstRowLock);
    expect(lastPreLock).toBeLessThan(firstWrite);
    // and nothing out of the pre-locked set is ever locked
    expect(new Set(locks)).toEqual(
      new Set([`advisory:product-labels:${TENANT}:ca`, `advisory:product-labels:${TENANT}:ny`]),
    );
  });

  it("a lost label that was NOT pre-locked (a concurrent label write since the read) is the retryable 409, nothing locked out of order", async () => {
    labelRowsAfterPlan = [...labelRows, { productId: "old", categoryId: "wa", mode: "INCLUDE" }];
    const err = await service
      .update("prod-1", { parentProductId: "fam" } as never, { packPrecondition: "internal" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(LabelLockTimeoutError);
    expect((err as LabelLockTimeoutError).getStatus()).toBe(409);
    expect((err as LabelLockTimeoutError).getResponse()).toMatchObject({
      code: API_ERROR_CODES.LABEL_CHANGE_IN_PROGRESS,
    });
    expect(labelLocks()).not.toContain(`advisory:product-labels:${TENANT}:wa`);
    expect(events.filter((e) => e.startsWith("write:label"))).toEqual([]);
  });

  it.each([
    ["40P01 in the driver shape", Object.assign(new Error("deadlock detected"), { code: "40P01" })],
    [
      "P2034 (Prisma's write-conflict / deadlock)",
      Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
        code: "P2034",
      }),
    ],
    [
      "40P01 under meta.code (raw query)",
      Object.assign(new Error("Raw query failed"), { code: "P2010", meta: { code: "40P01" } }),
    ],
  ])("a %s inside a reparent is the coded, retryable 409, never a 500", async (_n, raw) => {
    prisma.product.update.mockRejectedValue(raw);
    const err = await service
      .update("prod-1", { parentProductId: "fam" } as never, { packPrecondition: "internal" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(LabelLockTimeoutError);
    expect((err as LabelLockTimeoutError).getStatus()).toBe(409);
  });

  it("control: the same deadlock on an edit that is NOT a reparent is not relabelled", async () => {
    const raw = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    prisma.product.update.mockRejectedValue(raw);
    const err = await service
      .update("prod-1", { description: "x" } as never, { packPrecondition: "internal" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeInstanceOf(LabelLockTimeoutError);
  });

  it("control: a reparent that loses nothing takes no label lock at all", async () => {
    labelRows = [];
    await service.update("prod-1", { parentProductId: "fam" } as never, {
      packPrecondition: "internal",
    });
    expect(labelLocks()).toEqual([]);
  });

  it("SHOULD (b): a parent change with UNCHANGED category text never runs the text sync, so a label the operator removed from the product itself is not resurrected", async () => {
    // The text "Produce" names an existing label an operator removed from prod-1 on purpose (no row left; the audit is
    // on prod-1 itself, which familyRemovedLabel never reads: it reads ancestors only).
    prisma.productCategory.findMany.mockResolvedValue([{ id: "produce", name: "Produce" }]);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.productCategoryLabel.createMany.mockImplementation(
      async (args: { data: Array<{ categoryId: string }> }) => {
        for (const d of args.data) events.push(`write:label:${d.categoryId}`);
        return { count: args.data.length };
      },
    );
    const out = await service.update("prod-1", { parentProductId: "fam" } as never, {
      packPrecondition: "internal",
    });
    expect((out as { keptLabels?: string[] }).keptLabels).toEqual(["CA ban", "NY ban"]);
    expect(events.filter((e) => e.startsWith("write:label:"))).toEqual([
      "write:label:ca",
      "write:label:ny",
    ]);
    expect(labelLocks()).not.toContain(`advisory:product-labels:${TENANT}:produce`);
  });

  it("a reparent that ALSO changes the category text pre-locks the text's label before the row locks, and the sync adds it", async () => {
    prisma.productCategory.findMany.mockResolvedValue([{ id: "snack", name: "Snacks" }]);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.create.mockResolvedValue({});
    prisma.productCategoryLabel.createMany.mockImplementation(
      async (args: { data: Array<{ categoryId: string }> }) => {
        for (const d of args.data) events.push(`write:label:${d.categoryId}`);
        return { count: args.data.length };
      },
    );
    prisma.product.update.mockImplementation(async () => {
      events.push("write:product");
      return { ...PRODUCT, parentProductId: "fam", category: "Snacks" };
    });
    await service.update("prod-1", { parentProductId: "fam", category: "Snacks" } as never, {
      packPrecondition: "internal",
    });
    const firstRowLock = firstIndex((e) => e.startsWith("for-update:"));
    expect(labelLocks().slice(0, 3)).toEqual([
      `advisory:product-labels:${TENANT}:ca`,
      `advisory:product-labels:${TENANT}:ny`,
      `advisory:product-labels:${TENANT}:snack`,
    ]);
    expect(events.indexOf(`advisory:product-labels:${TENANT}:snack`)).toBeLessThan(firstRowLock);
    expect(events).toContain("write:label:snack");
  });
});
