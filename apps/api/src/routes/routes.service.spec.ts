import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { RoutesService } from './routes.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrisma } from '../testing/prisma-mock';

const MOCK_ROUTE = {
  id: 'route-1',
  name: 'Downtown Route',
  driverId: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_RUN = {
  id: 'run-1',
  routeId: 'route-1',
  driverId: 'drv-1',
  status: 'SCHEDULED' as const,
  scheduledDate: new Date(),
  startedAt: null,
  completedAt: null,
  manuallyReordered: false,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const operatorPayload = {
  sub: 'user-op',
  username: 'operator',
  role: 'OPERATOR' as const,
  status: 'ACTIVE' as const,
  forcePasswordChange: false,
};

const driverPayload = {
  sub: 'user-drv',
  username: 'driver1',
  role: 'DRIVER' as const,
  status: 'ACTIVE' as const,
  forcePasswordChange: false,
};

describe('RoutesService', () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<RoutesService>(RoutesService);
  });

  // ─── Route Templates ─────────────────────────────────────────────────────

  describe('findAllRoutes', () => {
    it('should return paginated routes', async () => {
      prisma.route.findMany.mockResolvedValue([MOCK_ROUTE]);
      prisma.route.count.mockResolvedValue(1);

      const result = await service.findAllRoutes({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('should filter by isActive', async () => {
      prisma.route.findMany.mockResolvedValue([]);
      prisma.route.count.mockResolvedValue(0);

      await service.findAllRoutes({ isActive: true, page: 1, limit: 20 });

      expect(prisma.route.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });
  });

  describe('findOneRoute', () => {
    it('should return a route with stops', async () => {
      prisma.route.findUnique.mockResolvedValue({ ...MOCK_ROUTE, stops: [] });
      const result = await service.findOneRoute('route-1');
      expect(result.id).toBe('route-1');
    });

    it('should throw NotFoundException for non-existent route', async () => {
      prisma.route.findUnique.mockResolvedValue(null);
      await expect(service.findOneRoute('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createRoute', () => {
    it('should create a route with just a name', async () => {
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      const result = await service.createRoute({ name: 'Downtown Route' });
      expect(prisma.route.create).toHaveBeenCalledWith({ data: { name: 'Downtown Route' } });
    });
  });

  describe('removeStop', () => {
    it('should delete a stop from a route', async () => {
      prisma.routeStop.findFirst.mockResolvedValue({ id: 'stop-1', routeId: 'route-1' });
      prisma.routeStop.delete.mockResolvedValue({});

      const result = await service.removeStop('route-1', 'stop-1');

      expect(result).toEqual({ success: true });
      expect(prisma.routeStop.delete).toHaveBeenCalledWith({ where: { id: 'stop-1' } });
    });

    it('should throw NotFoundException when stop does not belong to route', async () => {
      prisma.routeStop.findFirst.mockResolvedValue(null);
      await expect(service.removeStop('route-1', 'stop-x')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Route Runs ───────────────────────────────────────────────────────────

  describe('findOneRun', () => {
    it('should return a run with stops', async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...MOCK_RUN, stops: [] });
      const result = await service.findOneRun('run-1');
      expect(result.id).toBe('run-1');
    });

    it('should throw NotFoundException for non-existent run', async () => {
      prisma.routeRun.findUnique.mockResolvedValue(null);
      await expect(service.findOneRun('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateRunStatus', () => {
    it('should allow operators to set any status', async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
      prisma.routeRun.update.mockResolvedValue({ ...MOCK_RUN, status: 'CANCELLED' });

      const result = await service.updateRunStatus('run-1', { status: 'CANCELLED' as any }, operatorPayload);
      expect(prisma.routeRun.update).toHaveBeenCalled();
    });

    it('should allow drivers to set IN_PROGRESS', async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
      prisma.routeRun.update.mockResolvedValue({ ...MOCK_RUN, status: 'IN_PROGRESS' });

      await service.updateRunStatus('run-1', { status: 'IN_PROGRESS' as any }, driverPayload);
      expect(prisma.routeRun.update).toHaveBeenCalled();
    });

    it('should forbid drivers from setting CANCELLED', async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);

      await expect(
        service.updateRunStatus('run-1', { status: 'CANCELLED' as any }, driverPayload),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should set startedAt when transitioning to IN_PROGRESS', async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
      prisma.routeRun.update.mockResolvedValue({});

      await service.updateRunStatus('run-1', { status: 'IN_PROGRESS' as any }, operatorPayload);

      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ startedAt: expect.any(Date) }),
        }),
      );
    });

    it('should set completedAt when transitioning to COMPLETED', async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...MOCK_RUN, status: 'IN_PROGRESS' });
      prisma.routeRun.update.mockResolvedValue({});

      await service.updateRunStatus('run-1', { status: 'COMPLETED' as any }, operatorPayload);

      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ completedAt: expect.any(Date) }),
        }),
      );
    });

    it('should throw NotFoundException for non-existent run', async () => {
      prisma.routeRun.findUnique.mockResolvedValue(null);

      await expect(
        service.updateRunStatus('nonexistent', { status: 'COMPLETED' as any }, operatorPayload),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createRun', () => {
    it('should throw NotFoundException when route does not exist', async () => {
      prisma.route.findUnique.mockResolvedValue(null);

      await expect(
        service.createRun({ routeId: 'nonexistent', scheduledDate: '2025-01-01' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create a run with stops mirroring the route template', async () => {
      prisma.route.findUnique.mockResolvedValue({
        ...MOCK_ROUTE,
        stops: [{ id: 'rs-1', stopNumber: 1, customerId: 'c1', customerAddressId: 'a1' }],
      });
      prisma.routeRun.create.mockResolvedValue({ ...MOCK_RUN, stops: [] });

      await service.createRun({
        routeId: 'route-1',
        driverId: 'drv-1',
        scheduledDate: '2025-06-01',
      } as any);

      expect(prisma.routeRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stops: {
              create: [
                expect.objectContaining({
                  routeStopId: 'rs-1',
                  stopNumber: 1,
                  customerId: 'c1',
                  customerAddressId: 'a1',
                }),
              ],
            },
          }),
        }),
      );
    });
  });
});
