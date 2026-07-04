import { PrismaService } from "../prisma/prisma.service";

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
    "findMany",
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "create",
    "createMany",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "count",
    "aggregate",
    "upsert",
  ];

  // Sensible defaults so services don't crash when a mock isn't explicitly set up
  const defaultReturnValues: Record<string, unknown> = {
    findMany: [],
    findUnique: null,
    findUniqueOrThrow: {},
    findFirst: null,
    findFirstOrThrow: {},
    create: {},
    createMany: { count: 0 },
    update: {},
    updateMany: { count: 0 },
    delete: {},
    deleteMany: { count: 0 },
    count: 0,
    aggregate: { _sum: {}, _count: {}, _avg: {} },
    upsert: {},
  };

  const modelProxy = () =>
    Object.fromEntries(
      modelMethods.map((m) => {
        const fn = jest.fn();
        fn.mockResolvedValue(defaultReturnValues[m] ?? null);
        return [m, fn];
      }),
    );

  const allModels = () => ({
    user: modelProxy(),
    customer: modelProxy(),
    customerAddress: modelProxy(),
    driver: modelProxy(),
    product: modelProxy(),
    order: modelProxy(),
    orderItem: modelProxy(),
    deliveryMutation: modelProxy(),
    deliveryBatch: modelProxy(),
    route: modelProxy(),
    routeStop: modelProxy(),
    routeCustomer: modelProxy(),
    routeRun: modelProxy(),
    routeRunStop: modelProxy(),
    transaction: modelProxy(),
    transactionItem: modelProxy(),
    payment: modelProxy(),
    invoice: modelProxy(),
    invoiceItem: modelProxy(),
    invoicePayment: modelProxy(),
    creditNote: modelProxy(),
    advancePayment: modelProxy(),
    vendorBill: modelProxy(),
    vendorBillItem: modelProxy(),
    billPayment: modelProxy(),
    expense: modelProxy(),
    expenseCategory: modelProxy(),
    mileageRate: modelProxy(),
    deviceToken: modelProxy(),
    syncLog: modelProxy(),
    refreshToken: modelProxy(),
    systemConfig: modelProxy(),
    standingOrderTemplate: modelProxy(),
    standingOrderItem: modelProxy(),
    customerPrice: modelProxy(),
    contactPerson: modelProxy(),
    customerTag: modelProxy(),
    customerComment: modelProxy(),
    tenant: modelProxy(),
    return: modelProxy(),
    returnItem: modelProxy(),
    stockMovement: modelProxy(),
    stockLot: modelProxy(),
    supplier: modelProxy(),
    purchaseOrder: modelProxy(),
    purchaseOrderItem: modelProxy(),
    tenantAddon: modelProxy(),
    tobaccoReport: modelProxy(),
    tenantConfig: modelProxy(),
    idempotencyKey: modelProxy(),
    passwordResetToken: modelProxy(),
  });

  const txModels = () => ({
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
    invoice: modelProxy(),
    invoiceItem: modelProxy(),
    invoicePayment: modelProxy(),
    creditNote: modelProxy(),
    vendorBill: modelProxy(),
    vendorBillItem: modelProxy(),
    billPayment: modelProxy(),
    refreshToken: modelProxy(),
    idempotencyKey: modelProxy(),
    // Raw query support inside transactions
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
  });

  const models = allModels();

  return {
    ...models,
    // forTenant() returns the same model surface — tests can stub individual methods
    // using prisma.customer.findMany.mockResolvedValue(...) and it will work
    // whether the service calls prisma.customer directly or prisma.forTenant().customer
    forTenant: jest.fn().mockReturnValue(models),
    getTenantId: jest.fn().mockReturnValue("test-tenant"),
    // tenantTransaction wraps $transaction with tenant context — behaves the same in tests
    tenantTransaction: jest.fn((fn: any) =>
      fn({
        ...models,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      }),
    ),
    $transaction: jest.fn((fn: any) =>
      fn({
        ...models,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      }),
    ),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  } as any;
}
