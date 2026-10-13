import { US_STATES, ZIP3_STATE_SUGGESTIONS, suggestStateFromZip } from "@routeflow/types";
import { zip3States } from "./us-zip3";

/**
 * The shared ZIP-prefix -> state SUGGESTION (packages/types/api/zip-state.ts, Addendum D). It only
 * pre-fills a picker a person confirms; these pins keep it honest against the USPS allocation and
 * against the write-boundary resolver's own ZIP3 table.
 */
describe("suggestStateFromZip (shared, packages/types)", () => {
  // One or more ZIPs per state boundary, chosen at the edges of each state's prefix range.
  const SPOT: Array<[string, string]> = [
    ["75201", "TX"],
    ["10001", "NY"],
    ["90012", "CA"],
    ["33101", "FL"],
    ["60606", "IL"],
    ["98101", "WA"],
    ["20001", "DC"],
    ["20500", "DC"],
    ["20599", "DC"],
    ["20166", "VA"], // 201 is Dulles / Northern Virginia, not DC
    ["20601", "MD"],
    ["21999", "MD"],
    ["22001", "VA"],
    ["24699", "VA"],
    ["24701", "WV"],
    ["26886", "WV"],
    ["96701", "HI"],
    ["96898", "HI"],
    ["99501", "AK"],
    ["99950", "AK"],
    ["05001", "VT"],
    ["05401", "VT"],
    ["05901", "VT"],
    ["01001", "MA"],
    ["02790", "MA"],
    ["02801", "RI"],
    ["02940", "RI"],
    ["03031", "NH"],
    ["03899", "NH"],
    ["03901", "ME"],
    ["04992", "ME"],
    ["06001", "CT"],
    ["06928", "CT"],
    ["07001", "NJ"],
    ["08999", "NJ"],
    ["15001", "PA"],
    ["19699", "PA"],
    ["19701", "DE"],
    ["19980", "DE"],
    ["27006", "NC"],
    ["28909", "NC"],
    ["29001", "SC"],
    ["29945", "SC"],
    ["30002", "GA"],
    ["31999", "GA"],
    ["39813", "GA"],
    ["32003", "FL"],
    ["34997", "FL"],
    ["35004", "AL"],
    ["36925", "AL"],
    ["37010", "TN"],
    ["38589", "TN"],
    ["38601", "MS"],
    ["39776", "MS"],
    ["40003", "KY"],
    ["42788", "KY"],
    ["43001", "OH"],
    ["45899", "OH"],
    ["46001", "IN"],
    ["47997", "IN"],
    ["48001", "MI"],
    ["49971", "MI"],
    ["50001", "IA"],
    ["52809", "IA"],
    ["53001", "WI"],
    ["54990", "WI"],
    ["55001", "MN"],
    ["56763", "MN"],
    ["57001", "SD"],
    ["57799", "SD"],
    ["58001", "ND"],
    ["58856", "ND"],
    ["59001", "MT"],
    ["59937", "MT"],
    ["60001", "IL"],
    ["62999", "IL"],
    ["63001", "MO"],
    ["65899", "MO"],
    ["66002", "KS"],
    ["67954", "KS"],
    ["68001", "NE"],
    ["69367", "NE"],
    ["70001", "LA"],
    ["71497", "LA"],
    ["71601", "AR"],
    ["72959", "AR"],
    ["73001", "OK"],
    ["74966", "OK"],
    ["73301", "TX"], // the Austin TX IRS prefix inside Oklahoma's range
    ["79999", "TX"],
    ["88510", "TX"], // El Paso's second prefix, inside New Mexico's neighbourhood
    ["80001", "CO"],
    ["81658", "CO"],
    ["82001", "WY"],
    ["83128", "WY"],
    ["83201", "ID"],
    ["83877", "ID"],
    ["84001", "UT"],
    ["84791", "UT"],
    ["85001", "AZ"],
    ["86556", "AZ"],
    ["87001", "NM"],
    ["88439", "NM"],
    ["88901", "NV"],
    ["89883", "NV"],
    ["90001", "CA"],
    ["96162", "CA"],
    ["97001", "OR"],
    ["97920", "OR"],
    ["99001", "WA"],
    ["99403", "WA"],
    ["00601", "PR"],
    ["00802", "VI"],
    ["96910", "GU"],
  ];

  it.each(SPOT)("%s -> %s", (zip, state) => {
    expect(suggestStateFromZip(zip)).toBe(state);
  });

  it("accepts ZIP+4 (hyphen, space or none) and surrounding whitespace", () => {
    expect(suggestStateFromZip("75201-1234")).toBe("TX");
    expect(suggestStateFromZip(" 75201 ")).toBe("TX");
    expect(suggestStateFromZip("75201 1234")).toBe("TX");
    expect(suggestStateFromZip("752011234")).toBe("TX");
    expect(suggestStateFromZip("\t10001-0001\n")).toBe("NY");
  });

  it("rejects anything that is not a 5-digit ZIP: null, never a guess", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "7520",
      "752",
      "75",
      "7520A",
      "TX 75201",
      "75201-12",
      "75201-12345",
      "7 5201",
      "abcde",
      "75201x",
      "١٢٣٤٥", // non-ASCII digits are not ZIP digits
    ]) {
      expect(suggestStateFromZip(bad as string | null | undefined)).toBeNull();
    }
  });

  it("military, agency and unassigned prefixes have no suggestion", () => {
    for (const zip of [
      "09001", // APO/FPO Europe
      "09999",
      "34001", // APO/FPO Americas
      "96201", // APO/FPO Pacific
      "96601",
      "45901", // agency-only
      "56901", // agency-only
      "00001", // unassigned
      "00499",
      "71501", // 715 unassigned
      "88601", // 886-888 unassigned
    ]) {
      expect(suggestStateFromZip(zip)).toBeNull();
    }
    // neighbours of the gaps are assigned
    expect(suggestStateFromZip("45801")).toBe("OH");
    expect(suggestStateFromZip("39901")).toBe("GA");
    expect(suggestStateFromZip("71601")).toBe("AR");
  });

  it("every suggestion is a state the shared US_STATES list carries", () => {
    const codes = new Set(US_STATES.map((s) => s.code));
    for (const [, , state] of ZIP3_STATE_SUGGESTIONS) expect(codes.has(state)).toBe(true);
  });

  it("the ranges ascend and never overlap", () => {
    let last = -1;
    for (const [low, high] of ZIP3_STATE_SUGGESTIONS) {
      expect(Number(low)).toBeGreaterThan(last);
      expect(Number(high)).toBeGreaterThanOrEqual(Number(low));
      last = Number(high);
    }
  });

  it("agrees with the write-boundary ZIP3 table for all 1000 prefixes: one of its states, and null exactly where it has none", () => {
    const disagreements: string[] = [];
    for (let n = 0; n < 1000; n++) {
      const zip = `${String(n).padStart(3, "0")}01`;
      const allowed = zip3States(zip);
      const suggested = suggestStateFromZip(zip);
      if (allowed === null ? suggested !== null : !allowed.includes(suggested ?? "")) {
        disagreements.push(`${zip}: suggested ${suggested}, table ${JSON.stringify(allowed)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
