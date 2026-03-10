import { PrismaService } from '../prisma/prisma.service';

/**
 * Creates a deeply-mocked PrismaService where every model property
 * (customer, order, product, etc.) and every method (findMany, create,
 * update, etc.) is a jest.fn().
 *
 * Usage:
 *   providers: [{ provide: PrismaService, useValue: createMockPrisma() }]
 */
export function createMockPrisma(): jest.Mocked<PrismaService> {
  const modelMethods = [
    'findMany',
    'findUnique',
    'findFirst',
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'count',
    'aggregate',
    'upsert',
  ];

  const modelProxy = () =>
    Object.fromEntries(modelMethods.map((m) => [m, jest.fn()]));

  return {
    user: modelProxy(),
    customer: modelProxy(),
    customerAddress: modelProxy(),
    driver: modelProxy(),
    product: modelProxy(),
    order: modelProxy(),
    orderItem: modelProxy(),
    deliveryMutation: modelProxy(),
    route: modelProxy(),
    routeStop: modelProxy(),
    routeCustomer: modelProxy(),
    routeRun: modelProxy(),
    routeRunStop: modelProxy(),
    transaction: modelProxy(),
    transactionItem: modelProxy(),
    payment: modelProxy(),
    deviceToken: modelProxy(),
    syncLog: modelProxy(),
    refreshToken: modelProxy(),
    $transaction: jest.fn((fn: any) => fn({
      user: modelProxy(),
      customer: modelProxy(),
      customerAddress: modelProxy(),
      driver: modelProxy(),
      product: modelProxy(),
      order: modelProxy(),
      orderItem: modelProxy(),
      deliveryMutation: modelProxy(),
      routeRun: modelProxy(),
      routeRunStop: modelProxy(),
      routeStop: modelProxy(),
      transaction: modelProxy(),
      payment: modelProxy(),
      refreshToken: modelProxy(),
    })),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  } as any;
}
