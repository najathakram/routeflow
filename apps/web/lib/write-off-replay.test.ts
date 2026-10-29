import { API_ERROR_CODES } from "@routeflow/types";
import { isWriteOffReplay } from "./write-off-replay";

const err = (status: number, code?: string) => ({ response: { status, data: { code } } });

describe("isWriteOffReplay (SA-1050: an already written-off invoice is done)", () => {
  it("is true for 409 INVOICE_ALREADY_WRITTEN_OFF", () => {
    expect(isWriteOffReplay(err(409, API_ERROR_CODES.INVOICE_ALREADY_WRITTEN_OFF))).toBe(true);
  });

  it("is false for the other write-off refusal (nothing due), another 409, and a 400", () => {
    expect(isWriteOffReplay(err(409, API_ERROR_CODES.WRITE_OFF_NOTHING_DUE))).toBe(false);
    expect(isWriteOffReplay(err(409))).toBe(false);
    expect(isWriteOffReplay(err(400, API_ERROR_CODES.INVOICE_ALREADY_WRITTEN_OFF))).toBe(false);
  });

  it("is false for a network error with no response, null and undefined", () => {
    expect(isWriteOffReplay(new Error("Network Error"))).toBe(false);
    expect(isWriteOffReplay(null)).toBe(false);
    expect(isWriteOffReplay(undefined)).toBe(false);
  });
});
