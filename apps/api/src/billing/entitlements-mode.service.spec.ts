import { EntitlementsModeService } from "./entitlements-mode.service";

/** SA-1100 §3: the sweep reads the mode with no fail-open fallback; serving paths keep `getMode`. */
describe("EntitlementsModeService.getModeStrict", () => {
  const svc = (impl: () => Promise<{ value: string }[]>) =>
    new EntitlementsModeService({ $queryRaw: jest.fn(impl) } as never);

  it("reads the stored value: live is live, anything else is shadow", async () => {
    expect(await svc(async () => [{ value: "live" }]).getModeStrict()).toBe("live");
    expect(await svc(async () => [{ value: "shadow" }]).getModeStrict()).toBe("shadow");
    expect(await svc(async () => []).getModeStrict()).toBe("shadow");
  });

  it("a database error throws, where getMode() falls back to shadow", async () => {
    const failing = () => svc(async () => Promise.reject(new Error("db down")));
    await expect(failing().getModeStrict()).rejects.toThrow("db down");
    expect(await failing().getMode()).toBe("shadow");
  });
});
