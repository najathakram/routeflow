import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PickupCompleteDto } from "./pickup-complete.dto";

/** The body edge of POST /orders/:id/pickup-complete (the transform + whitelist the app's global pipe applies). */
const check = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(PickupCompleteDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, fields: errors.map((e) => e.property) };
};

describe("PickupCompleteDto.registerKey (SA-750r3)", () => {
  it("is optional: absent or blank passes and reads as absent (the service defaults it to 'main')", async () => {
    expect((await check({})).dto.registerKey).toBeUndefined();
    const blank = await check({ registerKey: "  " });
    expect(blank.fields).toEqual([]);
    expect(blank.dto.registerKey).toBeUndefined();
  });

  it("accepts the shared pattern and keeps the case as sent", async () => {
    for (const registerKey of ["b", "Till-B", "front_desk", "a:1", "0".repeat(64)]) {
      const r = await check({ registerKey });
      expect(r.fields).toEqual([]);
      expect(r.dto.registerKey).toBe(registerKey);
    }
  });

  it("refuses a key outside REGISTER_KEY_PATTERN (400 at the edge)", async () => {
    for (const registerKey of ["a b", ":lead", "x".repeat(65), "a/b", "é", 7, {}]) {
      expect((await check({ registerKey })).fields).toEqual(["registerKey"]);
    }
  });
});
