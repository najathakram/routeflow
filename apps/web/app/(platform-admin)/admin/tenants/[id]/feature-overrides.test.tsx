import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureOverridesSection } from "./page";

const mockGet = jest.fn();

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

const TENANT = { id: "t1" } as any;

function registryRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    key: "flag.credit_limits",
    kind: "boolean",
    area: "billing",
    label: "Credit limits",
    description: "",
    lifecycle: "ga",
    internal: false,
    gate: { via: "RequirePlanFlag", state: "enforced" },
    billing: { skus: [] },
    ...overrides,
  };
}

describe("FeatureOverridesSection — gate.via unwired warning (REG-B478)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the 'no wired gate' warning when the selected registry row's gate.via is 'none'", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith("/feature-overrides")) return Promise.resolve({ data: [] });
      if (url.endsWith("/features/registry")) {
        return Promise.resolve({
          data: [
            registryRow({
              key: "catalog.only",
              label: "Catalog only",
              gate: { via: "none", state: "none" },
            }),
          ],
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    render(<FeatureOverridesSection tenant={TENANT} />);

    await userEvent.click(await screen.findByRole("button", { name: /new override/i }));

    await waitFor(() => {
      expect(screen.getByText(/no wired gate/i)).toBeInTheDocument();
    });
  });

  it("does NOT show the warning for a row with a real gate (RequirePlanFlag)", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith("/feature-overrides")) return Promise.resolve({ data: [] });
      if (url.endsWith("/features/registry")) {
        return Promise.resolve({ data: [registryRow()] });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    render(<FeatureOverridesSection tenant={TENANT} />);

    await userEvent.click(await screen.findByRole("button", { name: /new override/i }));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /feature key/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/no wired gate/i)).not.toBeInTheDocument();
  });
});
