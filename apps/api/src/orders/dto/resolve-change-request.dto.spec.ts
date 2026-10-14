import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ChangeRequestResolveAction, ResolveChangeRequestDto } from "./resolve-change-request.dto";

/**
 * Row 510: the office's approve of a restricted change request is a 409 RESTRICTION_WARNING first, then the SAME
 * resolve plus the ack (lineKey `cr:<id>`). The global pipe whitelists and forbids unknown fields, so the DTO must
 * declare the ack or the resubmit would be a 400 (or silently stripped, and the dialog would loop).
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const run = (body: unknown) =>
  pipe.transform(body, { type: "body", metatype: ResolveChangeRequestDto });

describe("ResolveChangeRequestDto carries the restriction acknowledgement", () => {
  it("keeps restrictionOverrides and warningHash through the whitelisting pipe", async () => {
    const out = (await run({
      action: ChangeRequestResolveAction.APPROVE_AT_STOP,
      restrictionOverrides: [{ lineKey: "cr:cr-1", reason: "Licensed buyer" }],
      warningHash: "rw1:abc",
    })) as ResolveChangeRequestDto;
    expect(out.action).toBe("APPROVE_AT_STOP");
    expect(out.restrictionOverrides).toEqual([{ lineKey: "cr:cr-1", reason: "Licensed buyer" }]);
    expect(out.warningHash).toBe("rw1:abc");
  });

  it("accepts the same body for the next-delivery approval and still accepts no ack at all", async () => {
    await expect(
      run({
        action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY,
        restrictionOverrides: [{ lineKey: "cr:cr-1", reason: "Licensed buyer" }],
        warningHash: "rw1:abc",
      }),
    ).resolves.toBeDefined();
    await expect(
      run({ action: ChangeRequestResolveAction.DECLINE, reason: "No" }),
    ).resolves.toBeDefined();
  });

  it("still refuses a field that is not declared", async () => {
    await expect(
      run({ action: ChangeRequestResolveAction.APPROVE_AT_STOP, somethingElse: 1 }),
    ).rejects.toBeDefined();
  });
});
