/**
 * B983: TrackedCategory and TrackedSubcategory NAMES (printed on the regulated filings, invoices and exports) refuse a leading
 * = + - @ TAB CR LF with a readable coded 400 on create and rename. Change-only: an unchanged legacy name never blocks an
 * unrelated edit. Nothing is read or rewritten beyond the reads each method already makes.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("TrackedCategoriesService name guards (B983)", () => {
  let service: TrackedCategoriesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrackedCategoriesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(TrackedCategoriesService);
  });

  const section = {
    id: "c1",
    name: "Tobacco",
    active: true,
    taxType: "NONE",
    _count: { products: 0 },
  };
  const refused = async (p: Promise<unknown>, field: string) => {
    const err: any = await p.catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
    return err;
  };

  describe("category", () => {
    it("create refuses a formula-led name BEFORE any write", async () => {
      const err = await refused(
        service.create({ name: "=HYPERLINK(1)", taxType: "NONE" } as never),
        "categoryName",
      );
      expect(err.getResponse().message).toBe(
        "Category name can't start with =, +, -, @ or a tab/line break",
      );
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
    });

    it("update refuses a CHANGED formula-led name and writes nothing", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(section);
      await refused(service.update("c1", { name: "@evil" } as never), "categoryName");
      expect(prisma.trackedCategory.update).not.toHaveBeenCalled();
    });

    it("update lets a LEGACY formula-led name echoed back unchanged through", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({ ...section, name: "=LEGACY" });
      prisma.trackedCategory.update.mockResolvedValue({
        ...section,
        name: "=LEGACY",
        _count: { products: 0 },
      });
      await expect(
        service.update("c1", { name: "=LEGACY", active: true } as never),
      ).resolves.toBeDefined();
    });

    it("an update that does not touch the name never checks it", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({ ...section, name: "=LEGACY" });
      prisma.trackedCategory.update.mockResolvedValue({ ...section, _count: { products: 0 } });
      await expect(service.update("c1", { active: false } as never)).resolves.toBeDefined();
    });
  });

  describe("subcategory", () => {
    it("create refuses a formula-led name (after trimming) BEFORE any write", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(section);
      const err = await refused(
        service.createSubcategory("c1", { name: "  +SUM(A1)  " }),
        "subcategoryName",
      );
      expect(err.getResponse().message).toBe(
        "Subcategory name can't start with =, +, -, @ or a tab/line break",
      );
      expect(prisma.trackedSubcategory.create).not.toHaveBeenCalled();
    });

    it("rename refuses a CHANGED formula-led name: nothing is written or mirrored onto products", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(section);
      prisma.trackedSubcategory.findUnique.mockResolvedValue({
        id: "s1",
        name: "Cigarettes",
        trackedCategoryId: "c1",
        active: true,
        _count: { products: 2 },
      });
      prisma.trackedSubcategory.findFirst.mockResolvedValue(null);
      await refused(service.updateSubcategory("c1", "s1", { name: "-evil" }), "subcategoryName");
      expect(prisma.trackedSubcategory.update).not.toHaveBeenCalled();
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });

    it("a rename to an unchanged legacy name is not refused", async () => {
      prisma.trackedSubcategory.findUnique.mockResolvedValue({
        id: "s1",
        name: "=LEGACY",
        trackedCategoryId: "c1",
        active: true,
        _count: { products: 0 },
      });
      prisma.trackedSubcategory.findFirst.mockResolvedValue(null);
      prisma.trackedSubcategory.update.mockResolvedValue({
        id: "s1",
        name: "=LEGACY",
        trackedCategoryId: "c1",
        active: false,
        _count: { products: 0 },
      });
      await expect(
        service.updateSubcategory("c1", "s1", { name: "=LEGACY", active: false }),
      ).resolves.toBeDefined();
    });
  });
});
