import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateProductDto } from "./update-product.dto";

describe("UpdateProductDto.packReading (SA-946 MUST 4)", () => {
  const check = (packReading: unknown) =>
    validate(plainToInstance(UpdateProductDto, { unitsPerBox: 10, packReading }));

  it("accepts box and piece, and an absent key", async () => {
    expect(await check("box")).toEqual([]);
    expect(await check("piece")).toEqual([]);
    expect(await validate(plainToInstance(UpdateProductDto, { unitsPerBox: 10 }))).toEqual([]);
  });

  it("refuses any other answer", async () => {
    for (const bad of ["case", "BOX", "", 1]) {
      const errors = await check(bad);
      expect({ bad, props: errors.map((e) => e.property) }).toEqual({
        bad,
        props: ["packReading"],
      });
    }
  });
});
