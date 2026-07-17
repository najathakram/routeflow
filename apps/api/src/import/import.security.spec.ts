/**
 * Security tests for the import module.
 *
 * F8-003: per-row import failures used to push the raw Prisma/exception message
 * into the response `errors[]` (DB schema disclosure). They now push a generic,
 * row-scoped message and log the real error server-side.
 *
 * F9-008: CSV parsing had byte caps but no row-count cap, so a densely packed
 * file could expand into a huge in-memory array + per-row DB work. parseCsv now
 * rejects past MAX_IMPORT_ROWS with a clear 400.
 */
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ImportService — security (F8-003 / F9-008)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  // ── F8-003: raw error text must not reach the client ──────────────────────
  it("F8-003: pushRowError returns a generic message and logs the real error", () => {
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    const errors: string[] = [];

    (service as any).pushRowError(
      errors,
      "Acme Corp",
      new Error('null value in column "tax_id" violates not-null constraint'),
    );

    expect(errors).toEqual(["Acme Corp: import failed"]);
    // The DB schema detail is never echoed to the caller...
    expect(errors[0]).not.toMatch(/column|constraint|tax_id/i);
    // ...but it IS captured server-side for debugging.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tax_id"));
  });

  // ── F9-008: row-count cap ─────────────────────────────────────────────────
  it("F9-008: parseCsv rejects a file above the row-count cap", () => {
    const header = "name\n";
    const rows = Array.from({ length: 20_001 }, (_, i) => `row${i}`).join("\n");
    const buffer = Buffer.from(header + rows);

    expect(() => (service as any).parseCsv(buffer)).toThrow(BadRequestException);
  });

  it("F9-008: parseCsv still parses a normal, in-bounds file", () => {
    const buffer = Buffer.from("name,qty\nWidget,3\nGadget,4\n");
    const rows = (service as any).parseCsv(buffer) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Widget", qty: "3" });
  });
});
