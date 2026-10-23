import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupSection } from "./SetupSection";
import { EFFECTIVE_FIXTURE } from "./__fixtures__/effective.fixtures";
import {
  CAPABILITY_PRESETS_FIXTURE,
  DELIVERY_COUNTER_FIXTURE,
  capabilitiesFixture,
  capabilitiesPreview,
} from "./__fixtures__/capabilities.fixtures";

const mockFetchCapabilities = jest.fn();
const mockFetchPresets = jest.fn();
const mockPreview = jest.fn();
const mockApply = jest.fn();
const mockConfigValue = jest.fn();
const mockEffective = jest.fn();

jest.mock("@/lib/platform-admin/capabilities-contract", () => ({
  CAPABILITIES_ERROR_CODES: { BUSINESS_CAPABILITIES_EMPTY: "BUSINESS_CAPABILITIES_EMPTY" },
  fetchBusinessCapabilities: (tenantId: string) => mockFetchCapabilities(tenantId),
  fetchCapabilityPresets: () => mockFetchPresets(),
  previewBusinessCapabilities: (tenantId: string, body: unknown) => mockPreview(tenantId, body),
  applyBusinessCapabilities: (tenantId: string, body: unknown, fingerprint: string) =>
    mockApply(tenantId, body, fingerprint),
}));
jest.mock("@/lib/platform-admin/business-profiles", () => ({
  fetchTenantConfigValue: (tenantId: string, key: string) => mockConfigValue(tenantId, key),
}));
jest.mock("@/lib/platform-admin/features", () => ({
  fetchTenantFeaturesEffective: (tenantId: string) => mockEffective(tenantId),
}));

const TENANT_ID = "tenant-1";

function setRole(role: string | null) {
  window.localStorage.clear();
  if (role)
    window.localStorage.setItem("superAdminToken", `h.${window.btoa(JSON.stringify({ role }))}.s`);
}

/** Mimics the Setup tab: the parent owns `version` and bumps it when told the setup changed. */
function Harness({ onApplied }: { onApplied: () => void }) {
  const [version, setVersion] = React.useState(0);
  return (
    <SetupSection
      tenantId={TENANT_ID}
      version={version}
      onApplied={() => {
        onApplied();
        setVersion((v) => v + 1);
      }}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  setRole("SUPER_ADMIN");
  mockFetchCapabilities.mockResolvedValue(DELIVERY_COUNTER_FIXTURE);
  mockFetchPresets.mockResolvedValue(CAPABILITY_PRESETS_FIXTURE);
  mockPreview.mockResolvedValue(capabilitiesPreview());
  mockApply.mockResolvedValue({});
  mockConfigValue.mockImplementation((_t: string, key: string) =>
    Promise.resolve(key === "fulfilment_model" ? "delivery" : "unset"),
  );
  mockEffective.mockResolvedValue(EFFECTIVE_FIXTURE);
});

describe("SetupSection — platform admin only", () => {
  it("renders the summary and the capabilities card for a super admin", async () => {
    render(<Harness onApplied={jest.fn()} />);
    expect(await screen.findByText("Current setup")).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "Delivers on own trucks" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /Delivery distributor/ })).toBeNull();
  });

  it.each([["OPERATOR"], ["ADMIN"], [null]])(
    "renders nothing and fetches nothing for role %s",
    async (role) => {
      setRole(role);
      const { container } = render(<Harness onApplied={jest.fn()} />);
      expect(container).toBeEmptyDOMElement();
      expect(mockFetchCapabilities).not.toHaveBeenCalled();
      expect(mockFetchPresets).not.toHaveBeenCalled();
      expect(mockConfigValue).not.toHaveBeenCalled();
    },
  );

  it("applying a change reloads the current setup", async () => {
    const onApplied = jest.fn();
    render(<Harness onApplied={onApplied} />);
    await screen.findByText("Own delivery: orders go out on the business's own trucks");
    const before = mockConfigValue.mock.calls.length;

    fireEvent.click(await screen.findByRole("checkbox", { name: "Ships by carrier" }));
    const apply = await screen.findByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    mockConfigValue.mockImplementation((_t: string, key: string) =>
      Promise.resolve(key === "fulfilment_model" ? "both" : "unset"),
    );
    mockFetchCapabilities.mockResolvedValue(
      capabilitiesFixture({ delivery: true, doorPayments: true, shipping: true, counter: true }),
    );
    fireEvent.click(apply);

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith(
      TENANT_ID,
      { delivery: true, doorPayments: true, shipping: true, counter: true },
      "f".repeat(64),
    );
    expect(await screen.findByText("Own delivery and carrier shipping")).toBeInTheDocument();
    expect(mockConfigValue.mock.calls.length).toBeGreaterThan(before);
  });
});
