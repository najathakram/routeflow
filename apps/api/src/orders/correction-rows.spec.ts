import { OFFICE_CORRECTION, isCorrectionRow } from "./correction-rows";
import { deliveredSoFarFindManyArgs } from "../routes/delivered-so-far";

describe("isCorrectionRow (SA-1506 R-241 M-2)", () => {
  it("an office row with the reserved note is a correction", () => {
    expect(isCorrectionRow({ note: OFFICE_CORRECTION, driverId: null })).toBe(true);
  });

  it("a driver evidence row is not a correction, even with the reserved note", () => {
    expect(isCorrectionRow({ note: OFFICE_CORRECTION, driverId: "driver-1" })).toBe(false);
    expect(isCorrectionRow({ note: null, driverId: "driver-1" })).toBe(false);
  });

  it("an unselected driverId (undefined) is not a correction: undefined == null must never count a row", () => {
    expect(isCorrectionRow({ note: OFFICE_CORRECTION })).toBe(false);
    expect(isCorrectionRow({ note: OFFICE_CORRECTION, driverId: undefined })).toBe(false);
  });

  it("an ordinary office row (another note) is not a correction", () => {
    expect(isCorrectionRow({ note: "OFFICE_MARKED", driverId: null })).toBe(false);
    expect(isCorrectionRow({ note: null, driverId: null })).toBe(false);
  });

  it("the shared evidence read selects driverId, so the predicate can tell a driver's row", () => {
    expect(deliveredSoFarFindManyArgs(["o1"]).select).toMatchObject({ driverId: true });
  });
});
