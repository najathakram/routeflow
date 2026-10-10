import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The delegate methods createMockPrisma() replaces with jest.fn() on every model. The type below is
 * DERIVED from this list, so the runtime mock and the type can never disagree in either direction.
 */
const MODEL_METHODS = [
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
  "groupBy",
  "upsert",
] as const;
type MockModelMethod = (typeof MODEL_METHODS)[number];

/**
 * B806: `jest.Mocked<PrismaService>` is SHALLOW, so `prisma.order.findUnique` kept the real Prisma
 * delegate type and every `.mockResolvedValue(...)` on it was a type error (6,328 of them, invisible
 * only because check-types excluded specs). Each model's delegate methods are typed as the jest.fn()
 * they are at runtime. The object this function builds is unchanged (same method list, now
 * hoisted to MODEL_METHODS so the type is derived from it).
 */
export type MockPrisma = jest.Mocked<PrismaService> & {
  [K in Uncapitalize<Prisma.ModelName>]: Record<MockModelMethod, jest.Mock>;
};

/**
 * Creates a deeply-mocked PrismaService where every model property
 * (customer, order, product, etc.) and every method (findMany, create,
 * update, etc.) is a jest.fn().
 *
 * Usage:
 *   providers: [{ provide: PrismaService, useValue: createMockPrisma() }]
 */
