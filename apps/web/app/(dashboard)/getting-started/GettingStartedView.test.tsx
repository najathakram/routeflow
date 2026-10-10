import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import type { TenantOnboardingView } from "@routeflow/types";
import { GettingStartedView } from "./GettingStartedView";
import { GettingStartedBanner } from "../dashboard/GettingStartedBanner";
import { signOffErrorCopy } from "@/lib/api/onboarding";

// #2159 S4 — the tenant's "Getting started" checklist, sign-off and dashboard banner.
function view(over: Partial<TenantOnboardingView> = {}): TenantOnboardingView {
  return {
    stage: "VERIFY_TRAIN",
    status: "OPEN",
    targetGoLiveOn: "2026-10-15",
    steps: [
      {
        key: "collect.files",
        stage: "COLLECT",
        title: "Files received",
        required: true,
        status: "DONE",
        doneAt: "2026-09-20T10:00:00.000Z",
        check: null,
      },
      {
        key: "verify.cutoverAgreed",
        stage: "VERIFY_TRAIN",
        title: "Cutover date agreed",
        required: true,
        status: "PENDING",
        doneAt: null,
        check: { ok: false, detail: "2 products without a price" },
      },
    ],
    signOff: { status: "PENDING", signedAt: null, signedName: null, available: true },
    ...over,
  };
}

function renderView(props: Partial<React.ComponentProps<typeof GettingStartedView>> = {}) {
  const onSignOff = jest.fn();
  render(
    <GettingStartedView
      onboarding={view()}
      canSignOff
      signing={false}
      signOffError={null}
      onSignOff={onSignOff}
      {...props}
    />,
  );
  return { onSignOff };
}

describe("GettingStartedView", () => {
  it("shows the current stage, the customer's steps and their auto-check hint", () => {
    renderView();
    expect(screen.getByRole("heading", { name: /now: training & sign-off/i })).toBeInTheDocument();
    expect(screen.getByText("Files received")).toBeInTheDocument();
    expect(screen.getByText("2 products without a price")).toBeInTheDocument();
    const current = screen
      .getByRole("list", { name: /onboarding stages/i })
      .querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent("Training & sign-off");
  });

  it("the admin types their name and signs off", async () => {
    const user = userEvent.setup();
    const { onSignOff } = renderView();
    const button = screen.getByRole("button", { name: /sign off/i });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(/your full name/i), "Pat Example");
    await user.click(button);
    expect(onSignOff).toHaveBeenCalledWith("Pat Example");
  });

  it("a non-admin (or an impersonating super-admin) sees no sign-off form", () => {
    renderView({ canSignOff: false });
    expect(screen.queryByLabelText(/your full name/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-sign-off")).toHaveTextContent(
      /workspace admin needs to sign in/i,
    );
  });

  it("before sign-off opens, nobody gets the form", () => {
    renderView({
      onboarding: view({
        stage: "CONFIGURE",
        signOff: { status: "PENDING", signedAt: null, signedName: null, available: false },
      }),
    });
    expect(screen.queryByLabelText(/your full name/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-sign-off")).toHaveTextContent(/let you know/i);
  });

  it("a completed sign-off shows who signed", () => {
    renderView({
      onboarding: view({
        signOff: {
          status: "DONE",
          signedAt: "2026-09-27T09:00:00.000Z",
          signedName: "Pat Example",
          available: false,
        },
      }),
    });
    expect(screen.getByTestId("onboarding-sign-off")).toHaveTextContent(
      /signed off by pat example on sep 27, 2026/i,
    );
  });

  it("shows the fixed error copy it is given", () => {
    renderView({ signOffError: "Type your full name to sign off." });
    expect(screen.getByText("Type your full name to sign off.")).toBeInTheDocument();
  });
});

describe("signOffErrorCopy", () => {
  it("maps each failure to fixed copy, never the server message", () => {
    const e = (status: number, code?: string) => ({
      response: { status, data: { code, message: "RAW SERVER TEXT" } },
    });
    expect(signOffErrorCopy(e(409, "ONBOARDING_SIGN_OFF_NOT_AVAILABLE"))).toMatch(/isn't open/);
    expect(signOffErrorCopy(e(403))).toMatch(/signed in as themselves/);
    expect(signOffErrorCopy(e(400))).toMatch(/full name/);
    expect(signOffErrorCopy(e(500))).not.toMatch(/RAW SERVER TEXT/);
  });
});

describe("GettingStartedBanner", () => {
  it("is hidden with no case, and once the case is LIVE", () => {
    const { rerender } = render(<GettingStartedBanner onboarding={null} />);
    expect(screen.queryByTestId("getting-started-banner")).not.toBeInTheDocument();
    rerender(<GettingStartedBanner onboarding={view({ status: "LIVE" })} />);
    expect(screen.queryByTestId("getting-started-banner")).not.toBeInTheDocument();
  });

  it("links to Getting started and says when sign-off is open", () => {
    render(<GettingStartedBanner onboarding={view()} />);
    expect(screen.getByTestId("getting-started-banner")).toHaveTextContent(/sign-off is open/i);
    expect(screen.getByRole("link", { name: /getting started/i })).toHaveAttribute(
      "href",
      "/getting-started",
    );
  });

  it("counts the current stage's to-dos otherwise", () => {
    render(
      <GettingStartedBanner
        onboarding={view({
          signOff: { status: "PENDING", signedAt: null, signedName: null, available: false },
        })}
      />,
    );
    expect(screen.getByTestId("getting-started-banner")).toHaveTextContent(
      /1 item needs your team/i,
    );
  });
});
