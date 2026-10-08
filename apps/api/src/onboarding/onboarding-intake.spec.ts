import * as fs from "fs";
import * as path from "path";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ConflictException, NotFoundException, RequestMethod } from "@nestjs/common";
import { INTAKE_ERROR_CODES, INTAKE_LINK_NOT_FOUND } from "@routeflow/types";
import { validateSectionAnswers, INTAKE_RESERVED_SLUGS } from "./dto/intake-sections.dto";
import {
  LINK_NOT_FOUND,
  OnboardingIntakeService,
  PRIVACY_VERSION,
  TERMS_VERSION,
  assertAllowedUpload,
  safeFileName,
  sameOrder,
} from "./onboarding-intake.service";
import { PublicOnboardingController, intakeFileFilter } from "./public-onboarding.controller";
import { ONBOARDING_TOKEN_SECRET_MIN_LENGTH } from "./onboarding-token-secret";
import { mintSignedToken } from "../common/signed-token";

const ACCOUNT = {
  legalName: "Acme Wholesale LLC",
  slug: "acme-wholesale",
  ownerName: "Pat Owner",
  adminName: "Pat Owner",
  adminEmail: "pat@example.invalid",
  addressLine1: "1 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  phone: "512-555-0100",
  timeZone: "America/Chicago",
};

describe("intake section answers (#2159 S2)", () => {
  it("accepts a complete ACCOUNT section on submit", async () => {
    await expect(
      validateSectionAnswers("ACCOUNT", ACCOUNT, { partial: false }),
    ).resolves.toMatchObject({
      slug: "acme-wholesale",
    });
  });

  it("lets a draft be partial, but still type-checks the fields that ARE present", async () => {
    await expect(
      validateSectionAnswers("ACCOUNT", { legalName: "Acme" }, { partial: true }),
    ).resolves.toEqual({
      legalName: "Acme",
    });
    await expect(
      validateSectionAnswers("ACCOUNT", { state: "Texas" }, { partial: true }),
    ).rejects.toMatchObject({
      response: { code: "INTAKE_ANSWERS_INVALID" },
    });
  });

  it("SA-738: the time zone must be a real IANA zone, not just zone-shaped", async () => {
    await expect(
      validateSectionAnswers(
        "ACCOUNT",
        { ...ACCOUNT, timeZone: "Mars/Phobos" },
        { partial: false },
      ),
    ).rejects.toMatchObject({ response: { code: "INTAKE_ANSWERS_INVALID" } });
    await expect(
      validateSectionAnswers(
        "ACCOUNT",
        { ...ACCOUNT, timeZone: "America/Denver" },
        { partial: false },
      ),
    ).resolves.toMatchObject({ timeZone: "America/Denver" });
  });

  it("requires every required field on submit", async () => {
    const { phone: _p, ...noPhone } = ACCOUNT;
    await expect(
      validateSectionAnswers("ACCOUNT", noPhone, { partial: false }),
    ).rejects.toMatchObject({
      response: { errors: expect.arrayContaining([expect.objectContaining({ field: "phone" })]) },
    });
  });

  it("refuses unknown fields — a secret can't be smuggled in (plan §2)", async () => {
    for (const key of [
      "password",
      "bankAccountNumber",
      "routingNumber",
      "apiKey",
      "smtpPassword",
    ]) {
      await expect(
        validateSectionAnswers("ACCOUNT", { ...ACCOUNT, [key]: "x" }, { partial: true }),
      ).rejects.toMatchObject({ response: { code: "INTAKE_ANSWERS_INVALID" } });
    }
    await expect(
      validateSectionAnswers(
        "INVOICING",
        { paymentMethods: ["ach"], bankAccount: "123" },
        { partial: true },
      ),
    ).rejects.toBeDefined();
  });

  it("refuses a reserved or malformed workspace slug", async () => {
    for (const slug of [...INTAKE_RESERVED_SLUGS, "Ab", "-bad", "has space"]) {
      await expect(
        validateSectionAnswers("ACCOUNT", { ...ACCOUNT, slug }, { partial: false }),
      ).rejects.toBeDefined();
    }
  });

  it("validates nested rows (TEAM staff roles, TAX regulated goods)", async () => {
    await expect(
      validateSectionAnswers(
        "TEAM",
        { staff: [{ name: "A", email: "a@x.invalid", role: "owner" }], drivers: [] },
        { partial: false },
      ),
    ).rejects.toBeDefined();
    await expect(
      validateSectionAnswers(
        "TAX_COMPLIANCE",
        {
          regulatedGoods: [{ category: "tobacco", states: ["TX", "OK"] }],
          licences: [{ name: "Wholesale tobacco", number: "W-1", expiresOn: "2027-01-31" }],
          statesSoldInto: ["TX"],
          hasTaxExemptCustomers: false,
        },
        { partial: false },
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a non-object answers payload", async () => {
    await expect(
      validateSectionAnswers("TEAM", [] as unknown, { partial: true }),
    ).rejects.toBeDefined();
    await expect(
      validateSectionAnswers("TEAM", "x" as unknown, { partial: true }),
    ).rejects.toBeDefined();
  });
});

describe("intake uploads", () => {
  const ok = {
    originalname: "products.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 10,
  };

  it("allows csv/xlsx/pdf/png/jpg with a matching content type", () => {
    for (const f of [
      ok,
      { originalname: "c.csv", mimetype: "text/csv", size: 1 },
      { originalname: "c.PDF", mimetype: "application/pdf", size: 1 },
      { originalname: "l.png", mimetype: "image/png", size: 1 },
      { originalname: "l.jpeg", mimetype: "image/jpeg", size: 1 },
    ]) {
      expect(() => assertAllowedUpload(f)).not.toThrow();
    }
  });

  it("refuses other types, a mismatched content type, and anything over 25 MB", () => {
    for (const f of [
      { originalname: "x.exe", mimetype: "application/octet-stream", size: 1 },
      { originalname: "x.svg", mimetype: "image/svg+xml", size: 1 },
      { originalname: "x.pdf", mimetype: "text/html", size: 1 },
      { originalname: "noext", mimetype: "application/pdf", size: 1 },
      { ...ok, size: 25 * 1024 * 1024 + 1 },
    ]) {
      expect(() => assertAllowedUpload(f)).toThrow();
    }
    const cb = jest.fn();
    intakeFileFilter(null, { originalname: "x.html", mimetype: "text/html" }, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error), false);
  });

  it("stores a path-free, safe file name", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\\\Users\\\\me\\\\My Price List (v2).xlsx")).toBe(
      "My_Price_List_v2_.xlsx",
    );
    expect(safeFileName("...")).toBe("file");
  });
});

