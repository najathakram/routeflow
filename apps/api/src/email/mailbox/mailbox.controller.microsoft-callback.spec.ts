import { BadRequestException, INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import request from "supertest";
import { MailboxController } from "./mailbox.controller";
import { MailboxConnectionService } from "./mailbox-connection.service";
import { JwtStrategy } from "../../auth/strategies/jwt.strategy";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { AddonGuard } from "../../billing/addon.guard";
import { AddonService } from "../../billing/addon.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { FeatureOverrideService } from "../../billing/feature-override.service";
import { listenOnLoopback } from "../../common/testing/listen-loopback";

/**
 * HTTP-level tests for `GET /settings/email/mailbox/microsoft/callback` (email-connect-microsoft
 * PR-4, Opus review) — unguarded by design (see the controller class doc: it's a top-level
 * browser redirect FROM Microsoft, so it can carry no bearer token), so this exercises the
 * REDIRECT contract directly rather than a guard chain: a successful exchange redirects with
 * `mailbox_confirm`, a denied consent (`error`/`error_description`) redirects WITHOUT ever
 * calling the service, an AADSTS65001 org-consent-required denial gets its own flag, and a
 * failed exchange (thrown by the service) redirects with the matching error flag.
 */
describe("MailboxController — GET microsoft/callback", () => {
  let app: INestApplication;
  let mailboxConnection: { handleMicrosoftCallback: jest.Mock; discardState: jest.Mock };

  beforeAll(async () => {
    mailboxConnection = {
      handleMicrosoftCallback: jest.fn(),
      discardState: jest.fn().mockResolvedValue(undefined),
    };

    // The callback route itself is unguarded, but Nest still resolves every provider the
    // CONTROLLER'S OTHER routes reference via @UseGuards (JwtAuthGuard/RolesGuard/AddonGuard) —
    // same fixture shape as mailbox.controller.security.spec.ts.
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: "microsoft-callback-spec-secret" })],
      controllers: [MailboxController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        AddonGuard,
        Reflector,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                jwt: { secret: "microsoft-callback-spec-secret" },
                WEB_URL: "http://localhost:3001",
              })[key],
          },
        },
        { provide: AddonService, useValue: { getActiveAddons: jest.fn().mockResolvedValue([]) } },
        {
          provide: EntitlementsService,
          useValue: { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: FeatureOverrideService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: MailboxConnectionService, useValue: mailboxConnection },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it("a successful exchange redirects with mailbox_confirm=<token>", async () => {
    mailboxConnection.handleMicrosoftCallback.mockResolvedValue({ confirmToken: "tok-123" });

    const res = await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/callback")
      .query({ code: "code-1", state: "state-1" })
      .expect(302);

    expect(res.headers.location).toBe(
      "http://localhost:3001/settings?tab=email&mailbox_confirm=tok-123",
    );
    expect(mailboxConnection.handleMicrosoftCallback).toHaveBeenCalledWith("code-1", "state-1");
  });

  it("Microsoft's own error= redirect (consent denied, no AADSTS65001) redirects to mailbox_error=1 WITHOUT calling the service", async () => {
    const res = await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/callback")
      .query({ error: "access_denied", error_description: "The user cancelled the sign-in." })
      .expect(302);

    expect(res.headers.location).toBe("http://localhost:3001/settings?tab=email&mailbox_error=1");
    expect(mailboxConnection.handleMicrosoftCallback).not.toHaveBeenCalled();
  });

  it("Microsoft's error= redirect carrying AADSTS65001 redirects to mailbox_admin_consent_required=1", async () => {
    const res = await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/callback")
      .query({
        error: "access_denied",
        error_description:
          "AADSTS65001: The user or administrator has not consented to use the application.",
      })
      .expect(302);

    expect(res.headers.location).toBe(
      "http://localhost:3001/settings?tab=email&mailbox_admin_consent_required=1",
    );
    expect(mailboxConnection.handleMicrosoftCallback).not.toHaveBeenCalled();
  });

  it("a failed exchange (state_invalid) redirects to mailbox_error=1", async () => {
    mailboxConnection.handleMicrosoftCallback.mockRejectedValue(
      new BadRequestException("state_invalid"),
    );

    const res = await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/callback")
      .query({ code: "code-1", state: "bad-state" })
      .expect(302);

    expect(res.headers.location).toBe("http://localhost:3001/settings?tab=email&mailbox_error=1");
  });

  describe("the connect state is consumed on every terminal outcome (#2115)", () => {
    it("an error/cancel redirect burns its state before redirecting, never exchanging", async () => {
      const res = await request(app.getHttpServer())
        .get("/settings/email/mailbox/microsoft/callback")
        .query({
          error: "access_denied",
          error_description: "AADSTS65004: User declined to consent to access the app.",
          state: "state-1",
        })
        .expect(302);

      expect(res.headers.location).toBe("http://localhost:3001/settings?tab=email&mailbox_error=1");
      expect(mailboxConnection.discardState).toHaveBeenCalledWith("state-1");
      expect(mailboxConnection.handleMicrosoftCallback).not.toHaveBeenCalled();
    });

    it("a failed exchange burns its state too", async () => {
      mailboxConnection.handleMicrosoftCallback.mockRejectedValue(
        new BadRequestException("microsoft_token_invalid"),
      );

      await request(app.getHttpServer())
        .get("/settings/email/mailbox/microsoft/callback")
        .query({ code: "code-1", state: "state-2" })
        .expect(302);

      expect(mailboxConnection.discardState).toHaveBeenCalledWith("state-2");
    });

    it("a successful exchange leaves the state to handleMicrosoftCallback, which consumed it itself", async () => {
      mailboxConnection.handleMicrosoftCallback.mockResolvedValue({ confirmToken: "tok-9" });

      await request(app.getHttpServer())
        .get("/settings/email/mailbox/microsoft/callback")
        .query({ code: "code-1", state: "state-3" })
        .expect(302);

      expect(mailboxConnection.discardState).not.toHaveBeenCalled();
    });
  });

  describe("attacker-controllable query values (the route is unauthenticated)", () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());
    const warnLines = () => warn.mock.calls.map((args) => String(args[0]));

    it("logs the error code and the bare AADSTS code only, never the free-text description", async () => {
      await request(app.getHttpServer())
        .get("/settings/email/mailbox/microsoft/callback")
        .query({
          error: "access_denied",
          error_description: "AADSTS65001: Jane Doe of Acme Corp has not consented.",
        })
        .expect(302);

      expect(warnLines()).toEqual([
        "Mailbox Microsoft callback denied: access_denied (AADSTS65001)",
      ]);
    });

    it("a forged error carrying CR/LF is logged as a fixed placeholder, never raw", async () => {
      const res = await request(app.getHttpServer())
        .get("/settings/email/mailbox/microsoft/callback")
        .query({ error: "access_denied\r\n[Nest] 1 - ERROR forged line" })
        .expect(302);

      expect(res.headers.location).toBe("http://localhost:3001/settings?tab=email&mailbox_error=1");
      expect(warnLines()).toEqual(["Mailbox Microsoft callback denied: <malformed error>"]);
      expect(mailboxConnection.handleMicrosoftCallback).not.toHaveBeenCalled();
    });

    it("a repeated error_description (Express hands it over as an array) still redirects, never 500s", async () => {
      const res = await request(app.getHttpServer())
        .get(
          "/settings/email/mailbox/microsoft/callback?error=access_denied&error_description=a&error_description=b",
        )
        .expect(302);

      expect(res.headers.location).toBe("http://localhost:3001/settings?tab=email&mailbox_error=1");
      expect(mailboxConnection.handleMicrosoftCallback).not.toHaveBeenCalled();
    });
  });

  it("a failed exchange with microsoft_admin_consent_required redirects to mailbox_admin_consent_required=1", async () => {
    mailboxConnection.handleMicrosoftCallback.mockRejectedValue(
      new BadRequestException("microsoft_admin_consent_required"),
    );

    const res = await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/callback")
      .query({ code: "code-1", state: "state-1" })
      .expect(302);

    expect(res.headers.location).toBe(
      "http://localhost:3001/settings?tab=email&mailbox_admin_consent_required=1",
    );
  });
});
