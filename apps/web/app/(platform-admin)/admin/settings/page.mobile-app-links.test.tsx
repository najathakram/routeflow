import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "./page";

const mockGet = jest.fn();
const mockPut = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: (url: string) => mockGet(url),
    put: (url: string, body: unknown) => mockPut(url, body),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));
jest.mock("../../_components/DisabledHint", () => ({
  DisabledHint: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

const STORED = {
  androidApkUrl: "https://example.test/app.apk",
  playStoreUrl: null,
  iosUrl: null,
};

beforeEach(() => {
  mockGet.mockReset();
  mockPut.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/platform-admin/app-links") return Promise.resolve({ data: STORED });
    if (url === "/platform-admin/ai-config") {
      return Promise.resolve({
        data: {
          configured: false,
          source: "none",
          keyPreview: null,
          model: "claude-sonnet-4-5",
          maxTokens: 4096,
          verifiedAt: null,
          availableModels: ["claude-sonnet-4-5"],
        },
      });
    }
    return Promise.reject(new Error("unused"));
  });
});

describe("admin settings: Mobile app links card", () => {
  it("the Mobile app links card loads, saves, and shows the server's invalid-URL error by the field", async () => {
    const user = userEvent.setup();
    render(<AdminSettingsPage />);

    // loads the stored values
    const apk = await screen.findByLabelText("Android download link (APK)");
    await waitFor(() => expect(apk).toHaveValue(STORED.androidApkUrl));
    expect(screen.getByLabelText("Google Play link")).toHaveValue("");
    expect(screen.getByText(/Leave empty to hide an option/)).toBeVisible();

    // saves: the iOS link set, the Android link cleared
    mockPut.mockResolvedValueOnce({
      data: { androidApkUrl: null, playStoreUrl: null, iosUrl: "https://example.test/ios" },
    });
    await user.clear(apk);
    await user.type(screen.getByLabelText("iPhone and iPad link"), "https://example.test/ios");
    await user.click(screen.getByRole("button", { name: "Save links" }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith("/platform-admin/app-links", {
        androidApkUrl: "",
        playStoreUrl: "",
        iosUrl: "https://example.test/ios",
      }),
    );
    expect(await screen.findByText("Saved")).toBeVisible();

    // the server's invalid-URL error appears by the field it names
    mockPut.mockRejectedValueOnce({
      response: {
        data: {
          statusCode: 400,
          code: "APP_LINK_URL_INVALID",
          field: "playStoreUrl",
          message: "Enter a full https:// link (up to 2048 characters).",
        },
      },
    });
    await user.type(screen.getByLabelText("Google Play link"), "http://example.test/play");
    await user.click(screen.getByRole("button", { name: "Save links" }));
    const alert = await screen.findByText("Enter a full https:// link.");
    const play = screen.getByLabelText("Google Play link");
    expect(play).toHaveAttribute("aria-invalid", "true");
    expect(play.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
