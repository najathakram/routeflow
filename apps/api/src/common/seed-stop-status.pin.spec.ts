import { readFileSync } from "fs";
import { join } from "path";

/**
 * UX guide B22: a seeded RouteRunStop that carries `completedAt` must also carry status COMPLETED, otherwise the run
 * page reads "Completed 8:15 AM" under a stop that the header counts as not done.
 */
describe("seed.ts: a stop with a completed time has a COMPLETED status (UX guide B22)", () => {
  const src = readFileSync(join(__dirname, "../../prisma/seed.ts"), "utf8");
  const blocks = [...src.matchAll(/prisma\.routeRunStop\.upsert\(\{[\s\S]*?\n    \}\),/g)].map(
    (m) => m[0],
  );

  it("finds the seeded run stops", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it.each(blocks.map((b) => [/id: "(seed-rrs-[^"]+)"/.exec(b)?.[1] ?? "?", b]))(
    "%s: completedAt implies status COMPLETED",
    (_id, block) => {
      if (/completedAt:/.test(block)) expect(block).toMatch(/status: "COMPLETED"/);
    },
  );
});
