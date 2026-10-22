import { readFileSync } from "node:fs";
import path from "node:path";

/** Row 697 pin: both app shells mount the ONE wheel guard, so every number input app-wide is covered. */
const root = path.resolve(__dirname, "..");
describe("NumberWheelGuard is mounted in the app shells", () => {
  it.each(["app/(dashboard)/layout.tsx", "app/buyer/layout.tsx"])("%s", (rel) => {
    const src = readFileSync(path.join(root, rel), "utf8");
    expect(src).toMatch(/import \{ NumberWheelGuard \} from "@\/components\/NumberWheelGuard"/);
    expect(src).toMatch(/<NumberWheelGuard \/>/);
  });
});
