import { Test, TestingModule } from "@nestjs/testing";
import type { Job } from "bull";

// InvoiceProcessor's constructor metadata pulls in InvoiceService, whose module-level
// imports reach the S3 client and a .tsx template Jest's resolver cannot see (this
// workspace's `moduleFileExtensions` has no "tsx"). None of that is what this file proves,
// so it is stubbed exactly as invoice.service.tenant-scope.spec.ts does. Declared before
// the imports below because this project's ts-jest setup does not hoist `jest.mock`.
jest.mock("./invoice-template", () => ({ InvoiceTemplate: () => null }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }));

import { InvoiceService } from "./invoice.service";
import { InvoiceProcessor, type GenerateInvoiceJobData } from "./invoice.processor";

// REG-B188 / R7 — the JOB-PAYLOAD half of the tenant guard.
//
// invoice.service.tenant-scope.spec.ts pins what `generateInvoicePdf` does once it HAS a
// tenantId. That proves nothing on its own: the tenantId has to survive the trip through
// Redis and out of `job.data`, and the whole guard lives in that hand-off. A processor that
// reads only `transactionId` off the payload — which is exactly what it did before R7 —
// leaves `generateInvoicePdf` to fall back to its no-tenant branch on every real job, so the
// service-side guard would be live, correct, and never once exercised in production.
//
// Against the pre-R7 processor (`generateInvoicePdf(transactionId)`, one argument, and no
// `tenantId` field on GenerateInvoiceJobData) the forwarding assertion below is red.

// Built through a cast for the same reason invoice.service.tenant-scope.spec.ts casts its
// service call: against the PRE-fix `GenerateInvoiceJobData` (transactionId only) a literal
// carrying tenantId is a TS excess-property error, and a suite that cannot compile reports as
// an ERROR rather than the assertion failure this file is supposed to produce.
function makeJob(data: { transactionId: string; tenantId: string }): Job<GenerateInvoiceJobData> {
  return { data } as unknown as Job<GenerateInvoiceJobData>;
}

describe("InvoiceProcessor.handleGenerateInvoice — tenant hand-off (REG-B188 / T-B188)", () => {
  let processor: InvoiceProcessor;
  let generateInvoicePdf: jest.Mock;

  beforeEach(async () => {
    generateInvoicePdf = jest.fn().mockResolvedValue("https://signed.example/invoice.pdf");
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvoiceProcessor, { provide: InvoiceService, useValue: { generateInvoicePdf } }],
    }).compile();
    processor = module.get(InvoiceProcessor);
  });

  it("REG-B188: forwards the payload's tenantId as generateInvoicePdf's second argument", async () => {
    await processor.handleGenerateInvoice(
      makeJob({ transactionId: "txn-1", tenantId: "tenant-1" }),
    );

    expect(generateInvoicePdf).toHaveBeenCalledWith("txn-1", "tenant-1");
  });

  it("REG-B188: the tenantId it forwards is the payload's own, not a constant or a default", async () => {
    // Two jobs, same transaction, different owning tenants. A processor that hardcoded a
    // tenant, or read one from anywhere but `job.data`, would pass the previous test and fail
    // here — which is what makes this the assertion that the payload is genuinely the carrier.
    await processor.handleGenerateInvoice(
      makeJob({ transactionId: "txn-9", tenantId: "tenant-a" }),
    );
    await processor.handleGenerateInvoice(
      makeJob({ transactionId: "txn-9", tenantId: "tenant-b" }),
    );

    expect(generateInvoicePdf.mock.calls).toEqual([
      ["txn-9", "tenant-a"],
      ["txn-9", "tenant-b"],
    ]);
  });

  it("REG-B188: a refused (cross-tenant) job re-throws so Bull retries rather than silently dropping it", async () => {
    const boom = new Error("Transaction not found");
    generateInvoicePdf.mockRejectedValueOnce(boom);

    await expect(
      processor.handleGenerateInvoice(makeJob({ transactionId: "txn-1", tenantId: "tenant-2" })),
    ).rejects.toThrow(boom);
  });
});
