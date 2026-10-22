import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { GetTheAppStrip, GET_THE_APP_DISMISSED_KEY } from "./GetTheAppStrip";

let mockLinks:
  { androidApkUrl: string | null; playStoreUrl: string | null; iosUrl: string | null } | undefined;
let mockShell = false;

jest.mock("@/lib/api/app-links", () => ({
  ...jest.requireActual("@/lib/api/app-links"),
  useAppLinks: () => ({ data: mockLinks }),
}));
jest.mock("@/lib/in-shell", () => ({ isInShell: () => mockShell }));

const READY = { androidApkUrl: "https://example.test/app.apk", playStoreUrl: null, iosUrl: null };

beforeEach(() => {
  mockLinks = READY;
  mockShell = false;
  localStorage.clear();
});

describe("GetTheAppStrip", () => {
  it("shows when ready, hides in the shell, for drivers and after dismiss (remembered)", async () => {
    const user = userEvent.setup();

    // ready: one line, a link to the page, a dismiss button
    const first = render(<GetTheAppStrip isDriver={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Get the RouteFlow app on your phone.");
    expect(screen.getByRole("link", { name: "Get the app" })).toHaveAttribute(
      "href",
      "/get-the-app",
    );

    // dismiss hides it now and is remembered per device
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(localStorage.getItem(GET_THE_APP_DISMISSED_KEY)).toBe("1");
    first.unmount();
    render(<GetTheAppStrip isDriver={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides in the shell", () => {
    mockShell = true;
    render(<GetTheAppStrip isDriver={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides for drivers (they already get the driver-app banner)", () => {
    render(<GetTheAppStrip isDriver />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides when no link is ready or the links have not loaded", () => {
    mockLinks = { androidApkUrl: null, playStoreUrl: null, iosUrl: null };
    const { unmount } = render(<GetTheAppStrip isDriver={false} />);
    expect(screen.queryByRole("status")).toBeNull();
    unmount();
    mockLinks = undefined;
    render(<GetTheAppStrip isDriver={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("still renders when storage is blocked", () => {
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<GetTheAppStrip isDriver={false} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    spy.mockRestore();
  });
});
