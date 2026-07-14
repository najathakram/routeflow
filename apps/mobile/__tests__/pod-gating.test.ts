import { regulatedPodGateError } from "../lib/pod-gating";

describe("regulatedPodGateError", () => {
  it("not a regulated stop → null regardless of capture", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: false,
        identityCheckRequired: false,
        hasSignature: false,
      }),
    ).toBeNull();
  });

  it("regulated stop, no signature → signature message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: false,
        hasSignature: false,
      }),
    ).toBe("A signature is required for this regulated delivery.");
  });

  it("age required + signed, age not verified → age message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: false,
        hasSignature: true,
        ageVerified: false,
      }),
    ).toBe("Confirm the recipient's age before completing this regulated delivery.");
  });

  it("age required + verified, no identity required → null", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: false,
        hasSignature: true,
        ageVerified: true,
      }),
    ).toBeNull();
  });

  it("identity required + signed, not verified → identity message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: false,
        identityCheckRequired: true,
        hasSignature: true,
        identityVerified: false,
      }),
    ).toBe("Verify the recipient's ID before completing this regulated delivery.");
  });

  it("identity verified but no identityType recorded → id-type message", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: false,
        identityCheckRequired: true,
        hasSignature: true,
        identityVerified: true,
        identityType: null,
      }),
    ).toBe("Record which type of ID was checked.");
  });

  it("both age + identity required and fully satisfied → null", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: true,
        hasSignature: true,
        ageVerified: true,
        identityVerified: true,
        identityType: "DRIVERS_LICENSE",
      }),
    ).toBeNull();
  });

  it("both required, neither verified → age message wins (ladder order)", () => {
    expect(
      regulatedPodGateError({
        ageCheckRequired: true,
        identityCheckRequired: true,
        hasSignature: true,
        ageVerified: false,
        identityVerified: false,
      }),
    ).toBe("Confirm the recipient's age before completing this regulated delivery.");
  });
});
