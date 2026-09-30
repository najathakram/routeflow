import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// REG-B188 — apps/api/src/bookkeeping/invoice.service.ts#generateInvoicePdf reads and
// writes the Transaction row by id ALONE (bare `findUnique` / `update`), so a background
// job carrying a tenantId that does not own the row still finds and mutates it. R7
// (spec.md) requires the job's tenantId to gate both the read (`findFirst({id, tenantId})`)
// and the write (`updateMany({id, tenantId})`) — the same guard shape `getPresignedUrl`
// already uses for F1-002. T-B188 in test-plan.md.
//
// Per the vacuity-trap note in test-plan.md, the fake Transaction store below is
// partitioned by tenant (mirrors settings.controller.clear-financial.spec.ts's shape):
// its `findFirst` returns a row ONLY when both `id` and `tenantId` match (except for the
// `tenantId: undefined` case, where it reproduces Prisma's drop-the-field rule), while its
// `findUnique`/`update` faithfully reproduce TODAY's tenant-blind Prisma calls (id only).
// That is what makes a bare `findUnique` observably wrong here instead of silently
// "passing" against a mock that hands back whatever it's told to.

// The S3 client is mocked so `generateInvoicePdf`'s upload step never makes a real network
// call; `send` is a single shared spy so the test can assert "upload never called" (case 1)
// and "upload called exactly once" (case 2) without reaching into Nest's DI container.
jest.mock("@aws-sdk/client-s3", () => {
  const send = jest.fn();
  return {
    __send: send,
    S3Client: jest.fn().mockImplementation(() => ({ send })),
    PutObjectCommand: jest.fn((input: unknown) => ({ __command: "PutObjectCommand", input })),
    GetObjectCommand: jest.fn((input: unknown) => ({ __command: "GetObjectCommand", input })),
  };
});

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example/invoice.pdf"),
}));

// `moduleFileExtensions` in this workspace's jest config is ["js", "json", "ts"] — it does
// not include "tsx", so Jest's resolver cannot find "./invoice-template" (a real .tsx file)
// from a bare extension-less import, unrelated to anything this spec is proving. A virtual
// mock sidesteps that pre-existing resolver gap without touching jest config or the
// template file: the component's own body never runs anyway, since @react-pdf/renderer's
// jest mock (moduleNameMapper, apps/api/test/__mocks__/react-pdf-renderer.js) ignores the
// element it's handed.
jest.mock("./invoice-template", () => ({ InvoiceTemplate: () => null }), { virtual: true });

// Imported AFTER the mocks above so InvoiceService's module-level S3Client/getSignedUrl/
// InvoiceTemplate imports resolve to the mocks — same manual-ordering convention as
// bulk-mark-paid.spec.ts in this directory (this project's ts-jest setup does not hoist
// jest.mock calls).
import { InvoiceService } from "./invoice.service";

type TxnRow = { id: string; tenantId: string; pdfUrl: string | null };

/**
 * Purpose-built fake Transaction store: partitioned by tenant for `findFirst`/`updateMany`
 * (the R7 guard shape), tenant-blind for `findUnique`/`update` (TODAY's bare shape) — see
 * file-header note.
 */
function makeFakeStore(rows: TxnRow[]) {
  const state: TxnRow[] = rows.map((r) => ({ ...r }));

  const findUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
    return state.find((r) => r.id === where.id) ?? null;
  });

  // Mirrors Prisma's real filter semantics, including the one that makes case 3 a genuine
  // vulnerability rather than a style preference: an `undefined` field is DROPPED from the
  // where clause, so `{id, tenantId: undefined}` matches on id alone.
  const matches = (r: TxnRow, where: { id: string; tenantId?: string }) =>
    r.id === where.id && (where.tenantId === undefined || r.tenantId === where.tenantId);

  const findFirst = jest.fn(
    async ({ where }: { where: { id: string; tenantId?: string } }) =>
      state.find((r) => matches(r, where)) ?? null,
  );

  const update = jest.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<TxnRow> }) => {
      const row = state.find((r) => r.id === where.id);
      if (!row) throw new Error("record not found");
      Object.assign(row, data);
      return row;
    },
  );

  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; tenantId?: string };
      data: Partial<TxnRow>;
    }) => {
      const hits = state.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    },
  );

  const prisma: any = { transaction: { findUnique, findFirst, update, updateMany } };

  // A house-style implementation may reach the model through `forTenant()` or
  // wrap the write in `tenantTransaction()` rather than calling the raw client.
  // Both resolve back to this same fake so such an implementation is still
  // judged by the assertions below instead of dying on
  // `prisma.forTenant is not a function` — a TypeError is an ERROR, not the
  // assertion failure this spec exists to produce. Note the fake does NOT
  // silently satisfy them: `forTenant()` carries no tenant of its own here
  // (the real one reads ambient request context, which a background job does
  // not have), so a `forTenant().transaction.findFirst({where:{id}})`
  // implementation matches no row for either tenant and fails case 2's
  // success assertion — which is the correct verdict for R7, whose whole point
  // is that the tenantId must travel in the JOB PAYLOAD.
  prisma.forTenant = jest.fn(() => prisma);
  prisma.tenantTransaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  prisma.$transaction = jest.fn((arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma),
  );

  return { state, prisma };
}

