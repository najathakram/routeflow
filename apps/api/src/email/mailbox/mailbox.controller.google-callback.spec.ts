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

const CALLBACK = "/settings/email/mailbox/google/callback";
const SETTINGS = "http://localhost:3001/settings?tab=email";

/**
 * HTTP-level tests for `GET /settings/email/mailbox/google/callback` (F-10b, #2078), the Google
 * twin of mailbox.controller.microsoft-callback.spec.ts. The route is unguarded by design (a
 * top-level browser redirect FROM Google carries no bearer token; see the controller's class
 * doc), so this drives the REDIRECT contract directly: a successful exchange redirects with
 * `mailbox_confirm`; Google's own `error=` redirect is answered WITHOUT ever calling the service
 * (the user cancelling consent gets its own `mailbox_cancelled=google` flag, every other error
 * the generic `mailbox_error=1`); a failed exchange redirects with the generic flag; and the
 * attacker-controllable query values never reach a log line raw.
 */
describe("MailboxController — GET google/callback", () => {
  let app: INestApplication;
  let mailboxConnection: { handleCallback: jest.Mock; discardState: jest.Mock };
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    mailboxConnection = { handleCallback: jest.fn(), discardState: jest.fn() };

    // The callback route itself is unguarded, but Nest still resolves every provider the
    // CONTROLLER'S OTHER routes reference via @UseGuards (JwtAuthGuard/RolesGuard/AddonGuard) —
    // same fixture shape as mailbox.controller.microsoft-callback.spec.ts.
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: "google-callback-spec-secret" })],
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
                jwt: { secret: "google-callback-spec-secret" },
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

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset, not just clear: a resolved/rejected value set by one test must never answer
    // another test's (wrongly made) exchange call and hide it.
    mailboxConnection.handleCallback.mockReset();
    mailboxConnection.discardState.mockReset().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  /** Every line the controller logged at warn level during the request. */
  const warnLines = () => warn.mock.calls.map((args) => String(args[0]));

  it("a successful exchange redirects with mailbox_confirm=<token>", async () => {
    mailboxConnection.handleCallback.mockResolvedValue({ confirmToken: "tok-123" });

    const res = await request(app.getHttpServer())
      .get(CALLBACK)
      .query({ code: "code-1", state: "state-1" })
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_confirm=tok-123`);
    expect(mailboxConnection.handleCallback).toHaveBeenCalledWith("code-1", "state-1");
    // The exchange consumed the state itself (handleCallback GETDELs it first).
    expect(mailboxConnection.discardState).not.toHaveBeenCalled();
  });

  it("the user cancelling on Google's consent screen (error=access_denied) redirects to mailbox_cancelled=google WITHOUT calling the service", async () => {
    // Google echoes `state` on an error redirect (RFC 6749 §4.1.2.1) and sends no `code`.
    const res = await request(app.getHttpServer())
      .get(CALLBACK)
      .query({ error: "access_denied", state: "state-1" })
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_cancelled=google`);
    expect(mailboxConnection.handleCallback).not.toHaveBeenCalled();
    // The cancelled state is burned, so it can never be redeemed with a code later (#2115).
    expect(mailboxConnection.discardState).toHaveBeenCalledWith("state-1");
  });

  it("error= wins over a code riding along on the same URL: no exchange is attempted", async () => {
    const res = await request(app.getHttpServer())
      .get(CALLBACK)
      .query({ error: "access_denied", code: "code-1", state: "state-1" })
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_cancelled=google`);
    expect(mailboxConnection.handleCallback).not.toHaveBeenCalled();
  });

  it.each(["server_error", "temporarily_unavailable", "invalid_scope", "admin_policy_enforced"])(
    "any other Google error (%s) redirects to the generic mailbox_error=1 WITHOUT calling the service",
    async (error) => {
      const res = await request(app.getHttpServer())
        .get(CALLBACK)
        .query({ error, state: "state-1" })
        .expect(302);

      expect(res.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
      expect(mailboxConnection.handleCallback).not.toHaveBeenCalled();
      expect(mailboxConnection.discardState).toHaveBeenCalledWith("state-1");
    },
  );

  it("logs the denial by its error code only: error_description (free text) never reaches the log", async () => {
    await request(app.getHttpServer())
      .get(CALLBACK)
      .query({
        error: "access_denied",
        error_description: "Jane Doe <jane@acme.test> of Acme Corp declined",
        state: "state-1",
      })
      .expect(302);

    expect(warnLines()).toEqual(["Mailbox Google callback denied: access_denied"]);
  });

  it("a forged error carrying CR/LF is logged as a fixed placeholder, never raw, and gets the generic flag", async () => {
    const forged = "access_denied\r\n[Nest] 1 - ERROR forged line";

    const res = await request(app.getHttpServer())
      .get(CALLBACK)
      .query({ error: forged, state: "state-1" })
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
    expect(warnLines()).toEqual(["Mailbox Google callback denied: <malformed error>"]);
    expect(mailboxConnection.handleCallback).not.toHaveBeenCalled();
  });

  it("a repeated error param (Express hands it over as an array) is a malformed denial: generic flag, no exchange, no 500", async () => {
    const res = await request(app.getHttpServer())
      .get(`${CALLBACK}?error=access_denied&error=access_denied&state=state-1`)
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
    expect(warnLines()).toEqual(["Mailbox Google callback denied: <malformed error>"]);
    expect(mailboxConnection.handleCallback).not.toHaveBeenCalled();
  });

  it("a failed exchange (state_invalid) redirects to mailbox_error=1", async () => {
    mailboxConnection.handleCallback.mockRejectedValue(new BadRequestException("state_invalid"));

    const res = await request(app.getHttpServer())
      .get(CALLBACK)
      .query({ code: "code-1", state: "bad-state" })
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
    // A failed exchange burns the state too, whatever handleCallback got to before failing.
    expect(mailboxConnection.discardState).toHaveBeenCalledWith("bad-state");
  });

  it("a failed exchange for a Google-side reason (google_scope_missing) also redirects to mailbox_error=1: the admin-consent flag is Microsoft-only", async () => {
    mailboxConnection.handleCallback.mockRejectedValue(
      new BadRequestException("google_scope_missing"),
    );

    const res = await request(app.getHttpServer())
      .get(CALLBACK)
      .query({ code: "code-1", state: "state-1" })
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
  });
});
