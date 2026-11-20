import { ForbiddenException } from "@nestjs/common";
import { PRODUCT_COLUMNS, resolveColumns } from "./import-columns";
import {
  IMPORT_GATE_REQUIREMENT,
  skipDeniedGatedColumns,
  SKIPPED_COLUMN_MAX,
} from "./import-gated-columns";

const denial = (e: unknown) => e instanceof ForbiddenException;
const allow = () => Promise.resolve();
const deny = () => Promise.reject(new ForbiddenException("denied"));

describe("skipDeniedGatedColumns (SA-1193 K1)", () => {
  it("every gated field in the registry maps to a requirement (a new gate cannot ship unnamed)", () => {
    const gates = new Set(PRODUCT_COLUMNS.map((c) => c.gate).filter(Boolean));
    for (const g of gates)
      expect(IMPORT_GATE_REQUIREMENT[g as keyof typeof IMPORT_GATE_REQUIREMENT]).toBeDefined();
  });

  it("asks only the gates whose columns are present, and returns the resolution unchanged when all allow", async () => {
    const headers = ["Item Name", "MSRP"];
    const resolved = resolveColumns(headers, PRODUCT_COLUMNS);
    const asks = { msrp: jest.fn(allow), tobacco: jest.fn(allow), forecasting: jest.fn(allow) };
    const out = await skipDeniedGatedColumns(headers, resolved, PRODUCT_COLUMNS, asks, denial);
    expect(out.resolved).toBe(resolved);
    expect(out.skippedColumns).toEqual([]);
    expect(asks.msrp).toHaveBeenCalledTimes(1);
    expect(asks.tobacco).not.toHaveBeenCalled();
    expect(asks.forecasting).not.toHaveBeenCalled();
  });

  it("drops a denied field from a COPY of byField; the input resolution is not mutated", async () => {
    const headers = ["Item Name", "Reorder Point", "Reorder Qty"];
    const resolved = resolveColumns(headers, PRODUCT_COLUMNS);
    const out = await skipDeniedGatedColumns(
      headers,
      resolved,
      PRODUCT_COLUMNS,
      { msrp: allow, tobacco: allow, forecasting: deny },
      denial,
    );
    expect(out.resolved.byField).not.toHaveProperty("reorderPoint");
    expect(out.resolved.byField).not.toHaveProperty("reorderQty");
    expect(resolved.byField).toHaveProperty("reorderPoint", "Reorder Point");
  });

  it(`caps a skipped header at ${SKIPPED_COLUMN_MAX} characters (the user's own text, data only)`, async () => {
    const long = `MSRP${" ".repeat(400)}`; // normalizes to "msrp"
    const headers = ["Item Name", long];
    const out = await skipDeniedGatedColumns(
      headers,
      resolveColumns(headers, PRODUCT_COLUMNS),
      PRODUCT_COLUMNS,
      { msrp: deny, tobacco: allow, forecasting: allow },
      denial,
    );
    expect(out.skippedColumns).toHaveLength(1);
    expect(out.skippedColumns[0].column).toHaveLength(SKIPPED_COLUMN_MAX);
  });
});
