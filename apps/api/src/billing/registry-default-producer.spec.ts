/**
 * SA-1028 section 5, P-G5 (structural, OP-7) - ONE producer of a "no stored row" mode state.
 *
 * A tenant's mode state is the stored row, else the registry default. `FeatureConfigStore.getMode` is the
 * only place that decides "no row", so it is the only non-test file that may PRODUCE `source:
 * "REGISTRY_DEFAULT"`. A second producer is how the Feature Console preview came to show the registry
 * default as the "before" of a tenant that had a stored mode (the undo read "no difference"). Every other
 * reader goes through `FeatureConfigService.getState` / `FeatureConfigStore.getMode`.
 *
 * The type unions that merely NAME the literal (`source: "TENANT" | "REGISTRY_DEFAULT"`) do not match: the
 * pattern is a produced property, `source: "REGISTRY_DEFAULT"`.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const PRODUCER = /\bsource\s*:\s*"REGISTRY_DEFAULT"/;
const ONLY_PRODUCER = "billing/feature-config.store.ts";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('P-G5: "REGISTRY_DEFAULT" is produced in exactly one API file', () => {
  it("only feature-config.store.ts builds a state with source REGISTRY_DEFAULT", () => {
    const producers = sourceFiles(SRC_ROOT)
      .filter((file) => PRODUCER.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join("/"));

    expect(producers).toEqual([ONLY_PRODUCER]);
  });
});
