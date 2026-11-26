import { render } from "@testing-library/react";
import { AuthShell } from "@/components/auth/AuthShell";

// The sign-in family wears SiteFrame, which carries the palette style. The page must hold exactly
// one `style#brand-tokens`: the frame's, with nothing added by the auth shell on top.
describe("an auth page carries exactly one brand-tokens style", () => {
  it("AuthShell around a form", () => {
    render(
      <AuthShell audience="distributor" kicker="Sign in" title="Welcome back">
        <form />
      </AuthShell>,
    );
    expect(document.querySelectorAll("style#brand-tokens")).toHaveLength(1);
    expect(document.querySelectorAll('[id="brand-tokens"]')).toHaveLength(1);
  });
});