export function createMockPrisma(): MockPrisma {
  const modelMethods = MODEL_METHODS;

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
    aggregate: { _sum: {}, _count: {}, _avg: {}, _max: {}, _min: {} },
    groupBy: [],
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

  // Prisma's update() returns the written row. B562 PR-2's order stock paths read the counter the
  // update returned (the SALE movement's stockAfter), so the product mock returns one by default.
  const productProxy = () => {
    const proxy = modelProxy();
    // #2717 M1: a real Product row always carries barcode/unitsPerBox/imageKeys; the dual-write
    // sync reads them from the UPDATE's result.
    proxy.update.mockResolvedValue({
      currentStock: 0,
      averageCost: null,
      barcode: null,
      unitsPerBox: null,
      imageKeys: [],
    });
    // #2717 M1: products.service.ts create() syncs ProductBarcode rows keyed off the CREATED row's
    // id — a spec that doesn't stub product.create needs a non-empty id, or the sync call 500s on
    // "productId required" instead of the no-op it should be (no barcode -> nothing to sync).
    proxy.create.mockResolvedValue({ id: "mock-product-id", barcode: null, unitsPerBox: null });
    return proxy;
  };

  const allModels = () => ({
    user: modelProxy(),
    customer: modelProxy(),
    customerAddress: modelProxy(),
    driver: modelProxy(),
    driverLocation: modelProxy(),
    product: productProxy(),
    productUnit: modelProxy(),
    // #2717 M1: additive barcode-by-level / photo rows (product-catalog-sync.ts). Default
    // findMany() -> [] (modelProxy) matches "no rows yet" — a spec that seeds rows stubs
    // .findMany.mockResolvedValue([...]) same as any other model.
    productBarcode: modelProxy(),
    productImage: modelProxy(),
    // #2717 M2: recipe versions and their component lines. Default findMany() -> [] / findFirst()
    // -> null ("no recipe"); a spec that seeds one stubs the method like any other model.
    recipe: modelProxy(),
    recipeComponent: modelProxy(),
    order: modelProxy(),
    orderItem: modelProxy(),
    // #2717 M3: frozen FIXED-line component rows (default findMany() -> [] = a plain line).
    orderItemComponent: modelProxy(),
    orderRevision: modelProxy(),
    changeRequest: modelProxy(),
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
    invoiceItemComponent: modelProxy(),
    invoicePayment: modelProxy(),
    paymentCounter: modelProxy(),
    creditNote: modelProxy(),
    advancePayment: modelProxy(),
    supplierCredit: modelProxy(),
    estimate: modelProxy(),
    estimateItem: modelProxy(),
    vendorBill: modelProxy(),
    vendorBillItem: modelProxy(),
    billPayment: modelProxy(),
    expense: modelProxy(),
    expenseCategory: modelProxy(),
    mileageRate: modelProxy(),
    deviceToken: modelProxy(),
    userPreference: modelProxy(),
    syncLog: modelProxy(),
    refreshToken: modelProxy(),
    systemConfig: modelProxy(),
    standingOrderTemplate: modelProxy(),
    standingOrderItem: modelProxy(),
    customerPrice: modelProxy(),
    contactPerson: modelProxy(),
    customerTag: modelProxy(),
    customerTagAssignment: modelProxy(),
    customerComment: modelProxy(),
    tenant: modelProxy(),
    return: modelProxy(),
    returnItem: modelProxy(),
    stockMovement: modelProxy(),
    stockLot: modelProxy(),
    supplier: modelProxy(),
    productMapping: modelProxy(),
    purchaseOrder: modelProxy(),
    purchaseOrderItem: modelProxy(),
    tenantAddon: modelProxy(),
    tobaccoReport: modelProxy(),
    tenantConfig: modelProxy(),
    idempotencyKey: modelProxy(),
    // B215: OrdersController.create's staff merge branch replays a same-key
    // retry through this table first, written inside updateOrderItems' own
    // fold transaction (recordMergeIdempotencyKey) — see
    // orders.merge-idempotency.spec.ts.
    orderIdempotencyKey: modelProxy(),
    passwordResetToken: modelProxy(),
    saleDraft: modelProxy(),
    trackedCategory: modelProxy(),
    trackedSubcategory: modelProxy(),
    customerAuthorization: modelProxy(),
    authorizationOverride: modelProxy(),
    regulatedSalesLedger: modelProxy(),
    regulatedLedgerParkedReversal: modelProxy(),
    returnParkedRestock: modelProxy(),
    regulatedFiling: modelProxy(),
    numberingSequence: modelProxy(),
    importExternalRef: modelProxy(),
    productAlias: modelProxy(),
    migrationJob: modelProxy(),
    migrationStagingRecord: modelProxy(),
    importBatch: modelProxy(),
    importQueueItem: modelProxy(),
    buyerFavorite: modelProxy(),
    orderTemplate: modelProxy(),
    orderTemplateItem: modelProxy(),
    creditNoteItem: modelProxy(),
    orderCreditNote: modelProxy(),
    creditNoteApplyBlock: modelProxy(), // SA-436 (#2401)
    promotion: modelProxy(),
    promotionProduct: modelProxy(),
    // P6-1 (F0): messaging thread schema (message was previously missing).
    message: modelProxy(),
    messageThread: modelProxy(),
    messageTemplate: modelProxy(),
    notificationRule: modelProxy(),
    messageOptOut: modelProxy(),
    messagingSettings: modelProxy(),
    inboundTriage: modelProxy(),
    recurringInvoice: modelProxy(),
    recurringInvoiceItem: modelProxy(),
    buyerAccount: modelProxy(),
    buyerRefreshToken: modelProxy(),
    buyerPasswordResetToken: modelProxy(),
    buyerEmailVerificationToken: modelProxy(),
    customerLink: modelProxy(),
    replenishmentSnooze: modelProxy(),
    stockAlert: modelProxy(),
    stockCountSession: modelProxy(),
    stockCountLine: modelProxy(),
    // B120 (F10): reopenStop archives POD pointers via `tx.auditLog.create`, so the
    // model must exist on the object the default tenantTransaction/$transaction mocks
    // spread — a per-spec `(prisma as any).auditLog = ...` only reaches the returned
    // object, never this one.
    auditLog: modelProxy(),
    crmConnection: modelProxy(),
    crmHandoff: modelProxy(),
    // SA-750r3: the day-close window reads (`counterWindowClosed`)
    counterDayClose: modelProxy(),
  });

  const txModels = () => ({
    user: modelProxy(),
    customer: modelProxy(),
    customerAddress: modelProxy(),
    driver: modelProxy(),
    product: productProxy(),
    productUnit: modelProxy(),
    productBarcode: modelProxy(),
    productImage: modelProxy(),
    recipe: modelProxy(),
    recipeComponent: modelProxy(),
    order: modelProxy(),
    orderItem: modelProxy(),
    orderItemComponent: modelProxy(),
    orderRevision: modelProxy(),
    changeRequest: modelProxy(),
    deliveryMutation: modelProxy(),
    routeRun: modelProxy(),
    routeRunStop: modelProxy(),
    routeStop: modelProxy(),
    transaction: modelProxy(),
    payment: modelProxy(),
    invoice: modelProxy(),
    invoiceItem: modelProxy(),
    invoiceItemComponent: modelProxy(),
    invoicePayment: modelProxy(),
    paymentCounter: modelProxy(),
    creditNote: modelProxy(),
    vendorBill: modelProxy(),
    vendorBillItem: modelProxy(),
    billPayment: modelProxy(),
    refreshToken: modelProxy(),
    idempotencyKey: modelProxy(),
    trackedCategory: modelProxy(),
    trackedSubcategory: modelProxy(),
    customerAuthorization: modelProxy(),
    authorizationOverride: modelProxy(),
    regulatedSalesLedger: modelProxy(),
    regulatedLedgerParkedReversal: modelProxy(),
    returnParkedRestock: modelProxy(),
    regulatedFiling: modelProxy(),
    numberingSequence: modelProxy(),
    importExternalRef: modelProxy(),
    productAlias: modelProxy(),
    migrationJob: modelProxy(),
    migrationStagingRecord: modelProxy(),
    importBatch: modelProxy(),
    importQueueItem: modelProxy(),
    creditNoteItem: modelProxy(),
    orderCreditNote: modelProxy(),
    creditNoteApplyBlock: modelProxy(), // SA-436 (#2401)
    promotion: modelProxy(),
    promotionProduct: modelProxy(),
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
