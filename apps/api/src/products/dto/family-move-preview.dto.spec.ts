import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { FamilyMovePreviewDto } from "./family-move-preview.dto";

const PRICES = ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

const read = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(FamilyMovePreviewDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors: errors.map((e) => e.property) };
};

describe("FamilyMovePreviewDto (SA-1082 A-1, A-4)", () => {
  it.each(PRICES)("%s: blank is absent, as it is on the save it previews", async (price) => {
    // Null is what a list Undo holds for a price its row didn't carry (products/page.tsx: `?? null`).
    for (const blank of [undefined, null, "", "  "]) {
      const { dto, errors } = await read({ [price]: blank });
      expect(errors).toEqual([]);
      expect(dto[price]).toBeUndefined();
    }
  });

  it.each(PRICES)(
    "%s: a price still reads as a decimal, and anything else is refused",
    async (price) => {
      const { dto, errors } = await read({ [price]: 12.5 });
      expect(errors).toEqual([]);
      expect(dto[price]).toBe("12.5");
      expect((await read({ [price]: "abc" })).errors).toEqual([price]);
    },
  );
});
