import * as React from "react";
import { render, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ruleEditImpactCopy } from "@routeflow/types";
import { Providers } from "@/app/providers";
import { EditRuleDialog } from "./EditRuleDialog";

const post = jest.fn();
const put = jest.fn();
const toast = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
let role = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn(() => Promise.resolve({ data: [] })),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  },
}));

const RULE = {
  id: "r1",
  jurisdiction: "STATE" as const,
  states: ["TX"],
  surface: "ALL" as const,
  effectiveFrom: new Date("2026-10-10T00:00:00").toISOString(),
  effectiveTo: null,
  reason: "State ban",
  revision: 4,
  status: "ACTIVE" as const,
};
const preview = (over: Record<string, unknown> = {}) => ({
  changes: [
    { field: "states", direction: "TIGHTENS" },
    { field: "reason", direction: "NEUTRAL" },
  ],
  impact: { openOrders: 2, drafts: 1 },
  impactHash: "hash-1",
  revision: 4,
  ...over,
});
const reject = (status: number, data: object) =>
  Object.assign(new Error("Request failed"), { response: { status, data } });

const onClose = jest.fn();
const open = () =>
  render(
    <Providers>
      <EditRuleDialog rule={RULE as any} open onClose={onClose} />
    </Providers>,
  );
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
const addCA = () => fireEvent.click(screen.getByRole("checkbox", { name: /California/ }));

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
});

describe("EditRuleDialog", () => {
  it("opens pre-filled with the rule's settings and no targets field", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Edit rule settings" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Specific states" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Texas/ })).toBeChecked();
    expect(screen.getByLabelText("Reason")).toHaveValue("State ban");
    expect(screen.getByLabelText(/Starts on/)).toHaveValue("2026-10-10");
    expect(screen.queryByLabelText("Search products")).toBeNull();
  });

  it("validates like create, in the same words, and previews nothing", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Texas/ }));
    save();
    expect(await screen.findByText("Add a reason")).toBeInTheDocument();
    expect(screen.getByText("Pick at least one state")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("Save checks the impact first: tightens/loosens chips, the impact line, a link to orders; nothing is saved yet", async () => {
    post.mockResolvedValueOnce({ data: preview() });
    open();
    addCA();
    save();
    await screen.findByRole("button", { name: "Confirm change" });
    expect(post).toHaveBeenCalledWith("/selling-restrictions/r1/edit-preview", {
      jurisdiction: "STATE",
      states: ["TX", "CA"],
      surface: "ALL",
      effectiveFrom: RULE.effectiveFrom,
      effectiveTo: null,
      reason: "State ban",
    });
    expect(screen.getByText("States")).toBeInTheDocument();
    expect(screen.getByText("Tightens")).toBeInTheDocument();
    expect(screen.getByText("Reason")).toBeInTheDocument();
    expect(screen.queryByText("Loosens")).toBeNull();
    expect(screen.getByText(ruleEditImpactCopy(3))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View open orders" })).toHaveAttribute(
      "href",
      "/orders",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("a loosening change is named as one", async () => {
    post.mockResolvedValueOnce({
      data: preview({
        changes: [{ field: "states", direction: "LOOSENS" }],
        impact: { openOrders: 0, drafts: 0 },
      }),
    });
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: /Texas/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Florida/ }));
    save();
    expect(await screen.findByText("Loosens")).toBeInTheDocument();
    expect(screen.getByText("No open orders are affected.")).toBeInTheDocument();
  });

  it("Confirm change PUTs with the revision and impact hash it was shown, then closes with one toast", async () => {
    post.mockResolvedValueOnce({ data: preview() });
    put.mockResolvedValueOnce({ data: { id: "r1" } });
    open();
    addCA();
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith("/selling-restrictions/r1", {
      jurisdiction: "STATE",
      states: ["TX", "CA"],
      surface: "ALL",
      effectiveFrom: RULE.effectiveFrom,
      effectiveTo: null,
      reason: "State ban",
      expectedRevision: 4,
      confirmImpactHash: "hash-1",
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatchObject({ title: "Rule updated", variant: "success" });
  });

  it("Back returns to the form with the edits kept", async () => {
    post.mockResolvedValueOnce({ data: preview() });
    open();
    addCA();
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(screen.getByRole("checkbox", { name: /California/ })).toBeChecked();
    expect(put).not.toHaveBeenCalled();
  });

  it("nothing changed: says so and offers no Confirm", async () => {
    post.mockResolvedValueOnce({ data: preview({ changes: [] }) });
    open();
    save();
    expect(await screen.findByText("Nothing changed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm change" })).toBeNull();
  });

  it("409 RULE_STALE: fixed 'someone changed this rule' line with Reload, and NO toast", async () => {
    post.mockResolvedValueOnce({ data: preview() });
    put.mockRejectedValueOnce(reject(409, { code: "RULE_STALE", message: "raw server sentence" }));
    open();
    addCA();
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm change" }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Someone changed this rule");
    expect(banner).not.toHaveTextContent("raw server sentence");
    expect(toast).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm change" })).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("409 RULE_IMPACT_CHANGED: previews again by itself and shows the new impact, with NO toast", async () => {
    post.mockResolvedValueOnce({ data: preview() });
    post.mockResolvedValueOnce({
      data: preview({ impact: { openOrders: 7, drafts: 0 }, impactHash: "hash-2" }),
    });
    put.mockRejectedValueOnce(reject(409, { code: "RULE_IMPACT_CHANGED" }));
    put.mockResolvedValueOnce({ data: { id: "r1" } });
    open();
    addCA();
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm change" }));
    expect(await screen.findByText(ruleEditImpactCopy(7))).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();
    expect(
      screen.getByText("The open orders this change affects have changed."),
    ).toBeInTheDocument();
    // the second confirm carries the NEW hash
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][1]).toMatchObject({
      confirmImpactHash: "hash-2",
      expectedRevision: 4,
    });
  });

  it("409 RULE_NOT_EDITABLE: closes, and the one global toast carries the fixed copy", async () => {
    post.mockResolvedValueOnce({ data: preview() });
    put.mockRejectedValueOnce(reject(409, { code: "RULE_NOT_EDITABLE", message: "raw" }));
    open();
    addCA();
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0].title).toMatch(/can't be changed/);
    expect(toast.mock.calls[0][0].title).not.toMatch(/raw/);
  });

  it("an operator cannot edit a rule INTO 'everywhere' (L5): the choice is disabled and explained", () => {
    role = "OPERATOR";
    open();
    expect(screen.getByRole("radio", { name: "Everywhere (federal)" })).toBeDisabled();
    expect(
      screen.getByText("Only an account admin can make a rule apply everywhere."),
    ).toBeInTheDocument();
  });

  it("an admin can", () => {
    open();
    expect(screen.getByRole("radio", { name: "Everywhere (federal)" })).toBeEnabled();
  });

  it("Escape closes without saving", () => {
    open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
