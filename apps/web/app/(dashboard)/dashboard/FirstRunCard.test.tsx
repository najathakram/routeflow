import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import userEvent from "@testing-library/user-event";
import { API_ERROR_CODES } from "@routeflow/types";
import type { FirstRunStatus } from "@routeflow/types";
import { FirstRunCard, firstRunErrorLine } from "./FirstRunCard";

/**
 * W1 (COPY 2p): the first question. Pending shows three ticks and one button; "Choose at least one." is local;
 * an answer posts only the three booleans; the done state carries the Workspace ID and next steps by what was ticked.
 */
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { post: (...a: unknown[]) => mockPost(...a), get: jest.fn() },
}));

const shown = () =>
  !!screen.queryByTestId("first-run-card") || !!screen.queryByTestId("first-run-done");

const base: FirstRunStatus = {
  state: "pending",
  workspaceId: "acme-trial",
  delivery: false,
  shipping: false,
  counter: false,
  hasOrder: false,
};

beforeEach(() => mockPost.mockReset());

describe("FirstRunCard", () => {
  it("renders nothing without a state (not a new sign-up, a failed read, or still loading)", () => {
    const { rerender } = renderWithProviders(<FirstRunCard status={undefined} />);
    expect(shown()).toBe(false);
    rerender(<FirstRunCard status={{ ...base, state: null }} />);
    expect(shown()).toBe(false);
    rerender(<FirstRunCard status={{ ...base, state: "closed" }} />);
    expect(shown()).toBe(false);
  });

  it("asks one question with three ticks, one button and the change-later line", () => {
    renderWithProviders(<FirstRunCard status={base} />);
    expect(screen.getByText("How do orders reach your customers?")).toBeInTheDocument();
    expect(screen.getByLabelText("We deliver with our own trucks")).not.toBeChecked();
    expect(screen.getByLabelText("We ship by carrier")).not.toBeChecked();
    expect(screen.getByLabelText("Customers pick up or buy at the counter")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Set up my account" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "hello@routeflow.info" })).toHaveAttribute(
      "href",
      "mailto:hello@routeflow.info",
    );
  });

  it("nothing ticked: says 'Choose at least one.' and sends nothing", async () => {
    renderWithProviders(<FirstRunCard status={base} />);
    await userEvent.click(screen.getByRole("button", { name: "Set up my account" }));
    expect(await screen.findByText("Choose at least one.")).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("posts exactly the three booleans, then shows the ready state with the Workspace ID", async () => {
    mockPost.mockResolvedValue({ data: { outcome: "applied", state: "answered" } });
    renderWithProviders(<FirstRunCard status={base} />);
    await userEvent.click(screen.getByLabelText("We ship by carrier"));
    await userEvent.click(screen.getByRole("button", { name: "Set up my account" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/settings/fulfilment/first-run", {
        delivery: false,
        shipping: true,
        counter: false,
      }),
    );
    expect(await screen.findByText("Your account is ready.")).toBeInTheDocument();
    expect(screen.getByText("acme-trial")).toBeInTheDocument();
    expect(screen.getByText(/You.ll need it to sign in\./)).toBeInTheDocument();
  });

  it("a kept setup says so and adds no error", async () => {
    mockPost.mockResolvedValue({ data: { outcome: "kept", state: "closed" } });
    renderWithProviders(<FirstRunCard status={base} />);
    await userEvent.click(screen.getByLabelText("We deliver with our own trucks"));
    await userEvent.click(screen.getByRole("button", { name: "Set up my account" }));
    expect(
      await screen.findByText("Your account is already set up, so we left it as it is."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a carrier in transit keeps the card open with the mapped line", async () => {
    mockPost.mockRejectedValue({
      response: { status: 409, data: { code: API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT } },
    });
    renderWithProviders(<FirstRunCard status={base} />);
    await userEvent.click(screen.getByLabelText("We deliver with our own trucks"));
    await userEvent.click(screen.getByRole("button", { name: "Set up my account" }));
    expect(
      await screen.findByText(
        "Orders are with the carrier right now. Try again once they're delivered.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up my account" })).toBeEnabled();
  });

  describe("after the answer", () => {
    const done = (over: Partial<FirstRunStatus>): FirstRunStatus => ({
      ...base,
      state: "answered",
      ...over,
    });

    it("delivery adds the address, driver and route steps", () => {
      renderWithProviders(<FirstRunCard status={done({ delivery: true })} />);
      expect(screen.getByRole("link", { name: "Add your business address" })).toHaveAttribute(
        "href",
        "/settings?tab=profile#business-address",
      );
      expect(screen.getByRole("link", { name: "Add a driver" })).toHaveAttribute(
        "href",
        "/drivers",
      );
      expect(screen.getByRole("link", { name: "Plan your first route" })).toHaveAttribute(
        "href",
        "/routes/create",
      );
      expect(screen.queryByRole("link", { name: "Start a counter sale" })).not.toBeInTheDocument();
    });

    it("a counter adds the counter sale step; shipping alone adds neither", () => {
      const { rerender } = renderWithProviders(<FirstRunCard status={done({ counter: true })} />);
      expect(screen.getByRole("link", { name: "Start a counter sale" })).toHaveAttribute(
        "href",
        "/orders/counter-sale",
      );
      rerender(<FirstRunCard status={done({ shipping: true })} />);
      expect(screen.queryByRole("link", { name: "Add a driver" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Start a counter sale" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Add your products" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Take your first order" })).toBeInTheDocument();
    });

    it("goes away once a first order exists", () => {
      renderWithProviders(<FirstRunCard status={done({ shipping: true, hasOrder: true })} />);
      expect(shown()).toBe(false);
    });
  });
});

describe("firstRunErrorLine", () => {
  it("a closed question is not an error line (the re-read removes the card)", () => {
    expect(
      firstRunErrorLine({ response: { data: { code: API_ERROR_CODES.FIRST_RUN_CLOSED } } }),
    ).toBeNull();
  });
  it("anything else gets one plain line", () => {
    expect(firstRunErrorLine(new Error("boom"))).toBe(
      "We couldn't set up your account. Try again.",
    );
  });
});
