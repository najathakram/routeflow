import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateMessagingSettingsDto } from "./update-messaging-settings.dto";

/** SA-738 ride-along: the quiet-hours zone is validated as IANA; "" still clears it back to null. */
describe("UpdateMessagingSettingsDto.timezone", () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(UpdateMessagingSettingsDto, body))).map((e) => e.property);

  it("accepts a real IANA zone", async () => {
    expect(await errorsFor({ timezone: "America/Chicago" })).toEqual([]);
  });

  it('still accepts "" (the clear)', async () => {
    expect(await errorsFor({ timezone: "" })).toEqual([]);
  });

  it("accepts a body without timezone", async () => {
    expect(await errorsFor({ quietHoursEnabled: true })).toEqual([]);
  });

  it("refuses Mars/Phobos", async () => {
    expect(await errorsFor({ timezone: "Mars/Phobos" })).toContain("timezone");
  });
});
