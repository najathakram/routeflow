import { spawnSync } from "node:child_process";
import path from "node:path";
import { Prisma } from "@prisma/client";

/**
 * SA-816 (d)1: apps/api/scripts/generate-not-nan-checks.mjs reads the schema folder as TEXT; the pin
 * (numeric-not-nan-check.spec.ts) reads the generated client. This proves the two agree on the column set, so the
 * generator can never silently miss a Decimal column (a parser gap would show here as a count / name mismatch).
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/generate-not-nan-checks.mjs");
const run = (args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("generate-not-nan-checks.mjs (SA-816 (d)1)", () => {
  it("--self-test passes", () => {
    const r = run(["--self-test"]);
    expect(r.stdout.trim()).toBe("self-test ok");
    expect(r.status).toBe(0);
  });

  it("--list names exactly the generated client's Decimal columns", () => {
    const r = run(["--list"]);
    expect(r.status).toBe(0);
    const listed = r.stdout.split("\n").filter(Boolean).sort();
    const fromClient = Prisma.dmmf.datamodel.models
      .flatMap((m) =>
        m.fields
          .filter((f) => f.kind === "scalar" && f.type === "Decimal" && !f.isList)
          .map((f) => `${m.dbName ?? m.name}.${f.dbName ?? f.name}`),
      )
      .sort();
    expect(listed).toEqual(fromClient);
  });
});
