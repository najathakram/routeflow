import * as fs from "fs";
import * as path from "path";
// The REAL shared module by path: jest maps `@routeflow/types` to a hand stub, and these are
// the exact helpers the app imports from it at runtime.
import {
  ONBOARDING_STAGE_CUSTOMER_LABEL,
  ONBOARDING_STAGE_VALUES,
  tenantOnboardingSignOffErrorCopy,
  tenantOnboardingSummary,
  type TenantOnboardingView,
} from "../../../packages/types/api/onboarding";

// #2159 S4 — the mobile "Getting started" card + screen mirror the web: same endpoints,
// same shared copy (packages/types/api/onboarding.ts). Pure logic + wiring pins only.

function view(over: Partial<TenantOnboardingView> = {}): TenantOnboardingView {
  return {
    stage: "COLLECT",
    status: "OPEN",
    targetGoLiveOn: null,
    steps: [
      {
        key: "collect.files",
        stage: "COLLECT",
        title: "Files received",
        required: true,
        status: "PENDING",
        doneAt: null,
        check: null,
      },
      {
        key: "collect.answers",
        stage: "COLLECT",
        title: "Questionnaire answered",
        required: true,
        status: "PENDING",
        doneAt: null,
        check: null,
      },
      {
        key: "verify.cutoverAgreed",
        stage: "VERIFY_TRAIN",
        title: "Cutover agreed",
        required: true,
        status: "PENDING",
        doneAt: null,
        check: null,
      },
    ],
    signOff: { status: "PENDING", signedAt: null, signedName: null, available: false },
    ...over,
  };
}

describe("tenantOnboardingSummary (#2159 S4)", () => {
  it("is null — card hidden — with no case, or once LIVE", () => {
    expect(tenantOnboardingSummary(null)).toBeNull();
    expect(tenantOnboardingSummary(view({ status: "LIVE" }))).toBeNull();
  });

  it("counts only the CURRENT stage's to-dos", () => {
    expect(tenantOnboardingSummary(view())).toBe("2 items need your team right now.");
  });

  it("says when sign-off is open, and when onboarding is paused", () => {
    expect(
      tenantOnboardingSummary(
        view({
          stage: "VERIFY_TRAIN",
          signOff: { status: "PENDING", signedAt: null, signedName: null, available: true },
        }),
      ),
    ).toBe("Sign-off is open for your workspace admin.");
    expect(tenantOnboardingSummary(view({ status: "ON_HOLD" }))).toBe(
      "Onboarding is paused for now.",
    );
  });

  it("has a customer-facing label for every stage", () => {
    for (const s of ONBOARDING_STAGE_VALUES) {
      expect(ONBOARDING_STAGE_CUSTOMER_LABEL[s]).toMatch(/\S/);
    }
  });

  it("maps sign-off failures to fixed copy", () => {
    const e = (status: number, code?: string) => ({
      response: { status, data: { code, message: "RAW" } },
    });
    expect(tenantOnboardingSignOffErrorCopy(e(409, "ONBOARDING_SIGN_OFF_NOT_AVAILABLE"))).toMatch(
      /isn't open/,
    );
    expect(tenantOnboardingSignOffErrorCopy(e(503))).not.toMatch(/RAW/);
  });
});

describe("Getting started wiring (#2159 S4)", () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  it("uses the web's endpoints", () => {
    const api = read("lib/api/onboarding.ts");
    expect(api).toContain('apiClient.get("/onboarding/me")');
    expect(api).toContain('apiClient.post("/onboarding/me/sign-off"');
  });

  it("the home card opens the Getting started screen, which offers sign-off only to TENANT_ADMIN", () => {
    expect(read("app/(operator)/(tabs)/home.tsx")).toContain(
      'router.push("/(operator)/getting-started")',
    );
    const screen = read("app/(operator)/getting-started.tsx");
    expect(screen).toContain('user?.role === "TENANT_ADMIN"');
    expect(screen).toContain("useOnboardingSignOff");
  });
});
