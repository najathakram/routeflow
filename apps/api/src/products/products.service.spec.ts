import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrisma } from '../testing/prisma-mock';

const MOCK_PRODUCT = {
  id: 'prod-1',
  name: 'Cherry Tomatoes',
  sku: 'TOM-001',
  unit: 'punnet',
  pricePerUnit: 4.99,
  category: 'Produce',
  description: 'Fresh cherry tomatoes',
  isActive: true,
  lowStock: false,
  imageKey: null,
  zohoProductId: null,
  hasLocalOverride: false,
  syncConflict: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('should return paginated products', async () => {
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });

    it('should apply search filter', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ search: 'tomato', page: 1, limit: 20 });

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: expect.any(Object) }),
            ]),
          }),
        }),
      );
    });

    it('should filter by category', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ category: 'Produce', page: 1, limit: 20 });

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: 'Produce' }),
        }),
      );
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('should return a product by id', async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      const result = await service.findOne('prod-1');
      expect(result).toEqual(MOCK_PRODUCT);
    });

    it('should throw NotFoundException when product does not exist', async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a product with explicit field mapping', async () => {
      prisma.product.findUnique.mockResolvedValue(null); // SKU check
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      const result = await service.create({
        name: 'Cherry Tomatoes',
        sku: 'TOM-001',
        unit: 'punnet',
        pricePerUnit: 4.99,
        category: 'Produce',
        description: 'Fresh cherry tomatoes',
      } as any);

      expect(result).toEqual(MOCK_PRODUCT);
      expect(prisma.product.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Cherry Tomatoes',
          sku: 'TOM-001',
          pricePerUnit: 4.99,
        }),
      });
    });

    it('should throw BadRequestException when SKU is duplicate', async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT); // SKU exists

      await expect(
        service.create({ name: 'Test', sku: 'TOM-001', unit: 'kg', pricePerUnit: 1 } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow creation without SKU', async () => {
      prisma.product.create.mockResolvedValue({ ...MOCK_PRODUCT, sku: null });

      const result = await service.create({
        name: 'Test',
        unit: 'kg',
        pricePerUnit: 1,
      } as any);

      expect(result).toBeDefined();
      // Should not check for duplicate SKU when sku is undefined
      expect(prisma.product.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update a product and set hasLocalOverride', async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.findFirst.mockResolvedValue(null); // no SKU conflict
      prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT, name: 'Updated' });

      const result = await service.update('prod-1', { name: 'Updated' } as any);

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
        data: expect.objectContaining({ hasLocalOverride: true }),
      });
    });

    it('should throw NotFoundException when product does not exist', async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.update('nonexistent', {} as any)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException on SKU conflict with another product', async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.findFirst.mockResolvedValue({ id: 'prod-2', sku: 'DUP-SKU' });

      await expect(
        service.update('prod-1', { sku: 'DUP-SKU' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── clearOverride ────────────────────────────────────────────────────────

  describe('clearOverride', () => {
    it('should reset override and conflict flags', async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT, hasLocalOverride: false, syncConflict: false });

      await service.clearOverride('prod-1');

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
        data: { hasLocalOverride: false, syncConflict: false },
      });
    });
  });
});
