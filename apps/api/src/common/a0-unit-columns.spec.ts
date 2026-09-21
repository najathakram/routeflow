/**
 * A0 (fleet lead 2026-09-20) — the smallest possible schema change: four additive, NULLABLE columns
 * so template / recurring-invoice / estimate lines can carry a selling unit. Pins that it stays
 * exactly that: no NOT NULL, no DEFAULT, no index, no backfill. It ships to prod BEFORE the PR that
 * adds the columns to the Prisma schema merges (the image runs `prisma generate` at build time and
 * Prisma selects every scalar, so a client ahead of the columns 500s every read of these models).
 */
import * as fs from "fs";
import * as path from "path";

const API = path.join(__dirname, "..", "..");
const sql = fs
  .readFileSync(
    path.join(API, "prisma", "migrations", "20260920210000_a0_unit_columns", "migration.sql"),
    "utf8",
  )
  .split("\n")
  .map((l) => l.replace(/--.*$/, "")) // whole-line AND trailing SQL comments
  .join("\n");
const schemaOf = (file: string) =>
  fs.readFileSync(path.join(API, "prisma", "schema", file), "utf8");
const modelBody = (src: string, name: string) =>
  src.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? "";

describe("A0 unit columns migration", () => {
  it("adds exactly the four nullable columns and nothing else", () => {
    expect(sql).toMatch(/ALTER TABLE "OrderTemplateItem" ADD COLUMN "unitLabel" TEXT;/);
    expect(sql).toMatch(/ALTER TABLE "RecurringInvoiceItem" ADD COLUMN "unitLabel" TEXT;/);
    expect(sql).toMatch(
      /ALTER TABLE "EstimateItem" ADD COLUMN "unitLabel" TEXT,\s*ADD COLUMN "unitsPerBox" INTEGER;/,
    );
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(4);
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(3);
  });

  it("is instant and additive: no NOT NULL, DEFAULT, INDEX, UPDATE, DROP or backfill", () => {
    expect(sql).not.toMatch(
      /NOT NULL|DEFAULT|CREATE\s+(UNIQUE\s+)?INDEX|UPDATE\s|DROP\s|INSERT\s/i,
    );
  });

  it("the Prisma schema declares the same four fields, all optional", () => {
    expect(modelBody(schemaOf("sales.prisma"), "OrderTemplateItem")).toMatch(
      /^\s*unitLabel\s+String\?/m,
    );
    const fin = schemaOf("finance.prisma");
    expect(modelBody(fin, "RecurringInvoiceItem")).toMatch(/^\s*unitLabel\s+String\?/m);
    expect(modelBody(fin, "EstimateItem")).toMatch(/^\s*unitLabel\s+String\?/m);
    expect(modelBody(fin, "EstimateItem")).toMatch(/^\s*unitsPerBox\s+Int\?/m);
  });
});
