/**
 * B444 + B1023: GET /bookkeeping/transactions/:id/pdf downloads a real Invoice's PDF.
 *  - the id is an Invoice id, and the file is the tenant renderer's (InvoicePdfService, forTenant());
 *  - B1023: the old letterhead renderer is gone, so nothing under src/bookkeeping renders a PDF itself.
 */
import { NotFoundException } from "@nestjs/common";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";

jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../vendor-bills/vendor-bills.service", () => ({
  VendorBillsService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));

import { BookkeepingController } from "./bookkeeping.controller";
import { BookkeepingService } from "./bookkeeping.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("B444 getPdfUrl is the tenant renderer's URL", () => {
  let service: BookkeepingService;
  let pdf: { getOrGenerate: jest.Mock };

  beforeEach(async () => {
    pdf = { getOrGenerate: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        BookkeepingService,
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: InvoicePdfService, useValue: pdf },
        { provide: StorageService, useValue: {} },
        { provide: VendorBillsService, useValue: {} },
        { provide: PlatformConfigService, useValue: {} },
        { provide: CommissionEngineService, useValue: {} },
      ],
    }).compile();
    service = mod.get(BookkeepingService);
  });

  it("returns { url } from getOrGenerate(invoiceId), called once", async () => {
    pdf.getOrGenerate.mockResolvedValue("https://r2.example.com/invoice-pdfs/inv-1.pdf");
    await expect(service.getPdfUrl("inv-1")).resolves.toEqual({
      url: "https://r2.example.com/invoice-pdfs/inv-1.pdf",
    });
    expect(pdf.getOrGenerate).toHaveBeenCalledTimes(1);
    expect(pdf.getOrGenerate).toHaveBeenCalledWith("inv-1");
  });

  it("an id the tenant does not own is the renderer's NotFound, not a 202", async () => {
    pdf.getOrGenerate.mockRejectedValue(new NotFoundException("Invoice not found"));
    await expect(service.getPdfUrl("other-tenant-inv")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the controller returns the { url } body (200), never a 202", async () => {
    pdf.getOrGenerate.mockResolvedValue("https://r2.example.com/x.pdf");
    const ctrl = new BookkeepingController(service);
    await expect(ctrl.getInvoicePdf("inv-1")).resolves.toEqual({
      url: "https://r2.example.com/x.pdf",
    });
  });
});

describe("B1023 no second PDF renderer under src/bookkeeping", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"));

  it("the letterhead renderer files are gone", () => {
    for (const gone of ["invoice.service.ts", "invoice.processor.ts", "invoice-template.tsx"]) {
      expect(readdirSync(dir)).not.toContain(gone);
    }
  });

  it("no non-spec file imports a PDF renderer or a template", () => {
    const offenders = files.filter((n) =>
      /@react-pdf\/renderer|renderToBuffer|invoice-template|\.\/invoice\.service/.test(
        readFileSync(join(dir, n), "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("getPdfUrl reaches the tenant renderer", () => {
    const src = readFileSync(join(dir, "bookkeeping.service.ts"), "utf8");
    expect(src).toMatch(/invoicePdfService\.getOrGenerate\(/);
  });
});
