import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateProductDto } from "./update-product.dto";

/**
 * M2: the update DTO's \`parentProductId\` was \`emptyToUndefined\`, so a form that cleared the parent select sent "" and
 * update() saw "unchanged"; the "promote a variant to standalone" branch (\`parentProductId === null\`) was unreachable.
 */
describe("UpdateProductDto.parentProductId (M2: emptyToNull)", () => {
  const dto = (v: unknown) => plainToInstance(UpdateProductDto, { parentProductId: v });
  it('"" and null both mean UNLINK (null), never "unchanged" and never an invalid uuid', async () => {
    for (const v of ["", "   ", null]) {
      const d = dto(v);
      expect(d.parentProductId).toBeNull();
      expect(await validate(d)).toEqual([]);
    }
  });
  it("a uuid passes; a non-uuid still fails; absent stays absent", async () => {
    const id = "5b3c1d1e-8f6a-4e5b-9a39-0f4f6f1c2a11";
    expect(dto(id).parentProductId).toBe(id);
    expect(await validate(dto(id))).toEqual([]);
    expect((await validate(dto("nope"))).length).toBeGreaterThan(0);
    const absent = plainToInstance(UpdateProductDto, {});
    expect(absent.parentProductId).toBeUndefined();
  });
});
