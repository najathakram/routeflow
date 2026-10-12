/**
 * The legacy per-tenant sign-in routes are retired: `GET /auth/google/:tenantSlug` and
 * `GET /auth/google/:tenantSlug/callback` answer 410 Gone with one fixed body. They start no
 * Google flow, issue no session, store no one-time code, set no cookie and redirect nowhere.
 * Standard Google sign-in (`GET /auth/google`, `GET /auth/google/callback`) is unchanged.
 */
import { GoneException, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AuthController } from "./auth.controller";

const RETIRED_BODY = {
  statusCode: 410,
  code: "SIGN_IN_ROUTE_RETIRED",
  message: "This sign-in route has been retired. Use the standard Google sign-in.",
  error: "Gone",
};

function makeController() {
  const configService = {
    get: jest.fn((k: string) => (k === "WEB_URL" ? "https://app.routeflow.test" : undefined)),
  };
  const authService = { login: jest.fn() };
  const googleOAuth = {
    generateAuthUrl: jest.fn(),
    verifyCallback: jest.fn(),
    createExchangeCode: jest.fn(),
  };
  const controller = new AuthController(
    authService as any,
    configService as any,
    googleOAuth as any,
    {} as any, // staffHandoff — not reached by the retired routes
    {} as any, // appleOAuth — not reached by the retired routes
  );
  return { controller, authService, googleOAuth };
}

function makeRes() {
  return {
    redirect: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    status: jest.fn().mockReturnThis(),
  } as any;
}

/** Call a retired handler the way an old caller would, returning whatever it threw. */
async function callRetired(
  controller: AuthController,
  method: "tenantGoogleLogin" | "tenantGoogleCallback",
  res: unknown,
): Promise<unknown> {
  const fn = (controller as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
    method
  ];
  const req = { query: { code: "g-code", state: "acme", next: "https://elsewhere.test" } };
  try {
    await (method === "tenantGoogleLogin"
      ? fn.call(controller, "acme", res)
      : fn.call(controller, "acme", req, res));
  } catch (err) {
    return err;
  }
  return undefined;
}

describe.each(["tenantGoogleLogin", "tenantGoogleCallback"] as const)(
  "AuthController.%s: retired route",
  (method) => {
    it("answers 410 Gone with the fixed body", async () => {
      const { controller } = makeController();
      const err = await callRetired(controller, method, makeRes());

      expect(err).toBeInstanceOf(GoneException);
      const gone = err as GoneException;
      expect(gone.getStatus()).toBe(410);
      expect(gone.getResponse()).toEqual(RETIRED_BODY);
    });

    it("echoes nothing from the request into the answer", async () => {
      const { controller } = makeController();
      const err = await callRetired(controller, method, makeRes());

      expect(err).toBeInstanceOf(GoneException);
      const body = JSON.stringify((err as GoneException).getResponse());
      expect(body).not.toContain("acme");
      expect(body).not.toContain("g-code");
      expect(body).not.toContain("elsewhere.test");
    });

    it("starts no Google flow, issues no session and stores no one-time code", async () => {
      const { controller, authService, googleOAuth } = makeController();
      await callRetired(controller, method, makeRes());

      expect(googleOAuth.generateAuthUrl).not.toHaveBeenCalled();
      expect(googleOAuth.verifyCallback).not.toHaveBeenCalled();
      expect(googleOAuth.createExchangeCode).not.toHaveBeenCalled();
      expect(authService.login).not.toHaveBeenCalled();
    });

    it("no longer depends on the per-tenant Google service", () => {
      // The constructor takes authService, config, googleOAuth, staffHandoff, appleOAuth only.
      expect(AuthController.length).toBe(5);
    });

    it("sets no cookie and redirects nowhere", async () => {
      const { controller } = makeController();
      const res = makeRes();
      await callRetired(controller, method, res);

      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
    });
  },
);

describe("AuthController: retired routes keep their paths and do not shadow google/*", () => {
  const proto = AuthController.prototype as unknown as Record<string, object>;
  const pathOf = (name: string) => Reflect.getMetadata(PATH_METADATA, proto[name]);
  const methodOf = (name: string) => Reflect.getMetadata(METHOD_METADATA, proto[name]);

  it("stay GET routes on their original paths", () => {
    expect(pathOf("tenantGoogleLogin")).toBe("google/:tenantSlug");
    expect(methodOf("tenantGoogleLogin")).toBe(RequestMethod.GET);
    expect(pathOf("tenantGoogleCallback")).toBe("google/:tenantSlug/callback");
    expect(methodOf("tenantGoogleCallback")).toBe(RequestMethod.GET);
  });

  it("are declared after the static GET google/link and google/callback routes", () => {
    // Express matches in registration order, which follows declaration order on the prototype.
    const order = Object.getOwnPropertyNames(AuthController.prototype);
    const at = (name: string) => order.indexOf(name);
    expect(pathOf("linkGoogleUrl")).toBe("google/link");
    expect(pathOf("googleCallback")).toBe("google/callback");
    expect(at("linkGoogleUrl")).toBeGreaterThan(-1);
    expect(at("googleCallback")).toBeGreaterThan(-1);
    expect(at("tenantGoogleLogin")).toBeGreaterThan(at("linkGoogleUrl"));
    expect(at("tenantGoogleLogin")).toBeGreaterThan(at("googleCallback"));
    expect(at("tenantGoogleCallback")).toBeGreaterThan(at("googleCallback"));
  });
});
