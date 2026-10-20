import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ADJUSTMENT_REASON_VALUES } from "@routeflow/types";
import { RecordAdjustmentDto } from "./record-adjustment.dto";

/**
 * SA-804(3): a manual stock adjustment carries a REASON (a required enum) and a note; the note is
 * required (3-200 characters) when the reason is OTHER. Validated exactly as the global pipe does.
 */
const check = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(RecordAdjustmentDto, { productId: "prod-1", quantity: -2, ...body });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, props: errors.map((e) => e.property) };
};

describe("RecordAdjustmentDto reasons (SA-804(3))", () => {
  it("an adjustment with no reason is refused", async () => {
    expect((await check({})).props).toContain("reason");
  });

  it("an unknown reason is refused", async () => {
    expect((await check({ reason: "BECAUSE" })).props).toContain("reason");
  });

  it.each([...ADJUSTMENT_REASON_VALUES].filter((r) => r !== "OTHER"))(
    "%s passes without a note",
    async (reason) => {
      expect((await check({ reason })).props).toEqual([]);
    },
  );

  it("OTHER without a note is refused", async () => {
    expect((await check({ reason: "OTHER" })).props).toContain("reasonNote");
  });

  it("OTHER with a note under 3 characters (after trimming) is refused", async () => {
    expect((await check({ reason: "OTHER", reasonNote: "  ab  " })).props).toContain("reasonNote");
  });

  it("OTHER with a 3-character note passes, and the note is stored trimmed", async () => {
    const { dto, props } = await check({ reason: "OTHER", reasonNote: "  abc  " });
    expect(props).toEqual([]);
    expect(dto.reasonNote).toBe("abc");
  });

  it("a note over 200 characters is refused for any reason", async () => {
    const long = "x".repeat(201);
    expect((await check({ reason: "DAMAGED", reasonNote: long })).props).toContain("reasonNote");
    expect((await check({ reason: "OTHER", reasonNote: long })).props).toContain("reasonNote");
    expect((await check({ reason: "OTHER", reasonNote: "x".repeat(200) })).props).toEqual([]);
  });
});
