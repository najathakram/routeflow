import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1073 PR-2: two copies of Radix's layer froze the page after a dialog opened from a menu. These three hold state
 * outside React, so a second lock entry for any of them brings that back. This is what stops a Dependabot group doing it.
 */
const lock = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "package-lock.json"), "utf8"),
) as { packages: Record<string, unknown> };

describe("one copy of Radix's stateful packages (SA-1073)", () => {
  it.each(["react-dismissable-layer", "react-focus-scope", "react-focus-guards"])(
    "%s has one lock entry, at the root",
    (name) => {
      const path = `node_modules/@radix-ui/${name}`;
      expect(Object.keys(lock.packages).filter((k) => k.endsWith(path))).toEqual([path]);
    },
  );
});
