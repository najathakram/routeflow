import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SetupSection } from "./SetupSection";
import { EFFECTIVE_FIXTURE } from "./__fixtures__/effective.fixtures";
import { PROFILES_FIXTURE, shippingPreviewWithBilling } from "./__fixtures__/profiles.fixtures";

const mockFetchProfiles = jest.fn();
const mockPreview = jest.fn();
const mockApply = jest.fn();
const mockConfigValue = jest.fn();
const mockEffective = jest.fn();

jest.mock("@/lib/platform-admin/business-profiles", () => ({
  fetchBusinessProfiles: () => mockFetchProfiles(),
  previewBusinessProfile: (tenantId: string, profile: string) => mockPreview(tenantId, profile),
  applyBusinessProfile: (tenantId: string, profile: string) => mockApply(tenantId, profile),
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
  mockFetchProfiles.mockResolvedValue(PROFILES_FIXTURE);
  mockPreview.mockResolvedValue(shippingPreviewWithBilling());
  mockApply.mockResolvedValue({});
  mockConfigValue.mockImplementation((_t: string, key: string) =>
    Promise.resolve(key === "fulfilment_model" ? "delivery" : "unset"),
  );
  mockEffective.mockResolvedValue(EFFECTIVE_FIXTURE);
});

describe("SetupSection — platform admin only", () => {
  it("renders the summary and the picker for a super admin", async () => {
    render(<Harness onApplied={jest.fn()} />);
    expect(await screen.findByText("Current setup")).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /Delivery distributor/ })).toBeInTheDocument();
  });

  it.each([["OPERATOR"], ["ADMIN"], [null]])(
    "renders nothing and fetches nothing for role %s",
    async (role) => {
      setRole(role);
      const { container } = render(<Harness onApplied={jest.fn()} />);
      expect(container).toBeEmptyDOMElement();
      expect(mockFetchProfiles).not.toHaveBeenCalled();
      expect(mockConfigValue).not.toHaveBeenCalled();
    },
  );

  it("applying a profile reloads the current setup", async () => {
    const onApplied = jest.fn();
    render(<Harness onApplied={onApplied} />);
    await screen.findByText("Own delivery: orders go out on the business's own trucks");
    const before = mockConfigValue.mock.calls.length;

    fireEvent.click(await screen.findByRole("radio", { name: /Shipping wholesaler/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const dialog = await screen.findByRole("dialog");
    mockConfigValue.mockImplementation((_t: string, key: string) =>
      Promise.resolve(key === "fulfilment_model" ? "ship" : "unset"),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith(TENANT_ID, "shipping_wholesaler");
    expect(
      await screen.findByText("Ship by carrier: orders are shipped, not delivered"),
    ).toBeInTheDocument();
    expect(mockConfigValue.mock.calls.length).toBeGreaterThan(before);
  });
});
