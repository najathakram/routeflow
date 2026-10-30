// W-870: not about the permission check; the live denied-groups read is mocked (a mocked Prisma has no permissions row).
jest.mock("../orders/counter-sale/till-permission.guard", () =>
  require("../testing/till-user").tillGuardMock(),
);
/**
 * units_v1 step 4c-1 — `InvoicesService.create` (a manual invoice) sells a line by a unit of the
 * product's ladder behind `flag.units_v1`; a pack-only request is byte-identical. The line builder
 * is proven in `invoice-unit-line.spec.ts`; this pins the WIRING: what create() reads, refuses and
 * writes. Nest `useMocker` auto-mocks every collaborator this spec does not care about.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({
  loadMsrpMap: jest.fn().mockResolvedValue(new Map([["p1", 30]])),
}));

import { Test } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** Any collaborator method resolves undefined; `then`/symbols stay undefined (a thenable mock hangs `await`). */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("InvoicesService.create — the warn census names its source (SA-982 PR-2)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let logs: jest.SpyInstance;
  // A 12-pack sent as qty only: the B644 shape, which `buildLine` refuses (BOXED_NO_SPLIT).
  const items = [{ description: "Widget", productId: "p1", qty: 6, unitPrice: 24 }];
  const actor = { sub: "u1", role: "OPERATOR" } as never;
  const ambiguity = () =>
    logs.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("line-ambiguity"));

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        if (token === EntitlementAuthority) return { can: jest.fn().mockResolvedValue(false) };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      isTaxExempt: false,
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        unit: "Box",
        unitsPerBox: 12,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      },
    ]);
    prisma.invoice.create.mockResolvedValue({ id: "inv-1", items: [], customer: {}, payments: [] });
    logs = jest
      .spyOn(require("@nestjs/common").Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });
  afterEach(() => logs.mockRestore());

  it("a call that names the site (POST /invoices) logs the ambiguous shape once", async () => {
    await service.create({ customerId: "cust-1", items } as never, actor, {
      warnSite: "invoices.manual",
    });
    expect(ambiguity()).toEqual([
      "line-ambiguity site=invoices.manual reason=BOXED_NO_SPLIT tenant=test-tenant role=OPERATOR",
    ]);
  });

  it("a call that names no site (a recurring run) is never counted, with or without an actor", async () => {
    await service.create({ customerId: "cust-1", items } as never, actor);
    await service.create({ customerId: "cust-1", items } as never);
    expect(ambiguity()).toEqual([]);
  });
});
