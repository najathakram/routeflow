import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { AppLinks } from "@routeflow/types";
import { GetTheAppView } from "./GetTheAppView";

const NONE: AppLinks = { androidApkUrl: null, playStoreUrl: null, iosUrl: null };
const APK = "https://example.test/app.apk";
const PLAY = "https://example.test/play";
const IOS = "https://example.test/ios";
const INSTALL_LINK = /android|google play|iphone/i;

describe("GetTheAppView", () => {
  it("shows only the ready options", () => {
    const { rerender } = render(
      <GetTheAppView links={{ ...NONE, androidApkUrl: APK }} inShell={false} />,
    );
    expect(screen.getAllByRole("link", { name: INSTALL_LINK })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Download for Android" })).toHaveAttribute("href", APK);
    expect(screen.getByText(/Allow installs from your browser when Android asks/)).toBeVisible();

    rerender(
      <GetTheAppView
        links={{ androidApkUrl: APK, playStoreUrl: PLAY, iosUrl: IOS }}
        inShell={false}
      />,
    );
    expect(screen.getAllByRole("link", { name: INSTALL_LINK })).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Get it on Google Play" })).toHaveAttribute(
      "href",
      PLAY,
    );
    expect(screen.getByRole("link", { name: "Get it for iPhone" })).toHaveAttribute("href", IOS);
    expect(screen.queryByText(/available yet/)).toBeNull();
  });

  it("says Opens TestFlight only for a TestFlight host", () => {
    const { rerender } = render(
      <GetTheAppView
        links={{ ...NONE, iosUrl: "https://testflight.example.test/join/abc" }}
        inShell={false}
      />,
    );
    expect(screen.queryByText("Opens TestFlight")).toBeNull();
    rerender(
      <GetTheAppView
        links={{ ...NONE, iosUrl: `https://${["testflight", "apple", "com"].join(".")}/join/abc` }}
        inShell={false}
      />,
    );
    expect(screen.getByText("Opens TestFlight")).toBeVisible();
  });

  it("none ready shows 'The app isn't available yet'", () => {
    render(<GetTheAppView links={NONE} inShell={false} />);
    expect(screen.getByText("The app isn't available yet. Check back soon.")).toBeVisible();
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.queryByRole("link", { name: INSTALL_LINK })).toBeNull();
  });

  it("in the shell shows 'You're already using the app' and no buttons", () => {
    render(
      <GetTheAppView links={{ androidApkUrl: APK, playStoreUrl: PLAY, iosUrl: IOS }} inShell />,
    );
    expect(screen.getByText("You're already using the app.")).toBeVisible();
    expect(screen.queryByRole("link", { name: INSTALL_LINK })).toBeNull();
  });

  it("Play and iOS links open in a new tab with noopener; the APK link does not", () => {
    render(
      <GetTheAppView
        links={{ androidApkUrl: APK, playStoreUrl: PLAY, iosUrl: IOS }}
        inShell={false}
      />,
    );
    for (const name of ["Get it on Google Play", "Get it for iPhone"]) {
      const a = screen.getByRole("link", { name });
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
      expect(a.getAttribute("rel")).toContain("noreferrer");
    }
    const apk = screen.getByRole("link", { name: "Download for Android" });
    expect(apk).not.toHaveAttribute("target");
    expect(apk).not.toHaveAttribute("download");
  });
});
