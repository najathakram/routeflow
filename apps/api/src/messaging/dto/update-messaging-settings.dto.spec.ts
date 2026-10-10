import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateMessagingSettingsDto } from "./update-messaging-settings.dto";

/** SA-738 ride-along: the quiet-hours zone is validated as IANA; "" and null still clear it. */
describe("UpdateMessagingSettingsDto.timezone", () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(UpdateMessagingSettingsDto, body))).map((e) => e.property);

  it("accepts a real IANA zone", async () => {
    expect(await errorsFor({ timezone: "America/Chicago" })).toEqual([]);
  });

  it('still accepts "" (the clear)', async () => {
    expect(await errorsFor({ timezone: "" })).toEqual([]);
  });

  it("still accepts null (it cleared before this change and must keep clearing)", async () => {
    expect(await errorsFor({ timezone: null })).toEqual([]);
  });

  it("accepts a body without timezone", async () => {
    expect(await errorsFor({ quietHoursEnabled: true })).toEqual([]);
  });

  it.each(["Mars/Phobos", "+01:00", "EST", "Etc/GMT+5", 42])("refuses %p", async (bad) => {
    expect(await errorsFor({ timezone: bad })).toContain("timezone");
  });
});
