/**
 * SA-1035 W-R1: the AI card has two selects, "AI model" and "Supplier bill scanning", that list the API's labelled models,
 * show a stored older id as "(older model)", seed from the API, and save both in one PATCH.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import AdminSettingsPage from "./page";

const mockGet = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: (url: string) => mockGet(url),
    put: jest.fn(),
    patch: (url: string, body: unknown) => mockPatch(url, body),
    post: jest.fn(),
  },
}));
jest.mock("../../_components/DisabledHint", () => ({
  DisabledHint: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

const MODELS = [
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
];

function config(over: Record<string, unknown> = {}) {
  return {
    configured: true,
    source: "database",
    keyPreview: "sk-ant-api03-x...abcd",
    model: "claude-sonnet-5-5",
    scanModel: "claude-haiku-5-5",
    maxTokens: 4096,
    verifiedAt: null,
    availableModels: MODELS,
    ...over,
  };
}

function serve(cfg: Record<string, unknown>) {
  mockGet.mockImplementation((url: string) => {
    if (url === "/platform-admin/ai-config") return Promise.resolve({ data: cfg });
    if (url === "/platform-admin/app-links") {
      return Promise.resolve({ data: { androidApkUrl: null, playStoreUrl: null, iosUrl: null } });
    }
    return Promise.reject(new Error("unused"));
  });
}

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
});

const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);

describe("admin settings: AI models (SA-1035)", () => {
  it("shows two labelled selects seeded from the API, offering the labels, not raw ids", async () => {
    serve(config());
    render(<AdminSettingsPage />);
    const general = await screen.findByRole("combobox", { name: "AI model" });
    const scan = screen.getByRole("combobox", { name: "Supplier bill scanning" });
    expect(optionLabels(general)).toEqual(["Fable 5.1", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    expect(optionLabels(scan)).toEqual(["Fable 5.1", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    expect(general).toHaveValue("claude-sonnet-5-5");
    expect(scan).toHaveValue("claude-haiku-5-5");
  });

  it("a stored older id stays visible as the current choice, marked (older model)", async () => {
    serve(config({ model: "claude-sonnet-4-5", scanModel: "claude-haiku-4-5" }));
    render(<AdminSettingsPage />);
    const general = await screen.findByRole("combobox", { name: "AI model" });
    const scan = screen.getByRole("combobox", { name: "Supplier bill scanning" });
    expect(general).toHaveValue("claude-sonnet-4-5");
    expect(
      within(general).getByRole("option", { name: "claude-sonnet-4-5 (older model)" }),
    ).toBeInTheDocument();
    expect(scan).toHaveValue("claude-haiku-4-5");
    expect(
      within(scan).getByRole("option", { name: "claude-haiku-4-5 (older model)" }),
    ).toBeInTheDocument();
  });

  it("one Save sends both models; an untouched older model is not re-sent (the API refuses it)", async () => {
    const user = userEvent.setup();
    serve(config({ model: "claude-sonnet-4-5", scanModel: "claude-haiku-5-5" }));
    mockPatch.mockResolvedValue({
      data: config({ model: "claude-sonnet-4-5", scanModel: "claude-opus-5-5" }),
    });
    render(<AdminSettingsPage />);
    const scan = await screen.findByRole("combobox", { name: "Supplier bill scanning" });
    await user.selectOptions(scan, "claude-opus-5-5");
    await user.click(screen.getByRole("button", { name: /Save AI Settings/ }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch).toHaveBeenCalledWith("/platform-admin/ai-config", {
      scanModel: "claude-opus-5-5",
      maxTokens: 4096,
    });
  });

  it("choosing both sends both", async () => {
    const user = userEvent.setup();
    serve(config());
    mockPatch.mockResolvedValue({
      data: config({ model: "claude-opus-5-5", scanModel: "claude-sonnet-5-5" }),
    });
    render(<AdminSettingsPage />);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "AI model" }),
      "claude-opus-5-5",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Supplier bill scanning" }),
      "claude-sonnet-5-5",
    );
    await user.click(screen.getByRole("button", { name: /Save AI Settings/ }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch).toHaveBeenCalledWith("/platform-admin/ai-config", {
      model: "claude-opus-5-5",
      scanModel: "claude-sonnet-5-5",
      maxTokens: 4096,
    });
  });
});
