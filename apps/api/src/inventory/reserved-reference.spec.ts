import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  assertStockReferenceFree,
  isReservedStockReference,
  RESERVED_STOCK_REFERENCE_PREFIXES,
} from "./reserved-reference";
import { stockCountReference } from "./stock-count-commit";
import { RecordAdjustmentDto } from "./dto/record-adjustment.dto";
import { RecordPurchaseDto } from "./dto/record-purchase.dto";
import { buildCountUnitWorld, CountUnitWorld, pid } from "./testing/count-unit-harness";

/**
 * B640 (row 562 S1): `StockMovement.reference` is free text on two inventory DTOs, and both stock-count commit
 * paths read "a movement with the count's reference exists" as "this line is already committed". The head
 * `STOCK_COUNT-` is therefore reserved: no DTO field accepts it and no service entry point records it.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

const SID = "5b0f6b7e-6c2f-4a87-9f0b-0c1b7a6d1e11";

describe("B640 reserved stock references", () => {
  describe("isReservedStockReference", () => {
    it("reserves the exact reference a count writes, in any case and with stray spaces", () => {
      expect(isReservedStockReference(stockCountReference(SID))).toBe(true);
      expect(isReservedStockReference(`stock_count-${SID}`)).toBe(true);
      expect(isReservedStockReference(`  Stock_Count-${SID}`)).toBe(true);
      expect(isReservedStockReference("STOCK_COUNT-")).toBe(true);
    });

    it("lets every other reference through, including near misses and non-strings", () => {
      for (const ok of [
        "RECOUNT-AISLE-3",
        "STOCK COUNT 1",
        "STOCKCOUNT-1",
        "MY-STOCK_COUNT-1",
        "",
      ]) {
        expect(isReservedStockReference(ok)).toBe(false);
      }
      expect(isReservedStockReference(undefined)).toBe(false);
      expect(isReservedStockReference(null)).toBe(false);
      expect(isReservedStockReference(42)).toBe(false);
    });

    it("the reserved heads include the one stockCountReference writes", () => {
      expect(
        RESERVED_STOCK_REFERENCE_PREFIXES.some((p) => stockCountReference("x").startsWith(p)),
      ).toBe(true);
    });
  });

  describe("assertStockReferenceFree", () => {
    it("throws the coded 400 STOCK_REFERENCE_RESERVED for a reserved reference", () => {
      let caught: unknown;
      try {
        assertStockReferenceFree(stockCountReference(SID));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).getStatus()).toBe(400);
      expect((caught as BadRequestException).getResponse()).toMatchObject({
        code: API_ERROR_CODES.STOCK_REFERENCE_RESERVED,
      });
    });

    it("passes an ordinary, an empty and an absent reference", () => {
      expect(() => assertStockReferenceFree("RECOUNT-1")).not.toThrow();
      expect(() => assertStockReferenceFree(undefined)).not.toThrow();
      expect(() => assertStockReferenceFree(null)).not.toThrow();
    });
  });

  describe("the two inventory DTOs", () => {
    const adjustment = (reference?: unknown) =>
      plainToInstance(RecordAdjustmentDto, { productId: "p1", quantity: 1, reference });
    const purchase = (reference?: unknown) =>
      plainToInstance(RecordPurchaseDto, { productId: "p1", quantity: 1, unitCost: 2, reference });

    it.each([
      ["RecordAdjustmentDto", adjustment],
      ["RecordPurchaseDto", purchase],
    ])(
      "%s refuses a reserved reference on `reference` and accepts an ordinary one",
      async (_n, make) => {
        const bad = await validate(make(stockCountReference(SID)) as object);
        expect(bad.map((e) => e.property)).toEqual(["reference"]);
        expect(Object.keys(bad[0].constraints ?? {})).toEqual(["isNotReservedStockReference"]);

        expect(await validate(make("RECOUNT-1") as object)).toHaveLength(0);
        expect(await validate(make(undefined) as object)).toHaveLength(0);
      },
    );
  });

  describe("pin: every free-text `reference` field of an inventory DTO carries the validator", () => {
    const DTO_DIR = join(__dirname, "dto");
    const FIELD = /(?:^|\n)((?:[ \t]*@[^\n]*\n)*)[ \t]*reference\??\s*:\s*string\b/g;

    /** Names of the `reference` fields in `src` that lack @IsNotReservedStockReference. */
    function unguarded(src: string): number {
      let bad = 0;
      for (const m of src.matchAll(FIELD)) {
        if (!/@IsNotReservedStockReference\(/.test(m[1])) bad += 1;
      }
      return bad;
    }

    it("detector self-test", () => {
      const ok =
        "  @IsOptional()\n  @IsString()\n  @IsNotReservedStockReference()\n  reference?: string;\n";
      const bare = "  @IsOptional()\n  @IsString()\n  reference?: string;\n";
      expect(unguarded(ok)).toBe(0);
      expect(unguarded(bare)).toBe(1);
      expect(unguarded("  referenceNo?: string;\n")).toBe(0);
    });

    it("no inventory DTO declares an unguarded `reference: string`", () => {
      const offenders = readdirSync(DTO_DIR)
        .filter((f) => /\.dto\.ts$/.test(f))
        .filter((f) => unguarded(readFileSync(join(DTO_DIR, f), "utf8")) > 0);
      expect(offenders).toEqual([]);
    });

    it("the two known reference fields are found by the scan", () => {
      for (const f of ["record-adjustment.dto.ts", "record-purchase.dto.ts"]) {
        const src = readFileSync(join(DTO_DIR, f), "utf8");
        expect(src.match(FIELD)).toHaveLength(1);
        expect(unguarded(src)).toBe(0);
      }
    });
  });

  describe("the service entry points", () => {
    let w: CountUnitWorld;
    beforeEach(async () => {
      w = await buildCountUnitWorld(mockWithAdvisoryLock);
      w.seed([pid(1)], 100);
    });

    it("recordAdjustment and recordPurchase refuse a reserved reference before any write", async () => {
      const reference = stockCountReference(SID);
      await expect(
        w.service.recordAdjustment({ productId: pid(1), quantity: 1, reference } as any, "u-1"),
      ).rejects.toMatchObject({ response: { code: "STOCK_REFERENCE_RESERVED" } });
      await expect(
        w.service.recordPurchase(
          { productId: pid(1), quantity: 1, unitCost: 2, reference } as any,
          "u-1",
        ),
      ).rejects.toMatchObject({ response: { code: "STOCK_REFERENCE_RESERVED" } });
      expect(w.prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(w.prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("the legacy one-shot commit refuses a sessionId that names a durable session, before its transaction", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue({ id: SID });

      await expect(
        w.service.commitStockCount(
          { sessionId: SID, items: [{ productId: pid(1), quantity: 5, mode: "REPLACE" }] } as any,
          "u-1",
        ),
      ).rejects.toMatchObject({ response: { code: "STOCK_COUNT_ID_TAKEN" }, status: 409 });
      expect(w.prisma.stockCountSession.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SID } }),
      );
      expect(w.prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(w.prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("the legacy one-shot commit with a client-only id still runs", async () => {
      w.prisma.stockCountSession.findUnique.mockResolvedValue(null);

      const res: any = await w.service.commitStockCount(
        { sessionId: SID, items: [{ productId: pid(1), quantity: 5, mode: "REPLACE" }] } as any,
        "u-1",
      );

      expect(res.reference).toBe(stockCountReference(SID));
      expect(res.applied).toBe(1);
    });
  });
});
