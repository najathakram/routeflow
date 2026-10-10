import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SetConfigSnapshotFlagDto } from "./set-config-snapshot-flag.dto";

// entitlements.configSnapshot is one of the four production flags an agent never flips — the
// owner is the only caller of PUT. `reason` is required (unlike the neighbouring
// entitlements/mode switch's optional reason), because this flag alone turns on unattended
// writes to tenant config during a plan change.

describe("SetConfigSnapshotFlagDto", () => {
  const run = async (body: Record<string, unknown>) => {
    const dto = plainToInstance(SetConfigSnapshotFlagDto, body);
    return validate(dto);
  };

  it("accepts enabled + a real reason", async () => {
    const errors = await run({ enabled: true, reason: "owner ruling 2026-09-23" });
    expect(errors).toHaveLength(0);
  });

  it("rejects a missing reason", async () => {
    const errors = await run({ enabled: true });
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });

  it("rejects an empty-string reason", async () => {
    const errors = await run({ enabled: true, reason: "" });
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });

  it("rejects a reason under the 3-char minimum", async () => {
    const errors = await run({ enabled: true, reason: "ok" });
    expect(errors.some((e) => e.property === "reason")).toBe(true);
  });

  it("rejects a missing enabled value", async () => {
    const errors = await run({ reason: "owner ruling 2026-09-23" });
    expect(errors.some((e) => e.property === "enabled")).toBe(true);
  });

  it("rejects a non-boolean enabled value", async () => {
    const errors = await run({ enabled: "on", reason: "owner ruling 2026-09-23" });
    expect(errors.some((e) => e.property === "enabled")).toBe(true);
  });
});
