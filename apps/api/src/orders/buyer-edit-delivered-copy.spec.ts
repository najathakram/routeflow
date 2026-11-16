import { readFileSync } from "fs";
import { join } from "path";

/** SA-1149: the buyer sentence lives once in packages/types; the mobile jest stub holds a byte-identical hand copy. */
describe("BUYER_EDIT_DELIVERED_LINES_COPY", () => {
  it("the mobile stub equals the packages/types constant", () => {
    const src = readFileSync(
      join(__dirname, "../../../../packages/types/api/buyer-order-edit.ts"),
      "utf8",
    );
    const real = /BUYER_EDIT_DELIVERED_LINES_COPY =\s*\n?\s*"([^"]+)"/.exec(src)?.[1];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require("../../../mobile/__tests__/__mocks__/@routeflow/types.js");
    expect(real).toBeTruthy();
    expect(stub.BUYER_EDIT_DELIVERED_LINES_COPY).toBe(real);
  });
});
