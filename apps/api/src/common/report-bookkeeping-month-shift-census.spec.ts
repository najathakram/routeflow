/**
 * SA-1057 F-1 / W-728: the month-shift census must read each event column as a true instant on ANY machine.
 * `createdAt`, `refundedAt` and `writtenOffAt` are TIMESTAMP(3) without a zone, and `pg` parses that type (OID 1114) in the
 * Node process's own zone. On a Central-time PC a stored 2026-11-01 04:30 became 09:30, so a $900 move that should STOP read as
 * no move at all. `AT TIME ZONE 'UTC'` makes Postgres return a timestamptz, which parses the same everywhere.
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(
  join(__dirname, "..", "..", "scripts", "report-bookkeeping-month-shift-census.mjs"),
  "utf8",
);

describe("report-bookkeeping-month-shift-census reads event columns as UTC instants (SA-1057 F-1)", () => {
  it.each(["createdAt", "refundedAt", "writtenOffAt"])(
    "the %s SELECT converts the column with AT TIME ZONE 'UTC'",
    (col) => {
      expect(src).toContain(`"${col}" AT TIME ZONE 'UTC' AS at`);
    },
  );

  it("no event SELECT reads a bare timestamp column as `AS at`", () => {
    expect(src).not.toMatch(/"(createdAt|refundedAt|writtenOffAt)" AS at/);
  });
});
