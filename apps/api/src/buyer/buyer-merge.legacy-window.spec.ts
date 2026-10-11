import { NotFoundException } from "@nestjs/common";
import { BuyerMergeController } from "./buyer-merge.controller";
import {
  LEGACY_MERGE_LINK_ACCEPT_UNTIL,
  legacyMergeLinkAccepted,
} from "../auth/legacy-link-windows";

/**
 * GET /buyer/auth/verify-merge/:token (token in the path) works only until its hard date; after it
 * the answer is the same as for an unknown token and the service is never asked. The POST form is
 * not subject to the window.
 */
describe("legacy buyer-merge link window", () => {
  const verifyMergeToken = jest.fn();
  const controller = new BuyerMergeController({ verifyMergeToken } as any);

  beforeEach(() => {
    verifyMergeToken.mockReset().mockResolvedValue({ success: true });
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("the cut-off is 2026-10-15T00:00:00Z and the helper is exclusive at the boundary", () => {
    expect(LEGACY_MERGE_LINK_ACCEPT_UNTIL.toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(legacyMergeLinkAccepted(new Date(LEGACY_MERGE_LINK_ACCEPT_UNTIL.getTime() - 1))).toBe(
      true,
    );
    expect(legacyMergeLinkAccepted(LEGACY_MERGE_LINK_ACCEPT_UNTIL)).toBe(false);
  });

  it("is served one millisecond before the cut-off", async () => {
    jest.setSystemTime(new Date(LEGACY_MERGE_LINK_ACCEPT_UNTIL.getTime() - 1));

    await expect(controller.verifyMerge("tok")).resolves.toEqual({ success: true });
    expect(verifyMergeToken).toHaveBeenCalledWith("tok");
  });

  it.each([
    ["at the cut-off", LEGACY_MERGE_LINK_ACCEPT_UNTIL.getTime()],
    ["a day after", LEGACY_MERGE_LINK_ACCEPT_UNTIL.getTime() + 86_400_000],
  ])("%s it answers the generic not-found and never reaches the service", async (_n, at) => {
    jest.setSystemTime(new Date(at));

    expect(() => controller.verifyMerge("tok")).toThrow(NotFoundException);
    expect(() => controller.verifyMerge("tok")).toThrow("Invalid verification token");
    expect(verifyMergeToken).not.toHaveBeenCalled();
  });

  it("the POST form is not subject to the window", async () => {
    jest.setSystemTime(new Date(LEGACY_MERGE_LINK_ACCEPT_UNTIL.getTime() + 86_400_000));

    await expect(controller.verifyMergeByBody({ token: "tok" } as any)).resolves.toEqual({
      success: true,
    });
  });
});
