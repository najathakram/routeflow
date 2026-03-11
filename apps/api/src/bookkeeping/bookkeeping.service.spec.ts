import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

// Manual mock factory prevents Jest from parsing invoice.service.ts
// which would trigger the @react-pdf/renderer ESM import error
jest.mock('./invoice.service', () => ({
  InvoiceService: jest.fn().mockImplementation(() => ({
    generateInvoice: jest.fn(),
    getPresignedUrl: jest.fn(),
  })),
}));

import { BookkeepingService } from './bookkeeping.service';
import { InvoiceService } from './invoice.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrisma } from '../testing/prisma-mock';

const MOCK_TXN = {
  id: 'txn-1',
  customerId: 'cust-1',
  orderId: 'ord-1',
  status: 'UNPAID' as const,
  totalOwed: 100,
  totalPaid: 0,
  dueDate: new Date(),
  paidAt: null,
  notes: null,
  pdfUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('BookkeepingService', () => {
  let service: BookkeepingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoiceService: { getPresignedUrl: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoiceService = { getPresignedUrl: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookkeepingService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceService, useValue: invoiceService },
      ],
    }).compile();

    service = module.get<BookkeepingService>(BookkeepingService);
  });

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('should return paginated transactions', async () => {
      prisma.transaction.findMany.mockResolvedValue([MOCK_TXN]);
      prisma.transaction.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('should filter by status', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.transaction.count.mockResolvedValue(0);

      await service.findAll({ status: 'UNPAID' as any, page: 1, limit: 20 });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'UNPAID' }),
        }),
      );
    });

    it('should filter by customerId', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.transaction.count.mockResolvedValue(0);

      await service.findAll({ customerId: 'cust-1', page: 1, limit: 20 });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: 'cust-1' }),
        }),
      );
    });

    it('should filter by date range', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.transaction.count.mockResolvedValue(0);

      await service.findAll({
        dateFrom: '2025-01-01',
        dateTo: '2025-12-31',
        page: 1,
        limit: 20,
      });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({
              gte: expect.any(Date),
              lte: expect.any(Date),
            }),
          }),
        }),
      );
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('should return a transaction with customer and items', async () => {
      prisma.transaction.findUnique.mockResolvedValue(MOCK_TXN);
      const result = await service.findOne('txn-1');
      expect(result).toEqual(MOCK_TXN);
    });

    it('should throw NotFoundException when transaction does not exist', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── recordPayment ────────────────────────────────────────────────────────

  describe('recordPayment', () => {
    it('should throw NotFoundException when transaction does not exist', async () => {
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          transaction: { findUnique: jest.fn().mockResolvedValue(null) },
          payment: { create: jest.fn() },
        };
        return fn(tx);
      });

      await expect(
        service.recordPayment('nonexistent', { amount: 50, method: 'CASH' as any }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getPdfUrl ────────────────────────────────────────────────────────────

  describe('getPdfUrl', () => {
    it('should return url when PDF exists', async () => {
      invoiceService.getPresignedUrl.mockResolvedValue('https://r2.example.com/invoice.pdf');
      const result = await service.getPdfUrl('txn-1');
      expect(result).toEqual({ url: 'https://r2.example.com/invoice.pdf' });
    });

    it('should return null when PDF is not yet generated', async () => {
      invoiceService.getPresignedUrl.mockResolvedValue(null);
      const result = await service.getPdfUrl('txn-1');
      expect(result).toBeNull();
    });
  });

  // ─── getSummary ───────────────────────────────────────────────────────────

  describe('getSummary', () => {
    it('should return aggregated financial summary', async () => {
      prisma.transaction.aggregate.mockResolvedValue({ _sum: { totalOwed: 5000 } });
      prisma.transaction.findMany.mockResolvedValue([
        { totalOwed: 200, totalPaid: 50 },
        { totalOwed: 300, totalPaid: 100 },
      ]);
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 1500 } });
      prisma.transaction.count.mockResolvedValue(3);

      const result = await service.getSummary();

      expect(result).toEqual({
        totalRevenue: 5000,
        outstandingReceivables: 350,   // (200-50) + (300-100)
        paymentsThisWeek: 1500,
        overdueCount: 3,
      });
    });

    it('should handle empty data gracefully', async () => {
      prisma.transaction.aggregate.mockResolvedValue({ _sum: { totalOwed: null } });
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prisma.transaction.count.mockResolvedValue(0);

      const result = await service.getSummary();

      expect(result).toEqual({
        totalRevenue: 0,
        outstandingReceivables: 0,
        paymentsThisWeek: 0,
        overdueCount: 0,
      });
    });
  });
});
