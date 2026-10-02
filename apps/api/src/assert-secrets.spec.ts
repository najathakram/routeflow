import { assertSecrets, type AssertSecretsIo } from "./assert-secrets";
import { ONBOARDING_TOKEN_SECRET_MIN_LENGTH } from "./onboarding/onboarding-token-secret";

// SA-456: the boot half of the ONBOARDING_TOKEN_SECRET contract. Production refuses to start
// without a full-length secret; elsewhere an unset/short one boots but warns loudly.
const GOOD = "o".repeat(ONBOARDING_TOKEN_SECRET_MIN_LENGTH);
const SHORT = "o".repeat(ONBOARDING_TOKEN_SECRET_MIN_LENGTH - 1);

// A full-length HANDOFF_TOKEN_SECRET by default, so each block only sees its own secret's warning.
const HANDOFF_OK = "h".repeat(32);

function run(env: NodeJS.ProcessEnv) {
  const io: jest.Mocked<AssertSecretsIo> = { exit: jest.fn(), error: jest.fn(), warn: jest.fn() };
  assertSecrets(
    { JWT_SECRET: "j", JWT_REFRESH_SECRET: "r", HANDOFF_TOKEN_SECRET: HANDOFF_OK, ...env },
    io,
  );
  return io;
}

describe("assertSecrets — HANDOFF_TOKEN_SECRET (#2653, SA-542a)", () => {
  const ONB = "o".repeat(32);
  it.each([
    ["development", "unset", undefined],
    ["development", "short", "h".repeat(31)],
    ["production", "unset", undefined],
    ["production", "short", "h".repeat(31)],
  ])(
    "%s, %s: boots (never exits) and warns that the handoff is disabled",
    (nodeEnv, _l, secret) => {
      const io = run({
        ...(nodeEnv === "production" ? PROD : { NODE_ENV: nodeEnv }),
        ONBOARDING_TOKEN_SECRET: ONB,
        HANDOFF_TOKEN_SECRET: secret,
      });
      expect(io.exit).not.toHaveBeenCalled();
      expect(io.warn.mock.calls.flat().join("\n")).toMatch(
        /HANDOFF_TOKEN_SECRET .*handoff is DISABLED .*409 HANDOFF_NOT_CONFIGURED/,
      );
    },
  );

  it("is quiet with a full-length secret", () => {
    const io = run({ ...PROD, ONBOARDING_TOKEN_SECRET: ONB });
    expect(io.warn.mock.calls.flat().join("\n")).not.toMatch(/HANDOFF_TOKEN_SECRET/);
  });
});

const PROD = {
  NODE_ENV: "production",
  STORAGE_URL_SIGNING_SECRET: "s",
  ENCRYPTION_KEY: "a".repeat(64),
};

describe("assertSecrets — ONBOARDING_TOKEN_SECRET (SA-456)", () => {
  it("uses one 32-char threshold", () => {
    expect(ONBOARDING_TOKEN_SECRET_MIN_LENGTH).toBe(32);
  });

  it.each([
    ["unset", undefined],
    ["short", SHORT],
    ["whitespace-padded short", `  ${SHORT}  `],
  ])("exits in production when it is %s", (_label, secret) => {
    const io = run({ ...PROD, ONBOARDING_TOKEN_SECRET: secret });
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error.mock.calls.flat().join("\n")).toMatch(/ONBOARDING_TOKEN_SECRET \(32\+ chars\)/);
  });

  it("boots in production with a full-length secret, silently", () => {
    const io = run({ ...PROD, ONBOARDING_TOKEN_SECRET: GOOD });
    expect(io.exit).not.toHaveBeenCalled();
    expect(io.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["short", SHORT],
  ])(
    "does NOT exit in dev when it is %s, but warns loudly that intake links are disabled",
    (_l, secret) => {
      const io = run({ NODE_ENV: "development", ONBOARDING_TOKEN_SECRET: secret });
      expect(io.exit).not.toHaveBeenCalled();
      const warned = io.warn.mock.calls.flat().join("\n");
      expect(warned).toMatch(/ONBOARDING_TOKEN_SECRET/);
      expect(warned).toMatch(/intake links are DISABLED/);
    },
  );

  it("stays quiet in dev with a full-length secret", () => {
    const io = run({ NODE_ENV: "development", ONBOARDING_TOKEN_SECRET: GOOD });
    expect(io.exit).not.toHaveBeenCalled();
    expect(io.warn).not.toHaveBeenCalled();
  });

  it("still exits on the pre-existing required secrets", () => {
    const io = jest.mocked<AssertSecretsIo>({ exit: jest.fn(), error: jest.fn(), warn: jest.fn() });
    assertSecrets({ NODE_ENV: "development", ONBOARDING_TOKEN_SECRET: GOOD }, io);
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error.mock.calls.flat().join("\n")).toMatch(/JWT_SECRET, JWT_REFRESH_SECRET/);
  });
});
