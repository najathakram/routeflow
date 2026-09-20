import * as React from "react";
import { render, waitFor } from "@testing-library/react";
import { SentryInit } from "./SentryInit";

// Release-health tagging (PR 1): SentryInit must pass `release:
// NEXT_PUBLIC_RELEASE_SHA` to Sentry.init() in the browser, and never crash when
// that env var (or the DSN) is unset. @sentry/react is dynamically imported
// inside a useEffect, so the mock below is what the `import("@sentry/react")`
// resolves to.
const sentryInit = jest.fn();
const sentrySetTag = jest.fn();
jest.mock("@sentry/react", () => ({
  init: (...args: unknown[]) => sentryInit(...args),
  setTag: (...args: unknown[]) => sentrySetTag(...args),
}));

describe("SentryInit release tagging (PR 1)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    sentryInit.mockClear();
    sentrySetTag.mockClear();
    document.cookie = "tenant-slug=; path=/; max-age=0";
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("passes release: NEXT_PUBLIC_RELEASE_SHA to Sentry.init when both DSN and sha are set", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@o0.ingest.sentry.io/1";
    process.env.NEXT_PUBLIC_RELEASE_SHA = "abc123deadbeef";

    render(<SentryInit />);

    await waitFor(() => expect(sentryInit).toHaveBeenCalled());
    expect(sentryInit).toHaveBeenCalledWith(expect.objectContaining({ release: "abc123deadbeef" }));
  });

  it("does not crash and initializes with release: undefined when NEXT_PUBLIC_RELEASE_SHA is unset", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@o0.ingest.sentry.io/1";
    delete process.env.NEXT_PUBLIC_RELEASE_SHA;

    expect(() => render(<SentryInit />)).not.toThrow();

    await waitFor(() => expect(sentryInit).toHaveBeenCalled());
    expect(sentryInit).toHaveBeenCalledWith(expect.objectContaining({ release: undefined }));
  });

  it("never initializes Sentry at all when NEXT_PUBLIC_SENTRY_DSN is unset (release-sha alone is not enough)", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.NEXT_PUBLIC_RELEASE_SHA = "abc123deadbeef";

    render(<SentryInit />);

    // No dynamic import happens without a DSN, so give the microtask queue a
    // turn and assert init was never reached.
    await new Promise((r) => setTimeout(r, 0));
    expect(sentryInit).not.toHaveBeenCalled();
  });
});
