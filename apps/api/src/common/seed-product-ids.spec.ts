import { readFileSync } from "fs";
import { join } from "path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const seed = readFileSync(join(__dirname, "../../prisma/seed.ts"), "utf8");

describe("seed product ids (B745)", () => {
  it("every seeded product id is a UUID (the counter DTO requires @IsUUID productId)", () => {
    const start = seed.indexOf("const productDefs = [");
    const end = seed.indexOf("];", start);
    const ids = [...seed.slice(start, end).matchAll(/^\s+id: "([^"]+)"/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(15);
    expect(ids.filter((id) => !UUID.test(id))).toEqual([]);
  });

  it("no stock or order reference still points at a seed-prod-NN id", () => {
    expect(seed.match(/seed-prod-\d+/g) ?? []).toEqual([]);
  });
});
