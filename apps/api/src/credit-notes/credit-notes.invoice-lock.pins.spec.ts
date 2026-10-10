import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-628 lock revert probe (SA-214 lock order): create() takes `SELECT id FROM "Invoice" ... FOR UPDATE` as the FIRST statement
 * of its tx, before validateAndBuildCnItems re-reads the per-line headroom, so a credit note and a return refund on one
 * invoice serialise on that row. Dropping it, or moving it after the validation, turns this red. The race itself is
 * credit-return-line-cap.db.spec.ts case 8.
 */
const src = readFileSync(join(__dirname, "credit-notes.service.ts"), "utf8");

describe("CreditNotesService.create: the invoice row lock precedes the in-tx headroom re-read", () => {
  it("FOR UPDATE on the Invoice row comes before the in-tx validateAndBuildCnItems(tx, dto, …)", () => {
    const create = src.slice(src.search(/\n  async create\(/));
    const lock = create.indexOf(
      'SELECT id FROM "Invoice" WHERE id = ${dto.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE',
    );
    const recheck = create.indexOf("await this.validateAndBuildCnItems(tx, dto");
    expect(lock).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(recheck);
  });
  it("the cap reads the credited-so-far from the ONE shared helper (no second per-line formula)", () => {
    expect(src).toMatch(/loadLineCredits\(/);
    expect(src).not.toMatch(/priorLineItems/);
  });
});
