import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunSettlementForm } from "./RunSettlementForm";

// SA-1098 A-1 (PR-S): the one settlement form behind the driver's footer and the office run page.
// Rows SE-1 (settle then finish), SE-2 (the server asks for a reason), SE-3 (one cent / two cents),
// SE-4 (a lost response), SE-5 (settled, finish failed), SE-8 (office settles, amends), SE-9 (two lines).

const settle = jest.fn();
const setStatus = jest.fn();
const toast = jest.fn();

jest.mock("@/lib/api/routes", () => ({
  useSettleRun: () => ({ mutateAsync: settle, isPending: false }),
  useUpdateRouteRunStatus: () => ({ mutateAsync: setStatus, isPending: false }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const REASON_MESSAGE =
  "Counted cash does not match the expected amount — a varianceReason is required.";

function axiosError(data: Record<string, unknown>, status = 400) {
  return Object.assign(new Error(String(data.message ?? "x")), { response: { status, data } });
}

function renderForm(
  over: Partial<React.ComponentProps<typeof RunSettlementForm>> = {},
  runOver: Record<string, unknown> = {},
) {
  const onDone = jest.fn();
  const run = {
    id: "run-1",
    settlementNote: null,
    collectedPayments: { cashTotal: 40, checkTotal: 30, count: 2 },
    ...runOver,
  } as any;
  const qc = new QueryClient();
  const utils = render(
    <QueryClientProvider client={qc}>
      <RunSettlementForm run={run} mode="driver" onDone={onDone} {...over} />
    </QueryClientProvider>,
  );
  return { onDone, run, qc, ...utils };
}

const counted = () => screen.getByLabelText(/cash and checks counted/i);

beforeEach(() => {
  settle.mockReset().mockResolvedValue({});
  setStatus.mockReset().mockResolvedValue({});
  toast.mockReset();
});

describe("RunSettlementForm", () => {
  it("SE-9: shows cash and checks on two lines and their sum as the expected figure", () => {
    renderForm();
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("Checks")).toBeInTheDocument();
    expect(screen.getByText("$40.00")).toBeInTheDocument();
    expect(screen.getByText("$30.00")).toBeInTheDocument();
    expect(screen.getByTestId("settlement-expected")).toHaveTextContent("$70.00");
  });

  it("SE-1: a matching count settles with no reason, then finishes the run", async () => {
    const { onDone } = renderForm();
    await userEvent.type(counted(), "70");
    expect(screen.queryByLabelText(/why is it different/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(settle).toHaveBeenCalledWith({
      id: "run-1",
      countedCash: 70,
      varianceReason: undefined,
    });
    expect(setStatus).toHaveBeenCalledWith({ id: "run-1", status: "COMPLETED" });
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(setStatus.mock.invocationCallOrder[0]);
  });

  it("SE-3: one cent off needs no reason, two cents off asks for one and will not send without it", async () => {
    renderForm();
    await userEvent.type(counted(), "70.01");
    expect(screen.queryByLabelText(/why is it different/i)).not.toBeInTheDocument();

    await userEvent.clear(counted());
    await userEvent.type(counted(), "69.98");
    const reason = await screen.findByLabelText(/why is it different/i);
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
    expect(settle).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/reason/i);

    await userEvent.type(reason, "Fuel from the bag");
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
    await waitFor(() => expect(setStatus).toHaveBeenCalled());
    expect(settle).toHaveBeenCalledWith({
      id: "run-1",
      countedCash: 69.98,
      varianceReason: "Fuel from the bag",
    });
  });

  it("SE-2: when the server asks for a reason the form opens the field, keeps the count and does not finish", async () => {
    settle.mockRejectedValueOnce(
      axiosError({ code: "RUN_VARIANCE_REASON_REQUIRED", message: REASON_MESSAGE }),
    );
    const { onDone } = renderForm();
    await userEvent.type(counted(), "70");
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));

    expect(await screen.findByLabelText(/why is it different/i)).toBeInTheDocument();
    expect(counted()).toHaveValue("70");
    expect(screen.getByRole("alert")).toHaveTextContent(/expected amount changed/i);
    expect(setStatus).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("SE-4: a lost settle response (already settled) carries on to finish and says so", async () => {
    settle.mockRejectedValueOnce(axiosError({ code: "RUN_ALREADY_SETTLED", message: "x" }));
    const { onDone } = renderForm();
    await userEvent.type(counted(), "70");
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith({ id: "run-1", status: "COMPLETED" });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Settlement already recorded." }),
    );
  });

  it("SE-5: settled but finishing failed, the retry sends only the finish", async () => {
    setStatus.mockRejectedValueOnce(axiosError({ message: "Network down" }, 500));
    const { onDone } = renderForm();
    await userEvent.type(counted(), "70");
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(settle).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledTimes(2);
  });

  it("a run already settled before this screen opened finishes without settling again", async () => {
    const { onDone } = renderForm({}, { settlementNote: "Settlement recorded" });
    expect(screen.queryByLabelText(/cash and checks counted/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(settle).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith({ id: "run-1", status: "COMPLETED" });
  });

  it("SE-8 office: Settle run settles and never finishes the run", async () => {
    const { onDone } = renderForm({ mode: "office" });
    await userEvent.type(counted(), "70");
    await userEvent.click(screen.getByRole("button", { name: /^settle run$/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(settle).toHaveBeenCalledWith({
      id: "run-1",
      countedCash: 70,
      varianceReason: undefined,
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("SE-8 office: Amend writes a new count even when a settlement is on record", async () => {
    const { onDone } = renderForm({ mode: "amend" }, { settlementNote: "Settlement recorded" });
    await userEvent.type(counted(), "65");
    const reason = await screen.findByLabelText(/why is it different/i);
    await userEvent.type(reason, "Recount");
    await userEvent.click(screen.getByRole("button", { name: /save new count/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(settle).toHaveBeenCalledWith({
      id: "run-1",
      countedCash: 65,
      varianceReason: "Recount",
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("will not send until the run's totals have loaded", async () => {
    renderForm({}, { collectedPayments: undefined });
    expect(screen.getByRole("button", { name: /settle and finish route/i })).toBeDisabled();
  });

  it("refuses an empty or non-numeric count on the form and sends nothing", async () => {
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/enter the cash and checks you counted/i);
    await userEvent.type(counted(), "abc");
    await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
    expect(settle).not.toHaveBeenCalled();
  });
});
