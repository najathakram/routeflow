import { readFileSync } from "node:fs";
import { join } from "node:path";

/** W2a (L-072): the panel's column-alias type is the shared one from @routeflow/types, never a local copy. */
describe("ImportCsvPanel column alias type", () => {
  const src = readFileSync(join(__dirname, "ImportCsvPanel.tsx"), "utf8");

  it("declares no local ImportColumnAlias and imports the shared one", () => {
    expect(src).not.toMatch(/(interface|type) ImportColumnAlias\b/);
    expect(src).toMatch(/import type \{ ImportColumnAlias \} from "@routeflow\/types"/);
  });
});
