import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureOverridesSection, type FeatureOverridesSectionHandle } from "./page";

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

describe("FeatureOverridesSection — comps default to 30 days and show the end date (back-office P2)", () => {
  // Noon UTC: the same calendar day in every US timezone the suite runs in.
  const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith("/feature-overrides")) return Promise.resolve({ data: [] });
      if (url.endsWith("/features/registry")) return Promise.resolve({ data: [registryRow()] });
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const openNew = async () => {
    render(<FeatureOverridesSection tenant={TENANT} />);
    await userEvent.click(await screen.findByRole("button", { name: /new override/i }));
    return (await screen.findByRole("combobox", { name: "Expires" })) as HTMLSelectElement;
  };

  it("+ New Override: Kind is Complimentary and Expires is 30 days, not permanent", async () => {
    const expires = await openNew();
    expect((screen.getByRole("combobox", { name: "Kind" }) as HTMLSelectElement).value).toBe(
      "COMP",
    );
    expect(expires.value).toBe("30");
  });

  it("the three options name their end date (labels only: the same three values)", async () => {
    const expires = await openNew();
    expect(Array.from(expires.options).map((o) => [o.value, o.textContent])).toEqual([
      ["30", "30 days (ends November 6, 2026)"],
      ["90", "90 days (ends January 5, 2027)"],
      ["none", "No end date"],
    ]);
  });

  it("choosing No end date shows the caption; a timed choice does not", async () => {
    const expires = await openNew();
    expect(screen.queryByText("This stays on until someone revokes it.")).not.toBeInTheDocument();
    await userEvent.selectOptions(expires, "none");
    expect(screen.getByText("This stays on until someone revokes it.")).toBeInTheDocument();
    expect(expires).toHaveAttribute("aria-describedby", "override-no-end-note");
    await userEvent.selectOptions(expires, "90");
    expect(screen.queryByText("This stays on until someone revokes it.")).not.toBeInTheDocument();
  });

  it("other kinds keep today's default (no end date); Trial is a 30-day default like Complimentary", async () => {
    const expires = await openNew();
    const kind = screen.getByRole("combobox", { name: "Kind" });
    await userEvent.selectOptions(kind, "PILOT");
    expect(expires.value).toBe("none");
    await userEvent.selectOptions(kind, "TRIAL");
    expect(expires.value).toBe("30");
    await userEvent.selectOptions(kind, "SUPPORT");
    expect(expires.value).toBe("none");
  });

  it("once the operator picks an Expires value, changing Kind does not override their choice", async () => {
    const expires = await openNew();
    await userEvent.selectOptions(expires, "90");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "PILOT");
    expect(expires.value).toBe("90");
  });

  it("the Customise prefill (openFor) starts at 30 days too", async () => {
    const ref = React.createRef<FeatureOverridesSectionHandle>();
    render(<FeatureOverridesSection ref={ref} tenant={TENANT} />);
    await screen.findByRole("button", { name: /new override/i });
    act(() => ref.current?.openFor("flag.credit_limits"));
    const expires = (await screen.findByRole("combobox", { name: "Expires" })) as HTMLSelectElement;
    expect(expires.value).toBe("30");
  });
});
