import {
  ZIP3_STATE_SUGGESTIONS as SHARED_TABLE,
  suggestStateFromZip as sharedSuggest,
} from "@routeflow/types";
import { ZIP3_STATE_SUGGESTIONS, suggestStateFromZip } from "./zip-state";

/** The API copy of the ZIP-prefix suggestion must stay identical to the shared source. */
describe("zip-state API mirror parity", () => {
  it("has the same prefix table, in the same order", () => {
    expect(ZIP3_STATE_SUGGESTIONS.length).toBeGreaterThan(50);
    expect(ZIP3_STATE_SUGGESTIONS).toEqual(SHARED_TABLE);
  });

  it("suggests exactly like the shared source for every prefix and the malformed inputs", () => {
    const inputs: Array<string | null | undefined> = [null, undefined, "", " ", "7520", "abcde"];
    for (let n = 0; n < 1000; n++) {
      const p = String(n).padStart(3, "0");
      inputs.push(`${p}01`, ` ${p}99-1234 `, `${p}0`, `${p}01x`);
    }
    for (const input of inputs) expect(suggestStateFromZip(input)).toBe(sharedSuggest(input));
  });
});