async function buildService(prisma: unknown): Promise<InvoiceService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InvoiceService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("") } },
    ],
  }).compile();
  return module.get<InvoiceService>(InvoiceService);
}

// The production method is still single-argument pre-fix
// (`generateInvoicePdf(transactionId: string)`); R7 adds a `tenantId` parameter carried by
// the job data (GenerateInvoiceJobData). Calling through this cast — rather than typing
// `service` as `any` — lets this file compile against TODAY's signature while still
// exercising the two-argument contract the fix must add, so the spec fails on the
// assertions below instead of on a TS2554 argument-count error (same technique as
// settings.controller.clear-financial.spec.ts's `callClearFinancialData`).
type GenerateInvoicePdfCaller = (transactionId: string, tenantId: string) => Promise<string>;
function callGenerateInvoicePdf(service: InvoiceService, transactionId: string, tenantId: string) {
  return (service.generateInvoicePdf as unknown as GenerateInvoicePdfCaller)(
    transactionId,
    tenantId,
  );
}

describe("InvoiceService.generateInvoicePdf — tenant scoping", () => {
  let s3Send: jest.Mock;

  beforeEach(() => {
    s3Send = (jest.requireMock("@aws-sdk/client-s3") as { __send: jest.Mock }).__send;
    s3Send.mockClear();
  });

  // T-B188 case 1 (R7) — a job whose tenantId does not own the transaction must be
  // refused, not merely warned about: no PDF upload, no persistence write. Against
  // TODAY's bare `findUnique({where:{id}})`, the row is found regardless of the caller's
  // tenantId, so the call resolves instead of rejecting — red today.
  it("REG-B188: refuses a tenant-2 job for a transaction owned by tenant-1 (NotFoundException, no upload, no update)", async () => {
    const { state, prisma } = makeFakeStore([{ id: "txn-1", tenantId: "tenant-1", pdfUrl: null }]);
    const service = await buildService(prisma);

    await expect(callGenerateInvoicePdf(service, "txn-1", "tenant-2")).rejects.toThrow(
      NotFoundException,
    );

    expect(s3Send).not.toHaveBeenCalled();
    expect(prisma.transaction.update).not.toHaveBeenCalled();
    expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
    // The row itself is untouched — the refusal is a pre-condition check, not a failed
    // write that already mutated something.
    expect(state.find((r) => r.id === "txn-1")?.pdfUrl).toBeNull();
  });

  // T-B188 case 2 (R7) — the owning tenant succeeds, and the persistence write is the
  // guarded `updateMany({id, tenantId})` shape, not a bare `update({id})`. Against TODAY's
  // code (which calls `update`, never `updateMany`), this fails cleanly on the second
  // assertion: `updateMany` is never invoked.
  it("REG-B188: succeeds for the owning tenant-1 and persists via updateMany({id, tenantId})", async () => {
    const { prisma } = makeFakeStore([{ id: "txn-1", tenantId: "tenant-1", pdfUrl: null }]);
    const service = await buildService(prisma);

    const url = await callGenerateInvoicePdf(service, "txn-1", "tenant-1");

    expect(url).toBe("https://signed.example/invoice.pdf");
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "txn-1", tenantId: "tenant-1" },
        data: expect.objectContaining({ pdfUrl: expect.any(String) }),
      }),
    );
  });

  // T-B188 case 3 (R7) — the guard must FAIL CLOSED on a payload with no tenantId. Job data
  // is deserialized from Redis, so `tenantId: string` on GenerateInvoiceJobData is
  // compile-time only, and Prisma DROPS `tenantId: undefined` from a where clause: without
  // an explicit pre-condition check, `findFirst({id, tenantId: undefined})` degrades to
  // `findFirst({id})` and serves — then overwrites the pdfUrl of — any tenant's transaction,
  // which is exactly the B188 hole. The refusal must happen before the lookup, so the two
  // fake-store queries below must never run.
  it("REG-B188: refuses a job payload carrying no tenantId (BadRequestException, no lookup, no upload, no update)", async () => {
    const { state, prisma } = makeFakeStore([{ id: "txn-1", tenantId: "tenant-1", pdfUrl: null }]);
    const service = await buildService(prisma);

    await expect(
      callGenerateInvoicePdf(service, "txn-1", undefined as unknown as string),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.transaction.findFirst).not.toHaveBeenCalled();
    expect(prisma.transaction.findUnique).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
    expect(prisma.transaction.update).not.toHaveBeenCalled();
    expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
    expect(state.find((r) => r.id === "txn-1")?.pdfUrl).toBeNull();
  });
});