describe("public intake controller (L-188 / L-178)", () => {
  const proto = PublicOnboardingController.prototype as unknown as Record<string, object>;
  const routes = Object.getOwnPropertyNames(PublicOnboardingController.prototype).filter(
    (n) => n !== "constructor",
  );

  it("is public (no guards) and every route is a POST", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PublicOnboardingController)).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, PublicOnboardingController)).toBe(
      "public/onboarding",
    );
    for (const r of routes) {
      expect(Reflect.getMetadata(METHOD_METADATA, proto[r])).toBe(RequestMethod.POST);
    }
  });

  it("every route is throttled", () => {
    for (const r of routes) {
      const keys = Reflect.getMetadataKeys(proto[r]).map(String);
      expect(keys.some((k) => k.startsWith("THROTTLER:LIMIT"))).toBe(true);
    }
  });

  it("no route reads a token from the query string or a path parameter", () => {
    const src = fs.readFileSync(path.join(__dirname, "public-onboarding.controller.ts"), "utf8");
    expect(src).not.toMatch(/@Query\(|@Param\(|@Headers\(/);
  });

  it("uses the one generic not-found body everywhere", () => {
    expect(LINK_NOT_FOUND).toBe(INTAKE_LINK_NOT_FOUND);
  });

  it("every intake error code the service throws is in the shared contract", () => {
    const src =
      fs.readFileSync(path.join(__dirname, "onboarding-intake.service.ts"), "utf8") +
      fs.readFileSync(path.join(__dirname, "dto", "intake-sections.dto.ts"), "utf8");
    const thrown = new Set(
      [...src.matchAll(/code: (?:"|API_ERROR_CODES\.)(INTAKE_[A-Z_]+)\b/g)].map((m) => m[1]),
    );
    expect([...thrown].sort()).toEqual([...INTAKE_ERROR_CODES].sort());
  });
});

describe("Terms/Privacy versions track the published pages", () => {
  const page = (name: string) =>
    fs.readFileSync(path.join(__dirname, "../../../web/app/(marketing)", name, "page.tsx"), "utf8");
  const lastUpdated = (src: string) => {
    const m = src.match(/LAST_UPDATED\s*=\s*"([^"]+)"/);
    if (!m) throw new Error("LAST_UPDATED not found");
    return new Date(`${m[1]} 00:00:00 UTC`).toISOString().slice(0, 10);
  };

  it("TERMS_VERSION equals the Terms page's Last updated date", () => {
    expect(TERMS_VERSION).toBe(lastUpdated(page("terms")));
  });

  it("PRIVACY_VERSION equals the Privacy page's Last updated date", () => {
    expect(PRIVACY_VERSION).toBe(lastUpdated(page("privacy")));
  });
});

// SA-456: the request-time half of the ONBOARDING_TOKEN_SECRET contract — the same 32-char bar
// as boot. An unset or short secret refuses to issue a link and makes every link read 404.
describe("intake links with an unset or short secret (SA-456)", () => {
  const prev = process.env.ONBOARDING_TOKEN_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.ONBOARDING_TOKEN_SECRET;
    else process.env.ONBOARDING_TOKEN_SECRET = prev;
  });

  function service() {
    const prisma = {
      onboardingCase: { findUnique: jest.fn() },
      intakeAccessToken: { findUnique: jest.fn() },
    };
    const svc = new OnboardingIntakeService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma };
  }

  it.each([
    ["unset", undefined],
    ["short (31 chars)", "k".repeat(ONBOARDING_TOKEN_SECRET_MIN_LENGTH - 1)],
  ])("issueLink refuses with 409 when the secret is %s, before touching the DB", async (_l, s) => {
    if (s === undefined) delete process.env.ONBOARDING_TOKEN_SECRET;
    else process.env.ONBOARDING_TOKEN_SECRET = s;
    const { svc, prisma } = service();
    await expect(svc.issueLink("case-1", "admin-1", false)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.onboardingCase.findUnique).not.toHaveBeenCalled();
  });

  it("a link signed under a short secret reads 404 while that secret is configured", async () => {
    const short = "k".repeat(ONBOARDING_TOKEN_SECRET_MIN_LENGTH - 1);
    process.env.ONBOARDING_TOKEN_SECRET = short;
    const token = mintSignedToken(short);
    const { svc, prisma } = service();
    await expect(svc.resolve(token)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.intakeAccessToken.findUnique).not.toHaveBeenCalled();
  });

  it("a full-length secret passes the gate and reaches the hash lookup", async () => {
    const good = "k".repeat(ONBOARDING_TOKEN_SECRET_MIN_LENGTH);
    process.env.ONBOARDING_TOKEN_SECRET = good;
    const { svc, prisma } = service();
    prisma.intakeAccessToken.findUnique.mockResolvedValue(null);
    await expect(svc.resolve(mintSignedToken(good))).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.intakeAccessToken.findUnique).toHaveBeenCalledTimes(1);
  });
});

// #2431 fold (d): accept's "same order" check — jsonb reorders keys and every quote stamps a
// fresh computedAt, neither of which makes it a different order.
describe("sameOrder (#2431 fold d)", () => {
  const base = { planKey: "GROWTH", dueToday: 99, lines: [{ key: "GROWTH", monthly: 99 }] };
  it("ignores key order and computedAt", () => {
    expect(
      sameOrder(
        { ...base, computedAt: "2030-01-01T00:00:00Z" },
        {
          lines: [{ monthly: 99, key: "GROWTH" }],
          dueToday: 99,
          planKey: "GROWTH",
          computedAt: "x",
        },
      ),
    ).toBe(true);
  });
  it("any real difference is a different order", () => {
    expect(sameOrder(base, { ...base, dueToday: 149 })).toBe(false);
    expect(sameOrder(base, { ...base, lines: [{ key: "GROWTH", monthly: 149 }] })).toBe(false);
    expect(sameOrder(base, null)).toBe(false);
  });
});
