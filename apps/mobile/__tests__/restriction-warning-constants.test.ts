/**
 * Row 510: the mobile jest run stubs the @routeflow/types package root with hand copies of its runtime values
 * (see __tests__/__mocks__/@routeflow/types.js). The four restriction constants the pure helper reads must equal the
 * REAL source, or a test could pass on a stale copy while the app ships another number.
 */
import * as fs from "fs";
import * as path from "path";

const stub = require("./__mocks__/@routeflow/types.js");
const real = fs.readFileSync(
  path.resolve(__dirname, "../../../packages/types/api/restrictions.ts"),
  "utf8",
);
const constOf = (name: string): string => {
  const m = real.match(new RegExp(`export const ${name} =\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in packages/types/api/restrictions.ts`);
  return m[1].trim();
};

describe("mobile @routeflow/types stub: restriction constants equal the real source", () => {
  it.each([
    "RESTRICTION_OVERRIDE_REASON_MIN",
    "RESTRICTION_OVERRIDE_REASON_MAX",
    "DRIVER_RESTRICTION_BLOCK_MESSAGE",
    "RESTRICTION_OVERRIDE_LABEL",
  ])("%s", (name) => {
    expect(JSON.stringify(stub[name])).toBe(constOf(name));
  });
});
