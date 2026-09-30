/**
 * TP7 (T45–T48) — `GoHighLevelSettingsTab` rendered directly with props.
 * See test-plan.md T45–T48 for the exact oracle each assertion transplants
 * from ux-spec.md's Card 1 / Card 3 / Card 4 copy, pinned verbatim.
 *
 * Fix round (2026-09-11-crm-gohighlevel-handoff, Group C) adds three more:
 * the Card 2 stage picker (M14), the container's handoff-envelope unwrap
 * (M16), and the "Preview existing leads" wiring (M15/m5) — the latter two
 * exercise the default-exported container against a mocked `apiClient`, the
 * same pattern `settings-profile.test.tsx` uses.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import GoHighLevelSettingsTabConnected, {
  GoHighLevelSettingsTab,
} from "./_components/GoHighLevelSettingsTab";

describe("GoHighLevelSettingsTab", () => {
  // T45 / R29 — not-connected body: two inputs + primary button.
  it("T45: shows Connection key + GoHighLevel account ID inputs and a Save & test button when status is null", () => {
    render(<GoHighLevelSettingsTab status={null} />);

    expect(screen.getByLabelText("Connection key")).toBeInTheDocument();
    expect(screen.getByLabelText("GoHighLevel account ID")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save & test" })).toBeInTheDocument();
  });

  // T46 / R29 — connected success state: badge/summary line names the location.
  it("T46: shows 'Connected to Acme HQ' when status is CONNECTED with locationName Acme HQ", () => {
    render(<GoHighLevelSettingsTab status="CONNECTED" locationName="Acme HQ" />);

    expect(screen.getByText(/Connected to Acme HQ/)).toBeInTheDocument();
  });

  // T47 / R29 — dry-run banner, copy "Preview mode" pinned verbatim.
  it("T47: shows a 'Preview mode' banner when dryRun is true", () => {
    render(<GoHighLevelSettingsTab status="CONNECTED" locationName="Acme HQ" dryRun={true} />);

    expect(screen.getByText(/Preview mode/)).toBeInTheDocument();
  });

  // T48 / R29 — activity Details column translates reason codes to plain words.
  it("T48: renders 'No email or phone on the contact' for a NEEDS_REVIEW row with reason no-identity", () => {
    render(
      <GoHighLevelSettingsTab
        status="CONNECTED"
        locationName="Acme HQ"
        activity={[
          {
            id: "h1",
            status: "NEEDS_REVIEW",
            reason: "no-identity",
            opportunityName: "Big Order",
            contactName: "Acme Foods",
          },
        ]}
      />,
    );

    expect(screen.getByText("No email or phone on the contact")).toBeInTheDocument();
  });

  // M14 / ux-spec Card 2 — the stage picker renders the selected pipeline's
  // stages and "Save" sends the trigger patch (triggerMode/pipelineId/stageId).
  it("M14: stage picker renders the pipeline's stages and saving sends the trigger patch", async () => {
    const user = userEvent.setup();
    const onUpdateConfig = jest.fn();

    render(
      <GoHighLevelSettingsTab
        status="CONNECTED"
        locationName="Acme HQ"
        config={{
          triggerMode: "STAGE",
          pipelineId: null,
          stageId: null,
          stageName: null,
          startFrom: "2026-01-01T00:00:00.000Z",
          writeBackFields: true,
          writeBackTag: true,
          writeBackNote: true,
          markWon: false,
          enabled: false,
        }}
        pipelines={[
          { id: "p1", name: "Sales", stages: [{ id: "s1", name: "Proposal sent", position: 0 }] },
        ]}
        onUpdateConfig={onUpdateConfig}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Pipeline"), "p1");
    expect(screen.getByRole("option", { name: "Proposal sent" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Stage"), "s1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ triggerMode: "STAGE", pipelineId: "p1", stageId: "s1" }),
    );
  });
});

// ─── Container tests (M15/M16/m5) — mock `apiClient`, mount the real hooks ─────

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

import { apiClient as apiClientMock } from "@/lib/api-client";

const DISCONNECTED_STATUS_RESPONSE = {
  connection: null,
  counts: { pending: 0, needsReview: 0, created: 0, linked: 0, dryRun: 0, failed: 0 },
};

const CONNECTED_STATUS_RESPONSE = {
  connection: {
    status: "CONNECTED",
    enabled: false,
    dryRun: true,
    triggerMode: "STAGE",
    pipelineId: null,
    stageId: null,
    stageName: null,
    locationId: "loc_1",
    locationName: "Acme HQ",
    tokenLast4: "ab12",
    startFrom: "2026-01-01T00:00:00.000Z",
    writeBackFields: true,
    writeBackTag: true,
    writeBackNote: true,
    markWon: false,
    defaultRegion: "US",
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
  },
  counts: { pending: 0, needsReview: 0, created: 0, linked: 0, dryRun: 0, failed: 0 },
};

function mockGet(handoffs: unknown) {
  (apiClientMock.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/crm/gohighlevel") return Promise.resolve({ data: CONNECTED_STATUS_RESPONSE });
    if (url === "/crm/gohighlevel/handoffs") return Promise.resolve({ data: handoffs });
    if (url === "/crm/gohighlevel/pipelines") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
}

describe("GoHighLevelSettingsTabConnected (container)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (apiClientMock.patch as jest.Mock).mockResolvedValue({ data: {} });
    (apiClientMock.delete as jest.Mock).mockResolvedValue({ data: {} });
  });

  // M16 — the shared-contract envelope is `{data, total, page, limit}`; the
  // Activity table must render its rows straight from `.data`.
  it("M16: renders Activity rows from the {data, total, page, limit} envelope", async () => {
    mockGet({
      data: [
        {
          id: "h1",
          opportunityId: "o1",
          opportunityName: "Big Deal",
          contactId: "c1",
          contactName: "Acme Foods",
          status: "CREATED",
          matchedBy: null,
          reason: null,
          customerId: "cust1",
          attempts: 0,
          createdAt: new Date().toISOString(),
          processedAt: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 25,
    });

    renderWithProviders(<GoHighLevelSettingsTabConnected />);

    expect(await screen.findByText("Big Deal")).toBeInTheDocument();
    expect(screen.getByText("Acme Foods")).toBeInTheDocument();
  });

  // M15/m5 — "Preview existing leads" was wired to nothing; it must call the
  // preview endpoint.
  it("m5: 'Preview existing leads' calls the preview endpoint", async () => {
    const user = userEvent.setup();
    mockGet({ data: [], total: 0, page: 1, limit: 25 });
    (apiClientMock.post as jest.Mock).mockResolvedValue({ data: { count: 0, sample: [] } });

    renderWithProviders(<GoHighLevelSettingsTabConnected />);

    const button = await screen.findByRole("button", { name: "Preview existing leads" });
    await user.click(button);

    await waitFor(() =>
      expect(apiClientMock.post).toHaveBeenCalledWith("/crm/gohighlevel/import-existing/preview"),
    );
  });

  // #4 (fix-plan round 2, Group E) — a rejected key is an HTTP 200 `{ok:false}`, not a rejected
  // mutation: the inline error must come from that payload and no success toast may fire.
  it("#4: a rejected key shows the inline error and never toasts a success", async () => {
    const user = userEvent.setup();
    (apiClientMock.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/crm/gohighlevel")
        return Promise.resolve({ data: DISCONNECTED_STATUS_RESPONSE });
      if (url === "/crm/gohighlevel/handoffs")
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 25 } });
      if (url === "/crm/gohighlevel/pipelines") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    (apiClientMock.patch as jest.Mock).mockResolvedValue({ data: DISCONNECTED_STATUS_RESPONSE });
    (apiClientMock.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/crm/gohighlevel/connection/test") {
        return Promise.resolve({
          data: { ok: false, reason: "GoHighLevel rejected the token", connection: null },
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderWithProviders(<GoHighLevelSettingsTabConnected />);

    await user.type(await screen.findByLabelText("Connection key"), "bad-key");
    await user.type(screen.getByLabelText("GoHighLevel account ID"), "loc_1");
    await user.click(screen.getByRole("button", { name: "Save & test" }));

    expect(
      await screen.findByText("GoHighLevel rejected this key. Create a new one and paste it here."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connected to/)).not.toBeInTheDocument();
  });

  // #5 (fix-plan round 2, Group E) — a successful Save & test collapses to the summary line and
  // never leaves the pasted key sitting in an input.
  it("#5: a successful Save & test shows the key-ending summary and clears the inputs", async () => {
    const user = userEvent.setup();
    let connected = false;
    (apiClientMock.get as jest.Mock).mockImplementation((url: string) => {
      if (url === "/crm/gohighlevel") {
        return Promise.resolve({
          data: connected ? CONNECTED_STATUS_RESPONSE : DISCONNECTED_STATUS_RESPONSE,
        });
      }
      if (url === "/crm/gohighlevel/handoffs")
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 25 } });
      if (url === "/crm/gohighlevel/pipelines") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    (apiClientMock.patch as jest.Mock).mockResolvedValue({ data: DISCONNECTED_STATUS_RESPONSE });
    (apiClientMock.post as jest.Mock).mockImplementation((url: string) => {
      if (url === "/crm/gohighlevel/connection/test") {
        connected = true;
        return Promise.resolve({
          data: {
            ok: true,
            locationName: "Acme HQ",
            connection: CONNECTED_STATUS_RESPONSE.connection,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderWithProviders(<GoHighLevelSettingsTabConnected />);

    await user.type(await screen.findByLabelText("Connection key"), "good-key");
    await user.type(screen.getByLabelText("GoHighLevel account ID"), "loc_1");
    await user.click(screen.getByRole("button", { name: "Save & test" }));

    expect(await screen.findByText(/key ending in/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Connection key")).not.toBeInTheDocument();
  });
});
